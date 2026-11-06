import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProject, initialize, search } from '../src/core.mjs';
import { setupProject } from '../src/setup.mjs';
import { listCandidates } from '../src/learning.mjs';

const host = process.env.PI_TEST_HOST_PACKAGE;
let factory, classifyModelError;
if (host) {
  const require = createRequire(host), { createJiti } = require('jiti');
  const extension = await createJiti(import.meta.url, { alias: { typebox: require.resolve('typebox') } }).import(fileURLToPath(new URL('../index.ts', import.meta.url)));
  factory = extension.default;
  classifyModelError = extension.classifyModelError;
}
const integration = (name, fn) => test(name, { skip: !host }, fn);
integration('model error classification exposes only allowlisted categories, never raw provider text', () => {
  const cases = [
    ['401 secret-provider-body', 'http-401'],
    ['HTTP 503: private response', 'http-503'],
    ['status code: 429 private response', 'http-429'],
    ['Unauthorized access token: private-token', 'authentication'],
    ['Unsupported parameter: prompt_cache_options', 'unsupported-request'],
    ['Model does not exist', 'model-unavailable'],
    ['fetch failed: private endpoint', 'network'],
    ['stream ended without a stop reason', 'response-protocol'],
    ['request timed out', 'provider-timeout'],
    ['usage limit exceeded', 'rate-limit-or-quota'],
    ['arbitrary private response', 'unknown'],
    [undefined, 'unknown'],
  ];
  for (const [message, category] of cases) assert.equal(classifyModelError(message), category);
});

const messages = [
  { role: 'user', content: 'Check and remember the release procedure.' },
  { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'All 12 release checks passed.' }], isError: false },
  { role: 'assistant', content: [{ type: 'text', text: 'Verified release procedure: tests must pass before manual approval.' }], stopReason: 'stop' },
];
function response(payload, candidateOverrides = {}) {
  const source = payload.evidence.find(item => item.role === 'toolResult') ?? payload.evidence.at(-1);
  return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ candidates: [{ type: 'runbook', title: 'Verified release checks', content: 'Release checks passed. Require successful checks before manual release approval.', tags: ['release'], evidence: [{ id: source.id, quote: source.text.slice(0, Math.min(100, source.text.length)) }], ...candidateOverrides }] }) }], usage: { input: 100, output: 50, totalTokens: 150, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
}
async function harness(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-lifecycle-'));
  const oldHome = process.env.PI_PROJECT_MEMORY_HOME, oldConfig = process.env.PI_PROJECT_MEMORY_CONFIG;
  process.env.PI_PROJECT_MEMORY_HOME = path.join(temp, 'vault');
  process.env.PI_PROJECT_MEMORY_CONFIG = path.join(temp, 'config.json');
  fs.writeFileSync(process.env.PI_PROJECT_MEMORY_CONFIG, JSON.stringify(options.config ?? {}));
  t.after(() => {
    if (oldHome === undefined) delete process.env.PI_PROJECT_MEMORY_HOME; else process.env.PI_PROJECT_MEMORY_HOME = oldHome;
    if (oldConfig === undefined) delete process.env.PI_PROJECT_MEMORY_CONFIG; else process.env.PI_PROJECT_MEMORY_CONFIG = oldConfig;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  const config = loadConfig();
  const project = options.unmarked ? resolveProject(root, config) : setupProject(root, config);
  const events = new Map(), tools = new Map(), commands = new Map(), sent = [], entries = [], calls = [];
  const pi = { on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), sendMessage: message => sent.push(message), appendEntry: (name, data) => entries.push({ name, data }) };
  factory(pi);
  const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => 'test-session', getBranch: () => [] }, model: { provider: 'test', id: 'mock-model' }, modelRegistry: { streamSimple: (_model, input, callOptions) => {
    const payload = JSON.parse(input.messages[0].content[0].text);
    calls.push({ payload, options: callOptions, systemPrompt: input.systemPrompt });
    return { result: () => options.model ? options.model(payload, callOptions) : Promise.resolve(response(payload)) };
  } } };
  await events.get('session_start')({}, ctx);
  const run = async (turnMessages = messages) => {
    await events.get('before_agent_start')({ prompt: 'Verify release procedure' }, ctx);
    await events.get('agent_start')({}, ctx);
    return events.get('agent_end')({ messages: turnMessages }, ctx);
  };
  return { temp, root, project, config, ctx, events, tools, commands, sent, entries, calls, run };
}

