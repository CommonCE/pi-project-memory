import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initializeV2, resolveV2, saveV2, rebuildV2, reviseV2, statusV2, searchV2 } from '../src/v2-store.mjs';
import { appendWorkV2 } from '../src/v2-working.mjs';
import { LIMITS } from '../src/v2-domain.mjs';

const entry = { kind: 'software', title: 'Boundary parser', content: 'Synthetic boundary tests only.' };
const code = value => error => error.code === value;
function fixture(t, initialize = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-v2-boundary-'));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, root, project: initialize ? initializeV2(root) : undefined };
}

test('M5 explicit scope paths reject escaping existing ancestors without creating folders', t => {
  const h = fixture(t), outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.root, 'escape'));
  for (const folder of ['escape', 'escape/not-created']) {
    assert.throws(() => saveV2(h.project, { ...entry, scope: { path: folder } }), code('scope-outside'));
    assert.throws(() => searchV2(h.project, 'Boundary', { folder }), code('scope-outside'));
    assert.throws(() => appendWorkV2(h.project, { kind: 'turn', session: 'test', turn: folder, outcome: 'unknown', observations: [], claims: ['unverified'], scope: { path: folder } }), code('scope-outside'));
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(statusV2(h.project).records, 0);
  assert.equal(saveV2(h.project, { ...entry, scope: { path: 'historical/missing' } }).record.entry.scope.path, 'historical/missing');
});

