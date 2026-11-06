import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeV2, resolveV2, getV2, statusV2 } from '../src/v2-store.mjs';
import { listCandidatesV2 } from '../src/v2-candidates.mjs';
import { readWorkingV2 } from '../src/v2-working.mjs';

const host = process.env.PI_TEST_HOST_PACKAGE;
const integration = (name, fn) => test(name, { skip: !host, timeout: 30000 }, fn);
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-host-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'), agent = path.join(temp, 'agent'), home = path.join(temp, 'home');
  fs.mkdirSync(root); fs.mkdirSync(agent); fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated host fixture');
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ enableAnalytics: false, enableInstallTelemetry: false, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 0 } }));
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agent, PI_MEMORY_TEST_CALLS: path.join(temp, 'calls.jsonl') };
  const args = [path.join(path.dirname(host), 'dist/cli.js'), '--offline', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-mcp', '--approve',
    '--provider', 'memory-offline-test', '--model', 'offline', '--thinking', 'off', '--tools', 'project_memory_search,project_memory_save',
    '--extension', fileURLToPath(new URL('./fixtures/offline-provider.ts', import.meta.url)), '--extension', fileURLToPath(new URL('../v2.ts', import.meta.url))];
  const calls = () => fs.existsSync(env.PI_MEMORY_TEST_CALLS) ? fs.readFileSync(env.PI_MEMORY_TEST_CALLS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const run = prompt => spawnSync(process.execPath, [...args, '--mode', 'json', '--print', prompt], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  return { temp, root, env, args, calls, run };
}
class Rpc {
  constructor(f) {
    this.records = []; this.buffer = ''; this.stderr = ''; this.waiters = new Set(); this.sequence = 0;
    this.child = spawn(process.execPath, [...f.args, '--mode', 'rpc'], { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', data => {
      this.buffer += data;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line); this.records.push(value);
          for (const waiter of [...this.waiters]) if (this.records.length > waiter.since && waiter.check(value)) waiter.resolve(value);
        } catch (error) { for (const waiter of [...this.waiters]) waiter.reject(error); }
      }
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-16000); });
    this.closed = new Promise(resolve => this.child.on('close', code => { for (const waiter of [...this.waiters]) waiter.reject(new Error(`Host exited ${code}: ${this.stderr}`)); resolve(code); }));
  }
  wait(check, since = 0) {
    const found = this.records.slice(since).find(check); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const finish = fn => value => { clearTimeout(timer); this.waiters.delete(waiter); fn(value); };
      const waiter = { check, since, resolve: finish(resolve), reject: finish(reject) };
      const timer = setTimeout(() => waiter.reject(new Error(`RPC timeout: ${this.stderr}`)), 15000); this.waiters.add(waiter);
    });
  }
  async request(value) {
    const id = `v2-${++this.sequence}`, pending = this.wait(record => record.type === 'response' && record.id === id);
    this.child.stdin.write(JSON.stringify({ ...value, id }) + '\n');
    const response = await pending; assert.equal(response.success, true, JSON.stringify(response)); return response;
  }
  async prompt(message) {
    const since = this.records.length, response = await this.request({ type: 'prompt', message });
    if (response.data.disposition !== 'handled') await this.wait(record => record.type === 'agent_settled', since);
  }
  async close() {
    if (this.child.exitCode !== null) return this.child.exitCode;
    this.child.stdin.end(); const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try { return await this.closed; } finally { clearTimeout(timer); }
  }
}

integration('M7 real offline host dispatches manual brief without model calls or pack writes', async t => {
  const f = fixture(t), project = initializeV2(f.root);
  const snapshot = () => fs.readdirSync(project.memory, { recursive: true }).sort()
    .filter(name => fs.statSync(path.join(project.memory, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(project.memory, name)).toString('base64')]);
  const before = snapshot(), printed = f.run('/memory brief');
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /No prior memory/);
  const rpc = new Rpc(f); t.after(() => { if (rpc.child.exitCode === null) rpc.child.kill('SIGKILL'); });
  try {
    await rpc.prompt('/memory brief');
    const notice = await rpc.wait(record => record.type === 'extension_ui_request' && record.method === 'notify');
    const brief = JSON.parse(notice.message);
    assert.equal(brief.folder, '.'); assert.equal(brief.chars, brief.content.length); assert(brief.chars <= 1200);
    assert.match(brief.content, /No prior memory/);
    assert.equal(f.calls().length, 0);
    assert.deepEqual(snapshot(), before);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});