integration('agent_end suggests grounded candidates, records usage and command approval publishes a searchable note', async t => {
  const h = await harness(t);
  await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].options.maxTokens, 3000);
  assert.equal(h.calls[0].options.signal.aborted, false);
  assert.equal(h.entries[0].name, 'project-memory-usage');
  const pending = listCandidates(h.project); assert.equal(pending.length, 1);
  assert.equal(search(h.project, 'release checks', h.config).hits.length, 0);
  await h.commands.get('memory').handler('review', h.ctx);
  assert.match(h.sent.at(-1).content, /Verified release checks/);
  await h.commands.get('memory').handler(`review approve ${pending[0].id.slice(0, 12)}`, h.ctx);
  assert.equal(listCandidates(h.project).length, 0);
  assert.equal(search(h.project, 'release checks', h.config).hits.length, 1);
  await h.run();
  assert.equal(listCandidates(h.project, { all: true }).length, 1);
});
integration('Pi 1.2 custom-triggered runs skip retrieval and learning without breaking the next user run', async t => {
  const h = await harness(t);
  await h.run();
  assert.equal(h.calls.length, 1);
  const result = await h.events.get('before_agent_start')({ messageType: 'custom', message: { content: 'Continue' } }, h.ctx);
  assert.equal(result, undefined);
  await h.events.get('agent_start')({}, h.ctx);
  await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(h.calls.length, 1);
  await h.run(); assert.equal(h.calls.length, 2);
});
integration('qchem project tuning reaches curator, search default and inventory commands', async t => {
  const h = await harness(t);
  const localFile = path.join(h.root, '.pi/project-memory.json');
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  fs.writeFileSync(localFile, JSON.stringify({ ...local, profile: 'qchem', learningOutputTokens: 5000 }));
  await h.run();
  assert.equal(h.calls[0].options.maxTokens, 5000);
  await h.commands.get('memory').handler('status', h.ctx);
  assert.match(h.sent.at(-1).content, /Profile: qchem/);
  assert.match(h.sent.at(-1).content, /Retrieval: 8 notes/);
  assert.match(h.sent.at(-1).content, /Saved: 0; searchable: 0/);
  await h.commands.get('memory').handler('stats', h.ctx);
  assert.equal(JSON.parse(h.sent.at(-1).content).pending, 1);
  for (let i = 0; i < 9; i++) await h.tools.get('project_memory_save').execute('save', { type: 'observation', title: `Bader ${i}`, content: `Bader System ${i} basin analysis` }, undefined, undefined, h.ctx);
  const result = await h.tools.get('project_memory_search').execute('search', { query: '盆积分' }, undefined, undefined, h.ctx);
  assert.equal(result.details.hits.length, 8);
  await h.commands.get('memory').handler('stats', h.ctx);
  assert.equal(JSON.parse(h.sent.at(-1).content).searchable, 9);
});
integration('auto mode publishes grounded candidates and does not duplicate repeated discoveries', async t => {
  const h = await harness(t, { config: { learningMode: 'auto' } });
  await h.run(); await h.run();
  assert.equal(listCandidates(h.project).length, 0);
  assert.equal(listCandidates(h.project, { all: true })[0].status, 'approved');
  assert.equal(fs.readdirSync(path.join(h.project.packPath, '70-runbooks')).length, 1);
});
integration('switching suggest to auto can approve an already pending identical candidate', async t => {
  const h = await harness(t);
  await h.run(); assert.equal(listCandidates(h.project).length, 1);
  await h.commands.get('memory').handler('learn auto', h.ctx);
  await h.run();
  assert.equal(listCandidates(h.project).length, 0);
  assert.equal(listCandidates(h.project, { all: true })[0].status, 'approved');
  assert.equal(fs.readdirSync(path.join(h.project.packPath, '70-runbooks')).length, 1);
});
integration('session learning mode override resets on session_start and off makes no model requests', async t => {
  const h = await harness(t);
  await h.commands.get('memory').handler('learn off', h.ctx);
  await h.run(); assert.equal(h.calls.length, 0);
  await h.events.get('session_start')({}, h.ctx);
  await h.run(); assert.equal(h.calls.length, 1);
  await h.commands.get('memory').handler('status', h.ctx);
  assert.match(h.sent.at(-1).content, /Learning: suggest/);
  assert.match(h.sent.at(-1).content, /Pending: 1/);
});
integration('no-marker directories never learn, save handoffs or silently create project files', async t => {
  const h = await harness(t, { unmarked: true });
  await h.run();
  const abort = new AbortController();
  await h.events.get('session_before_compact')({ signal: abort.signal, branchEntries: [], preparation: { messagesToSummarize: messages, turnPrefixMessages: [] }, reason: 'manual' }, h.ctx);
  assert.equal(h.calls.length, 0); assert.deepEqual(fs.readdirSync(h.root), []);
  assert.equal(fs.existsSync(h.config.vaultPath), false);
  await h.commands.get('memory-init').handler('New project', h.ctx);
  assert.equal(resolveProject(h.root, h.config).enabled, true);
  assert.match(h.sent.at(-1).content, /Project memory ready/);
});
integration('unsafe or hallucinated candidates and malformed model responses are not persisted', async t => {
  let mode = 'unsafe';
  const h = await harness(t, { model: payload => Promise.resolve(mode === 'unsafe' ? response(payload, { content: 'api_key: unsafeValue' }) : mode === 'fabricated' ? response(payload, { evidence: [{ id: 'm1', quote: 'Fabricated verification evidence' }] }) : { content: [{ type: 'text', text: 'not JSON' }] }) });
  await h.run(); mode = 'fabricated'; await h.run(); mode = 'malformed'; await h.run();
  assert.equal(listCandidates(h.project).length, 0);
});
integration('suggest and auto preserve unverified note status and explicit history search without auto injection', async t => {
  const h = await harness(t, { model: payload => {
    const source = payload.evidence.at(-1);
    return Promise.resolve({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ candidates: [{ type: 'observation', title: 'Unverified chemistry result', content: 'chemLifecycle result needs convergence verification; do not treat it as established.', status: 'unverified', evidence: ['calc/static/OUTCAR：待核实的收敛记录'], grounding: [{ id: source.id, quote: source.text }] }] }) }] });
  } });
  await h.run();
  const pending = listCandidates(h.project)[0];
  assert.equal(pending.note.status, 'unverified');
  await h.commands.get('memory').handler(`review approve ${pending.id}`, h.ctx);
  assert.equal(search(h.project, 'chemLifecycle', h.config).hits.length, 0);
  const tool = h.tools.get('project_memory_search');
  const historical = await tool.execute('test', { query: 'chemLifecycle', includeInactive: true }, undefined, undefined, h.ctx);
  assert.equal(historical.details.hits[0].status, 'unverified');
  assert.equal(await h.events.get('before_agent_start')({ prompt: 'chemLifecycle' }, h.ctx), undefined);
  await h.commands.get('memory').handler('search --all chemLifecycle', h.ctx);
  assert.equal(JSON.parse(h.sent.at(-1).content).hits[0].status, 'unverified');
  await h.commands.get('memory').handler('learn auto', h.ctx);
  await h.run();
  assert.equal(listCandidates(h.project, { all: true }).length, 1);
  assert.equal(listCandidates(h.project, { all: true })[0].note.status, 'unverified');
});

