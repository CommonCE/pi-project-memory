import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initializeV2, resolveV2, saveV2, getV2, searchV2, statusV2 } from '../src/v2-store.mjs';
import { buildWorkingContext, readWorkingV2, updateWorkingV2 } from '../src/v2-working.mjs';
import { listCandidatesV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { extractCandidatesV2 } from '../src/v2-extraction.mjs';

const host = process.env.PI_TEST_HOST_PACKAGE;
let factory;
if (host) {
  const require = createRequire(host), { createJiti } = require('jiti');
  factory = await createJiti(import.meta.url, { alias: { typebox: require.resolve('typebox') } }).import(fileURLToPath(new URL('../v2.ts', import.meta.url)), { default: true });
}
const integration = (name, fn) => test(name, { skip: !host, timeout: 8000 }, fn);
const code = expected => error => error.code === expected;
const observed = 'Synthetic SCF did not converge. Proposed retry is NOT an executed or validated result.';
const messages = () => [{ role: 'user', content: 'Investigate the synthetic failed SCF fixture without running a calculation.' },
  { role: 'toolResult', toolName: 'read', isError: true, content: observed },
  { role: 'assistant', stopReason: 'stop', content: 'I propose checking the model; no adopted or tested remedy is claimed.' }];
const selected = extra => ({ kind: 'runs', title: 'SCF did not converge', grounding: [{ id: 'm1', quote: 'SCF did not converge.' }], ...extra });
const plainResponse = extra => ({ text: JSON.stringify({ candidates: [selected(extra)] }), usage: { inputTokens: 10, outputTokens: 5 } });
const modelResponse = extra => ({ stopReason: 'stop', content: [{ type: 'text', text: plainResponse(extra).text }], usage: { input: 10, output: 5 } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-m3-'));
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated M3 fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project: initializeV2(root, { name: 'M3 fixture' }) };
}
function config(root, values) {
  const file = path.join(root, '.pi/project-memory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...values }));
}
async function harness(t, settings = {}) {
  const f = fixture(t); config(f.root, settings);
  const events = new Map(), commands = new Map(), tools = new Map(), sent = [], calls = [];
  factory({ on: (name, handler) => events.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command), sendMessage: message => sent.push(message) });
  let session = randomUUID(), turn = randomUUID(), model = async () => modelResponse();
  const ctx = { cwd: f.root, hasUI: false, model: { provider: 'offline', id: 'offline' },
    sessionManager: { getSessionId: () => session, getBranch: () => messages().map((message, i) => ({ type: 'message', id: i === 0 ? turn : `message-${i}`, message })) },
    modelRegistry: { streamSimple: (_model, context, options) => ({ result: () => { calls.push({ context, options }); return model(context, options); } }) } };
  const begin = async () => { turn = randomUUID(); await events.get('before_agent_start')({ messageType: 'user', prompt: messages()[0].content }, ctx); };
  const end = async (value = messages()) => events.get('agent_end')({ messages: value }, ctx);
  const settle = async () => events.get('agent_before_settle')({}, ctx);
  const run = async (value = messages()) => { await begin(); await end(value); await settle(); };
  await events.get('session_start')({}, ctx);
  return { ...f, events, commands, tools, sent, calls, ctx, begin, end, settle, run, setModel: fn => { model = fn; },
    nextSession: async () => { session = randomUUID(); await events.get('session_start')({}, ctx); },
    command: async value => commands.get('memory').handler(value, ctx) };
}

test('M3 configuration validates modes and bounded extraction overrides without changing identity', t => {
  const { root, project } = fixture(t);
  config(root, { longTermMode: 'auto', extraction: { maxChars: 3000, toolChars: 100, outputTokens: 100, timeoutMs: 100, maxCandidates: 1 } });
  assert.equal(resolveV2(root).id, project.id); assert.equal(statusV2(resolveV2(root)).longTermMode, 'auto');
  for (const invalid of [{ longTermMode: 'on' }, { longTermMode: null }, { longTermMode: 'review', extraction: null },
    { extraction: { maxChars: 48001 } }, { extraction: { toolChars: 79 } }, { extraction: { maxCandidates: 9 } },
    { extraction: { outputTokens: 0 } }, { extraction: { timeoutMs: 60001 } }, { extraction: { unknown: 1 } }]) {
    config(root, { longTermMode: 'review', extraction: {}, ...invalid });
    assert.throws(() => resolveV2(root), code('invalid-schema'));
  }
});

test('M3 entity-aware BM25 ranks exact entities and bounds automatic recall to the active method', t => {
  const { project } = fixture(t);
  const method = label => saveV2(project, { kind: 'methods', title: 'Same method title', content: `${label} model settings.` }).record;
  const a = method('A'), b = method('B');
  const run = (id, content) => saveV2(project, { kind: 'runs', title: 'Same run title', content, entities: [{ type: 'method', id }] }).record;
  const active = run(a.id, 'Active scope calibration observation, still unverified.');
  const other = run(b.id, 'Foreign scope calibration calibration calibration observation.');
  const search = searchV2(project, 'calibration', { entityIds: [a.id], kind: 'runs' });
  assert.equal(search.hits[0].id, active.id); assert.equal(search.hits[0].entityMatches, 1);
  assert.equal(search.hits.find(hit => hit.id === other.id).entityMatches, 0);
  updateWorkingV2(project, 'state', 0, { goal: 'Continue calibration', entities: [a.id] });
  const context = buildWorkingContext(project, '继续');
  assert.match(context.content, /Active scope calibration/); assert.doesNotMatch(context.content, /Foreign scope/);
  assert.ok(context.chars <= 12000);
});

test('M3 source dedup keeps complementary content and does not merge different entities', t => {
  const { project } = fixture(t);
  const entry = extra => ({ kind: 'software', title: 'Shared excerpt', content: 'Common parser observation.', sourceTurn: 'turn:fixture', evidence: ['turn:fixture:m1'], ...extra });
  saveV2(project, entry()); saveV2(project, entry({ title: 'Another selected heading' }));
  saveV2(project, entry({ content: 'Common parser observation with complementary compatibility limits.' }));
  assert.equal(searchV2(project, 'Common').hits.length, 3);
  const search = searchV2(project, 'Common', { deduplicateSources: true });
  assert.equal(search.hits.length, 2); assert.equal(search.deduplicated, 1);
  assert.ok(search.hits.every(hit => hit.requiresVerification));
});

test('M3 dedup compares complete source content, not only identical truncated excerpts', t => {
  const { project } = fixture(t), prefix = 'Common shared introduction. '.repeat(100);
  for (const suffix of ['Distinct limit A.', 'Distinct limit B.']) saveV2(project, { kind: 'software', title: 'Same title',
    content: prefix + suffix, sourceTurn: 'turn:fixture', evidence: ['turn:fixture:m1'] });
  const search = searchV2(project, 'Common', { deduplicateSources: true });
  assert.equal(search.hits.length, 2); assert.equal(search.deduplicated, 0);
});

test('M3 auto publishes without upgrading verification or independent run states and records auto review', async t => {
  const { project } = fixture(t);
  const options = { session: 'session', turn: 'turn', isCurrent: () => true, mode: 'auto', model: async () => plainResponse() };
  const result = await extractCandidatesV2(project, messages(), options);
  assert.equal(result.status, 'published'); assert.equal(result.counts.published, 1);
  const [candidate] = listCandidatesV2(project).candidates;
  assert.equal(candidate.status, 'approved'); assert.equal(candidate.reviewer, 'auto');
  const saved = getV2(project, candidate.id);
  assert.equal(saved.entry.verification, 'reported'); assert.equal(saved.entry.provenance, 'model-extraction');
  assert.deepEqual(saved.entry.run, { execution: 'unknown', termination: 'unknown', convergence: 'unknown', validity: 'unchecked' });
  const retry = await extractCandidatesV2(project, messages(), options);
  assert.equal(retry.counts.published, 0); assert.equal(statusV2(project).records, 1);
});

test('M3 policy and budget changes inside a response revoke a direct extraction API call', async t => {
  for (const changed of [{ longTermMode: 'auto' }, { extraction: { maxCandidates: 1 } }]) {
    const { root, project } = fixture(t);
    const result = await extractCandidatesV2(project, messages(), { session: 'session', turn: 'turn', isCurrent: () => true,
      model: async () => { config(root, changed); return plainResponse(); } });
    assert.equal(result.reasons['scope-changed'], 1); assert.equal(listCandidatesV2(project).candidates.length, 0);
  }
});

test('M3 auto respects a prior explicit rejection instead of overriding it', async t => {
  const { project } = fixture(t), options = { session: 'session', turn: 'turn', isCurrent: () => true, model: async () => plainResponse() };
  await extractCandidatesV2(project, messages(), options);
  const candidate = listCandidatesV2(project).candidates[0]; reviewCandidateV2(project, candidate.candidate.requestId, 'reject');
  const result = await extractCandidatesV2(project, messages(), { ...options, mode: 'auto' });
  assert.equal(result.reasons['review-rejected'], 1); assert.equal(statusV2(project).records, 0);
  assert.equal(listCandidatesV2(project).candidates[0].reviewer, 'user');
});

test('M3 off inside the auto review lock prevents publication before and after approval intent', async t => {
  for (const afterIntent of [false, true]) {
    const { root, project } = fixture(t), directory = path.join(project.memory, '.internal/candidates');
    const result = await extractCandidatesV2(project, messages(), { session: 'session', turn: 'turn', mode: 'auto',
      model: async () => plainResponse(), isCurrent: () => {
        if (fs.existsSync(path.join(project.memory, '.internal/write.lock')) && fs.existsSync(directory)) {
          const names = fs.readdirSync(directory), hasDecision = names.some(name => name.endsWith('.decision.json'));
          if (afterIntent ? hasDecision : names.some(name => name.endsWith('.candidate.json'))) config(root, { longTermMode: 'off' });
        }
        return true;
      } });
    assert.equal(result.status, 'partial'); assert.equal(result.counts.published, 0);
    assert.equal(statusV2(project).records, 0);
    const [candidate] = listCandidatesV2(project).candidates;
    assert.equal(candidate.status, afterIntent ? 'approved' : 'pending');
    if (afterIntent) assert.equal(candidate.publication, 'pending');
  }
});

test('M3 final record/projection publication rechecks off after inventory and approval intent', async t => {
  for (const stopAt of [2, 3]) {
    const { root, project } = fixture(t), directory = path.join(project.memory, '.internal/candidates'); let checksAfterIntent = 0;
    const result = await extractCandidatesV2(project, messages(), { session: 'session', turn: 'turn', mode: 'auto',
      model: async () => plainResponse(), isCurrent: () => {
        if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.endsWith('.decision.json'))) {
          if (++checksAfterIntent === stopAt) config(root, { longTermMode: 'off' });
        }
        return true;
      } });
    assert.equal(result.reasons.disabled, 1);
    if (stopAt === 2) {
      assert.equal(statusV2(project).records, 0); assert.equal(result.status, 'partial');
    } else {
      // Canonical publication preceded off; the derived view must remain missing.
      assert.equal(statusV2(project).records, 1); assert.equal(result.counts.published, 1);
      assert.equal(result.reasons['projection-pending'], 1);
      const [candidate] = listCandidatesV2(project).candidates;
      assert.equal(fs.existsSync(path.join(project.memory, 'knowledge/runs', `${candidate.id}.md`)), false);
    }
  }
});

