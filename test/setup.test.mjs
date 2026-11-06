import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProject, initialize } from '../src/core.mjs';
import { setupProject } from '../src/setup.mjs';
import { enqueueCandidate } from '../src/learning.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-setup-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo with spaces'); fs.mkdirSync(root);
  const config = loadConfig({ home: path.join(temp, 'home'), env: {} });
  return { temp, root, config };
}
test('explicit setup creates marker and project-local configuration; rerun preserves every file', t => {
  const { root, config } = fixture(t);
  const project = setupProject(root, config, '科研项目');
  assert.equal(project.root, root); assert.equal(project.name, '科研项目');
  assert.equal(project.packPath, path.join(root, 'pi-memory/packs/科研项目'));
  assert.equal(fs.readFileSync(path.join(root, '.pi-root'), 'utf8'), '');
  const before = fs.readFileSync(path.join(root, '.pi/project-memory.json'));
  assert.equal(setupProject(root, config).packPath, project.packPath);
  assert.deepEqual(fs.readFileSync(path.join(root, '.pi/project-memory.json')), before);
  assert.throws(() => setupProject(root, config, 'Different'), /already configured/);
});
test('setup from a subdirectory respects nearest existing project boundary', t => {
  const { root, config } = fixture(t);
  const project = setupProject(root, config);
  const sub = path.join(root, 'src'); fs.mkdirSync(sub);
  assert.equal(setupProject(sub, config).id, project.id);
  assert.equal(fs.existsSync(path.join(sub, '.pi-root')), false);
});
test('existing pi-init legacy pack is selected without changing marker or existing notes', t => {
  const { root, config } = fixture(t);
  fs.writeFileSync(path.join(root, '.pi-root'), 'legacy marker');
  const pack = path.join(root, 'pi-memory/packs/old-pack'); fs.mkdirSync(pack, { recursive: true });
  const file = path.join(pack, 'legacy.md'); fs.writeFileSync(file, '# Previous notes\nKeep these intact.\n');
  const before = fs.readFileSync(file);
  assert.equal(setupProject(root, config).packPath, pack);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readFileSync(path.join(root, '.pi-root'), 'utf8'), 'legacy marker');
});
test('multiple legacy packs require an explicit matching name and do not create a marker on failure', t => {
  const { root, config } = fixture(t);
  for (const name of ['alpha', 'beta']) fs.mkdirSync(path.join(root, 'pi-memory/packs', name), { recursive: true });
  assert.throws(() => setupProject(root, config), /Multiple legacy packs/);
  assert.throws(() => setupProject(root, config, 'gamma'), /does not match/);
  assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
  assert.equal(setupProject(root, config, 'beta').packSlug, 'beta');
});
test('existing registered central pack and existing local config are never rebound', t => {
  const { root, config } = fixture(t);
  fs.writeFileSync(path.join(root, '.pi-root'), '');
  const central = { ...resolveProject(root, config), packPath: path.join(config.vaultPath, 'packs/existing-central'), packSlug: 'existing-central' }; initialize(central, config);
  assert.equal(setupProject(root, config).packPath, central.packPath);
  assert.equal(fs.existsSync(path.join(root, '.pi/project-memory.json')), false);
});
test('disabled configuration, invalid names, marker directories and unsafe project directories are rejected', t => {
  const { root, config, temp } = fixture(t);
  assert.throws(() => setupProject(root, { ...config, enabled: false }), /globally disabled/);
  assert.throws(() => setupProject(root, config, 'bad\nname'), /one nonempty line/);
  fs.mkdirSync(path.join(root, '.pi-root'));
  assert.throws(() => setupProject(root, config), /regular file/);
  fs.rmdirSync(path.join(root, '.pi-root'));
  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, '.pi'));
  assert.throws(() => setupProject(root, config), /Unsafe project .pi/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
});
test('invalid or disabled existing local configuration is rejected before marker creation', t => {
  const { root, config } = fixture(t);
  fs.mkdirSync(path.join(root, '.pi'));
  const file = path.join(root, '.pi/project-memory.json');
  for (const text of ['{bad', '{"enabled":false}', '{"id":"../escape"}', '{"learningMode":"invalid"}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => setupProject(root, config));
    assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
test('legacy pack symlinks require explicit inspection/adoption rather than implicit selection', t => {
  const { root, config, temp } = fixture(t);
  const packs = path.join(root, 'pi-memory/packs'); fs.mkdirSync(packs, { recursive: true });
  const target = path.join(temp, 'external'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(packs, 'external'));
  assert.throws(() => setupProject(root, config), /symlink found/);
  assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
  assert.deepEqual(fs.readdirSync(target), []);
});
test('CLI setup and review work with spaced paths and fail closed without a marker', t => {
  const { root, config } = fixture(t);
  const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const init = fileURLToPath(new URL('../bin/pi-memory-init.mjs', import.meta.url));
  const env = { ...process.env, PI_PROJECT_MEMORY_HOME: config.vaultPath, PI_PROJECT_MEMORY_CONFIG: path.join(root, 'missing.json') };
  const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run(['review']).status, 1);
  assert.equal(spawnSync(process.execPath, [init, 'Spaced project'], { cwd: root, env }).status, 0);
  const project = resolveProject(root, config);
  const record = enqueueCandidate(project, { type: 'observation', title: 'Checks', content: 'The release procedure requires successful tests.' }, config);
  assert.equal(JSON.parse(run(['review']).stdout).length, 1);
  assert.equal(run(['review', 'show', record.id.slice(0, 12)]).status, 0);
  assert.equal(run(['review', 'approve', record.id]).status, 0);
  assert.equal(JSON.parse(run(['review']).stdout).length, 0);
  assert.equal(JSON.parse(run(['review', 'all']).stdout)[0].status, 'approved');
  assert.equal(run(['review', 'approve']).status, 1);
});
test('optional CLI initialization and status work without shell integration', t => {
  assert.equal(fs.existsSync(new URL('../examples/bashrc.sh', import.meta.url)), false);
  const { root, config } = fixture(t);
  const init = fileURLToPath(new URL('../bin/pi-memory-init.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const env = { ...process.env, PI_PROJECT_MEMORY_HOME: config.vaultPath, PI_PROJECT_MEMORY_CONFIG: path.join(root, 'missing.json') };
  const initialized = spawnSync(process.execPath, [init, 'CLI project'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const status = spawnSync(process.execPath, [cli, 'status'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /CLI project/);
});
