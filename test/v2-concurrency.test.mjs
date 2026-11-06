import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { initializeV2, resolveV2, saveV2, getV2, searchV2, statusV2 } from '../src/v2-store.mjs';

const workerSource = `
import fs from 'node:fs';
import {resolveV2,saveV2,reviseV2,initializeV2} from ${JSON.stringify(new URL('../src/v2-store.mjs', import.meta.url).href)};
const [mode,id,requestId]=process.argv.slice(1);
const entry={kind:'software',title:'Concurrent parser',content:'Synthetic fixture validates local storage, not scientific compatibility.'};
if(mode==='init') {
 try { console.log(JSON.stringify({ok:true,id:initializeV2(process.cwd()).id})); }
 catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); process.exitCode=2; }
} else {
 const project=resolveV2(process.cwd());
 if(mode==='crash-before') {
  const link=fs.linkSync;
  fs.linkSync=(source,target)=>{if(String(target).includes('/records/'))process.exit(17);return link(source,target);};
 }
 if(mode==='crash-after') {
  const rename=fs.renameSync;
  fs.renameSync=(source,target)=>{if(String(target).includes('/knowledge/'))process.exit(17);return rename(source,target);};
 }
 if(mode==='projection-error') {
  fs.renameSync=()=>{const error=new Error('simulated output failure');error.code='EIO';throw error;};
 }
 if(mode==='partial') {
  const write=fs.writeFileSync;let paused=false;
  fs.writeFileSync=(file,data,options)=>{
   const name=typeof file==='number'?fs.readlinkSync('/proc/self/fd/'+file):String(file);
   if(!paused&&name.includes('/records/')&&name.endsWith('.tmp')){
    paused=true;const bytes=Buffer.from(data),middle=Math.floor(bytes.length/2);
    fs.writeSync(file,bytes.subarray(0,middle));console.log(JSON.stringify({stage:'partial'}));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,400);
    fs.writeSync(file,bytes.subarray(middle));return;
   }
   return write(file,data,options);
  };
 }
 try {
  const result=mode==='revise'?reviseV2(project,id,1,entry,{requestId}):saveV2(project,entry,{requestId});
  console.log(JSON.stringify({ok:true,id:result.record.id,revision:result.record.revision,duplicate:result.duplicate,projection:result.projection}));
 } catch(error) {console.log(JSON.stringify({ok:false,code:error.code}));process.exitCode=2;}
}
`;
function fixture(t, initialize = true) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-v2-concurrency-'));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated fixture');
  const project = initialize ? initializeV2(root) : undefined;
  const children = new Set();
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  });
  function start(mode, id = '', requestId = randomUUID(), cwd = root) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource, mode, id, requestId], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', stderr = '', buffer = '', stageResolve;
    const stage = new Promise(resolve => { stageResolve = resolve; });
    child.stdout.on('data', data => {
      output += data; buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (JSON.parse(line).stage) stageResolve();
      }
    });
    child.stderr.on('data', data => { stderr += data; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', exitCode => { children.delete(child); resolve({ exitCode, stderr, records: output.trim() ? output.trim().split('\n').map(line => JSON.parse(line)) : [] }); });
    });
    return { stage, done };
  }
  return { root, project, start };
}

test('M5 concurrent scoped saves remain isolated and request identities cannot cross folders', { timeout: 10000 }, async t => {
  const h = fixture(t), dirs = ['a', 'b'].map(folder => path.join(h.root, folder));
  dirs.forEach(dir => fs.mkdirSync(dir));
  const requests = [randomUUID(), randomUUID()];
  const results = await Promise.all(dirs.map((dir, i) => h.start('save', '', requests[i], dir).done));
  for (let i = 0; i < results.length; i++) {
    if (results[i].exitCode !== 0) {
      assert.equal(results[i].records.at(-1).code, 'busy');
      assert.equal((await h.start('save', '', requests[i], dirs[i]).done).exitCode, 0);
    }
  }
  for (let i = 0; i < dirs.length; i++) {
    const hits = searchV2(resolveV2(dirs[i]), 'Concurrent parser').hits;
    assert.equal(hits.length, 1); assert.equal(hits[0].scope.path, ['a', 'b'][i]);
  }
  assert.equal(searchV2(h.project, 'Concurrent parser').hits.length, 0);
  assert.equal((await h.start('save', '', requests[0], dirs[1]).done).records.at(-1).code, 'request-conflict');
  assert.equal(statusV2(h.project).records, 2);
});