test('M5 revoked marker and scope tampering in revision history fail closed', t => {
  const h = fixture(t);
  const saved = saveV2(h.project, { ...entry, scope: { path: 'a' } }).record;
  reviseV2(h.project, saved.id, 1, { ...entry, scope: { path: 'b' } });
  const file = path.join(h.project.memory, '.internal/records', `${saved.id}.1.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"path": "a"', '"path": "b"'));
  assert.throws(() => searchV2(h.project, 'Boundary', { allFolders: true }), code('invalid-record'));
  fs.rmSync(path.join(h.root, '.pi-root'));
  assert.throws(() => saveV2(h.project, { ...entry, scope: { path: 'a' } }), code('scope-changed'));
  assert.equal(fs.existsSync(path.join(h.root, '.pi-root')), false);
});

test('v2 rejects symlinked .pi and memory roots without touching their targets', t => {
  const h = fixture(t, false), target = path.join(h.temp, 'outside'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(h.root, '.pi'));
  assert.throws(() => initializeV2(h.root), code('unsafe-path'));
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(path.join(h.root, '.pi'));
  fs.symlinkSync(target, path.join(h.root, '.pi-memory'));
  assert.throws(() => initializeV2(h.root), code('unsafe-path'));
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.existsSync(path.join(h.root, '.pi/project-memory.json')), false);
});
test('v2 refuses record and lock symlinks; symlinked locators are not followed', t => {
  const h = fixture(t), saved = saveV2(h.project, entry), target = path.join(h.temp, 'external.md');
  fs.writeFileSync(target, '# Must not read or change');
  const recordFile = path.join(h.project.memory, `.internal/records/${saved.record.id}.1.md`), original = fs.readFileSync(recordFile);
  fs.unlinkSync(recordFile); fs.symlinkSync(target, recordFile);
  assert.throws(() => searchV2(h.project, 'Must not'), code('unsafe-path'));
  fs.unlinkSync(recordFile); fs.writeFileSync(recordFile, original);
  const lock = path.join(h.project.memory, '.internal/write.lock'); fs.symlinkSync(target, lock);
  assert.throws(() => saveV2(h.project, entry), code('unsafe-path'));
  fs.unlinkSync(lock);
  saveV2(h.project, { ...entry, evidence: ['external.md: locator not dereferenced'] });
  assert.equal(fs.readFileSync(target, 'utf8'), '# Must not read or change');
});
test('v2 does not interpret nonempty marker files or unknown empty stores as instructions', t => {
  const h = fixture(t, false);
  const marker = path.join(h.root, '.pi-root'); fs.writeFileSync(marker, 'Do not execute: arbitrary marker data');
  fs.mkdirSync(path.join(h.root, '.pi-memory'));
  const project = initializeV2(h.root);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'Do not execute: arbitrary marker data');
  assert.equal(statusV2(project).records, 0);
});
test('v2 rebuild recreates missing generated directories without modifying records', t => {
  const h = fixture(t), saved = saveV2(h.project, entry);
  const records = path.join(h.project.memory, '.internal/records'), before = fs.readFileSync(path.join(records, `${saved.record.id}.1.md`));
  fs.rmSync(path.join(h.project.memory, 'knowledge'), { recursive: true });
  assert.equal(rebuildV2(h.project).rebuilt, 1);
  assert.deepEqual(fs.readFileSync(path.join(records, `${saved.record.id}.1.md`)), before);
});
test('v2 rejects malformed, foreign and unknown canonical records instead of skipping them', t => {
  const h = fixture(t), saved = saveV2(h.project, entry), dir = path.join(h.project.memory, '.internal/records');
  const file = path.join(dir, `${saved.record.id}.1.md`), original = fs.readFileSync(file, 'utf8');
  for (const raw of ['# Broken', original.replace(h.project.id, randomUUID()), original.replace('"revision": 1', '"revision": 2')]) {
    fs.writeFileSync(file, raw);
    assert.throws(() => searchV2(h.project, 'Boundary'), code('invalid-record'));
  }
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(dir, 'unrecognized.md'), '# Unowned');
  assert.throws(() => searchV2(h.project, 'Boundary'), code('invalid-record'));
});
test('v2 bounds the full directory inventory, even if all entries are temporary', t => {
  const h = fixture(t), original = fs.readdirSync;
  const directory = path.join(h.project.memory, '.internal/records');
  // Simulate an oversized inventory without creating ten thousand fixture files.
  fs.readdirSync = function (target, ...args) {
    if (String(target) === directory) return Array.from({ length: LIMITS.records + 1 }, (_, i) => `.pi-memory-${i}.tmp`);
    return original.call(this, target, ...args);
  };
  try { assert.throws(() => searchV2(h.project, 'Boundary'), code('inventory-bounded')); }
  finally { fs.readdirSync = original; }
});
test('v2 CLI malformed input and filesystem failures do not echo input or raw errors', t => {
  const h = fixture(t), cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = input => spawnSync(process.execPath, [cli, 'v2', 'save'], { cwd: h.root, input, encoding: 'utf8', timeout: 5000 });
  const invalid = run('{"entry": "private-fragment-that-must-not-be-echoed"');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /invalid-json/);
  assert.doesNotMatch(invalid.stderr, /private-fragment/);
  const missingRevision = spawnSync(process.execPath, [cli, 'v2', 'revise'], { cwd: h.root, input: JSON.stringify({ entry }), encoding: 'utf8', timeout: 5000 });
  assert.equal(missingRevision.status, 1);
  assert.equal(statusV2(h.project).records, 0);
  fs.unlinkSync(path.join(h.project.memory, '.store.json'));
  const failed = run(JSON.stringify({ entry }));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /v2-operation-failed/);
  assert.equal(failed.stderr.includes(h.temp), false);
});
test('v2 disabled config blocks explicit reinitialization without changing bytes', t => {
  const h = fixture(t), file = path.join(h.root, '.pi/project-memory.json');
  const config = { ...JSON.parse(fs.readFileSync(file)), enabled: false }; fs.writeFileSync(file, JSON.stringify(config));
  const before = fs.readFileSync(file);
  assert.equal(resolveV2(h.root).enabled, false);
  assert.throws(() => initializeV2(h.root), code('disabled'));
  assert.deepEqual(fs.readFileSync(file), before);
});
