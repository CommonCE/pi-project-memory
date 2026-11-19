import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initialize, readNote, readState, save } from '../src/memory.mjs';

const host = process.env.PI_TEST_HOST_PACKAGE;
test('Pi entry refreshes ephemeral context after corrections, withdrawal and project switches', { skip: !host && 'Set PI_TEST_HOST_PACKAGE to verify the installed host API' }, async t => {
  assert.ok(path.isAbsolute(host) && fs.statSync(host).isFile(), 'Host package.json must exist at an absolute path');
  const require = createRequire(host), metadata = JSON.parse(fs.readFileSync(host, 'utf8'));
  const runtime = metadata.exports?.['.']?.import;
  assert.equal(typeof runtime, 'string', 'Host must expose its documented ESM API');
  const { createJiti } = require('jiti');
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
    '@earendil-works/pi-coding-agent': path.resolve(path.dirname(host), runtime),
    typebox: require.resolve('typebox'),
  } });
  const extension = await jiti.import(fileURLToPath(new URL('../index.ts', import.meta.url)), { default: true });
  const handlers = new Map(), commands = new Map(), tools = new Map(), notifications = [];
  extension({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    registerTool: tool => tools.set(tool.name, tool), sendMessage: message => notifications.push(message) });
  assert.deepEqual([...commands.keys()], ['memory-init', 'memory']);
  assert.deepEqual([...tools.keys()], ['project_memory_search', 'project_memory_save']);
  assert.equal(handlers.has('agent_end'), false, 'No automatic extraction or persistence');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-notes-extension-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'first'), other = path.join(temp, 'other');
  fs.mkdirSync(root); fs.mkdirSync(other);
  fs.writeFileSync(path.join(root, '.pi-root'), ''); fs.writeFileSync(path.join(other, '.pi-root'), '');
  const project = initialize(root); initialize(other);
  const current = save(project, { target: 'state', expected: null, content: 'Inspect SCF input; blocker at calc/a/run.out; no calculation authorization.' });
  const first = save(project, { target: 'note', title: 'SCF fixture', content: 'SCF OLD_FALSE_CLAIM', sources: ['fixture/run.out:7'], conditions: 'Synthetic fixture only.', status: 'active' });
  const ctx = { cwd: root, hasUI: false };
  const event = { messages: [{ role: 'user', content: 'Continue SCF', timestamp: 1 }, { role: 'custom', customType: 'project-memory-context', content: 'STALE_INJECTION', timestamp: 2 }] };
  await handlers.get('session_start')({}, ctx);
  await handlers.get('before_agent_start')({ messageType: 'user', prompt: 'Continue SCF' }, ctx);
  const context = await handlers.get('context')(event, ctx);
  assert.equal(context.messages.filter(message => message.customType === 'project-memory-context').length, 1);
  assert.match(context.messages.at(-1).content, /OLD_FALSE_CLAIM/);
  assert.doesNotMatch(context.messages.at(-1).content, /STALE_INJECTION/);
  const toolsSave = tools.get('project_memory_save'), toolsSearch = tools.get('project_memory_search');
  const read = await toolsSearch.execute('read', { id: first.id }, undefined, undefined, ctx);
  assert.equal(read.details.expected, first.expected);
  await toolsSave.execute('correct', { target: 'note', id: first.id, expected: first.expected, content: 'SCF corrected; no converged energy.' }, undefined, undefined, ctx);
  const corrected = await handlers.get('context')({ messages: context.messages }, ctx);
  assert.doesNotMatch(corrected.messages.at(-1).content, /OLD_FALSE_CLAIM/);
  assert.match(corrected.messages.at(-1).content, /no converged energy/);
  const now = readNote(project, first.id);
  await toolsSave.execute('withdraw', { target: 'note', id: first.id, expected: now.expected, status: 'inactive' }, undefined, undefined, ctx);
  const withdrawn = await handlers.get('context')({ messages: corrected.messages }, ctx);
  assert.doesNotMatch(withdrawn.messages.at(-1).content, /no converged energy/);
  await toolsSave.execute('state', { target: 'state', expected: current.expected, content: 'New task: inspect parser source.' }, undefined, undefined, ctx);
  assert.equal(readState(project).content, 'New task: inspect parser source.');
  const switched = await handlers.get('context')({ messages: withdrawn.messages }, { ...ctx, cwd: other });
  assert.doesNotMatch(switched.messages.at(-1).content, /calc\/a|SCF|parser/);
  assert.equal(switched.messages.filter(message => message.customType === 'project-memory-context').length, 1);
  // Storage corruption must drop old context and issue a visible diagnostic.
  const file = path.join(project.memory, 'state.md'); fs.writeFileSync(file, 'broken');
  const failed = await handlers.get('context')({ messages: withdrawn.messages }, ctx);
  assert.equal(failed.messages.filter(message => message.customType === 'project-memory-context').length, 0);
  assert.ok(notifications.some(message => /Memory context unavailable/.test(message.content)));
});