test('M3 auto recovery retains an approval intent but never overwrites manual knowledge edits', async t => {
  const { project } = fixture(t), saved = saveV2(project, { kind: 'runs', title: 'Run fixture', content: 'Original claim.' });
  const view = path.join(project.memory, saved.path), original = fs.readFileSync(view);
  fs.writeFileSync(view, 'MANUAL_EDIT');
  const options = { session: 'session', turn: 'turn', isCurrent: () => true, mode: 'auto', entityIds: [saved.record.id],
    model: async () => plainResponse({ target: { id: saved.record.id, expectedRevision: 1 } }) };
  const result = await extractCandidatesV2(project, messages(), options);
  assert.equal(result.status, 'partial'); assert.equal(result.reasons['view-conflict'], 1);
  assert.equal(listCandidatesV2(project).candidates[0].publication, 'pending');
  assert.equal(fs.readFileSync(view, 'utf8'), 'MANUAL_EDIT');
  fs.writeFileSync(view, original);
  const retry = await extractCandidatesV2(project, messages(), options);
  assert.equal(retry.counts.published, 1); assert.equal(getV2(project, saved.record.id).revision, 2);
});

integration('M3 host defaults to one review extraction at settlement, not each low-level ending', async t => {
  const h = await harness(t); await h.begin();
  await h.end(); await h.end(); assert.equal(h.calls.length, 0);
  await h.settle(); await h.end(); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(listCandidatesV2(h.project).candidates[0].status, 'pending');
  assert.equal(statusV2(h.project).records, 0);
  await h.command('status'); const status = JSON.parse(h.sent.at(-1).content);
  assert.equal(status.longTermCurator, true); assert.equal(status.effectiveLongTermMode, 'review');
  assert.equal(status.candidates.pending, 1); assert.equal(status.diagnostics.counts.modelCalls, 1);
  assert.deepEqual(status.diagnostics.usage, { inputTokens: 10, outputTokens: 5 });
  assert.doesNotMatch(JSON.stringify(status.diagnostics), /Synthetic|Proposed|fixture|systemPrompt/);
});

