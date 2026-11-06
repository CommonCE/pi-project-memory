import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverRoot, loadConfig, resolveProject } from '../src/core.mjs';
import { normalizeEntry, LIMITS } from '../src/v2-domain.mjs';
import { getV2, initializeV2, rebuildV2, resolveV2, reviseV2, saveV2, searchV2, statusV2 } from '../src/v2-store.mjs';

const entry = (overrides = {}) => ({ kind: 'software', title: 'Parser checks', content: 'Parser tests use synthetic fixtures; real chemistry is not validated.', ...overrides });
const code = expected => error => error.code === expected;
function fixture(t, initialize = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-v2-'));
  const root = path.join(temp, 'project with spaces'); fs.mkdirSync(root);
  // Never inherit another project's marker, even when TMPDIR is project-local.
  fs.writeFileSync(path.join(root, '.pi-root'), 'fixture boundary');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = initialize ? initializeV2(root, { name: '计算与软件' }) : undefined;
  return { temp, root, project, config: path.join(root, '.pi/project-memory.json') };
}
function files(dir) {
  if (!fs.existsSync(dir)) return {};
  const result = {};
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) for (const [name, bytes] of Object.entries(files(target))) result[`${item.name}/${name}`] = bytes;
    else if (item.isFile()) result[item.name] = fs.readFileSync(target).toString('base64');
  }
  return result;
}

