import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { initializeV2, resolveV2, saveV2, reviseV2, getV2, searchV2, statusV2 } from '../src/v2-store.mjs';
import { listCandidatesV2, proposeCandidateV2, reviewCandidateV2, CANDIDATE_LIMITS } from '../src/v2-candidates.mjs';
import { runV2 } from '../src/v2-cli.mjs';

const code = expected => error => error.code === expected;
const entry = (extra = {}) => ({ kind: 'software', title: 'Parser hypothesis', content: 'Proposed parser change, not an observed test result.', ...extra });
const request = (extra = {}) => ({ requestId: randomUUID(), entry: entry(), ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-candidates-'));
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = initializeV2(root, { name: 'Candidate fixture' });
  return { root, project, directory: path.join(project.memory, '.internal/candidates') };
}
function config(root, values) {
  const file = path.join(root, '.pi/project-memory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...values }));
}

test('M3 pending and rejected candidates never enter knowledge search', t => {
  const { project } = fixture(t), value = request();
  proposeCandidateV2(project, value);
  assert.equal(listCandidatesV2(project).candidates[0].status, 'pending');
  assert.equal(statusV2(project).records, 0);
  assert.deepEqual(searchV2(project, 'Parser', { includeInactive: true }).hits, []);
  assert.equal(reviewCandidateV2(project, value.requestId, 'reject').status, 'rejected');
  assert.equal(listCandidatesV2(project).candidates[0].status, 'rejected');
  assert.equal(statusV2(project).records, 0);
  assert.equal(reviewCandidateV2(project, value.requestId, 'reject').duplicate, true);
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('review-conflict'));
});

test('M3 proposal and approval retries are idempotent without certification', t => {
  const { project, directory } = fixture(t), value = request();
  assert.equal(proposeCandidateV2(project, value).duplicate, false);
  const original = fs.readFileSync(path.join(directory, `${value.requestId}.candidate.json`));
  assert.equal(proposeCandidateV2(project, value).duplicate, true);
  assert.throws(() => proposeCandidateV2(project, { ...value, entry: entry({ content: 'Different claim' }) }), code('request-conflict'));
  const approved = reviewCandidateV2(project, value.requestId, 'approve');
  const record = approved.publication.record;
  assert.equal(record.entry.verification, 'reported');
  assert.equal(record.entry.provenance, 'assistant-claim');
  assert.match(record.entry.content, /not an observed/);
  assert.equal(reviewCandidateV2(project, value.requestId, 'approve').publication.record.id, record.id);
  assert.equal(statusV2(project).records, 1);
  assert.equal(listCandidatesV2(project).candidates[0].publication, 'committed');
  assert.deepEqual(fs.readFileSync(path.join(directory, `${value.requestId}.candidate.json`)), original);
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'reject'), code('review-conflict'));
});

