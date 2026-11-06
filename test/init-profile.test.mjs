import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { effectiveConfig, initialize, loadConfig, resolveProject } from '../src/core.mjs';
import { parseSetupArgs, setupProject } from '../src/setup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-init-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = loadConfig({ home: path.join(root, 'home'), env: {} });
  return { root, cfg, localFile: path.join(root, '.pi/project-memory.json') };
}
test('init arguments support profiles, either order, equals and quoted names', () => {
  for (const args of ['科研项目 --profile qchem', '--profile=qchem 科研项目', ['科研项目', '--profile', 'qchem']]) {
    assert.deepEqual(parseSetupArgs(args), { name: '科研项目', profile: 'qchem' });
  }
  assert.deepEqual(parseSetupArgs('--profile default'), { name: undefined, profile: 'default' });
  assert.equal(parseSetupArgs('"Project with spaces" --profile qchem').name, 'Project with spaces');
  assert.equal(parseSetupArgs('Project with spaces --profile qchem').name, 'Project with spaces');
  assert.deepEqual(parseSetupArgs('  '), { name: undefined, profile: undefined });
  for (const args of ['--profile', '--profile unknown', '--profile qchem --profile default', '--other', '"unterminated', ['too', 'many']]) assert.throws(() => parseSetupArgs(args));
});
test('new project stores requested profile; same-profile rerun preserves bytes; different-profile fails', t => {
  const h = fixture(t);
  const project = setupProject(h.root, h.cfg, '科研项目', 'qchem');
  assert.equal(effectiveConfig(h.cfg, project).maxItems, 8);
  assert.equal(JSON.parse(fs.readFileSync(h.localFile, 'utf8')).profile, 'qchem');
  const before = fs.readFileSync(h.localFile);
  setupProject(h.root, h.cfg, undefined, 'qchem');
  assert.deepEqual(fs.readFileSync(h.localFile), before);
  assert.throws(() => setupProject(h.root, h.cfg, undefined, 'default'), /different profile/);
  assert.deepEqual(fs.readFileSync(h.localFile), before);
});
test('invalid profile fails before creating a marker or configuration', t => {
  const h = fixture(t);
  assert.throws(() => setupProject(h.root, h.cfg, undefined, 'invalid'), /profile/);
  assert.deepEqual(fs.readdirSync(h.root), []);
});
test('registered pack without local config gets profile only, preserving its binding and notes', t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.root, '.pi-root'), '');
  const project = resolveProject(h.root, h.cfg); initialize(project, h.cfg);
  const note = path.join(project.packPath, '20-context/old.md'); fs.writeFileSync(note, '# Keep unchanged');
  const updated = setupProject(h.root, h.cfg, undefined, 'qchem');
  assert.equal(updated.packPath, project.packPath);
  assert.equal(fs.readFileSync(note, 'utf8'), '# Keep unchanged');
  assert.deepEqual(JSON.parse(fs.readFileSync(h.localFile, 'utf8')), { profile: 'qchem' });
});
test('pi-memory-init and setup CLI persist profile and reject malformed options without writes', t => {
  const h = fixture(t);
  const env = { ...process.env, PI_PROJECT_MEMORY_HOME: h.cfg.vaultPath, PI_PROJECT_MEMORY_CONFIG: path.join(h.root, 'missing.json') };
  const init = fileURLToPath(new URL('../bin/pi-memory-init.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: h.root, env, encoding: 'utf8' });
  assert.equal(run(init, ['--profile']).status, 1);
  assert.equal(fs.existsSync(path.join(h.root, '.pi-root')), false);
  const first = run(init, ['Project with spaces', '--profile', 'qchem']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).settings.profile, 'qchem');
  assert.equal(run(cli, ['setup', '--profile=qchem']).status, 0);
  assert.equal(run(cli, ['setup', '--profile=default']).status, 1);
});
