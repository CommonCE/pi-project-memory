import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initializeV2, resolveV2, statusV2 } from '../src/v2-store.mjs';
import { readBriefV2, readWorkingV2, updateWorkingV2 } from '../src/v2-working.mjs';

const host = process.env.PI_TEST_HOST_PACKAGE;
let factory;
if (host) {
  const require = createRequire(host), { createJiti } = require('jiti');
  factory = await createJiti(import.meta.url, { alias: { typebox: require.resolve('typebox') } }).import(fileURLToPath(new URL('../v2.ts', import.meta.url)), { default: true });
}
const integration = (name, fn) => test(name, { skip: !host }, fn);
const messages = [
  { role: 'user', content: '检查合成 SCF 故障夹具 calc/test/run.out，暂不执行任何计算。' },
  { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'calc/test/run.out: SCF NOT CONVERGED (synthetic fixture)' }] },
  { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '助手建议：检查模型、初猜与输入参数；这些建议尚未验证。'.repeat(6) }] },
];
async function harness(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-lifecycle-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const project = initializeV2(root), events = new Map(), tools = new Map(), commands = new Map(), sent = [];
  factory({ on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command), sendMessage: message => sent.push(message) });
  let session = 'test-session', turn = randomUUID();
  const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => session, getBranch: () => [{ type: 'message', id: turn, message: messages[0] }] },
    modelRegistry: { streamSimple: () => { throw new Error('M2 must never call a model'); } } };
  await events.get('session_start')({}, ctx);
  const before = async () => events.get('before_agent_start')({ messageType: 'user', prompt: messages[0].content }, ctx);
  const run = async (value = messages) => { turn = randomUUID(); await before(); await events.get('agent_end')({ messages: value }, ctx); };
  return { temp, root, project, events, tools, commands, sent, ctx, before, run, changeSession: () => { session = randomUUID(); } };
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true }).sort().filter(name => fs.statSync(path.join(root, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(root, name)).toString('base64')]);
}

integration('M7 manual brief is shared, read-only and never consumes first-turn eligibility', async t => {
  const h = await harness(t);
  t.mock.method(Date, 'now', () => 1700000000000);
  const before = snapshot(h.root), command = h.commands.get('memory');
  await command.handler('brief', h.ctx);
  assert.deepEqual(JSON.parse(h.sent.at(-1).content), readBriefV2(h.project));
  assert.deepEqual(snapshot(h.root), before);
  assert.match((await h.before()).message.content, /Folder brief/);
  await command.handler('brief', h.ctx);
  assert.doesNotMatch((await h.before())?.message.content ?? '', /Folder brief/);
  await command.handler('brief --folder other', h.ctx);
  assert.match(h.sent.at(-1).content, /invalid-arguments/);
  const notices = [], uiCtx = { ...h.ctx, hasUI: true, ui: { notify: text => notices.push(text) } };
  await command.handler('brief', uiCtx);
  assert.deepEqual(JSON.parse(notices.at(-1)), readBriefV2(h.project));
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  const disabled = snapshot(h.root);
  await command.handler('brief', h.ctx);
  assert.deepEqual(JSON.parse(h.sent.at(-1).content), { content: '', chars: 0, folder: null });
  assert.deepEqual(snapshot(h.root), disabled);
});

integration('M7 brief follows directory and project identity, including switching back and canonical aliases', async t => {
  const h = await harness(t);
  const other = path.join(h.temp, 'other'); fs.mkdirSync(other); initializeV2(other);
  const child = path.join(h.root, 'child'); fs.mkdirSync(child);
  const alias = path.join(h.temp, 'alias'); fs.symlinkSync(child, alias);
  for (const cwd of [h.root, child, h.root, other, h.root, child]) {
    h.ctx.cwd = cwd;
    assert.match((await h.before()).message.content, /Folder brief/, cwd);
    assert.doesNotMatch((await h.before())?.message.content ?? '', /Folder brief/, cwd);
  }
  h.ctx.cwd = alias;
  assert.doesNotMatch((await h.before())?.message.content ?? '', /Folder brief/);
  h.ctx.cwd = h.temp; // No project; returning must count as an identity transition.
  assert.equal(await h.before(), undefined);
  h.ctx.cwd = child;
  assert.match((await h.before()).message.content, /Folder brief/);
});

