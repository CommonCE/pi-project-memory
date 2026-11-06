import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brief, initialize, loadConfig, normalizeNote, resolveProject, saveNote, search } from '../src/core.mjs';
import { candidateId, CURATOR_PROMPT, enqueueCandidate, listCandidates, parseCandidates, reviewCandidate, saveHandoff } from '../src/learning.mjs';

const note = { type: 'context', title: 'Mn oxide settings', content: 'chemFixture: project-specific Mn oxide static calculation settings.', tags: [] };
const all = { includeInactive: true, includeHandoffs: true };
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-chem-memory-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = loadConfig({ home: path.join(temp, 'home'), env: {} });
  const make = name => {
    const root = path.join(temp, name); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
    const project = resolveProject(root, config); initialize(project, config); return project;
  };
  return { temp, config, project: make('repo'), make };
}
function legacy(project, name, fields = '', body = 'chemFixture legacy settings') {
  const relativePath = `20-context/${name}.md`;
  const file = path.join(project.packPath, relativePath);
  fs.writeFileSync(file, `---\ntype: context\ntitle: ${name}\n${fields}---\n\n# ${name}\n\n${body}\n`);
  return { path: file, relativePath };
}
function find(project, config, options = {}) { return search(project, 'chemFixture', config, 20, undefined, options); }

test('legacy notes remain active; default excludes inactive notes and handoffs, all-history brief remains safe', t => {
  const { project, config } = fixture(t);
  const old = legacy(project, 'legacy');
  const unverified = saveNote(project, { ...note, status: 'unverified' });
  saveNote(project, { ...note, status: 'superseded', title: 'Archived settings' });
  const handoff = saveHandoff(project, { firstKeptEntryId: 'boundary' }, [{ role: 'user', content: 'chemFixture next calculation goal' }], config);
  const regularSession = saveNote(project, { ...note, type: 'session', title: 'Ordinary scientific session' });
  const result = find(project, config);
  assert.deepEqual(new Set(result.hits.map(h => h.path)), new Set([old.path, regularSession.path]));
  assert.equal(result.hits.find(h => h.path === old.path).status, 'active');
  const history = find(project, config, all);
  assert.equal(history.hits.length, 5);
  const snapshot = history.hits.find(h => h.path === handoff.path);
  assert.equal(snapshot.handoff, true); assert.ok(snapshot.created); assert.ok(snapshot.updated);
  assert.equal(history.hits.find(h => h.path === unverified.path).status, 'unverified');
  const injected = brief(project, history, { ...config, contextChars: 10000 });
  assert.ok(!injected.includes(unverified.relativePath)); assert.ok(!injected.includes(handoff.relativePath));
  assert.ok(injected.includes(old.relativePath));
  assert.throws(() => find(project, config, { includeInactive: 'yes' }), /boolean/);
});

test('explicit active replacements hide old notes without changing bytes; unverified or superseded sources do not', t => {
  const { project, config } = fixture(t);
  const old = legacy(project, 'old-settings'), before = fs.readFileSync(old.path);
  saveNote(project, { ...note, status: 'unverified', supersedes: old.relativePath });
  saveNote(project, { ...note, status: 'superseded', supersedes: old.relativePath, title: 'Obsolete claim' });
  assert.ok(find(project, config).hits.some(h => h.path === old.path));
  const replacement = saveNote(project, { ...note, supersedes: old.relativePath, evidence: ['用户明确确认：该项目 Mn 3d 使用 Ueff=4 eV'] });
  assert.deepEqual(fs.readFileSync(old.path), before);
  assert.deepEqual(find(project, config).hits.map(h => h.path), [replacement.path]);
  const oldHit = find(project, config, all).hits.find(h => h.path === old.path);
  assert.equal(oldHit.status, 'superseded'); assert.equal(oldHit.declaredStatus, 'active');
  assert.deepEqual(oldHit.supersededBy, [replacement.relativePath]);
  const newest = saveNote(project, { ...note, supersedes: replacement.relativePath, title: 'Newer settings' });
  assert.deepEqual(find(project, config).hits.map(h => h.path), [newest.path]);
  // Same title alone is not a replacement.
  const parallel = saveNote(project, { ...note, title: 'Newer settings' });
  assert.equal(find(project, config).hits.length, 2); assert.notEqual(newest.path, parallel.path);
});