integration('auto can publish a new unverified candidate without activating it; zero candidates is valid', async t => {
  let empty = false;
  const h = await harness(t, { config: { learningMode: 'auto' }, model: payload => {
    const source = payload.evidence.at(-1);
    return Promise.resolve({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ candidates: empty ? [] : [{ type: 'observation', title: 'Unverified auto observation', content: 'chemAuto observation still requires checking.', status: 'unverified', grounding: [{ id: source.id, quote: source.text }] }] }) }] });
  } });
  await h.run();
  assert.equal(listCandidates(h.project).length, 0);
  const record = listCandidates(h.project, { all: true })[0];
  assert.equal(record.status, 'approved'); assert.equal(record.note.status, 'unverified');
  assert.equal(search(h.project, 'chemAuto', h.config).hits.length, 0);
  empty = true; await h.run();
  assert.equal(h.calls.length, 2); assert.equal(listCandidates(h.project, { all: true }).length, 1);
  await h.commands.get('memory').handler('learn off', h.ctx);
  await h.run(); assert.equal(h.calls.length, 2);
});

integration('save tool passes new metadata and explicit handoff search flags through to core', async t => {
  const h = await harness(t);
  const tool = h.tools.get('project_memory_save');
  const saved = await tool.execute('test', { type: 'observation', title: 'Chemistry note', content: 'chemTool local result reference', status: 'unverified', evidence: ['analysis/bader_summary.csv：逐原子电荷'] }, undefined, undefined, h.ctx);
  assert.match(fs.readFileSync(saved.details.path, 'utf8'), /status: unverified/);
  await h.events.get('session_before_compact')({ signal: new AbortController().signal, reason: 'manual', preparation: { firstKeptEntryId: 'chem-boundary', messagesToSummarize: [{ role: 'user', content: 'chemTool next calculation' }], turnPrefixMessages: [] } }, h.ctx);
  const result = await h.tools.get('project_memory_search').execute('test', { query: 'chemTool', includeInactive: true, includeHandoffs: true }, undefined, undefined, h.ctx);
  assert.equal(result.details.hits.length, 2);
  assert.ok(result.details.hits.some(hit => hit.handoff && hit.created));
  assert.equal(search(h.project, 'chemTool', h.config).hits.length, 0);
});

