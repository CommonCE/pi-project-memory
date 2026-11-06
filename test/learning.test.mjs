import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveProject, initialize, saveNote, search } from '../src/core.mjs';
import { candidateId, collectEvidence, enqueueCandidate, listCandidates, parseCandidates, reviewCandidate, safeFragment, saveHandoff } from '../src/learning.mjs';

const note = { type: 'runbook', title: 'Release procedure', content: 'Release with release.sh after a successful test run and manual approval.', tags: ['release'] };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-learning-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = loadConfig({ home: path.join(temp, 'home'), env: {} });
  const root = path.join(temp, 'repo'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const project = resolveProject(root, config); initialize(project, config);
  return { temp, root, project, config, queue: path.join(project.packPath, '00-system/pi-agent/.learning') };
}

test('candidates are persistent, deduplicated, and excluded from retrieval until approved', t => {
  const { project, config } = fixture(t);
  const record = enqueueCandidate(project, note, config);
  assert.equal(enqueueCandidate(project, note, config).duplicate, true);
  assert.equal(listCandidates(project).length, 1);
  assert.equal(search(project, 'release.sh', config).hits.length, 0);
  const approved = reviewCandidate(project, record.id.slice(0, 12), 'approve');
  assert.ok(fs.existsSync(approved.result.path));
  assert.equal(search(project, 'release.sh', config).hits.length, 1);
  assert.equal(listCandidates(project).length, 0);
  assert.equal(listCandidates(project, { all: true })[0].status, 'approved');
  assert.equal(reviewCandidate(project, record.id, 'approve').result.path, approved.result.path);
  assert.equal(enqueueCandidate(project, note, config).status, 'approved');
});
test('rejection does not create a note and decisions cannot be reversed or silently overwritten', t => {
  const { project, config } = fixture(t);
  const record = enqueueCandidate(project, note, config);
  reviewCandidate(project, record.id, 'reject');
  assert.equal(reviewCandidate(project, record.id, 'reject').status, 'rejected');
  assert.throws(() => reviewCandidate(project, record.id, 'approve'), /already rejected/);
  assert.equal(search(project, 'release.sh', config).hits.length, 0);
  assert.equal(enqueueCandidate(project, note, config).duplicate, true);
  assert.throws(() => reviewCandidate(project, '1', 'show'), /at least 8/);
  assert.throws(() => reviewCandidate(project, 'f'.repeat(64), 'show'), /Unknown/);
});
test('approval retry recovers a crash between note creation and decision publication', t => {
  const { project, config } = fixture(t);
  const record = enqueueCandidate(project, note, config);
  const first = saveNote(project, record.note, { dedupeKey: record.id });
  const bytes = fs.readFileSync(first.path);
  const approved = reviewCandidate(project, record.id, 'approve');
  assert.equal(approved.result.path, first.path);
  assert.deepEqual(fs.readFileSync(first.path), bytes);
  assert.equal(fs.readdirSync(path.join(project.packPath, '70-runbooks')).length, 1);
});
test('deduplicated saves refuse conflicting content and symlink targets', t => {
  const { project } = fixture(t);
  const key = candidateId(project, note), saved = saveNote(project, note, { dedupeKey: key });
  assert.throws(() => saveNote(project, { ...note, content: 'Different content' }, { dedupeKey: key }), /does not match/);
  fs.unlinkSync(saved.path); fs.symlinkSync('/nonexistent', saved.path);
  assert.throws(() => saveNote(project, note, { dedupeKey: key }), /does not match/);
});
test('queue capacity, duplicates and process lock fail safely without leaking the lock', t => {
  const { project, config, queue } = fixture(t);
  const small = { ...config, queueMaxItems: 1 };
  const record = enqueueCandidate(project, note, small);
  assert.equal(enqueueCandidate(project, note, small).duplicate, true);
  assert.throws(() => enqueueCandidate(project, { ...note, title: 'Other' }, small), /queue is full/);
  assert.equal(fs.existsSync(path.join(queue, '.lock')), false);
  fs.mkdirSync(path.join(queue, '.lock'));
  assert.throws(() => reviewCandidate(project, record.id, 'approve'), /queue is busy/);
  fs.rmdirSync(path.join(queue, '.lock'));
  reviewCandidate(project, record.id, 'reject');
  assert.equal(enqueueCandidate(project, { ...note, title: 'Other' }, small).status, 'pending');
});
test('queue is isolated by project even when two explicit configurations share a pack', t => {
  const { temp, project, config } = fixture(t);
  enqueueCandidate(project, note, config);
  const root = path.join(temp, 'other'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  fs.mkdirSync(path.join(root, '.pi')); fs.writeFileSync(path.join(root, '.pi/project-memory.json'), JSON.stringify({ packPath: project.packPath }));
  const other = resolveProject(root, config);
  assert.equal(listCandidates(other).length, 0);
  const record = enqueueCandidate(other, note, config);
  assert.notEqual(record.id, candidateId(project, note));
  assert.equal(listCandidates(project).length, 1);
});
test('marker removal blocks all queue operations and handoff writes', t => {
  const { root, project, config } = fixture(t);
  const record = enqueueCandidate(project, note, config);
  fs.unlinkSync(path.join(root, '.pi-root'));
  for (const operation of [() => listCandidates(project), () => enqueueCandidate(project, note, config), () => reviewCandidate(project, record.id, 'approve'), () => saveHandoff(project, {}, [], config)]) assert.throws(operation, /disabled/);
});
test('unsafe candidate files, tampered identities and symlink directories are refused', t => {
  const { temp, project, config, queue } = fixture(t);
  const record = enqueueCandidate(project, note, config), file = path.join(queue, 'candidates', `${record.id}.json`);
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...record, id: 'f'.repeat(64) }));
  assert.throws(() => listCandidates(project), /identity mismatch/);
  fs.writeFileSync(file, bytes);
  fs.renameSync(path.join(queue, 'candidates'), path.join(temp, 'outside'));
  fs.symlinkSync(path.join(temp, 'outside'), path.join(queue, 'candidates'));
  assert.throws(() => listCandidates(project), /Unsafe candidate directory/);
  assert.throws(() => enqueueCandidate(project, note, config), /Unsafe/);
});
test('secrets in candidate notes or evidence are rejected before persistence', t => {
  const { project, config } = fixture(t);
  assert.throws(() => enqueueCandidate(project, { ...note, content: 'password = unsafeValue' }, config), /secret-looking/);
  assert.throws(() => enqueueCandidate(project, { note, evidence: [{ id: 'm0', quote: 'token: unsafeValue' }] }, config), /secret-looking/);
  assert.equal(listCandidates(project).length, 0);
});
test('evidence collection excludes thinking, images, tool arguments, prior turns and secret fragments', () => {
  const messages = [
    { role: 'user', content: 'Old unrelated project request' },
    { role: 'assistant', content: [{ type: 'text', text: 'Old unrelated answer' }] },
    { role: 'user', content: 'Verify the release procedure' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'image', data: 'private image' }, { type: 'toolCall', arguments: { value: 'password: unsafeValue' } }] },
    { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'password: unsafeValue' }] },
    { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'All checks passed for release.sh' }], isError: false },
    { role: 'assistant', content: [{ type: 'text', text: 'Use release.sh after manual approval.' }], stopReason: 'stop' },
  ];
  const evidence = collectEvidence(messages, 2000, { latestTurn: true });
  assert.deepEqual(evidence.map(item => item.id), ['m2', 'm5', 'm6']);
  assert.ok(!JSON.stringify(evidence).includes('private'));
  assert.ok(JSON.stringify(evidence).length < 2400);
  assert.equal(safeFragment(`${'a'.repeat(5000)}\napi_key: unsafeValue`, 100), '');
});
test('curator candidates require exact bounded evidence and valid safe note data', () => {
  const evidence = [{ id: 'm1', role: 'toolResult', text: 'All checks passed for release.sh' }];
  const good = { ...note, evidence: [{ id: 'm1', quote: 'All checks passed' }] };
  const parsed = parseCandidates(JSON.stringify({ candidates: [good, { ...good, evidence: [{ id: 'm1', quote: 'Fabricated check result' }] }, { ...good, content: 'password: unsafeValue' }, { ...good, type: 'invalid' }] }), evidence, 4);
  assert.equal(parsed.accepted.length, 1); assert.equal(parsed.rejected.length, 3);
  assert.equal(parseCandidates('```json\n' + JSON.stringify({ candidates: [good] }) + '\n```', evidence, 1).accepted.length, 1);
  assert.throws(() => parseCandidates('not JSON', evidence, 4));
  assert.throws(() => parseCandidates('{}', evidence, 4), /candidates array/);
});
test('handoff uses safe bounded recent context, is retry-idempotent, and never archives thinking', t => {
  const { project, config } = fixture(t);
  const messages = [
    { role: 'user', content: 'Prepare the next release and inspect the test results.' },
    { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'All checks passed for release.sh' }], isError: false },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Do not archive this' }, { type: 'text', text: 'Release inputs are ready. Next step: obtain manual approval.' }], stopReason: 'stop' },
  ];
  const prep = { previousSummary: 'Previous context: release must be manually approved.', firstKeptEntryId: 'kept-1' };
  const result = saveHandoff(project, prep, messages, config, { session: 'session-1', reason: 'manual' });
  const text = fs.readFileSync(result.path, 'utf8');
  assert.match(text, /Latest goal/); assert.match(text, /manual approval/);
  assert.ok(!text.includes('Do not archive this'));
  assert.equal(saveHandoff(project, prep, messages, config, { session: 'session-1', reason: 'manual' }).path, result.path);
  assert.equal(saveHandoff(project, {}, [], config), null);
  const unsafe = saveHandoff(project, {}, [{ role: 'user', content: 'api_key: unsafeValue' }], config);
  assert.equal(unsafe, null);
});
test('long Chinese titles fit filename byte limits in deterministic and ordinary saves', t => {
  const { project, config } = fixture(t);
  const long = { ...note, title: '科研'.repeat(50) };
  const record = enqueueCandidate(project, long, config);
  const approved = reviewCandidate(project, record.id, 'approve');
  assert.ok(Buffer.byteLength(path.basename(approved.result.path)) <= 255);
  const ordinary = saveNote(project, long);
  assert.ok(Buffer.byteLength(path.basename(ordinary.path)) <= 255);
  assert.ok(fs.existsSync(ordinary.path));
});
test('learning configuration validates defaults, global options and project overrides', t => {
  const { root, project, config, temp } = fixture(t);
  assert.equal(config.learningMode, 'suggest'); assert.equal(config.handoffEnabled, true);
  assert.equal(config.learningTimeoutMs, 60000);
  fs.mkdirSync(path.join(root, '.pi')); fs.writeFileSync(path.join(root, '.pi/project-memory.json'), '{"learningMode":"off","handoffEnabled":false}');
  assert.equal(resolveProject(root, config).learningMode, 'off');
  assert.equal(resolveProject(root, config).handoffEnabled, false);
  fs.writeFileSync(path.join(root, '.pi/project-memory.json'), '{"learningMode":"unknown"}');
  assert.throws(() => resolveProject(root, config), /learningMode/);
  const file = path.join(temp, 'config.json'); fs.writeFileSync(file, '{"learningTimeoutMs":0}');
  assert.throws(() => loadConfig({ env: { PI_PROJECT_MEMORY_CONFIG: file } }), /learningTimeoutMs/);
  fs.writeFileSync(file, '{"learningTimeoutMs":20000}');
  assert.equal(loadConfig({ env: { PI_PROJECT_MEMORY_CONFIG: file } }).learningTimeoutMs, 20000);
  assert.ok(project.enabled);
});
