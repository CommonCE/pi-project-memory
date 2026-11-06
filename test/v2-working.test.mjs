import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeV2, resolveV2, saveV2, statusV2 } from '../src/v2-store.mjs';
import { appendWorkV2, buildWorkingContext, collectWorkTurn, readWorkingV2, rebuildWorkingV2, updateWorkingV2 } from '../src/v2-working.mjs';

const code = expected => error => error.code === expected;
const goal = '检查体系 A 的 SCF 故障，保留运行目录 calc/a，不要把计划当成结果。';
const messages = [
  { role: 'user', content: goal },
  { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'calc/a/run.out: SCF NOT CONVERGED; synthetic fixture only.' }], isError: true },
  { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '建议检查体系和初猜。以下是待验证的助手判断，不代表修复已经成功，也不代表得到有效能量。'.repeat(3) }] },
];
function work(turn = 'turn-1', options = {}) { return collectWorkTurn(messages, { session: 'session-a', turn, ...options }); }
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-working-'));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, root, project: initializeV2(root) };
}

test('working memory preserves failure evidence and keeps assistant advice unverified', t => {
  const h = fixture(t), payload = work(), saved = appendWorkV2(h.project, payload);
  assert.equal(saved.projection, 'current');
  const state = readWorkingV2(h.project);
  assert.match(state.state, /SCF NOT CONVERGED/);
  assert.match(state.state, /Assistant claims \/ unverified/);
  assert.match(state.state, /待验证/);
  assert.equal(statusV2(h.project).records, 0);
  assert.equal(fs.existsSync(path.join(h.project.memory, 'state.md')), true);
  assert.equal(fs.readdirSync(path.join(h.project.memory, 'journal')).length, 1);
});
test('working memory restores overview and task state for an uninformative new-session prompt', t => {
  const h = fixture(t);
  updateWorkingV2(h.project, 'overview', 0, { content: '体系 A；PBE 设置仅为夹具描述。软件代码入口 src/parser.mjs。' });
  updateWorkingV2(h.project, 'state', 0, { goal, blockers: ['SCF 未收敛'], nextSteps: ['先核对输入和初猜，不自动提交计算'], artifacts: ['calc/a/run.out'],
    provenance: 'user-confirmation', evidence: ['用户明确要求：先核对输入和初猜，不自动提交计算'] });
  appendWorkV2(h.project, work());
  const context = buildWorkingContext(resolveV2(h.root), '继续');
  assert.match(context.content, /体系 A/);
  assert.match(context.content, /src\/parser.mjs/);
  assert.match(context.content, /SCF 未收敛/);
  assert.match(context.content, /calc\/a\/run.out/);
  assert.match(context.content, /不自动提交计算/);
  assert.ok(context.chars <= 12000);
  assert.equal(context.chars, context.content.length);
});
test('working memory never promotes aborted, failed or truncated assistant claims', t => {
  const h = fixture(t);
  for (const stopReason of ['error', 'aborted', 'length']) {
    const value = collectWorkTurn([...messages.slice(0, 2), { ...messages[2], stopReason, content: [{ type: 'text', text: 'UNSUPPORTED_SUCCESS_CLAIM'.repeat(20) }] }], { session: 'test', turn: stopReason });
    assert.deepEqual(value.claims, []);
    appendWorkV2(h.project, value);
  }
  const cancelled = collectWorkTurn(messages, { session: 'test', turn: 'cancelled-signal', cancelled: true });
  assert.equal(cancelled.outcome, 'interrupted'); assert.deepEqual(cancelled.claims, []);
  assert.doesNotMatch(readWorkingV2(h.project).state, /UNSUPPORTED_SUCCESS_CLAIM/);
});
test('working collector excludes prior turns, thinking, images, tool args, memory echoes and secrets before truncation', () => {
  const value = collectWorkTurn([
    { role: 'user', content: 'OLD_PROJECT_SECRET_FREE_BUT_UNRELATED' },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'OLD_ANSWER'.repeat(30) }] },
    ...messages.slice(0, 1),
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'image', data: 'PRIVATE_IMAGE' }, { type: 'toolCall', name: 'bash', arguments: { command: 'PRIVATE_ARGUMENT' } }] },
    { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'safe prefix'.repeat(1000) + ' password = unsafeValue ' + 'safe suffix'.repeat(1000) }] },
    { role: 'toolResult', toolName: 'project_memory_search', content: 'MEMORY_ECHO' },
    { role: 'custom', customType: 'project-memory-context', content: 'INJECTED_CONTEXT' },
    messages[1], messages[2],
  ], { session: 'session', turn: 'turn' });
  assert.doesNotMatch(JSON.stringify(value), /OLD_PROJECT|OLD_ANSWER|PRIVATE_|unsafeValue|MEMORY_ECHO|INJECTED_CONTEXT|safe prefix/);
  assert.equal(value.observations.length, 1);
});
test('chatter yields no work; a continuation does not erase the last substantive goal', t => {
  assert.equal(collectWorkTurn([{ role: 'user', content: '你好' }, { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '你好' }] }], { session: 's', turn: 't' }), null);
  const h = fixture(t); appendWorkV2(h.project, work());
  const continuation = collectWorkTurn([{ role: 'user', content: '继续' }, ...messages.slice(1)], { session: 's', turn: 'next' });
  assert.equal(continuation.goal, undefined); appendWorkV2(h.project, continuation);
  assert.match(buildWorkingContext(h.project, '继续').content, /检查体系 A 的 SCF 故障/);
});
test('working updates require explicit revisions and user-attributed next-step evidence', t => {
  const h = fixture(t), requestId = randomUUID(), value = { goal: 'Develop parser' };
  const saved = updateWorkingV2(h.project, 'state', 0, value, { requestId });
  assert.equal(updateWorkingV2(h.project, 'state', 0, value, { requestId }).duplicate, true);
  assert.throws(() => updateWorkingV2(h.project, 'state', 0, value), code('revision-conflict'));
  assert.throws(() => updateWorkingV2(h.project, 'state', 1, { ...value, nextSteps: ['submit job'] }), code('invalid-schema'));
  assert.throws(() => updateWorkingV2(h.project, 'state', 1, { ...value, entities: [randomUUID()] }), code('invalid-reference'));
  assert.throws(() => updateWorkingV2(h.project, 'state', 1, { ...value, blockers: null }), code('invalid-schema'));
  assert.equal(readWorkingV2(h.project).events.length, 1);
  updateWorkingV2(h.project, 'state', 1, { goal: 'Next parser milestone' });
  updateWorkingV2(h.project, 'state', 0, value, { requestId });
  assert.match(readWorkingV2(h.project).state, /Next parser milestone/);
  assert.equal(saved.event.sequence, 1);
});
test('work events are idempotent and modified overview/state/journal views are preserved', t => {
  const h = fixture(t), payload = work(), saved = appendWorkV2(h.project, payload);
  assert.equal(appendWorkV2(h.project, payload).duplicate, true);
  const stateFile = path.join(h.project.memory, 'state.md'), old = fs.readFileSync(stateFile);
  appendWorkV2(h.project, work('next'));
  fs.writeFileSync(stateFile, old); rebuildWorkingV2(h.project);
  assert.match(fs.readFileSync(stateFile, 'utf8'), /turn next/);
  fs.appendFileSync(stateFile, '\nMANUAL_EDIT\n');
  assert.throws(() => appendWorkV2(h.project, work('third')), code('view-conflict'));
  assert.throws(() => rebuildWorkingV2(h.project), code('view-conflict'));
  assert.match(fs.readFileSync(stateFile, 'utf8'), /MANUAL_EDIT/);
  fs.unlinkSync(stateFile); rebuildWorkingV2(h.project);
  const journal = path.join(h.project.memory, `journal/${saved.event.id}.md`);
  fs.appendFileSync(journal, '\nMANUAL_JOURNAL_EDIT\n');
  const pending = appendWorkV2(h.project, work('third'));
  assert.equal(pending.projection, 'pending');
  assert.match(fs.readFileSync(journal, 'utf8'), /MANUAL_JOURNAL_EDIT/);
});
test('handoff archives only projected messages, does not replace task goal, and deduplicates', t => {
  const h = fixture(t); appendWorkV2(h.project, work());
  const payload = collectWorkTurn([{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'PROJECTED_ONLY'.repeat(20) }] }], { kind: 'handoff', session: 's', turn: 'compact:entry', previousSummary: 'Previous summary only; not verified.' });
  appendWorkV2(h.project, payload); assert.equal(appendWorkV2(h.project, payload).duplicate, true);
  const context = buildWorkingContext(h.project, '继续');
  assert.match(context.content, /PROJECTED_ONLY/);
  assert.match(context.content, /检查体系 A 的 SCF 故障/);
  assert.equal(readWorkingV2(h.project).events.length, 2);
});
test('split-turn handoff can preserve only the projected user goal without inventing an assistant response', t => {
  const h = fixture(t);
  const payload = collectWorkTurn([messages[0]], { kind: 'handoff', session: 's', turn: 'split' });
  assert.equal(payload.goal, messages[0].content);
  assert.deepEqual(payload.claims, []); assert.deepEqual(payload.observations, []);
  appendWorkV2(h.project, payload);
  assert.match(readWorkingV2(h.project).state, /handoff/);
  assert.equal(readWorkingV2(h.project).events[0].payload.goal, goal);
});
test('work context budget is hard-bounded and includes related structured knowledge', t => {
  const h = fixture(t);
  saveV2(h.project, { kind: 'software', title: 'SCF parser', content: 'SCF output parsing src/parser.mjs with synthetic fixtures.' });
  appendWorkV2(h.project, work());
  for (const maxChars of [1000, 3000, 12000]) assert.ok(buildWorkingContext(h.project, 'SCF', { maxChars }).chars <= maxChars);
  const context = buildWorkingContext(h.project, 'SCF');
  assert.match(context.content, /knowledge:/); assert.match(context.content, /requires verification/);
  updateWorkingV2(h.project, 'overview', 0, { content: 'Long overview '.repeat(500) });
  const compact = buildWorkingContext(h.project, '继续', { maxChars: 1000 });
  assert.match(compact.content, /检查体系 A/);
});
test('work reads/writes stop on scope revocation, symlinks and corrupt event chains', t => {
  const h = fixture(t), saved = appendWorkV2(h.project, work());
  const file = path.join(h.project.memory, `.internal/work/${saved.event.id}.md`), raw = fs.readFileSync(file);
  fs.writeFileSync(file, 'broken'); assert.throws(() => readWorkingV2(h.project), code('invalid-record'));
  fs.unlinkSync(file); fs.symlinkSync(path.join(h.temp, 'missing'), file);
  assert.throws(() => readWorkingV2(h.project), code('unsafe-path'));
  fs.unlinkSync(file); fs.writeFileSync(file, raw);
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  assert.throws(() => appendWorkV2(h.project, work('next')));
});
test('Unicode excerpt cuts remain well-formed and do not conflict with generated views', t => {
  const h = fixture(t);
  const payload = collectWorkTurn([messages[0], { role: 'toolResult', toolName: 'read', content: 'a' + '😀'.repeat(4000) }, messages[2]], { session: 's', turn: 'unicode' });
  assert.equal(payload.observations[0].text.isWellFormed(), true);
  appendWorkV2(h.project, payload);
  assert.equal(rebuildWorkingV2(h.project).rebuilt, 1);
  assert.equal(readWorkingV2(h.project).events.length, 1);
});
test('working CLI exposes explicit state, overview, records and bounded context', t => {
  const h = fixture(t), cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = (command, value) => spawnSync(process.execPath, [cli, 'v2', command], { cwd: h.root, input: value ? JSON.stringify(value) : undefined, encoding: 'utf8', timeout: 5000 });
  assert.equal(run('overview', { expectedRevision: 0, value: { content: 'Synthetic SCF parser project.' } }).status, 0);
  assert.equal(run('state', { expectedRevision: 0, value: { goal } }).status, 0);
  assert.equal(run('record', work()).status, 0);
  assert.match(JSON.parse(run('context').stdout).content, /SCF/);
  assert.equal(JSON.parse(run('work').stdout).revisions.state, 1);
  assert.equal(run('rebuild-work').status, 0);
});
