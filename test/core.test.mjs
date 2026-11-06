import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adoptPack, assertSafe, brief, discoverRoot, initialize, listProjects, loadConfig, resolveProject, saveNote, search } from '../src/core.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-memory-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const config = loadConfig({ home, env: {} });
  const make = (name, marker = '.pi-root') => {
    const root = path.join(temp, name); fs.mkdirSync(root, { recursive: true });
    if (marker) fs.writeFileSync(path.join(root, marker), '');
    return root;
  };
  return { temp, home, config, make };
}
function note(project, title = '部署流程', content = '生产部署需要人工批准，使用 release.sh 脚本。') {
  return saveNote(project, { type: 'runbook', title, content, tags: ['deploy'] });
}

test('only .pi-root defines a project; nested git/worktree files do not override it', t => {
  const { make } = fixture(t);
  const root = make('repo', '.pi-root'), sub = path.join(root, 'src/deep'); fs.mkdirSync(sub, { recursive: true });
  assert.equal(discoverRoot(sub), root);
  fs.writeFileSync(path.join(root, 'src/.git'), 'gitdir: /unused/worktree');
  assert.equal(discoverRoot(sub), root);
  fs.writeFileSync(path.join(root, 'src/.pi-root'), '');
  assert.equal(discoverRoot(sub), path.join(root, 'src'));
  const alias = `${root}-alias`; fs.symlinkSync(root, alias);
  assert.equal(discoverRoot(alias), root);
});
test('same directory names get different ids; nested cwd gets the same id', t => {
  const { make, config } = fixture(t);
  const a = make('a/repo'), b = make('b/repo'); fs.mkdirSync(path.join(a, 'src'));
  assert.notEqual(resolveProject(a, config).id, resolveProject(b, config).id);
  assert.equal(resolveProject(a, config).id, resolveProject(path.join(a, 'src'), config).id);
});
test('unbound projects default to their own pi-memory/packs directory, including low-level init', t => {
  const { make, config } = fixture(t), root = make('polymer-study');
  const project = resolveProject(root, config);
  assert.equal(project.packPath, path.join(root, 'pi-memory/packs/polymer-study'));
  assert.equal(project.packSlug, 'polymer-study');
  assert.equal(fs.existsSync(project.packPath), false);
  initialize(project, config);
  const saved = note(project);
  assert.ok(saved.path.startsWith(project.packPath + path.sep));
  assert.equal(fs.existsSync(path.join(config.vaultPath, 'packs')), false);
  assert.equal(listProjects(config)[0].packPath, project.packPath);
});
test('validated legacy .md notes are searchable without exposing other hidden content', t => {
  const { make, config } = fixture(t), project = resolveProject(make('repo'), config);
  initialize(project, config);
  const directory = path.join(project.packPath, '20-context');
  const file = path.join(directory, '.md');
  fs.writeFileSync(file, '---\ntype: context\ntitle: 命名与编号约定\n---\n# 命名与编号约定\nlegacyDotFixture applies to molecular atom numbering.\n');
  fs.writeFileSync(path.join(directory, '.private.md'), '# Hidden\nprivateHiddenFixture\n');
  fs.mkdirSync(path.join(directory, '.hidden'));
  fs.writeFileSync(path.join(directory, '.hidden/visible.md'), '# Hidden\nhiddenDirectoryFixture\n');
  assert.equal(search(project, 'legacyDotFixture', config).hits[0].relativePath, '20-context/.md');
  assert.equal(search(project, 'privateHiddenFixture', config).hits.length, 0);
  assert.equal(search(project, 'hiddenDirectoryFixture', config).hits.length, 0);
  for (const invalid of ['# No metadata\nlegacyDotFixture', '---\ntype: secret\ntitle: Wrong type\n---\nlegacyDotFixture', '---\ntype: context\ntitle: ""\n---\nlegacyDotFixture', '---\ntype: context\ntitle: Unsafe\n---\nlegacyDotFixture api_key: unsafeValue']) {
    fs.writeFileSync(file, invalid);
    assert.equal(search(project, 'legacyDotFixture', config).hits.length, 0);
  }
});
test('initialization is explicit and idempotent, notes are non-overwriting and linked', t => {
  const { make, config } = fixture(t), root = make('repo');
  const project = resolveProject(root, config);
  assert.equal(fs.existsSync(config.vaultPath), false);
  assert.throws(() => note(project), /not initialized/);
  initialize(project, config); initialize(project, config);
  const a = note(project), b = note(project);
  assert.notEqual(a.path, b.path);
  assert.ok(fs.readFileSync(a.path, 'utf8').includes(`project: "${project.id}"`));
  assert.ok(a.wikilink.startsWith(`[[packs/${project.packSlug}/70-runbooks/`));
  assert.equal(listProjects(config).length, 1);
});
test('marked plain directories stay bound from child directories after registration', t => {
  const { make, config } = fixture(t), root = make('plain');
  const p = resolveProject(root, config); initialize(p, config);
  const sub = path.join(root, 'nested'); fs.mkdirSync(sub);
  assert.equal(resolveProject(sub, config).id, p.id);
});
test('search is bilingual, scoped, deterministic and bounded', t => {
  const { make, config } = fixture(t);
  const a = resolveProject(make('a'), config), b = resolveProject(make('b'), config);
  initialize(a, config); initialize(b, config);
  note(a); note(b, 'Only other project', '部署 forbiddenOtherProject');
  const result = search(a, '如何部署生产？', config);
  assert.equal(result.hits.length, 1);
  assert.ok(result.hits[0].excerpt.includes('人工批准'));
  assert.equal(search(a, 'forbiddenOtherProject', config).hits.length, 0);
  assert.deepEqual(search(a, 'release.sh', config), search(a, 'release.sh', config));
  assert.ok(brief(a, result, { ...config, contextChars: 1000 }).length <= 1000);
  assert.equal(search(a, '部署', { ...config, maxFiles: 1 }).truncated, true);
});
test('nested marked project is not swallowed by parent registry; prefix siblings are isolated', t => {
  const { make, config } = fixture(t), root = make('repo');
  const parent = resolveProject(root, config); initialize(parent, config);
  const nested = make('repo/child');
  assert.notEqual(resolveProject(nested, config).id, parent.id);
  assert.notEqual(resolveProject(make('repo-other'), config).id, parent.id);
});
test('project config explicitly shares an id and pack across checkouts', t => {
  const { make, config } = fixture(t);
  const a = resolveProject(make('repo-a'), config); initialize(a, config);
  const b = make('repo-b'); fs.mkdirSync(path.join(b, '.pi'));
  fs.writeFileSync(path.join(b, '.pi/project-memory.json'), JSON.stringify({ id: a.id, name: 'shared' }));
  const shared = resolveProject(b, config);
  assert.equal(shared.packPath, a.packPath);
  assert.equal(shared.name, 'shared');
});
test('adoption registers an existing legacy pack without modifying it', t => {
  const { make, config } = fixture(t);
  const p = resolveProject(make('project'), config), pack = make('legacy-pack', null);
  const file = path.join(pack, 'legacy.md'); fs.writeFileSync(file, '---\ntype: context\ntitle: Legacy architecture\n---\n# Legacy\nUses PostgreSQL.\n');
  const before = fs.readFileSync(file);
  adoptPack(p, pack, config);
  assert.deepEqual(fs.readdirSync(pack), ['legacy.md']);
  assert.deepEqual(fs.readFileSync(file), before);
  const resolved = resolveProject(p.root, config);
  assert.equal(resolved.packPath, pack);
  assert.equal(search(resolved, 'PostgreSQL', config).hits.length, 1);
  assert.ok(note(resolved).wikilink.startsWith('[[packs/legacy-pack/'));
});
test('a pack root symlink is allowed; descendant note symlinks are not', t => {
  const { make, config } = fixture(t);
  const p = resolveProject(make('repo'), config), pack = make('external', null);
  fs.mkdirSync(path.dirname(p.packPath), { recursive: true }); fs.symlinkSync(pack, p.packPath);
  initialize(p, config); note(p);
  const outside = make('outside', null);
  fs.rmdirSync(path.join(pack, '50-decisions'));
  fs.writeFileSync(path.join(outside, 'hidden.md'), 'Hidden external memory needleSecret');
  fs.symlinkSync(outside, path.join(pack, '50-decisions'));
  assert.equal(search(p, 'needleSecret', config).hits.length, 0);
});
test('save refuses malicious note directory symlinks without modifying targets', t => {
  const { make, config } = fixture(t);
  const p = resolveProject(make('repo'), config); initialize(p, config);
  fs.rmdirSync(path.join(p.packPath, '70-runbooks'));
  const outside = make('outside', null); fs.symlinkSync(outside, path.join(p.packPath, '70-runbooks'));
  assert.throws(() => note(p), /Unsafe note directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('sensitive content is blocked at save and omitted from retrieval', t => {
  const { make, config } = fixture(t), p = resolveProject(make('repo'), config); initialize(p, config);
  for (const value of ['password = unsafePassword', 'https://user:pass@example.org', '-----BEGIN PRIVATE KEY-----', `ghp_${'A'.repeat(36)}`]) assert.throws(() => assertSafe(value), /secret-looking/);
  assert.throws(() => note(p, 'Credentials', 'api_key: unsafeValue'), /secret-looking/);
  fs.writeFileSync(path.join(p.packPath, 'secret.md'), 'Deployment token: unsafeValue');
  assert.equal(search(p, 'Deployment', config).hits.length, 0);
});
test('malformed configs, path traversal, invalid note data and limits are rejected', t => {
  const { make, config } = fixture(t), root = make('repo'); fs.mkdirSync(path.join(root, '.pi'));
  const local = path.join(root, '.pi/project-memory.json');
  fs.writeFileSync(local, '{bad'); assert.throws(() => resolveProject(root, config), /Cannot read/);
  fs.writeFileSync(local, JSON.stringify({ id: '../escape' })); assert.throws(() => resolveProject(root, config), /Invalid project id/);
  fs.writeFileSync(local, JSON.stringify({ id: 'valid-id' }));
  const p = resolveProject(root, config); initialize(p, config);
  assert.throws(() => saveNote(p, { type: 'bad', title: 'x', content: 'x' }), /Invalid note type/);
  assert.throws(() => note(p, 'bad\ntitle'), /Title/);
  assert.throws(() => search(p, '', config), /Query/);
  assert.throws(() => search(p, 'x', config, 99), /Limit/);
  fs.writeFileSync(path.join(config.vaultPath, 'projects/broken.json'), 'null');
  assert.throws(() => listProjects(config), /JSON object/);
});
test('disabled projects do not read or write memory', t => {
  const { make, config } = fixture(t), root = make('repo'); fs.mkdirSync(path.join(root, '.pi'));
  fs.writeFileSync(path.join(root, '.pi/project-memory.json'), '{"enabled":false}');
  const p = resolveProject(root, config);
  assert.equal(search(p, 'query', config).hits.length, 0);
  assert.throws(() => initialize(p, config), /disabled/);
  assert.throws(() => note(p), /disabled/);
});
test('registry conflicts do not overwrite binding or create conflicting packs', t => {
  const { make, config } = fixture(t), root = make('repo'), p = resolveProject(root, config);
  initialize(p, config);
  const pack = make('another-pack', null);
  assert.throws(() => adoptPack(p, pack, config), /already bound/);
  assert.equal(resolveProject(root, config).packPath, p.packPath);
});
test('CLI init, JSON save and search roundtrip without touching real user config', t => {
  const { make, config } = fixture(t), root = make('repo');
  const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, PI_PROJECT_MEMORY_HOME: config.vaultPath, PI_PROJECT_MEMORY_CONFIG: path.join(root, 'missing-config.json') }, input, encoding: 'utf8' });
  assert.equal(run(['init']).status, 0);
  const saved = run(['save'], JSON.stringify({ type: 'context', title: 'Architecture', content: 'Service uses PostgreSQL.' }));
  assert.equal(saved.status, 0, saved.stderr);
  const found = run(['search', 'PostgreSQL']); assert.equal(found.status, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).hits.length, 1);
  assert.notEqual(run(['save'], '{bad').status, 0);
});
