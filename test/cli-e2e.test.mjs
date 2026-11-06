import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveProject, search } from '../src/core.mjs';
import { setupProject } from '../src/setup.mjs';
import { listCandidates } from '../src/learning.mjs';

test('M5 v2 CLI scopes saves/search and exposes explicit folder views', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-cli-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root'); fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  const bin = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
  const run = (args, cwd = root, value) => spawnSync(process.execPath, [bin, 'v2', ...args], {
    cwd, encoding: 'utf8', timeout: 10000, input: value === undefined ? undefined : JSON.stringify(value),
    env: { PATH: process.env.PATH, HOME: temp, PI_OFFLINE: '1' },
  });
  assert.equal(run(['init']).status, 0);
  assert.equal(run(['save'], path.join(root, 'a'), { entry: { kind: 'methods', title: 'local scope', content: 'SCOPEDMARKER' } }).status, 0);
  assert.equal(JSON.parse(run(['search', 'SCOPEDMARKER']).stdout).hits.length, 0);
  assert.equal(JSON.parse(run(['search', 'SCOPEDMARKER', '--folder', 'a']).stdout).hits[0].scope.path, 'a');
  assert.equal(JSON.parse(run(['search', '--all-folders', 'SCOPEDMARKER']).stdout).hits.length, 1);
  assert.equal(run(['search', 'SCOPEDMARKER', '--folder']).status, 1);
  assert.equal(run(['folder', 'list']).status, 0);
  assert.equal(run(['folder', 'rebuild']).status, 0);
  assert.match(JSON.parse(run(['folder', 'show', 'a']).stdout).content, /local scope/);
});

const host = process.env.PI_TEST_HOST_PACKAGE;
const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
const provider = fileURLToPath(new URL('./fixtures/offline-provider.ts', import.meta.url));
const realCli = (name, fn) => test(name, { skip: !host, timeout: 30000 }, fn);
function fixture(t, settings = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-cli-e2e-'));
  const root = path.join(temp, 'repo with spaces'), agent = path.join(temp, 'agent');
  fs.mkdirSync(root); fs.mkdirSync(agent); fs.mkdirSync(path.join(temp, 'home'));
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enableAnalytics: false, enableInstallTelemetry: false, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 0 } }));
  const configFile = path.join(temp, 'memory.json'); fs.writeFileSync(configFile, JSON.stringify(settings));
  // Intentionally exclude the user's credentials, proxy, packages, and settings.
  const env = { PATH: process.env.PATH, HOME: path.join(temp, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agent, PI_PROJECT_MEMORY_HOME: path.join(temp, 'vault'), PI_PROJECT_MEMORY_CONFIG: configFile, PI_MEMORY_TEST_CALLS: path.join(temp, 'calls.jsonl') };
  const config = loadConfig({ env });
  const args = [path.join(path.dirname(host), 'dist/cli.js'), '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-mcp', '--approve', '--provider', 'memory-offline-test', '--model', 'offline', '--thinking', 'off', '--tools', 'project_memory_search,project_memory_save', '--extension', provider, '--extension', entry];
  const calls = () => fs.existsSync(env.PI_MEMORY_TEST_CALLS) ? fs.readFileSync(env.PI_MEMORY_TEST_CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, root, env, config, args, calls };
}
class Rpc {
  constructor(fixture) {
    this.records = []; this.waiters = new Set(); this.stderr = ''; this.buffer = ''; this.sequence = 0;
    this.child = spawn(process.execPath, [...fixture.args, '--mode', 'rpc'], { cwd: fixture.root, env: fixture.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', data => {
      this.buffer += data.toString('utf8');
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, ''); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const record = JSON.parse(line); this.records.push(record);
          for (const waiter of [...this.waiters]) if (this.records.length > waiter.since && waiter.predicate(record)) { waiter.resolve(record); }
        } catch (error) { this.fail(new Error(`Non-JSON RPC output: ${String(error)}`)); }
      }
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-64000); });
    this.exit = new Promise(resolve => {
      this.child.on('error', error => this.fail(error));
      this.child.on('close', code => { this.fail(new Error(`Pi exited (${code}): ${this.stderr}`)); resolve(code); });
    });
  }
  fail(error) { for (const waiter of [...this.waiters]) waiter.reject(error); }
  waitFor(predicate, since = 0) {
    const existing = this.records.slice(since).find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter = { since, predicate, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error(`RPC deadline: ${this.stderr}`)), 20000);
      this.waiters.add(waiter);
    });
  }
  async request(command) {
    const id = `request-${++this.sequence}`;
    const pending = this.waitFor(record => record.type === 'response' && record.id === id);
    this.child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    const result = await pending;
    assert.equal(result.success, true, JSON.stringify(result));
    return result;
  }
  async prompt(message) {
    const since = this.records.length;
    const response = await this.request({ type: 'prompt', message });
    if (response.data.disposition !== 'handled') await this.waitFor(record => record.type === 'agent_settled', since);
    return response;
  }
  async close() {
    if (this.child.exitCode !== null) return this.child.exitCode;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    try { return await this.exit; } finally { clearTimeout(timer); }
  }
}