test('M3 provenance/verification/result grounding cannot be self-certified', t => {
  const { project } = fixture(t);
  for (const invalid of [
    { verification: 'evidence-backed', evidence: ['output.log:1'] },
    { verification: 'user-confirmed', provenance: 'user-confirmation', evidence: ['turn:1'] },
    { provenance: 'tool-observation' },
    { kind: 'runs', run: { validity: 'accepted-with-scope' } },
    { kind: 'results', result: { runId: randomUUID(), property: 'energy', value: -1, unit: 'Ha', definition: 'total' }, evidence: ['output.log:1'] },
  ]) assert.throws(() => proposeCandidateV2(project, request({ entry: entry(invalid) })), code('invalid-grounding'));
  assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('M3 explicit extraction provenance is preserved without implying a model call', t => {
  const { project } = fixture(t), value = request({ entry: entry({ provenance: 'model-extraction' }) });
  proposeCandidateV2(project, value);
  assert.equal(reviewCandidateV2(project, value.requestId, 'approve').publication.record.entry.provenance, 'model-extraction');
});

test('M3 approval preserves independent failed-run states and unresolved claims', t => {
  const { project } = fixture(t), value = request({ entry: entry({ kind: 'runs', verification: 'unresolved',
    provenance: 'assistant-claim', run: { execution: 'terminated', termination: 'error', convergence: 'not-converged' } }) });
  proposeCandidateV2(project, value);
  const record = reviewCandidateV2(project, value.requestId, 'approve').publication.record;
  assert.equal(record.entry.verification, 'unresolved');
  assert.deepEqual(record.entry.run, { execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked' });
});

test('M3 same titles create separate records, revisions require an explicit current target', t => {
  const { project } = fixture(t), first = saveV2(project, entry()), value = request();
  proposeCandidateV2(project, value);
  const second = reviewCandidateV2(project, value.requestId, 'approve').publication.record;
  assert.notEqual(first.record.id, second.id);
  const update = request({ target: { id: first.record.id, expectedRevision: 1 }, entry: entry({ content: 'Revised unverified claim' }) });
  proposeCandidateV2(project, update);
  const revised = reviewCandidateV2(project, update.requestId, 'approve').publication.record;
  assert.equal(revised.id, first.record.id); assert.equal(revised.revision, 2);
  assert.equal(getV2(project, revised.id, { revision: 1 }).entry.content, entry().content);
  reviseV2(project, revised.id, 2, entry({ content: 'Later explicit revision' }));
  // Retrying the earlier approval returns that operation, not a new revision,
  // and must not move the current knowledge view backwards.
  assert.equal(reviewCandidateV2(project, update.requestId, 'approve').publication.record.revision, 2);
  assert.equal(getV2(project, revised.id).revision, 3);
});

test('M3 stale target fails before a review decision; entity references are checked', t => {
  const { project, directory } = fixture(t), saved = saveV2(project, entry()).record;
  const value = request({ target: { id: saved.id, expectedRevision: 1 } });
  proposeCandidateV2(project, value);
  reviseV2(project, saved.id, 1, entry({ content: 'Newer manual revision' }));
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('revision-conflict'));
  assert.equal(fs.existsSync(path.join(directory, `${value.requestId}.decision.json`)), false);
  assert.throws(() => proposeCandidateV2(project, request({ entry: entry({ entities: [{ type: 'system', id: randomUUID() }] }) })), code('invalid-reference'));
  assert.throws(() => proposeCandidateV2(project, request({ target: { id: saved.id, expectedRevision: 1 } })), code('revision-conflict'));
});

test('M3 interrupted approved publication is recoverable and protects manual knowledge edits', t => {
  const { project } = fixture(t), saved = saveV2(project, entry());
  const value = request({ target: { id: saved.record.id, expectedRevision: 1 } });
  proposeCandidateV2(project, value);
  const view = path.join(project.memory, saved.path), original = fs.readFileSync(view);
  fs.writeFileSync(view, 'User edit must survive');
  const approval = reviewCandidateV2(project, value.requestId, 'approve');
  assert.deepEqual(approval.publication, { status: 'pending', reason: 'view-conflict' });
  assert.equal(listCandidatesV2(project).candidates[0].publication, 'pending');
  assert.equal(fs.readFileSync(view, 'utf8'), 'User edit must survive');
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'reject'), code('review-conflict'));
  // Fixture-only restoration stands in for explicit user conflict resolution.
  fs.writeFileSync(view, original);
  assert.equal(reviewCandidateV2(project, value.requestId, 'approve').publication.record.revision, 2);
  assert.equal(statusV2(project).records, 2);
});

test('M3 candidate identity cannot reuse a knowledge requestId', t => {
  const { project } = fixture(t), value = request();
  saveV2(project, entry(), { requestId: value.requestId });
  assert.throws(() => proposeCandidateV2(project, value), code('request-conflict'));
  const next = request(); proposeCandidateV2(project, next);
  saveV2(project, entry(), { requestId: next.requestId });
  assert.throws(() => reviewCandidateV2(project, next.requestId, 'approve'), code('request-conflict'));
  assert.equal(listCandidatesV2(project).candidates[0].status, 'pending');
});

test('M3 explicit candidate actions work with learning off but recheck disabled and marker boundaries', t => {
  const { project, root } = fixture(t), value = request();
  config(root, { learningMode: 'off' });
  proposeCandidateV2(project, value);
  config(root, { enabled: false });
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('scope-changed'));
  assert.throws(() => listCandidatesV2(project), code('scope-changed'));
  config(root, { enabled: true });
  fs.unlinkSync(path.join(root, '.pi-root'));
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('scope-changed'));
  assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
});

test('M3 captured scope cannot follow a changed project identity', t => {
  const { project, root } = fixture(t), value = request();
  proposeCandidateV2(project, value);
  config(root, { id: randomUUID() });
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('scope-changed'));
});

test('M3 symlinked candidate storage is rejected without writing outside the pack', t => {
  const { project, root, directory } = fixture(t), outside = path.join(root, 'outside');
  fs.mkdirSync(outside); fs.symlinkSync(outside, directory);
  assert.throws(() => proposeCandidateV2(project, request()), code('unsafe-path'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('M3 malformed or edited candidates fail closed, unpublished atomic temp files are ignored', t => {
  const { project, directory } = fixture(t), value = request();
  proposeCandidateV2(project, value);
  fs.writeFileSync(path.join(directory, '.pi-memory-fixture.tmp'), 'partial file');
  assert.equal(listCandidatesV2(project).candidates.length, 1);
  const file = path.join(directory, `${value.requestId}.candidate.json`), original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('Parser hypothesis', 'Edited hypothesis'));
  assert.throws(() => listCandidatesV2(project), code('invalid-record'));
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('invalid-record'));
  assert.equal(statusV2(project).records, 0);
});

test('M3 candidate inventory is bounded, including abandoned atomic temp entries', t => {
  const { project, directory } = fixture(t);
  fs.mkdirSync(directory);
  for (let i = 0; i <= CANDIDATE_LIMITS.files; i++) fs.writeFileSync(path.join(directory, `.pi-memory-${i}.tmp`), '');
  assert.throws(() => listCandidatesV2(project), code('inventory-bounded'));
  assert.throws(() => proposeCandidateV2(project, request()), code('inventory-bounded'));
});

test('M3 sensitive and oversized proposals fail before candidate publication', t => {
  const { project, directory } = fixture(t);
  assert.throws(() => proposeCandidateV2(project, request({ entry: entry({ content: 'password = unsafeValue' }) })));
  assert.equal(fs.existsSync(directory), false);
  assert.throws(() => proposeCandidateV2(project, request({ entry: entry({ content: '中'.repeat(90000) }) })), code('inventory-bounded'));
  assert.equal(listCandidatesV2(project).candidates.length, 0);
  assert.equal(statusV2(project).records, 0);
});

test('M3 shared lock rejects concurrent writes without taking over the lock', t => {
  const { project } = fixture(t), lock = path.join(project.memory, '.internal/write.lock');
  fs.mkdirSync(lock);
  assert.throws(() => proposeCandidateV2(project, request()), code('busy'));
  assert.equal(fs.existsSync(lock), true);
});

function child(script, root, value) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(value)], { timeout: 6000, killSignal: 'SIGKILL' });
    let output = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { output += chunk; });
    process.on('error', reject);
    process.on('close', (status, signal) => resolve({ status, signal, output }));
  });
}
const imports = `import fs from 'node:fs';
import { resolveV2 } from ${JSON.stringify(new URL('../src/v2-store.mjs', import.meta.url).href)};
import { proposeCandidateV2, reviewCandidateV2 } from ${JSON.stringify(new URL('../src/v2-candidates.mjs', import.meta.url).href)};
const project = resolveV2(process.argv[1]), value = JSON.parse(process.argv[2]);`;