integration('real M3 JSON uses one offline curator, queues review, and manual approval makes no extra request', t => {
  const f = fixture(t), project = initializeV2(f.root);
  const response = f.run('检查合成解析器项目 v2_work_fixture');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(f.calls().filter(call => call.kind === 'v2-curator').length, 1);
  assert.ok(f.calls().filter(call => call.kind === 'v2-curator').every(call => call.tools.length === 0));
  const [candidate] = listCandidatesV2(project).candidates;
  assert.equal(candidate.status, 'pending'); assert.equal(statusV2(project).records, 0);
  const before = f.calls().length;
  const approved = f.run(`/memory review ${candidate.candidate.requestId} approve`);
  assert.equal(approved.status, 0, approved.stderr); assert.equal(f.calls().length, before);
  const item = listCandidatesV2(project).candidates[0]; assert.equal(item.reviewer, 'user');
  const record = getV2(project, item.id);
  assert.equal(record.entry.verification, 'reported'); assert.equal(record.entry.provenance, 'model-extraction');
});
integration('real M3 JSON auto publishes unverified records through the same offline host adapter', t => {
  const f = fixture(t), project = initializeV2(f.root), file = path.join(f.root, '.pi/project-memory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), longTermMode: 'auto', extraction: { maxCandidates: 1, timeoutMs: 3000 } }));
  const response = f.run('检查合成解析器项目 v2_work_fixture');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(f.calls().filter(call => call.kind === 'v2-curator').length, 1);
  const [item] = listCandidatesV2(project).candidates;
  assert.equal(item.status, 'approved'); assert.equal(item.reviewer, 'auto');
  assert.equal(getV2(project, item.id).entry.verification, 'reported'); assert.equal(statusV2(project).records, 1);
});
integration('real M3 RPC handles auto/off/reset, review rejection, and native compaction without extra curation', async t => {
  const f = fixture(t), rpc = new Rpc(f); t.after(() => { if (rpc.child.exitCode === null) rpc.child.kill('SIGKILL'); });
  try {
    await rpc.prompt('/memory-init M3 RPC'); const project = resolveV2(f.root);
    await rpc.prompt('/memory curate auto');
    await rpc.prompt('检查合成解析器项目 v2_work_fixture');
    assert.equal(listCandidatesV2(project).candidates[0].reviewer, 'auto');
    const before = f.calls().filter(call => call.kind === 'v2-curator').length;
    await rpc.request({ type: 'compact' });
    assert.equal(f.calls().filter(call => call.kind === 'v2-curator').length, before);
    await rpc.prompt('/memory curate off'); await rpc.prompt('再次检查合成解析器项目 v2_work_fixture');
    assert.equal(f.calls().filter(call => call.kind === 'v2-curator').length, before);
    await rpc.request({ type: 'new_session' }); await rpc.prompt('新会话检查合成解析器项目 v2_work_fixture');
    const pending = listCandidatesV2(project).candidates.find(item => item.status === 'pending'); assert.ok(pending);
    await rpc.prompt(`/memory review ${pending.candidate.requestId} reject`);
    assert.equal(listCandidatesV2(project).candidates.find(item => item.candidate.requestId === pending.candidate.requestId).status, 'rejected');
    assert.equal(statusV2(project).records, 1);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});

integration('real v2 print initialization makes no model call; JSON sessions persist work and recall it on continue', t => {
  const f = fixture(t), init = f.run('/memory-init 离线v2项目');
  assert.equal(init.status, 0, init.stderr); assert.equal(f.calls().length, 0);
  const project = resolveV2(f.root);
  assert.equal(project.name, '离线v2项目');
  const first = f.run('检查合成解析器项目 v2_work_fixture use_search');
  assert.equal(first.status, 0, first.stderr);
  const events = first.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.toolName === 'project_memory_search' && !event.isError));
  assert.equal(readWorkingV2(project).events.filter(event => event.payload.kind === 'turn').length, 1);
  const second = f.run('继续'); assert.equal(second.status, 0, second.stderr);
  assert.equal(f.calls().filter(call => call.kind === 'assistant').at(-1).workingContext, true);
  assert.equal(f.calls().filter(call => call.kind === 'curator').length, 0);
});
integration('real v2 JSON honors project learning off without extra requests or work writes', t => {
  const f = fixture(t), project = initializeV2(f.root), file = path.join(f.root, '.pi/project-memory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), learningMode: 'off' }));
  const response = f.run('检查合成解析器项目 v2_work_fixture');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(readWorkingV2(project).events.length, 0);
  assert.equal(f.calls().length, 1);
});
integration('real v2 RPC supports commands, native compaction, handoff and session override reset', async t => {
  const f = fixture(t), rpc = new Rpc(f); t.after(() => { if (rpc.child.exitCode === null) rpc.child.kill('SIGKILL'); });
  try {
    await rpc.prompt('/memory-init RPCv2项目');
    const project = resolveV2(f.root);
    await rpc.prompt('检查合成解析器项目 v2_work_fixture');
    assert.equal(readWorkingV2(project).events.length, 1);
    const compact = await rpc.request({ type: 'compact' });
    assert.equal(readWorkingV2(project).events.filter(event => event.payload.kind === 'handoff').length, 1, JSON.stringify({ compact, calls: f.calls(), ui: rpc.records.filter(record => record.type === 'extension_ui_request') }));
    assert.equal(f.calls().filter(call => call.kind === 'curator').length, 0);
    await rpc.prompt('/memory learn off');
    const before = readWorkingV2(project).events.length;
    await rpc.prompt('检查合成解析器项目 v2_work_fixture');
    assert.equal(readWorkingV2(project).events.length, before);
    await rpc.request({ type: 'new_session' });
    await rpc.prompt('新会话检查合成解析器项目 v2_work_fixture');
    assert.equal(readWorkingV2(project).events.length, before + 1);
    assert.equal(f.calls().filter(call => call.kind === 'assistant').at(-1).workingContext, true);
  } finally { assert.equal(await rpc.close(), 0, rpc.stderr); }
});