integration('M3 host manual review shows bounded content and approval is not user confirmation', async t => {
  const h = await harness(t); await h.run();
  await h.command('review'); const summary = JSON.parse(h.sent.at(-1).content);
  assert.equal(summary.total, 1); const id = summary.candidates[0].id;
  await h.command(`review ${id}`); assert.match(JSON.parse(h.sent.at(-1).content).candidate.entry.content, /NOT an executed/);
  await h.command(`review ${id} approve`);
  const result = JSON.parse(h.sent.at(-1).content); assert.equal(result.status, 'approved');
  assert.equal(result.publication.revision, 1);
  const candidate = listCandidatesV2(h.project).candidates[0]; assert.equal(candidate.reviewer, 'user');
  assert.equal(getV2(h.project, candidate.id).entry.verification, 'reported');
  await h.command('review'); assert.equal(JSON.parse(h.sent.at(-1).content).total, 0);
});

integration('M3 host auto is explicit and preserves unresolved scientific meaning', async t => {
  const h = await harness(t, { longTermMode: 'auto' }); await h.run();
  assert.equal(statusV2(h.project).records, 1);
  assert.equal(listCandidatesV2(h.project).candidates[0].reviewer, 'auto');
  const hits = searchV2(h.project, 'SCF').hits;
  assert.equal(hits[0].requiresVerification, true); assert.equal(hits[0].run.validity, 'unchecked');
});