integration('learning diagnostics identify failure stages without exposing raw errors or responses', async t => {
  let mode = 'throw';
  const secret = 'private-provider-response-do-not-display';
  const h = await harness(t, { model: payload => {
    if (mode === 'throw') throw new TypeError(secret);
    if (mode === 'json') return Promise.resolve({ stopReason: 'stop', content: [{ type: 'text', text: secret }] });
    if (mode === 'error') return Promise.resolve({ stopReason: 'error', content: [], errorMessage: secret });
    return Promise.resolve(response(payload));
  } });
  const warnings = [];
  h.ctx.hasUI = true;
  h.ctx.ui = { notify: (text, level) => warnings.push({ text, level }), setStatus: () => {} };
  await h.run();
  assert.match(warnings.at(-1).text, /stage=model-call, reason=type-error/);
  mode = 'json'; await h.run();
  assert.match(warnings.at(-1).text, /stage=parse-response, reason=invalid-json/);
  mode = 'error'; await h.run();
  assert.match(warnings.at(-1).text, /stage=model-call, reason=model-error/);
  mode = 'queue';
  const lock = path.join(h.project.packPath, '00-system/pi-agent/.learning/.lock');
  fs.mkdirSync(lock, { recursive: true });
  await h.run();
  assert.match(warnings.at(-1).text, /stage=enqueue, reason=exception/);
  assert.ok(warnings.every(item => item.level === 'warning' && !item.text.includes(secret)));
  assert.equal(listCandidates(h.project).length, 0);
});

integration('timeout diagnostics distinguish the learning deadline from provider exceptions', async t => {
  const h = await harness(t, { config: { learningTimeoutMs: 100 }, model: () => new Promise(() => {}) });
  const warnings = [];
  h.ctx.hasUI = true;
  h.ctx.ui = { notify: text => warnings.push(text), setStatus: () => {} };
  await h.run();
  assert.match(warnings.at(-1), /stage=model-call, reason=timeout, elapsedMs=\d+/);
  assert.equal(listCandidates(h.project).length, 0);
});