test('self-references, cycles and chains into invalid relations are diagnosed without hiding normal notes', t => {
  const { project, config } = fixture(t);
  legacy(project, 'self', 'supersedes: 20-context/self.md\n');
  legacy(project, 'a', 'supersedes: 20-context/b.md\n');
  legacy(project, 'b', 'supersedes: 20-context/a.md\n');
  legacy(project, 'incoming', 'supersedes: 20-context/a.md\n');
  legacy(project, 'missing', 'supersedes: 20-context/not-present.md\n');
  legacy(project, 'broken-chain', 'supersedes: 20-context/missing.md\n');
  legacy(project, 'traversal', 'supersedes: ../escape.md\n');
  legacy(project, 'absolute', 'supersedes: /tmp/escape.md\n');
  const result = find(project, config);
  assert.equal(result.hits.length, 8);
  assert.ok(result.hits.every(h => h.status === 'active'));
  assert.equal(result.diagnostics.length, 8);
  assert.ok(result.diagnostics.some(d => d.reason === 'self-reference'));
  assert.ok(result.diagnostics.some(d => d.reason === 'cyclic-or-invalid-chain'));
});

test('replacement paths are strictly pack-relative and descendant symlinks cannot escape', t => {
  const { project, config, temp } = fixture(t);
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'target.md'), 'chemFixture outside memory');
  fs.symlinkSync(outside, path.join(project.packPath, 'linked'));
  fs.symlinkSync(path.join(outside, 'target.md'), path.join(project.packPath, '20-context/link.md'));
  for (const supersedes of ['../escape.md', '/tmp/escape.md', 'C:/escape.md', '20-context\\target.md', '20-context/../target.md', './target.md', '20-context//target.md', '20-context/.private.md', '20-context/target.txt', 'linked/target.md', '20-context/link.md', '20-context/missing.md']) {
    assert.throws(() => saveNote(project, { ...note, supersedes }));
  }
  legacy(project, 'unsafe-reference', 'supersedes: linked/target.md\n');
  const result = find(project, config);
  assert.equal(result.hits.length, 1); assert.equal(result.hits[0].status, 'active');
  assert.ok(result.diagnostics.some(d => d.reason === 'target-unavailable'));
  assert.equal(fs.readFileSync(path.join(outside, 'target.md'), 'utf8'), 'chemFixture outside memory');
});

test('evidence is bounded filtered locator text only; block lists are read without accessing or executing locators', t => {
  const { project, config, temp } = fixture(t);
  const forbidden = path.join(temp, 'evidence-not-to-read');
  const marker = path.join(temp, 'must-not-execute');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    assert.notEqual(String(file), forbidden, 'locator must never be read'); return read.call(this, file, ...args);
  });
  const evidence = ['calc/static/OUTCAR：最终能量及收敛记录', forbidden, `touch ${marker}`];
  const saved = saveNote(project, { ...note, evidence });
  const hit = find(project, config).hits.find(h => h.path === saved.path);
  assert.deepEqual(hit.evidence, evidence); assert.equal(hit.source, 'pi-project-memory');
  assert.equal(fs.existsSync(marker), false);
  legacy(project, 'block-evidence', 'source: pi-memctx\nevidence:\n  - "calc/static/OUTCAR：收敛记录"\n  - \'analysis/bader_summary.csv：逐原子电荷\'\n');
  const block = find(project, config).hits.find(h => h.title === 'block-evidence');
  assert.deepEqual(block.evidence, ['calc/static/OUTCAR：收敛记录', 'analysis/bader_summary.csv：逐原子电荷']);
  assert.equal(block.source, 'pi-memctx');
  for (const invalid of [Array(11).fill('file'), ['x'.repeat(501)], [''], ['line\nbreak'], [{ path: 'file' }], ['api_key: unsafeValue']]) {
    assert.throws(() => saveNote(project, { ...note, evidence: invalid }));
  }
});