test('M3 bounded concurrent processes stage and approve exactly one record', async t => {
  const { project, root } = fixture(t), value = request();
  for (const operation of ['proposeCandidateV2(project, value)', "reviewCandidateV2(project, value.requestId, 'approve')"]) {
    const script = imports + `try { ${operation}; console.log('ok'); } catch (error) { if (error.code !== 'busy') throw error; console.log('busy'); }`;
    const results = await Promise.all(Array.from({ length: 4 }, () => child(script, root, value)));
    for (const result of results) {
      assert.equal(result.signal, null, result.output);
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, /^(ok|busy)\s*$/);
    }
    assert.ok(results.some(result => result.output.startsWith('ok')));
  }
  assert.equal(listCandidatesV2(project).candidates.length, 1);
  assert.equal(statusV2(project).records, 1);
  assert.equal(reviewCandidateV2(project, value.requestId, 'approve').publication.duplicate, true);
});

test('M3 real process exit after review intent recovers without duplicate knowledge', async t => {
  const { project, root } = fixture(t), value = request();
  proposeCandidateV2(project, value);
  const script = imports + `const link = fs.linkSync;
fs.linkSync = function(source, target) {
  const result = link.call(this, source, target);
  if (String(target).endsWith('.decision.json')) process.exit(81);
  return result;
};
reviewCandidateV2(project, value.requestId, 'approve');`;
  const result = await child(script, root, value);
  assert.equal(result.status, 81, result.output); assert.equal(result.signal, null);
  assert.equal(statusV2(project).records, 0);
  assert.equal(listCandidatesV2(project).candidates[0].publication, 'pending');
  assert.throws(() => reviewCandidateV2(project, value.requestId, 'approve'), code('busy'));
  // Only the isolated fixture lock is cleared, after the child has exited.
  fs.rmdirSync(path.join(project.memory, '.internal/write.lock'));
  const recovered = reviewCandidateV2(project, value.requestId, 'approve');
  assert.equal(recovered.publication.record.revision, 1);
  assert.equal(reviewCandidateV2(project, value.requestId, 'approve').publication.record.id, recovered.publication.record.id);
  assert.equal(statusV2(project).records, 1);
});

test('M3 CLI proposal/review/list and exact entity filtering share existing storage contracts', async t => {
  const { project, root } = fixture(t), methodA = saveV2(project, entry({ kind: 'methods', title: 'Method A', content: 'Method scope A only.' })).record;
  const methodB = saveV2(project, entry({ kind: 'methods', title: 'Method B', content: 'Method scope B only.' })).record;
  const a = request({ entry: entry({ entities: [{ type: 'method', id: methodA.id }] }) });
  const b = request({ entry: entry({ entities: [{ type: 'method', id: methodB.id }] }) });
  const run = (args, value) => runV2(args, { cwd: root, input: Readable.from([JSON.stringify(value)]) });
  await run(['propose'], a); await run(['propose'], b);
  assert.equal((await run(['candidates'])).candidates.length, 2);
  const approved = await run(['review', a.requestId, 'approve']);
  const hits = (await run(['search', '--all', '--entity', methodA.id, 'Parser'])).hits;
  assert.deepEqual(hits.map(hit => hit.id), [approved.publication.record.id]);
  assert.equal((await run(['search', '--entity', methodB.id, 'Parser'])).hits.length, 0);
  await assert.rejects(run(['search', '--entity']), code('invalid-arguments'));
  await assert.rejects(run(['review', a.requestId]), code('invalid-arguments'));
  await assert.rejects(run(['search', '--entity', 'invalid', 'Parser']), code('invalid-schema'));
  assert.equal(resolveV2(root).enabled, true);
});