integration('M7 cancelled switch/fork retains eligibility while successful session replacement resets it', async t => {
  const h = await harness(t);
  await h.before();
  for (const name of ['session_before_switch', 'session_before_fork']) {
    await h.events.get(name)({}, h.ctx); // Another extension cancels: no shutdown/start follows.
    await h.events.get('agent_end')({ messages }, h.ctx);
    assert.equal(readWorkingV2(h.project).events.length, 0);
    assert.doesNotMatch((await h.before())?.message.content ?? '', /Folder brief/);
  }
  for (const reason of ['new', 'resume', 'fork']) {
    await h.events.get('session_shutdown')({ reason }, h.ctx);
    h.changeSession(); await h.events.get('session_start')({ reason }, h.ctx);
    assert.match((await h.before()).message.content, /Folder brief/);
    assert.doesNotMatch((await h.before())?.message.content ?? '', /Folder brief/);
  }
});

integration('M7 failed context generation can retry its first brief', async t => {
  const h = await harness(t), read = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (String(file).startsWith(h.project.memory)) throw new Error('synthetic read failure');
    return read.call(this, file, ...args);
  });
  assert.equal(await h.before(), undefined);
  assert.match(h.sent.at(-1).content, /Memory context skipped/);
  mock.mock.restore();
  assert.match((await h.before()).message.content, /Folder brief/);
});