integration('M3 session curation off preserves journal; reset restores project review default', async t => {
  const h = await harness(t); await h.command('curate off'); await h.run();
  assert.equal(h.calls.length, 0); assert.equal(readWorkingV2(h.project).events.length, 1);
  await h.nextSession(); await h.run(); assert.equal(h.calls.length, 1);
  assert.equal(listCandidatesV2(h.project).candidates[0].status, 'pending');
});

integration('M3 project off is a hard curator boundary but explicit storage remains available', async t => {
  const h = await harness(t, { longTermMode: 'off' }); await h.run();
  assert.equal(h.calls.length, 0); assert.equal(readWorkingV2(h.project).events.length, 1);
  await h.command('curate auto'); assert.match(h.sent.at(-1).content, /disabled/);
  assert.equal(h.calls.length, 0);
});

integration('M3 host honors smaller budgets and provides only explicit task entities as background', async t => {
  const h = await harness(t, { extraction: { maxChars: 4000, outputTokens: 123, timeoutMs: 100, maxCandidates: 1 } });
  const method = saveV2(h.project, { kind: 'methods', title: 'Method fixture', content: 'Method choice, not new evidence.' }).record;
  updateWorkingV2(h.project, 'state', 0, { goal: 'Investigate failed fixture', entities: [method.id] });
  h.setModel(async (context, options) => {
    assert.equal(options.maxTokens, 123);
    const envelope = JSON.parse(context.messages[0].content[0].text);
    assert.equal(envelope.maximumCandidates, 1); assert.deepEqual(envelope.entities.map(entity => entity.id), [method.id]);
    assert.ok(context.systemPrompt.length + context.messages[0].content[0].text.length <= 4000);
    return modelResponse();
  });
  await h.run(); assert.equal(h.calls.length, 1);
});

integration('M3 a final incomplete ending replaces a previous successful ending before settlement', async t => {
  const h = await harness(t); await h.begin(); await h.end();
  await h.end([{ role: 'assistant', stopReason: 'error', content: '' }]); await h.settle();
  assert.equal(h.calls.length, 0); assert.equal(listCandidatesV2(h.project).candidates.length, 0);
});

integration('M3 main failure/cancellation/truncation retains work observations without calling a curator', async t => {
  const h = await harness(t);
  for (const stopReason of ['error', 'aborted', 'length']) await h.run([...messages().slice(0, 2), { ...messages()[2], stopReason }]);
  assert.equal(h.calls.length, 0); assert.equal(readWorkingV2(h.project).events.length, 3);
  assert.equal(listCandidatesV2(h.project).candidates.length, 0);
});

integration('M3 invalid response and provider error do not break main lifecycle or expose raw errors', async t => {
  const h = await harness(t);
  h.setModel(async () => { throw new Error('password = doNotExpose'); }); await h.run();
  h.setModel(async () => ({ stopReason: 'length', content: [{ type: 'text', text: plainResponse().text }], usage: { input: 10, output: 5 } })); await h.run();
  assert.equal(readWorkingV2(h.project).events.length, 2); assert.equal(listCandidatesV2(h.project).candidates.length, 0);
  await h.command('status'); const status = JSON.parse(h.sent.at(-1).content);
  assert.equal(status.diagnostics.reasons['model-error'], 2); assert.doesNotMatch(JSON.stringify(status), /doNotExpose|password/);
  assert.deepEqual(status.diagnostics.usage, { inputTokens: 10, outputTokens: 5 });
});