integration('failed or aborted turns skip learning; safe evidence never forwards thinking or detected secrets', async t => {
  const h = await harness(t);
  await h.run([...messages.slice(0, -1), { role: 'assistant', content: [], stopReason: 'error' }]);
  await h.run([...messages.slice(0, -1), { role: 'assistant', content: [], stopReason: 'aborted' }]);
  assert.equal(h.calls.length, 0);
  await h.run([messages[0], { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'token: unsafeValue' }] }, messages[1], { ...messages[2], content: [{ type: 'thinking', thinking: 'hidden reasoning' }, ...messages[2].content] }]);
  const payload = JSON.stringify(h.calls[0].payload);
  assert.ok(!payload.includes('unsafeValue')); assert.ok(!payload.includes('hidden reasoning'));
});
integration('model timeout is bounded and cannot save a late response', async t => {
  let resolveResponse;
  const h = await harness(t, { config: { learningTimeoutMs: 100 }, model: () => new Promise(resolve => { resolveResponse = resolve; }) });
  const started = Date.now(); await h.run();
  assert.ok(Date.now() - started < 1500);
  assert.equal(h.calls[0].options.signal.aborted, true);
  resolveResponse(response(h.calls[0].payload)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCandidates(h.project).length, 0);
});
integration('scope changes abort a running curator and prevent cross-project persistence', async t => {
  let resolveResponse, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const h = await harness(t, { model: () => new Promise(resolve => { resolveResponse = resolve; notifyStarted(); }) });
  const otherRoot = path.join(h.temp, 'other'); fs.mkdirSync(otherRoot); fs.writeFileSync(path.join(otherRoot, '.pi-root'), '');
  const other = resolveProject(otherRoot, h.config); initialize(other, h.config);
  const running = h.run(); await started;
  await h.commands.get('memory').handler(`use ${other.id}`, h.ctx);
  resolveResponse(response(h.calls[0].payload)); await running;
  assert.equal(listCandidates(h.project).length, 0); assert.equal(listCandidates(other).length, 0);
  await h.run(); assert.equal(h.calls.length, 1);
});
integration('marker removal while a curator is running revokes the captured project', async t => {
  let resolveResponse, notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const h = await harness(t, { model: () => new Promise(resolve => { resolveResponse = resolve; notifyStarted(); }) });
  const running = h.run(); await started;
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  resolveResponse(response(h.calls[0].payload)); await running;
  fs.writeFileSync(path.join(h.root, '.pi-root'), '');
  assert.equal(listCandidates(h.project).length, 0);
});
integration('session_before_compact saves a handoff without a model call and leaves compaction unchanged', async t => {
  const h = await harness(t, { config: { learningMode: 'off' } });
  const event = { reason: 'manual', signal: new AbortController().signal, preparation: { firstKeptEntryId: 'kept-id', previousSummary: 'Previously verified release constraints.', messagesToSummarize: messages, turnPrefixMessages: [] }, branchEntries: messages.map((message, index) => ({ type: 'message', id: `entry-${index}`, message })) };
  const result = await h.events.get('session_before_compact')(event, h.ctx);
  assert.equal(result, undefined); assert.equal(h.calls.length, 0);
  const dir = path.join(h.project.packPath, '80-sessions');
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.match(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'), /manual approval/);
  await h.events.get('session_before_compact')(event, h.ctx);
  assert.equal(fs.readdirSync(dir).length, 1);
  fs.writeFileSync(process.env.PI_PROJECT_MEMORY_CONFIG, '{"handoffEnabled":false}');
  await h.events.get('session_before_compact')({ ...event, preparation: { ...event.preparation, firstKeptEntryId: 'next-id' } }, h.ctx);
  assert.equal(fs.readdirSync(dir).length, 1);
});
integration('handoff reads canonical preparation, not omitted or replaced raw branch messages', async t => {
  const h = await harness(t);
  const raw = [...messages, { role: 'assistant', content: [{ type: 'text', text: 'omittedRawAttemptShouldNeverReturn' }], stopReason: 'stop' }];
  await h.events.get('session_before_compact')({ signal: new AbortController().signal, reason: 'threshold', preparation: { firstKeptEntryId: 'canonical-id', messagesToSummarize: messages, turnPrefixMessages: [] }, branchEntries: raw.map(message => ({ type: 'message', message })) }, h.ctx);
  const dir = path.join(h.project.packPath, '80-sessions');
  const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  assert.ok(!text.includes('omittedRawAttemptShouldNeverReturn'));
  assert.match(text, /manual approval/);
});
integration('cancelled compaction and manual target selection do not save handoffs', async t => {
  const h = await harness(t);
  const controller = new AbortController(); controller.abort();
  const event = { signal: controller.signal, reason: 'manual', branchEntries: [], preparation: { messagesToSummarize: messages, turnPrefixMessages: [] } };
  await h.events.get('session_before_compact')(event, h.ctx);
  await h.commands.get('memory').handler(`use ${h.project.id}`, h.ctx);
  await h.events.get('session_before_compact')({ ...event, signal: new AbortController().signal }, h.ctx);
  assert.equal(fs.readdirSync(path.join(h.project.packPath, '80-sessions')).length, 0);
});