integration('M7 directory changes discard old turn writes and handoff stays in the current folder', async t => {
  const h = await harness(t), a = path.join(h.root, 'a'), b = path.join(h.root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  h.ctx.cwd = a; await h.before();
  h.ctx.cwd = b; await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(readWorkingV2(resolveV2(a)).events.length, 0);
  assert.equal(readWorkingV2(resolveV2(b)).events.length, 0);
  await h.events.get('session_before_compact')({ signal: new AbortController().signal, preparation: {
    messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'm7-b',
  } }, h.ctx);
  assert.equal(readWorkingV2(resolveV2(a)).events.length, 0);
  assert.equal(readWorkingV2(resolveV2(b)).events.at(-1).payload.scope.path, 'b');
});

integration('M7 synthetic save, retrieve, new-session continuation and explicit correction preserve old sources', async t => {
  const h = await harness(t), save = h.tools.get('project_memory_save'), search = h.tools.get('project_memory_search');
  const locator = 'synthetic/output.log:12';
  const sources = [{ locator, quote: 'Synthetic failed SCF fixture; no calculation executed.', source: 'tool-observation' }];
  const known = value => ({ state: 'known', value, sources: structuredClone(sources) });
  const write = async entry => (await save.execute('save', { target: 'knowledge', entry }, undefined, undefined, h.ctx)).details.record;
  const system = await write({ kind: 'systems', title: 'M7_SYSTEM', content: 'Synthetic neutral system; charge=0, spin unknown.' });
  const method = await write({ kind: 'methods', title: 'M7_METHOD', content: 'Synthetic model and basis; software synthetic 0. Not a real setup.' });
  const origin = await write({ kind: 'runs', title: 'M7_RUN', content: `Synthetic run for ${system.id}, method ${method.id}; no real calculation.`, evidence: [locator],
    run: { execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked', software: 'synthetic', version: '0' } });
  const entry = { kind: 'results', title: 'M7_ENERGY', content: 'Synthetic intermediate energy, NOT a converged final energy.', evidence: [locator],
    result: { runId: origin.id, property: 'M7_ENERGY', value: 0, unit: 'eV', definition: 'Synthetic intermediate only.' },
    card: { version: 1, fields: { propertyKey: known('M7_ENERGY'), qualifiers: known({}), run: known({ id: origin.id, revision: 1 }) },
      limitations: ['Synthetic SCF failure; spin unknown; no rerun authorization.'],
      support: Object.fromEntries(['property', 'value', 'unit', 'definition'].map(key => [`result.${key}`, structuredClone(sources)])) } };
  const result = await write(entry);
  await save.execute('state', { target: 'state', expectedRevision: 0, state: { goal: 'Continue M7_ENERGY inspection',
    entities: [origin.id, result.id], blockers: ['SCF failed; spin unknown; do not rerun.'] } }, undefined, undefined, h.ctx);
  const find = async () => (await search.execute('search', { query: 'M7_ENERGY' }, undefined, undefined, h.ctx)).details.hits.find(hit => hit.id === result.id);
  assert.equal((await find()).result.value, 0);
  await h.before(); h.changeSession(); await h.events.get('session_start')({ reason: 'new' }, h.ctx);
  const continued = await h.events.get('before_agent_start')({ messageType: 'user', prompt: '继续 M7_ENERGY' }, h.ctx);
  assert(continued.message.content.length <= 12000);
  assert.match(continued.message.content, /Folder brief/);
  assert.match(continued.message.content, /not-converged/);
  assert.match(continued.message.content, /eV/);
  assert.match(continued.message.content, /spin unknown/);
  const records = path.join(h.project.memory, '.internal/records'), originals = snapshot(records);
  const correction = { ...entry, content: 'Explicit correction: synthetic transcription was wrong; still failed SCF.', result: { ...entry.result, value: -1 } };
  const revised = await save.execute('correct', { target: 'knowledge', id: result.id, expectedRevision: 1, entry: correction }, undefined, undefined, h.ctx);
  assert.equal(revised.details.record.revision, 2);
  const hit = await find();
  assert.equal(hit.result.value, -1); assert.equal(hit.result.unit, 'eV');
  assert.equal(hit.sourceRun.revision, 1); assert.equal(hit.sourceRun.run.convergence, 'not-converged');
  assert.deepEqual(revised.details.record.entry.card.fields.run, entry.card.fields.run);
  for (const [name, bytes] of originals) assert.equal(fs.readFileSync(path.join(records, name)).toString('base64'), bytes);
  await h.commands.get('memory').handler(`get ${result.id}`, h.ctx);
  assert.match(h.sent.at(-1).content, /Explicit correction/);
});

integration('M5 tool scope parameters, session cwd, single brief and scoped handoff', async t => {
  const h = await harness(t);
  fs.mkdirSync(path.join(h.root, 'a'));
  h.ctx.cwd = path.join(h.root, 'a');
  const save = h.tools.get('project_memory_save');
  const saved = await save.execute('s', { target: 'knowledge', entry: { kind: 'methods', title: 'SCOPEDMETHOD', content: 'SCOPEDMETHOD' }, inherit: false }, undefined, undefined, h.ctx);
  assert.deepEqual(saved.details.record.entry.scope, { path: 'a', inherit: false });
  const first = await h.before(), second = await h.before();
  assert.match(first.message.content, /Folder: a/);
  assert.doesNotMatch(second?.message.content ?? '', /Folder: a/);
  h.changeSession(); await h.events.get('session_start')({}, h.ctx);
  assert.match((await h.before()).message.content, /Folder: a/);
  const search = h.tools.get('project_memory_search');
  const rootCtx = { ...h.ctx, cwd: h.root };
  assert.equal((await search.execute('q', { query: 'SCOPEDMETHOD' }, undefined, undefined, rootCtx)).details.hits.length, 0);
  assert.equal((await search.execute('q', { query: 'SCOPEDMETHOD', folder: 'a' }, undefined, undefined, rootCtx)).details.hits.length, 1);
  await h.events.get('session_before_compact')({ signal: new AbortController().signal, preparation: {
    messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'test',
  } }, h.ctx);
  const work = readWorkingV2(resolveV2(h.ctx.cwd));
  assert.equal(work.events.at(-1).payload.scope.path, 'a');
  assert.equal(readWorkingV2(h.project).events.length, 0);
});

integration('v2 host entry records local observations and restores context across a new session without a curator', async t => {
  const h = await harness(t); await h.run();
  assert.equal(readWorkingV2(h.project).events.length, 1);
  h.changeSession(); await h.events.get('session_start')({}, h.ctx);
  const context = await h.events.get('before_agent_start')({ messageType: 'user', prompt: '继续' }, h.ctx);
  assert.match(context.message.content, /SCF NOT CONVERGED/);
  assert.match(context.message.content, /calc\/test\/run.out/);
  assert.match(context.message.content, /Assistant claims/);
  assert.equal(context.message.display, false);
});
integration('v2 preserves later low-level agent endings in the same user scope and deduplicates retries', async t => {
  const h = await harness(t);
  await h.before(); await h.events.get('agent_end')({ messages }, h.ctx);
  await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, 1);
  const later = [...messages.slice(0, 2), { role: 'toolResult', toolName: 'read', content: 'Later complete parser diagnostic observation.' }, messages[2]];
  await h.events.get('agent_end')({ messages: later }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, 2);
  assert.match(readWorkingV2(h.project).state, /Later complete parser diagnostic/);
});
integration('v2 local observation recording survives main-model error, cancellation and truncation without success claims', async t => {
  const h = await harness(t);
  for (const stopReason of ['error', 'aborted', 'length']) await h.run([...messages.slice(0, 2), { ...messages[2], stopReason }]);
  const state = readWorkingV2(h.project);
  assert.equal(state.events.length, 3);
  for (const event of state.events) assert.deepEqual(event.payload.claims, []);
  assert.match(state.state, /SCF NOT CONVERGED/);
});
integration('v2 session learning override and project off prevent journal and handoff writes, not explicit saves', async t => {
  const h = await harness(t);
  await h.commands.get('memory').handler('learn off', h.ctx); await h.run();
  await h.events.get('session_before_compact')({ signal: new AbortController().signal, preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'boundary' } }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, 0);
  await h.tools.get('project_memory_save').execute('save', { target: 'overview', expectedRevision: 0, content: 'Explicit test overview.' }, undefined, undefined, h.ctx);
  assert.equal(readWorkingV2(h.project).revisions.overview, 1);
  await h.events.get('session_start')({}, h.ctx); await h.run();
  assert.equal(readWorkingV2(h.project).events.filter(event => event.payload.kind === 'turn').length, 1);
  const file = path.join(h.root, '.pi/project-memory.json'), config = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...config, learningMode: 'off', handoffEnabled: false }));
  await h.run();
  assert.equal(readWorkingV2(h.project).events.length, 2);
});
integration('v2 custom-triggered runs never retrieve or relearn the last user turn', async t => {
  const h = await harness(t); await h.run();
  const count = readWorkingV2(h.project).events.length;
  assert.equal(await h.events.get('before_agent_start')({ messageType: 'custom', message: { content: 'continue custom' } }, h.ctx), undefined);
  await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, count);
});
integration('v2 scope/session changes revoke captured observations before any write', async t => {
  const h = await harness(t);
  await h.before(); await h.events.get('session_before_switch')({}, h.ctx); await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, 0);
  await h.before(); h.changeSession(); await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, 0);
  await h.before(); fs.unlinkSync(path.join(h.root, '.pi-root')); await h.events.get('agent_end')({ messages }, h.ctx);
  assert.equal(fs.existsSync(path.join(h.project.memory, 'state.md')), false);
});
integration('v2 cancellation signal preserves complete tool evidence but drops assistant claims', async t => {
  const h = await harness(t), controller = new AbortController(); h.ctx.signal = controller.signal;
  await h.before(); controller.abort(); await h.events.get('agent_end')({ messages }, h.ctx);
  const event = readWorkingV2(h.project).events[0];
  assert.equal(event.payload.outcome, 'interrupted'); assert.deepEqual(event.payload.claims, []);
  assert.equal(event.payload.observations.length, 1);
});
integration('v2 compaction uses only canonical projected spans, deduplicates and leaves native compaction untouched', async t => {
  const h = await harness(t); await h.run();
  const event = { signal: new AbortController().signal, preparation: { messagesToSummarize: messages, turnPrefixMessages: [], firstKeptEntryId: 'kept', previousSummary: 'Previous projected summary.' },
    branchEntries: [{ message: { role: 'assistant', content: 'OMITTED_BRANCH_MUST_NOT_RETURN' } }] };
  assert.equal(await h.events.get('session_before_compact')(event, h.ctx), undefined);
  await h.events.get('session_before_compact')(event, h.ctx);
  const work = readWorkingV2(h.project);
  assert.equal(work.events.filter(item => item.payload.kind === 'handoff').length, 1);
  assert.doesNotMatch(JSON.stringify(work.events), /OMITTED_BRANCH/);
  const cancelled = new AbortController(); cancelled.abort();
  await h.events.get('session_before_compact')({ ...event, signal: cancelled.signal, preparation: { ...event.preparation, firstKeptEntryId: 'other' } }, h.ctx);
  assert.equal(readWorkingV2(h.project).events.length, 2);
});
integration('v2 tools expose explicit state revision, knowledge save/search and no scientific-status inference', async t => {
  const h = await harness(t), save = h.tools.get('project_memory_save'), search = h.tools.get('project_memory_search');
  const overview = await save.execute('overview', { target: 'overview', content: 'SCF parser project.', expectedRevision: 0 }, undefined, undefined, h.ctx);
  assert.equal(overview.details.event.payload.kind, 'overview');
  await save.execute('state', { target: 'state', expectedRevision: 0, state: { goal: 'SCF parser implementation', blockers: ['needs fixtures'] } }, undefined, undefined, h.ctx);
  const saved = await save.execute('knowledge', { target: 'knowledge', entry: { kind: 'runs', title: 'SCF fixture', content: 'Synthetic normal termination only.', run: { termination: 'normal' } } }, undefined, undefined, h.ctx);
  const response = await search.execute('search', { query: 'SCF' }, undefined, undefined, h.ctx);
  assert.equal(response.details.working.revisions.state, 1);
  assert.equal(response.details.hits[0].run.convergence, 'unknown');
  assert.equal(response.details.hits[0].requiresVerification, true);
  await assert.rejects(save.execute('bad', { target: 'knowledge', expectedRevision: 0, entry: { kind: 'software', title: 'Bad', content: 'Bad request' } }, undefined, undefined, h.ctx));
  await h.commands.get('memory').handler(`get ${saved.details.record.id}`, h.ctx);
  assert.match(h.sent.at(-1).content, /normal/);
});
integration('v2 manual view conflicts are reported safely and do not block the main lifecycle', async t => {
  const h = await harness(t); await h.run();
  fs.appendFileSync(path.join(h.project.memory, 'state.md'), '\nPRIVATE_MANUAL_EDIT\n');
  await h.run();
  assert.match(h.sent.at(-1).content, /view-conflict/);
  assert.doesNotMatch(h.sent.at(-1).content, /PRIVATE_MANUAL_EDIT/);
});
integration('v2 commands initialize explicitly and list pending review without silently auto-approving', async t => {
  const h = await harness(t);
  await h.commands.get('memory-init').handler('', h.ctx);
  await h.commands.get('memory').handler('review', h.ctx);
  assert.deepEqual(JSON.parse(h.sent.at(-1).content), { total: 0, truncated: false, candidates: [] });
  await h.commands.get('memory').handler('status', h.ctx);
  assert.equal(JSON.parse(h.sent.at(-1).content).longTermCurator, false);
  assert.equal(statusV2(resolveV2(h.root)).records, 0);
});