integration('M3 host timeout cancels nested model work and leaves main work intact', async t => {
  const h = await harness(t, { extraction: { timeoutMs: 10 } }); let modelSignal;
  h.setModel((_context, { signal }) => new Promise((resolve, reject) => {
    modelSignal = signal; signal.addEventListener('abort', () => reject(new Error('aborted fixture')), { once: true });
  }));
  await h.run(); assert.equal(modelSignal.aborted, true);
  assert.equal(readWorkingV2(h.project).events.length, 1); assert.equal(listCandidatesV2(h.project).candidates.length, 0);
  await h.command('status'); assert.equal(JSON.parse(h.sent.at(-1).content).diagnostics.reasons['model-timeout'], 1);
});

integration('M3 off during nested work aborts it and cannot publish a late candidate', async t => {
  const h = await harness(t); let started, finish, modelSignal;
  const ready = new Promise(resolve => { started = resolve; });
  h.setModel((_context, { signal }) => { modelSignal = signal; started(); return new Promise(resolve => { finish = resolve; }); });
  await h.begin(); await h.end(); const settling = h.settle(); await ready;
  await h.command('learn off'); await settling;
  assert.equal(modelSignal.aborted, true); finish(modelResponse()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCandidatesV2(h.project).candidates.length, 0);
  await h.command('status');
  const diagnostics = JSON.parse(h.sent.at(-1).content).diagnostics;
  assert.equal(diagnostics.counts.modelCalls, 1); assert.equal(diagnostics.reasons.cancelled, 1);
  assert.equal(Object.hasOwn(diagnostics.usage, 'outputTokens'), false);
});

integration('M3 session switch/fork/shutdown revoke in-flight extraction before any storage write', async t => {
  for (const event of ['session_before_switch', 'session_before_fork', 'session_shutdown']) {
    const h = await harness(t); let started, finish, modelSignal;
    const ready = new Promise(resolve => { started = resolve; });
    h.setModel((_context, { signal }) => { modelSignal = signal; started(); return new Promise(resolve => { finish = resolve; }); });
    await h.begin(); await h.end(); const settling = h.settle(); await ready;
    await h.events.get(event)({}, h.ctx); await settling;
    assert.equal(modelSignal.aborted, true); finish(modelResponse()); await new Promise(resolve => setImmediate(resolve));
    assert.equal(listCandidatesV2(h.project).candidates.length, 0);
  }
});

integration('M3 a new user/custom run cancels the prior scope and custom runs never learn', async t => {
  const h = await harness(t); let started, finish, modelSignal;
  const ready = new Promise(resolve => { started = resolve; });
  h.setModel((_context, { signal }) => { modelSignal = signal; started(); return new Promise(resolve => { finish = resolve; }); });
  await h.begin(); await h.end(); const settling = h.settle(); await ready;
  await h.events.get('before_agent_start')({ messageType: 'custom' }, h.ctx); await settling;
  assert.equal(modelSignal.aborted, true); finish(modelResponse()); await h.end(); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(listCandidatesV2(h.project).candidates.length, 0);
});

integration('M3 mode change or marker revocation inside a response cannot publish across the old scope', async t => {
  const h = await harness(t, { longTermMode: 'auto' });
  h.setModel(async () => { config(h.root, { longTermMode: 'review' }); return modelResponse(); });
  await h.run(); assert.equal(listCandidatesV2(h.project).candidates.length, 0);
  h.setModel(async () => { fs.unlinkSync(path.join(h.root, '.pi-root')); return modelResponse(); });
  await h.run(); assert.equal(fs.existsSync(path.join(h.root, '.pi-root')), false);
  assert.equal(fs.existsSync(path.join(h.project.memory, '.internal/candidates')), false);
});

integration('M3 explicit extraction uses the branch and does not add a main agent turn', async t => {
  const h = await harness(t); await h.command('extract');
  assert.equal(h.calls.length, 1); assert.equal(listCandidatesV2(h.project).candidates.length, 1);
  assert.equal(readWorkingV2(h.project).events.length, 0);
  assert.equal(JSON.parse(h.sent.at(-1).content).status, 'queued');
});