realCli('real Pi RPC handles init, tool execution, learning, approval, injection and native compaction end-to-end', async t => {
  const f = fixture(t), rpc = new Rpc(f);
  try {
    const commands = await rpc.request({ type: 'get_commands' });
    assert.deepEqual(commands.data.commands.map(command => command.name).sort(), ['memory', 'memory-init']);
    await rpc.prompt('核实发布流程 use_search');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 0);
    assert.equal(fs.existsSync(f.config.vaultPath), false);
    assert.equal(fs.existsSync(path.join(f.root, '.pi-root')), false);
    assert.equal((await rpc.prompt('/memory-init 离线项目 --profile qchem')).data.disposition, 'handled');
    const project = resolveProject(f.root, f.config);
    assert.equal(project.name, '离线项目');
    assert.equal(project.settings.profile, 'qchem');
    await rpc.prompt('核实发布流程 use_search');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 1);
    const pending = listCandidates(project); assert.equal(pending.length, 1);
    assert.equal(search(project, 'release.sh', f.config).hits.length, 0);
    const messages = (await rpc.request({ type: 'get_messages' })).data.messages;
    assert.ok(messages.some(message => message.role === 'toolResult' && message.toolName === 'project_memory_search' && !message.isError));
    await rpc.prompt(`/memory review show ${pending[0].id.slice(0, 12)}`);
    await rpc.prompt(`/memory review approve ${pending[0].id}`);
    await rpc.prompt(`/memory review approve ${pending[0].id}`);
    assert.equal(listCandidates(project).length, 0);
    assert.equal(search(project, 'release.sh', f.config).hits.length, 1);
    await rpc.prompt('release.sh 发布流程 use_search');
    assert.ok(f.calls().filter(call => call.kind === 'assistant').at(-1).injectedNote);
    assert.equal(listCandidates(project, { all: true }).length, 1);
    const curatorCallsBeforeCompact = f.calls().filter(call => call.kind === 'curator').length;
    const compact = await rpc.request({ type: 'compact' });
    assert.match(compact.data.summary, /Next Steps/);
    // Native Pi may summarize history and a split-turn prefix separately.
    assert.ok([1, 2].includes(f.calls().filter(call => call.kind === 'compact').length));
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, curatorCallsBeforeCompact);
    assert.equal(fs.readdirSync(path.join(project.packPath, '80-sessions')).filter(name => name.endsWith('.md')).length, 1);
    const entries = (await rpc.request({ type: 'get_entries' })).data.entries;
    assert.ok(entries.some(entry => entry.type === 'custom' && entry.customType === 'project-memory-usage'));
    assert.ok(entries.some(entry => entry.type === 'compaction'));
    assert.ok(f.calls().every(call => call.tools.every(name => ['project_memory_search', 'project_memory_save'].includes(name))));
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});
realCli('real Pi new_session resets learning override and marker removal disables later learning/handoff', async t => {
  const f = fixture(t), project = setupProject(f.root, f.config), rpc = new Rpc(f);
  try {
    await rpc.prompt('/memory learn off'); await rpc.prompt('验证发布流程');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 0);
    await rpc.request({ type: 'new_session' });
    await rpc.prompt('再次验证发布流程');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 1);
    assert.equal(listCandidates(project).length, 1);
    fs.unlinkSync(path.join(f.root, '.pi-root'));
    await rpc.prompt('不启用记忆的发布流程');
    await rpc.request({ type: 'compact' });
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 1);
    assert.equal(fs.readdirSync(path.join(project.packPath, '80-sessions')).length, 0);
    fs.writeFileSync(path.join(f.root, '.pi-root'), '');
    assert.equal(listCandidates(project).length, 1);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});