test('v2 init is local, repeatable, child-aware, and never changes ignore rules', t => {
  const h = fixture(t), before = files(h.root);
  const child = path.join(h.root, 'calc'); fs.mkdirSync(child);
  assert.equal(initializeV2(child).id, h.project.id);
  assert.equal(resolveV2(child).root, h.root);
  assert.deepEqual(files(h.root), before);
  assert.equal(h.project.memory, path.join(h.root, '.pi-memory'));
  assert.equal(fs.existsSync(path.join(h.root, '.gitignore')), false);
  assert.equal(fs.existsSync(path.join(child, '.pi-root')), false);
  assert.throws(() => initializeV2(child, { name: 'Other project' }), code('schema-conflict'));
  const nested = initializeV2(child, { nested: true, name: '独立子项目' });
  assert.notEqual(nested.id, h.project.id);
  assert.equal(nested.root, child);
  assert.equal(resolveV2(h.root).id, h.project.id);
});
test('v2 unmarked resolution does not read malformed local config or create files', t => {
  const h = fixture(t, false);
  if (discoverRoot(h.temp)) { t.skip('TMPDIR has an ancestor marker'); return; }
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  fs.mkdirSync(path.join(h.root, '.pi'));
  fs.writeFileSync(h.config, '{malformed');
  const before = files(h.root), project = resolveV2(h.root);
  assert.equal(project.reason, 'no-marker');
  assert.deepEqual(searchV2(project, 'parser').hits, []);
  assert.throws(() => saveV2(project, entry()), code('scope-changed'));
  assert.deepEqual(files(h.root), before);
});
test('v2 refuses old configs without modifying them or old scientific files', t => {
  const h = fixture(t, false);
  fs.mkdirSync(path.join(h.root, '.pi'));
  const legacy = '{"id":"old-project","packPath":"pi-memory/packs/old"}\n';
  fs.writeFileSync(h.config, legacy);
  fs.mkdirSync(path.join(h.root, 'pi-memory/packs/old'), { recursive: true });
  fs.writeFileSync(path.join(h.root, 'pi-memory/packs/old/old.md'), '# Old knowledge');
  fs.writeFileSync(path.join(h.root, 'run.out'), 'expensive result stays unchanged');
  const before = files(h.root);
  assert.throws(() => initializeV2(h.root), code('schema-conflict'));
  assert.throws(() => resolveV2(h.root), code('schema-conflict'));
  assert.deepEqual(files(h.root), before);
});
test('v2 preserves an unconfigured old pack rather than adopting or migrating it', t => {
  const h = fixture(t, false), old = path.join(h.root, 'pi-memory/packs/old');
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'old.md'), '# Keep');
  const before = files(old), project = initializeV2(h.root);
  assert.deepEqual(files(old), before);
  assert.equal(statusV2(project).records, 0);
});
test('v2 rejects unknown nonempty targets before creating marker or config', t => {
  const h = fixture(t, false);
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  if (discoverRoot(h.temp)) { t.skip('TMPDIR has an ancestor marker'); return; }
  fs.mkdirSync(path.join(h.root, '.pi-memory'));
  fs.writeFileSync(path.join(h.root, '.pi-memory/private.md'), '# Unknown data');
  const before = files(h.root);
  assert.throws(() => initializeV2(h.root), code('store-conflict'));
  assert.deepEqual(files(h.root), before);
});
test('legacy operations fail closed on v2 configuration', t => {
  const h = fixture(t), config = loadConfig({ home: h.temp, env: {} });
  assert.throws(() => resolveProject(h.root, config), /requires the v2 CLI/);
  assert.equal(fs.existsSync(config.vaultPath), false);
});
test('v2 revisions retain complete immutable Markdown records and same-title entities remain separate', t => {
  const h = fixture(t), first = saveV2(h.project, entry()), record = first.record;
  const before = files(path.join(h.project.memory, '.internal/records'));
  const next = reviseV2(h.project, record.id, 1, entry({ content: 'Parser checks passed for the synthetic fixture only.' }));
  assert.equal(next.record.revision, 2);
  assert.equal(next.projection, 'current');
  assert.equal(getV2(h.project, record.id).entry.content, next.record.entry.content);
  assert.deepEqual(getV2(h.project, record.id, { revision: 1 }), record);
  for (const [name, bytes] of Object.entries(before)) assert.equal(files(path.join(h.project.memory, '.internal/records'))[name], bytes);
  assert.throws(() => reviseV2(h.project, record.id, 1, entry()), code('revision-conflict'));
  assert.throws(() => reviseV2(h.project, record.id, 2, entry({ kind: 'methods' })), code('invalid-schema'));
  assert.notEqual(saveV2(h.project, entry()).record.id, record.id);
  assert.equal(statusV2(h.project).records, 3);
  assert.throws(() => reviseV2(h.project, undefined, undefined, entry()), code('invalid-schema'));
  assert.equal(statusV2(h.project).records, 3);
});
test('v2 idempotency checks payload and never rolls views back on an old retry', t => {
  const h = fixture(t), requestId = randomUUID();
  const first = saveV2(h.project, entry(), { requestId });
  const retry = saveV2(h.project, entry(), { requestId });
  assert.equal(retry.duplicate, true); assert.equal(retry.record.id, first.record.id);
  assert.throws(() => saveV2(h.project, entry({ title: 'Different' }), { requestId }), code('request-conflict'));
  const revRequest = randomUUID();
  const update = entry({ content: 'A revised parser contract.' });
  reviseV2(h.project, first.record.id, 1, update, { requestId: revRequest });
  assert.equal(reviseV2(h.project, first.record.id, 1, update, { requestId: revRequest }).duplicate, true);
  saveV2(h.project, entry(), { requestId });
  assert.equal(getV2(h.project, first.record.id).revision, 2);
  assert.match(fs.readFileSync(path.join(h.project.memory, first.path), 'utf8'), /A revised parser contract/);
  assert.equal(statusV2(h.project).records, 2);
});
test('v2 defaults preserve unknowns and do not equate termination with convergence', t => {
  const h = fixture(t);
  const record = saveV2(h.project, entry({ kind: 'runs', title: 'SCF run', run: { software: 'CP2K', termination: 'normal' } })).record;
  assert.equal(record.entry.verification, 'reported');
  assert.deepEqual(record.entry.run, { execution: 'unknown', termination: 'normal', convergence: 'unknown', validity: 'unchecked', software: 'CP2K' });
  assert.equal('result' in record.entry, false);
});
test('v2 validates domains, typed references, structured units and finite numeric values', t => {
  const h = fixture(t), system = saveV2(h.project, entry({ kind: 'systems', title: 'Synthetic system' })).record;
  const run = saveV2(h.project, entry({ kind: 'runs', title: 'Fixture run', entities: [{ type: 'system', id: system.id }] })).record;
  const result = entry({ kind: 'results', title: 'Synthetic energy format', evidence: ['fixtures/output.txt: fabricated energy for a parser test'],
    result: { runId: run.id, property: 'energy', value: -1.5, unit: 'eV', definition: 'Synthetic fixture energy, not a scientific result' } });
  const saved = saveV2(h.project, result).record;
  assert.equal(saved.entry.result.value, -1.5);
  assert.equal(getV2(h.project, run.id).entry.run.convergence, 'unknown');
  const hit = searchV2(h.project, 'energy', { kind: 'results' }).hits[0];
  assert.equal(hit.result.unit, 'eV');
  assert.equal(hit.resultRun.convergence, 'unknown');
  for (const value of [NaN, Infinity, '1.5', null]) assert.throws(() => saveV2(h.project, { ...result, result: { ...result.result, value } }), code('invalid-schema'));
  assert.throws(() => saveV2(h.project, { ...result, result: { ...result.result, unit: '' } }), code('invalid-schema'));
  assert.throws(() => saveV2(h.project, { ...result, evidence: [] }), code('invalid-schema'));
  assert.throws(() => saveV2(h.project, { ...result, result: { ...result.result, runId: system.id } }), code('invalid-reference'));
  assert.throws(() => saveV2(h.project, entry({ entities: [{ type: 'run', id: system.id }] })), code('invalid-reference'));
  assert.throws(() => saveV2(h.project, entry({ entities: [{ type: 'system', id: randomUUID() }] })), code('invalid-reference'));
});
test('v2 invalid schemas and secret-looking content fail without publishing records', t => {
  const h = fixture(t);
  const invalid = [entry({ kind: 'context' }), entry({ title: 'bad\ntitle' }), entry({ title: '\ud800' }), entry({ content: '' }), entry({ extra: 'ignored?' }),
    entry({ verification: 'evidence-backed' }), entry({ verification: 'user-confirmed', provenance: 'assistant-claim', evidence: ['user says so'] }),
    entry({ tags: [null] }), entry({ lifecycle: 'approved' }), entry({ run: {} }), entry({ evidence: ['bad\nlocator'] }), entry({ content: 'password = unsafeValue' }),
    entry({ tags: null }), entry({ verification: null }), entry({ kind: 'runs', run: { convergence: null } })];
  for (const value of invalid) assert.throws(() => saveV2(h.project, value));
  assert.throws(() => saveV2(h.project, entry({ content: '中'.repeat(90000) })), code('inventory-bounded'));
  assert.equal(statusV2(h.project).records, 0);
  assert.equal(normalizeEntry(entry()).verification, 'reported');
});
test('v2 search uses latest revisions, filters lifecycle and marks reported/unresolved claims', t => {
  const h = fixture(t), first = saveV2(h.project, entry()).record;
  reviseV2(h.project, first.id, 1, entry({ content: 'Parser implementation has changed.', lifecycle: 'archived' }));
  const run = saveV2(h.project, entry({ kind: 'runs', title: 'SCF 未收敛', content: 'Synthetic SCF 未收敛 fixture, not a calculation.', verification: 'unresolved' })).record;
  assert.equal(searchV2(h.project, 'Parser').hits.length, 0);
  assert.equal(searchV2(h.project, 'Parser', { includeInactive: true }).hits[0].revision, 2);
  const hit = searchV2(h.project, 'SCF 收敛').hits[0];
  assert.equal(hit.id, run.id); assert.equal(hit.requiresVerification, true);
  assert.equal(searchV2(h.project, 'SCF', { kind: 'methods' }).hits.length, 0);
  assert.equal(searchV2(h.project, 'SCF', { entityId: first.id }).hits.length, 0);
});
test('v2 evidence locators never cause external reads or command execution', t => {
  const h = fixture(t), target = path.join(h.temp, 'does-not-exist');
  saveV2(h.project, entry({ evidence: [`${target}: opaque locator only`, '$(touch should-not-exist): literal text'], verification: 'evidence-backed' }));
  assert.equal(searchV2(h.project, 'Parser').hits.length, 1);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(h.root, 'should-not-exist')), false);
});
test('v2 refuses manually edited views and rebuilds missing or stale owned views', t => {
  const h = fixture(t), first = saveV2(h.project, entry());
  const file = path.join(h.project.memory, first.path), original = fs.readFileSync(file);
  reviseV2(h.project, first.record.id, 1, entry({ content: 'Updated parser.' }));
  fs.writeFileSync(file, original);
  assert.equal(rebuildV2(h.project).rebuilt, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /Updated parser/);
  fs.unlinkSync(file); rebuildV2(h.project);
  fs.appendFileSync(file, '\nManual edit must survive.\n');
  const edited = fs.readFileSync(file);
  assert.throws(() => rebuildV2(h.project), code('view-conflict'));
  assert.throws(() => reviseV2(h.project, first.record.id, 2, entry()), code('view-conflict'));
  assert.deepEqual(fs.readFileSync(file), edited);
  assert.equal(statusV2(h.project).records, 2);
});
test('v2 rechecks marker, enabled flag, config identity and nested boundaries on every operation', t => {
  const h = fixture(t), saved = saveV2(h.project, entry());
  const before = files(h.project.memory), config = JSON.parse(fs.readFileSync(h.config));
  fs.writeFileSync(h.config, JSON.stringify({ ...config, enabled: false }));
  assert.throws(() => getV2(h.project, saved.record.id), code('scope-changed'));
  assert.equal(statusV2(resolveV2(h.root)).reason, 'disabled');
  fs.writeFileSync(h.config, JSON.stringify(config));
  fs.writeFileSync(h.config, JSON.stringify({ ...config, id: randomUUID() }));
  assert.throws(() => saveV2(h.project, entry()), code('scope-changed'));
  fs.writeFileSync(h.config, JSON.stringify(config));
  fs.unlinkSync(path.join(h.root, '.pi-root'));
  assert.throws(() => saveV2(h.project, entry()));
  fs.writeFileSync(path.join(h.root, '.pi-root'), '');
  const child = path.join(h.root, 'nested'); fs.mkdirSync(child);
  const inherited = resolveV2(child);
  initializeV2(child, { nested: true });
  assert.throws(() => saveV2(inherited, entry()), code('scope-changed'));
  assert.deepEqual(files(h.project.memory), before);
});
test('v2 project moves and copies do not use absolute paths or central bindings', t => {
  const h = fixture(t), saved = saveV2(h.project, entry()).record;
  const moved = path.join(h.temp, 'moved'); fs.renameSync(h.root, moved);
  const project = resolveV2(moved);
  assert.equal(project.id, h.project.id);
  assert.equal(getV2(project, saved.id).id, saved.id);
  const copy = path.join(h.temp, 'copy'); fs.cpSync(moved, copy, { recursive: true });
  const copied = resolveV2(copy);
  saveV2(copied, entry({ title: 'Copy-only parser' }));
  assert.equal(statusV2(project).records, 1);
  assert.equal(statusV2(copied).records, 2);
});
test('v2 checks symlinks at marker, config, memory, record and view boundaries', t => {
  const h = fixture(t), outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside);
  const record = saveV2(h.project, entry());
  for (const relative of [record.path, '.internal/records']) {
    const target = path.join(h.project.memory, relative), backup = target + '.backup';
    fs.renameSync(target, backup); fs.symlinkSync(outside, target);
    assert.throws(() => relative.startsWith('knowledge') ? rebuildV2(h.project) : searchV2(h.project, 'Parser'), code('unsafe-path'));
    fs.unlinkSync(target); fs.renameSync(backup, target);
  }
  const marker = path.join(h.root, '.pi-root'); fs.unlinkSync(marker); fs.symlinkSync(path.join(h.temp, 'missing'), marker);
  assert.throws(() => resolveV2(h.root), code('unsafe-path'));
  fs.unlinkSync(marker); fs.writeFileSync(marker, '');
  const before = fs.readFileSync(h.config); fs.unlinkSync(h.config); fs.symlinkSync(path.join(h.temp, 'missing'), h.config);
  assert.throws(() => resolveV2(h.root), code('unsafe-path'));
  fs.unlinkSync(h.config); fs.writeFileSync(h.config, before);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('v2 rejects traversal, reserved memory paths, manifest swaps and corrupt revision chains', t => {
  const h = fixture(t), config = fs.readFileSync(h.config);
  for (const memoryPath of ['../outside', '/tmp/outside', '.git', '.pi', 'notes/../escape', 'C:\\outside']) {
    fs.writeFileSync(h.config, JSON.stringify({ ...JSON.parse(config), memoryPath }));
    assert.throws(() => resolveV2(h.root), code('unsafe-path'));
  }
  fs.writeFileSync(h.config, config);
  const manifest = path.join(h.project.memory, '.store.json'), originalManifest = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, JSON.stringify({ schemaVersion: 2, projectId: randomUUID() }));
  assert.throws(() => saveV2(h.project, entry()), code('schema-conflict'));
  fs.writeFileSync(manifest, originalManifest);
  const saved = saveV2(h.project, entry()).record;
  reviseV2(h.project, saved.id, 1, entry({ content: 'Parser revision two.' }));
  const records = path.join(h.project.memory, '.internal/records');
  fs.unlinkSync(path.join(records, `${saved.id}.1.md`));
  assert.throws(() => searchV2(h.project, 'Parser'), code('invalid-record'));
});
test('v2 fails closed on oversized records, with no partial search result', t => {
  const h = fixture(t), saved = saveV2(h.project, entry()).record;
  const file = path.join(h.project.memory, `.internal/records/${saved.id}.1.md`);
  fs.truncateSync(file, LIMITS.recordBytes + 1);
  assert.throws(() => searchV2(h.project, 'Parser'), code('inventory-bounded'));
});
test('v2 CLI covers init/save/revise/get/search/rebuild without reading legacy global config', t => {
  const h = fixture(t, false), cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const malformed = path.join(h.temp, 'legacy-global.json'); fs.writeFileSync(malformed, '{bad');
  const env = { ...process.env, PI_PROJECT_MEMORY_CONFIG: malformed, PI_PROJECT_MEMORY_HOME: path.join(h.temp, 'must-not-create') };
  const run = (args, input) => spawnSync(process.execPath, [cli, 'v2', ...args], { cwd: h.root, env, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  assert.equal(run(['init', '科研项目']).status, 0);
  const saved = run(['save'], { entry: entry(), requestId: randomUUID() });
  assert.equal(saved.status, 0, saved.stderr);
  const record = JSON.parse(saved.stdout).record;
  assert.equal(run(['revise'], { id: record.id, expectedRevision: 1, entry: entry({ content: 'Parser updated.' }) }).status, 0);
  assert.equal(JSON.parse(run(['get', record.id]).stdout).revision, 2);
  assert.equal(JSON.parse(run(['get', record.id, '1']).stdout).revision, 1);
  assert.equal(JSON.parse(run(['search', 'Parser']).stdout).hits.length, 1);
  assert.equal(run(['rebuild']).status, 0);
  for (const args of [['init', '--unknown'], ['status', 'extra'], ['save', 'extra'], ['get', record.id, '0'], ['search']]) assert.equal(run(args).status, 1);
  assert.equal(fs.existsSync(env.PI_PROJECT_MEMORY_HOME), false);
  assert.equal(run(['save'], { entry: entry(), unknown: true }).status, 1);
});
