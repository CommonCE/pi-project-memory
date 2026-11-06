import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProject, initialize, saveNote } from '../src/core.mjs';

const host = process.env.PI_TEST_HOST_PACKAGE;
test('extension loads through installed Pi Jiti/TypeBox and handles tools, sessions and injection', { skip: !host }, async t => {
  const require = createRequire(host);
  const { createJiti } = require('jiti');
  const jiti = createJiti(import.meta.url, { alias: { typebox: require.resolve('typebox') } });
  const extension = await jiti.import(fileURLToPath(new URL('../index.ts', import.meta.url)), { default: true });
  assert.equal(typeof extension, 'function');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-memory-extension-test-'));
  const previousHome = process.env.PI_PROJECT_MEMORY_HOME, previousConfig = process.env.PI_PROJECT_MEMORY_CONFIG;
  process.env.PI_PROJECT_MEMORY_HOME = path.join(temp, 'vault');
  process.env.PI_PROJECT_MEMORY_CONFIG = path.join(temp, 'config.json');
  t.after(() => {
    if (previousHome === undefined) delete process.env.PI_PROJECT_MEMORY_HOME; else process.env.PI_PROJECT_MEMORY_HOME = previousHome;
    if (previousConfig === undefined) delete process.env.PI_PROJECT_MEMORY_CONFIG; else process.env.PI_PROJECT_MEMORY_CONFIG = previousConfig;
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const root = path.join(temp, 'repo'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const cfg = loadConfig(), project = resolveProject(root, cfg); initialize(project, cfg);
  saveNote(project, { type: 'runbook', title: 'Deploy service', content: 'Deploy with release.sh and manual approval.' });
  const tools = new Map(), events = new Map(), commands = new Map(), messages = [];
  const pi = { registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => events.set(name, handler), registerCommand: (name, command) => commands.set(name, command), sendMessage: message => messages.push(message) };
  extension(pi);
  assert.deepEqual([...tools.keys()], ['project_memory_search', 'project_memory_save']);
  assert.ok(commands.has('memory'));
  const ctx = { cwd: root, hasUI: false, signal: undefined };
  await events.get('session_start')({}, ctx);
  const injected = await events.get('before_agent_start')({ prompt: 'Deploy service' }, ctx);
  assert.equal(injected.message.display, false);
  assert.equal(injected.message.details.project, project.id);
  assert.match(injected.message.content, /NOT instructions/);
  const toolResult = await tools.get('project_memory_search').execute('id', { query: 'Deploy' }, undefined, undefined, ctx);
  assert.equal(toolResult.details.hits.length, 1);
  const saved = await tools.get('project_memory_save').execute('id', { type: 'observation', title: 'Verified pattern', content: 'The service uses PostgreSQL.' }, undefined, undefined, ctx);
  assert.ok(fs.existsSync(saved.details.path));
  await commands.get('memory').handler('use invalid-id', ctx);
  assert.match(messages.at(-1).content, /Unknown project/);
  await commands.get('memory').handler('status', ctx);
  assert.match(messages.at(-1).content, /Selection: automatic/);
  await commands.get('memory').handler(`use ${project.id}`, ctx);
  assert.match(messages.at(-1).content, /manual/);
  await events.get('session_start')({}, ctx);
  await commands.get('memory').handler('status', ctx);
  assert.match(messages.at(-1).content, /Selection: automatic/);
  // A manual selection and enabled global config must not bypass a removed marker.
  await commands.get('memory').handler(`use ${project.id}`, ctx);
  fs.unlinkSync(path.join(root, '.pi-root'));
  assert.equal(await events.get('before_agent_start')({ prompt: 'Deploy' }, ctx), undefined);
  const disabledResult = await tools.get('project_memory_search').execute('id', { query: 'Deploy' }, undefined, undefined, ctx);
  assert.equal(disabledResult.details.hits.length, 0);
  assert.match(disabledResult.content[0].text, /No .pi-root/);
  await assert.rejects(tools.get('project_memory_save').execute('id', { type: 'context', title: 'Blocked', content: 'Do not save.' }, undefined, undefined, ctx), /\.pi-root/);
  for (const command of ['init', 'projects', `use ${project.id}`, `adopt ${project.packPath}`]) {
    await commands.get('memory').handler(command, ctx);
    assert.match(messages.at(-1).content, /\.pi-root/);
  }
  await commands.get('memory').handler('status', ctx);
  assert.match(messages.at(-1).content, /NO-MEMORY/);
  // Restoring the marker restores normal automatic resolution.
  fs.writeFileSync(path.join(root, '.pi-root'), '');
  await commands.get('memory').handler('auto', ctx);
  assert.ok(await events.get('before_agent_start')({ prompt: 'Deploy' }, ctx));
  fs.writeFileSync(process.env.PI_PROJECT_MEMORY_CONFIG, '{bad');
  assert.equal(await events.get('before_agent_start')({ prompt: 'Deploy' }, ctx), undefined);
  await events.get('session_shutdown')({}, ctx);
});