realCli('persistent Pi restart restores session and pending queue but not session-only learning override', async t => {
  const f = fixture(t), project = setupProject(f.root, f.config);
  f.args = [...f.args.filter(arg => arg !== '--no-session'), '--session-dir', path.join(f.temp, 'sessions')];
  let rpc = new Rpc(f), sessionFile, sessionId;
  try {
    await rpc.prompt('验证发布流程');
    assert.equal(listCandidates(project).length, 1);
    await rpc.prompt('/memory learn off');
    const state = (await rpc.request({ type: 'get_state' })).data;
    sessionFile = state.sessionFile; sessionId = state.sessionId;
    assert.ok(sessionFile.startsWith(f.temp + path.sep));
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
  assert.ok(fs.existsSync(sessionFile));
  rpc = new Rpc({ ...f, args: [...f.args, '--session', sessionFile] });
  try {
    const state = (await rpc.request({ type: 'get_state' })).data;
    assert.equal(state.sessionId, sessionId);
    const restored = (await rpc.request({ type: 'get_messages' })).data.messages;
    assert.ok(restored.some(message => message.role === 'assistant'));
    await rpc.prompt('/memory status');
    assert.ok(JSON.stringify(rpc.records).includes('Learning: suggest'));
    await rpc.prompt('重启后再次验证发布流程');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 2);
    assert.equal(listCandidates(project).length, 1);
    await rpc.prompt(`/memory review approve ${listCandidates(project)[0].id}`);
    assert.equal(listCandidates(project).length, 0);
    assert.equal(search(project, 'release.sh', f.config).hits.length, 1);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});
realCli('real Pi observes local learning/handoff settings changed between prompts', async t => {
  const f = fixture(t, { learningMode: 'auto' }), project = setupProject(f.root, f.config);
  const localFile = path.join(f.root, '.pi/project-memory.json');
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  fs.writeFileSync(localFile, JSON.stringify({ ...local, learningMode: 'off', handoffEnabled: false }));
  const rpc = new Rpc(f);
  try {
    await rpc.prompt('验证发布流程');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 0);
    await rpc.request({ type: 'compact' });
    assert.equal(fs.readdirSync(path.join(project.packPath, '80-sessions')).length, 0);
    fs.writeFileSync(localFile, JSON.stringify({ ...local, learningMode: 'suggest', handoffEnabled: true }));
    await rpc.prompt('本地设置更新后验证发布流程');
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 1);
    assert.equal(listCandidates(project).length, 1);
    await rpc.request({ type: 'compact' });
    assert.equal(fs.readdirSync(path.join(project.packPath, '80-sessions')).filter(name => name.endsWith('.md')).length, 1);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});
realCli('real Pi 1.2 loads project qchem tuning and reports saved versus pending inventory', async t => {
  const f = fixture(t), project = setupProject(f.root, f.config);
  const localFile = path.join(f.root, '.pi/project-memory.json');
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  fs.writeFileSync(localFile, JSON.stringify({ ...local, profile: 'qchem' }));
  const rpc = new Rpc(f);
  try {
    await rpc.prompt('/memory status');
    assert.ok(JSON.stringify(rpc.records).includes('Profile: qchem'));
    assert.ok(JSON.stringify(rpc.records).includes('Retrieval: 8 notes'));
    await rpc.prompt('验证发布流程');
    const pending = listCandidates(project); assert.equal(pending.length, 1);
    await rpc.prompt('/memory stats');
    const statsMessage = [...rpc.records].reverse().find(record => record.type === 'extension_ui_request' && record.method === 'notify');
    assert.equal(JSON.parse(statsMessage.message).pending, 1);
    assert.equal(JSON.parse(statsMessage.message).searchable, 0);
    await rpc.prompt(`/memory review approve ${pending[0].id}`);
    await rpc.prompt('/memory stats');
    const approvedStats = [...rpc.records].reverse().find(record => record.type === 'extension_ui_request' && record.method === 'notify');
    assert.equal(JSON.parse(approvedStats.message).searchable, 1);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});
realCli('real Pi JSON one-shot auto mode saves learned notes without polluting stdout framing', t => {
  const f = fixture(t, { learningMode: 'auto' }), project = setupProject(f.root, f.config);
  const result = spawnSync(process.execPath, [...f.args, '--mode', 'json', '--print', '验证发布流程'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'agent_end'));
  assert.equal(listCandidates(project).length, 0);
  assert.equal(listCandidates(project, { all: true })[0].status, 'approved');
  assert.equal(search(project, 'release.sh', f.config).hits.length, 1);
  assert.equal(f.calls().filter(call => call.kind === 'curator').length, 1);
});
realCli('real Pi print mode can execute explicit initialization without any provider call', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [...f.args, '--print', '/memory-init Print项目'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(resolveProject(f.root, f.config).name, 'Print项目');
  assert.equal(f.calls().length, 0);
});