test('v2 concurrent initializers converge on one config or explicitly report contention', { timeout: 10000 }, async t => {
  const h = fixture(t, false);
  const results = await Promise.all(Array.from({ length: 6 }, () => h.start('init').done));
  assert.ok(results.some(result => result.exitCode === 0));
  const id = resolveV2(h.root).id;
  for (const result of results) {
    assert.equal(result.stderr, '');
    if (result.exitCode === 0) assert.equal(result.records.at(-1).id, id);
    else assert.equal(result.records.at(-1).code, 'busy');
  }
});
test('v2 concurrent idempotent saves publish one entity and complete record', { timeout: 10000 }, async t => {
  const h = fixture(t), request = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => h.start('save', '', request).done));
  assert.ok(results.some(result => result.exitCode === 0));
  for (const result of results) if (result.exitCode !== 0) assert.equal(result.records.at(-1).code, 'busy');
  assert.equal(statusV2(h.project).records, 1);
  assert.equal(searchV2(h.project, 'Concurrent parser').hits.length, 1);
});
test('v2 compare-and-swap rejects competing revisions without losing history', { timeout: 10000 }, async t => {
  const h = fixture(t), first = saveV2(h.project, { kind: 'software', title: 'First parser', content: 'Original synthetic record.' }).record;
  const results = await Promise.all(Array.from({ length: 6 }, () => h.start('revise', first.id).done));
  assert.equal(results.filter(result => result.exitCode === 0).length, 1);
  for (const result of results) if (result.exitCode !== 0) assert.ok(['busy', 'revision-conflict'].includes(result.records.at(-1).code));
  assert.equal(getV2(h.project, first.id).revision, 2);
  assert.equal(getV2(h.project, first.id, { revision: 1 }).entry.title, 'First parser');
});
test('v2 readers cannot see a half-written canonical record', { timeout: 10000, skip: process.platform !== 'linux' }, async t => {
  const h = fixture(t), worker = h.start('partial');
  await worker.stage;
  assert.equal(statusV2(h.project).records, 0);
  assert.deepEqual(searchV2(h.project, 'Concurrent').hits, []);
  const result = await worker.done;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(statusV2(h.project).records, 1);
});
for (const mode of ['crash-before', 'crash-after']) {
  test(`v2 ${mode} requires explicit lock recovery and is safe to retry`, { timeout: 10000 }, async t => {
    const h = fixture(t), request = randomUUID();
    const crashed = await h.start(mode, '', request).done;
    assert.equal(crashed.exitCode, 17, crashed.stderr);
    assert.equal(statusV2(h.project).records, mode === 'crash-after' ? 1 : 0);
    const blocked = await h.start('save', '', request).done;
    assert.equal(blocked.records.at(-1).code, 'busy');
    // Only this disposable fixture is cleaned, after the child is confirmed exited.
    fs.rmdirSync(path.join(h.project.memory, '.internal/write.lock'));
    const retried = await h.start('save', '', request).done;
    assert.equal(retried.exitCode, 0, retried.stderr);
    assert.equal(retried.records.at(-1).duplicate, mode === 'crash-after');
    assert.equal(retried.records.at(-1).projection, 'current');
    assert.equal(statusV2(h.project).records, 1);
    assert.equal(searchV2(h.project, 'Concurrent').hits.length, 1);
  });
}
test('v2 reports projection pending after a committed write instead of a false save failure', { timeout: 10000 }, async t => {
  const h = fixture(t), request = randomUUID();
  const result = await h.start('projection-error', '', request).done;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.records.at(-1).projection, 'pending');
  assert.equal(statusV2(h.project).records, 1);
  assert.equal(searchV2(h.project, 'Concurrent').hits.length, 1);
  const retry = await h.start('save', '', request).done;
  assert.equal(retry.exitCode, 0, retry.stderr);
  assert.equal(retry.records.at(-1).duplicate, true);
  assert.equal(retry.records.at(-1).projection, 'current');
});
