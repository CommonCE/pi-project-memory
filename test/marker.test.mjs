import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adoptPack, brief, discoverRoot, initialize, loadConfig, resolveProject, saveNote, search } from '../src/core.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-memory-marker-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  const config = loadConfig({ home: path.join(temp, 'home'), env: {} });
  return { temp, root, config };
}
const input = { type: 'context', title: 'Architecture', content: 'Service uses PostgreSQL.' };

test('no marker disables memory even in git with enabled local config and packPath', t => {
  const { root, config } = fixture(t);
  fs.mkdirSync(path.join(root, '.git')); fs.mkdirSync(path.join(root, '.pi'));
  fs.writeFileSync(path.join(root, '.pi/project-memory.json'), JSON.stringify({ enabled: true, id: 'bypass', packPath: '/nonexistent' }));
  const p = resolveProject(root, config);
  assert.equal(discoverRoot(root), null);
  assert.equal(p.enabled, false); assert.equal(p.packPath, null); assert.equal(p.id, null);
  assert.equal(search(p, 'PostgreSQL', config).hits.length, 0);
  assert.throws(() => initialize(p, config), /\.pi-root/);
  assert.throws(() => saveNote(p, input), /\.pi-root/);
  assert.throws(() => adoptPack(p, '/nonexistent', config), /\.pi-root/);
  assert.equal(fs.existsSync(config.vaultPath), false);
});
test('no marker avoids reading even malformed project config and registry', t => {
  const { root, config } = fixture(t);
  fs.mkdirSync(path.join(root, '.pi')); fs.writeFileSync(path.join(root, '.pi/project-memory.json'), '{bad');
  fs.mkdirSync(path.join(config.vaultPath, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(config.vaultPath, 'projects/broken.json'), '{bad');
  const p = resolveProject(root, config, 'bypass');
  assert.equal(p.enabled, false); assert.equal(p.selected, false);
});
test('existing registry and manual selection cannot activate an unmarked cwd', t => {
  const { temp, root, config } = fixture(t);
  fs.writeFileSync(path.join(root, '.pi-root'), '');
  const old = resolveProject(root, config); initialize(old, config); saveNote(old, input);
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  assert.equal(resolveProject(outside, config, old.id).enabled, false);
  fs.unlinkSync(path.join(root, '.pi-root'));
  assert.equal(resolveProject(root, config, old.id).enabled, false);
  assert.equal(resolveProject(root, config).enabled, false);
});
test('removing a marker revokes previously resolved handles for every read/write operation', t => {
  const { root, config } = fixture(t); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const p = resolveProject(root, config); initialize(p, config); saveNote(p, input);
  const result = search(p, 'PostgreSQL', config); assert.equal(result.hits.length, 1);
  fs.unlinkSync(path.join(root, '.pi-root'));
  assert.equal(search(p, 'PostgreSQL', config).hits.length, 0);
  assert.equal(brief(p, result, config), '');
  assert.throws(() => initialize(p, config), /disabled/);
  assert.throws(() => saveNote(p, input), /disabled/);
  assert.throws(() => adoptPack(p, p.packPath, config), /disabled/);
});
test('a directory named .pi-root does not count as a marker file', t => {
  const { root, config } = fixture(t); fs.mkdirSync(path.join(root, '.pi-root'));
  assert.equal(resolveProject(root, config).enabled, false);
});
test('nearest ancestor marker defines scope regardless of git or nested configuration', t => {
  const { root, config } = fixture(t); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const child = path.join(root, 'subrepo'); fs.mkdirSync(child); fs.writeFileSync(path.join(child, '.git'), 'gitdir: /unused');
  fs.mkdirSync(path.join(child, '.pi')); fs.writeFileSync(path.join(child, '.pi/project-memory.json'), '{bad');
  assert.equal(resolveProject(child, config).root, root);
  fs.writeFileSync(path.join(child, '.pi-root'), ''); fs.writeFileSync(path.join(child, '.pi/project-memory.json'), '{}');
  assert.equal(resolveProject(child, config).root, child);
});
test('manual selection requires the selected target to retain its own marker', t => {
  const { temp, root, config } = fixture(t); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const p = resolveProject(root, config); initialize(p, config);
  const other = path.join(temp, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, '.pi-root'), '');
  const target = resolveProject(other, config); initialize(target, config);
  const selected = resolveProject(root, config, target.id);
  assert.equal(selected.enabled, true);
  fs.unlinkSync(path.join(other, '.pi-root'));
  assert.equal(search(selected, 'query', config).hits.length, 0);
  assert.throws(() => saveNote(selected, input), /disabled/);
  assert.throws(() => resolveProject(root, config, target.id), /own .pi-root/);
});
test('CLI without marker reports NO-MEMORY and rejects init/save/adopt/projects without writes', t => {
  const { root, config } = fixture(t);
  const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, PI_PROJECT_MEMORY_HOME: config.vaultPath, PI_PROJECT_MEMORY_CONFIG: path.join(root, 'missing.json') }, input, encoding: 'utf8' });
  const status = run(['status']); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).name, 'NO-MEMORY');
  const found = run(['search', 'PostgreSQL']); assert.equal(found.status, 0); assert.equal(JSON.parse(found.stdout).hits.length, 0);
  for (const [args, stdin] of [[['init']], [['save'], JSON.stringify(input)], [['adopt', '/nonexistent']], [['projects']]]) {
    const result = run(args, stdin); assert.equal(result.status, 1); assert.match(result.stderr, /\.pi-root/);
  }
  assert.equal(fs.existsSync(config.vaultPath), false);
});