test('only specific plugin legacy snapshots count as handoffs; old snapshots are not rewritten', t => {
  const { project, config } = fixture(t);
  const snapshot = saveHandoff(project, {}, [{ role: 'user', content: 'chemFixture prepare calculation' }], config);
  // Simulate a pre-change snapshot in this disposable fixture, never user memory.
  const oldText = fs.readFileSync(snapshot.path, 'utf8').replace(/^handoff: true\n/m, '').replace(/^status: active\n/m, '');
  fs.writeFileSync(snapshot.path, oldText);
  const before = fs.readFileSync(snapshot.path);
  const retried = saveHandoff(project, {}, [{ role: 'user', content: 'chemFixture prepare calculation' }], config);
  assert.equal(retried.path, snapshot.path); assert.deepEqual(fs.readFileSync(snapshot.path), before);
  const ordinary = saveNote(project, { ...note, type: 'session', title: 'Pre-compaction handoff', tags: ['handoff', 'unverified-snapshot'] });
  assert.deepEqual(find(project, config).hits.map(h => h.path), [ordinary.path]);
  assert.equal(find(project, config, all).hits.find(h => h.path === snapshot.path).handoff, true);
});

test('old candidate hashes and old deduplicated saves remain valid; new metadata participates in identity', t => {
  const { project, config } = fixture(t);
  const normalized = { type: note.type, title: note.title, content: note.content, tags: [] };
  const oldHash = createHash('sha256').update(JSON.stringify([project.id, normalized])).digest('hex');
  assert.equal(candidateId(project, note), oldHash);
  assert.equal(candidateId(project, { ...note, status: 'active', evidence: [] }), oldHash);
  assert.notEqual(candidateId(project, { ...note, status: 'unverified' }), oldHash);
  assert.notEqual(candidateId(project, { ...note, evidence: ['calc/OUTCAR: energy'] }), oldHash);
  const record = enqueueCandidate(project, note, config);
  const saved = saveNote(project, note, { dedupeKey: record.id });
  fs.writeFileSync(saved.path, fs.readFileSync(saved.path, 'utf8').replace(/^status: active\n/m, ''));
  const before = fs.readFileSync(saved.path);
  assert.equal(reviewCandidate(project, record.id, 'approve').result.path, saved.path);
  assert.deepEqual(fs.readFileSync(saved.path), before);
  assert.equal(listCandidates(project, { all: true })[0].status, 'approved');
  const quotes = [{ id: 'm0', quote: 'Visible legacy source quote' }];
  const legacyCandidate = enqueueCandidate(project, { ...note, title: 'Legacy raw candidate', evidence: quotes }, config);
  assert.deepEqual(legacyCandidate.evidence, quotes);
  assert.equal(legacyCandidate.note.evidence, undefined);
});

test('candidate parsing allows zero/new optional fields and old quote schema; approval preserves unverified', t => {
  const { project, config } = fixture(t);
  const evidence = [{ id: 'm0', text: '用户明确确认：Mn oxide 项目设置需要进一步核实。' }];
  const grounding = [{ id: 'm0', quote: evidence[0].text }];
  const old = legacy(project, 'old');
  assert.deepEqual(parseCandidates('{"candidates":[]}', evidence, 4), { accepted: [], rejected: [] });
  const candidate = { ...note, status: 'unverified', supersedes: old.relativePath, evidence: ['用户明确确认：设置需要进一步核实'], grounding };
  const parsed = parseCandidates(JSON.stringify({ candidates: [candidate, { ...note, evidence: grounding }] }), evidence, 4);
  assert.equal(parsed.accepted.length, 2); assert.equal(parsed.rejected.length, 0);
  const record = enqueueCandidate(project, parsed.accepted[0], config);
  const approved = reviewCandidate(project, record.id, 'approve');
  assert.equal(approved.status, 'approved'); assert.equal(approved.note.status, 'unverified');
  assert.ok(find(project, config).hits.some(h => h.path === old.path));
  assert.ok(!find(project, config).hits.some(h => h.path === approved.result.path));
  assert.deepEqual(find(project, config, all).hits.find(h => h.path === approved.result.path).evidence, candidate.evidence);
  assert.equal(enqueueCandidate(project, parsed.accepted[0], config).duplicate, true);
  assert.throws(() => reviewCandidate(project, record.id, 'reject'), /immutable/);
  for (const change of [{ status: 'invalid' }, { evidence: [{ path: 'wrong' }] }, { supersedes: '../escape.md' }]) {
    assert.equal(parseCandidates(JSON.stringify({ candidates: [{ ...candidate, ...change }] }), evidence, 4).rejected.length, 1);
  }
  assert.throws(() => normalizeNote({ ...note, handoff: 'true' }), /boolean/);
  assert.match(CURATOR_PROMPT, /physical\/chemical model issues/);
  assert.match(CURATOR_PROMPT, /NOT user-confirmed/);
});

test('replacement relations and all-history queries remain scoped to the current pack and NO-MEMORY', t => {
  const { project, config, make } = fixture(t);
  const other = make('other');
  const target = legacy(other, 'only-other');
  legacy(project, 'claim', `supersedes: ${target.relativePath}\n`);
  assert.equal(find(project, config).hits.length, 1);
  assert.equal(find(other, config).hits.length, 1);
  fs.unlinkSync(path.join(project.root, '.pi-root'));
  assert.equal(find(project, config, all).hits.length, 0);
  assert.throws(() => saveNote(project, note), /disabled/);
});

test('invalid metadata and bounded target inventory never hide a normal target', t => {
  const { project, config } = fixture(t);
  const target = legacy(project, 'target');
  legacy(project, 'duplicate', `supersedes: ${target.relativePath}\nsupersedes: ${target.relativePath}\n`);
  legacy(project, 'unknown-status', `status: mystery\nsupersedes: ${target.relativePath}\n`);
  const handoff = saveNote(project, { ...note, handoff: true, supersedes: target.relativePath });
  const result = find(project, config);
  assert.ok(result.hits.some(hit => hit.path === target.path));
  assert.ok(result.diagnostics.some(item => item.reason === 'invalid-status'));
  assert.ok(result.diagnostics.some(item => item.reason === 'invalid-supersedes-path'));
  assert.equal(find(project, config, all).hits.find(hit => hit.path === handoff.path).handoff, true);
  assert.throws(() => saveNote(project, { ...note, status: 'mystery' }), /status/);
  // a.md sorts before z.md; a bounded scan cannot infer a replacement for an unseen target.
  const isolated = path.join(project.packPath, 'bounded'); fs.mkdirSync(isolated);
  fs.writeFileSync(path.join(isolated, 'a.md'), '---\ntitle: A\nsupersedes: z.md\n---\nchemFixture');
  fs.writeFileSync(path.join(isolated, 'z.md'), '# Z\nchemFixture');
  const boundedProject = { ...project, packPath: isolated };
  const bounded = search(boundedProject, 'chemFixture', { ...config, maxFiles: 1 });
  assert.equal(bounded.truncated, true); assert.equal(bounded.hits.length, 1);
  assert.equal(bounded.hits[0].status, 'active'); assert.equal(bounded.diagnostics[0].reason, 'target-unavailable');
});

test('dedupe refuses conflicting new metadata instead of stripping status or handoff distinctions', t => {
  const { project } = fixture(t), key = 'a'.repeat(64);
  const saved = saveNote(project, note, { dedupeKey: key });
  const bytes = fs.readFileSync(saved.path);
  for (const changes of [{ status: 'unverified' }, { evidence: ['calc/static/OUTCAR: energy'] }, { handoff: true }]) {
    assert.throws(() => saveNote(project, { ...note, ...changes }, { dedupeKey: key }), /does not match/);
  }
  assert.deepEqual(fs.readFileSync(saved.path), bytes);
});

test('CLI --all exposes inactive history without changing default search', t => {
  const { project, config, temp } = fixture(t);
  saveNote(project, { ...note, status: 'unverified' });
  const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [cli, 'search', ...args], { cwd: project.root, env: { ...process.env, PI_PROJECT_MEMORY_HOME: config.vaultPath, PI_PROJECT_MEMORY_CONFIG: path.join(temp, 'missing.json') }, encoding: 'utf8' });
  const ordinary = run(['chemFixture']), history = run(['--all', 'chemFixture']);
  assert.equal(ordinary.status, 0, ordinary.stderr); assert.equal(history.status, 0, history.stderr);
  assert.equal(JSON.parse(ordinary.stdout).hits.length, 0);
  assert.equal(JSON.parse(history.stdout).hits[0].status, 'unverified');
});
