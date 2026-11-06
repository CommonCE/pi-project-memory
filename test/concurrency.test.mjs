import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../src/core.mjs';
import { setupProject } from '../src/setup.mjs';
import { enqueueCandidate, listCandidates, reviewCandidate } from '../src/learning.mjs';

const workerSource = `
import fs from 'node:fs';
import {loadConfig,resolveProject} from ${JSON.stringify(new URL('../src/core.mjs', import.meta.url).href)};
import {enqueueCandidate,reviewCandidate} from ${JSON.stringify(new URL('../src/learning.mjs', import.meta.url).href)};
const config=loadConfig(), project=resolveProject(process.cwd(),config);
const note={type:'runbook',title:'Concurrent release',content:'Release requires successful checks and manual approval.',tags:[]};
const mode=process.argv[1];
if(mode==='partial') {
 const original=fs.writeFileSync;
 let paused=false;
 fs.writeFileSync=function(file,data,options){
  const filename=typeof file==='number'?fs.readlinkSync('/proc/self/fd/'+file):String(file);
  if(!paused&&filename.includes('/candidates/')&&(filename.endsWith('.json')||filename.endsWith('.tmp'))){
   paused=true;
   const own=typeof file!=='number',fd=own?fs.openSync(file,'wx',0o600):file;
   const bytes=Buffer.from(data),middle=Math.floor(bytes.length/2);
   fs.writeSync(fd,bytes.subarray(0,middle));
   console.log(JSON.stringify({stage:'partial'}));
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
   fs.writeSync(fd,bytes.subarray(middle));if(own)fs.closeSync(fd);return;
  }
  return original.call(fs,file,data,options);
 };
}
if(mode==='crash') {
 const write=fs.writeFileSync,link=fs.linkSync;
 fs.writeFileSync=function(file,data,options){
  if(typeof file==='string'&&/\\/.learning\\/[a-f0-9]{64}\\.json$/.test(file))process.exit(17);
  return write.call(fs,file,data,options);
 };
 fs.linkSync=function(source,target){
  if(/\\/.learning\\/[a-f0-9]{64}\\.json$/.test(String(target)))process.exit(17);
  return link.call(fs,source,target);
 };
 reviewCandidate(project,process.argv[2],'approve');
} else {
 try {const result=mode==='approve'?reviewCandidate(project,process.argv[2],'approve'):enqueueCandidate(project,note,config);console.log(JSON.stringify({ok:true,id:result.id,status:result.status,duplicate:result.duplicate}));}
 catch(error){console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=2;}
}
`;
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-concurrency-'));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  // A caller may put TMPDIR inside an already marked real project. Never inherit
  // that parent or write test candidates into its pack.
  fs.writeFileSync(path.join(root, '.pi-root'), '', { flag: 'wx' });
  const file = path.join(temp, 'config.json'); fs.writeFileSync(file, '{}');
  const env = { ...process.env, PI_PROJECT_MEMORY_HOME: path.join(temp, 'vault'), PI_PROJECT_MEMORY_CONFIG: file };
  const config = loadConfig({ env }), project = setupProject(root, config);
  assert.equal(project.root, fs.realpathSync(root));
  assert.equal(project.packPath, path.join(fs.realpathSync(root), 'pi-memory/packs/repo'));
  const children = new Set();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); fs.rmSync(temp, { recursive: true, force: true }); });
  const start = (mode, id) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', workerSource, mode, ...(id ? [id] : [])], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', error = '', buffer = '', stageResolve;
    const stage = new Promise(resolve => { stageResolve = resolve; });
    child.stdout.on('data', data => {
      output += data; buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const item = JSON.parse(line);
        if (item.stage) stageResolve(item);
      }
    });
    child.stderr.on('data', data => { error += data; });
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { children.delete(child); resolve({ code, error, records: output.trim() ? output.trim().split('\n').map(line => JSON.parse(line)) : [] }); }); });
    return { stage, done };
  };
  return { root, project, config, start };
}

test('concurrent readers never observe a partially published candidate JSON record', { timeout: 5000 }, async t => {
  const { project, start } = fixture(t);
  const worker = start('partial'); await worker.stage;
  // Until publication, readers may see the old empty snapshot, never broken JSON.
  assert.deepEqual(listCandidates(project), []);
  const result = await worker.done; assert.equal(result.code, 0, result.error);
  assert.equal(listCandidates(project).length, 1);
});
test('multiple enqueue processes produce one candidate; contenders fail explicitly or deduplicate', { timeout: 10000 }, async t => {
  const { project, start } = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => start('enqueue').done));
  assert.ok(results.some(result => result.code === 0));
  for (const result of results) if (result.code !== 0) assert.match(result.records.at(-1).error, /queue is busy/);
  assert.equal(listCandidates(project).length, 1);
});
test('multiple approval processes publish one note and one immutable decision', { timeout: 10000 }, async t => {
  const { project, config, start } = fixture(t);
  const record = enqueueCandidate(project, { type: 'runbook', title: 'Concurrent release', content: 'Release requires successful checks and manual approval.', tags: [] }, config);
  const results = await Promise.all(Array.from({ length: 8 }, () => start('approve', record.id).done));
  assert.ok(results.some(result => result.code === 0));
  for (const result of results) if (result.code !== 0) assert.match(result.records.at(-1).error, /queue is busy/);
  assert.equal(listCandidates(project).length, 0);
  assert.equal(fs.readdirSync(path.join(project.packPath, '70-runbooks')).filter(name => name.endsWith('.md')).length, 1);
});
test('an actual process crash after note creation is recoverable without overwriting or duplicating the note', { timeout: 10000 }, async t => {
  const { project, config, start } = fixture(t);
  const record = enqueueCandidate(project, { type: 'runbook', title: 'Concurrent release', content: 'Release requires successful checks and manual approval.', tags: [] }, config);
  const crashed = await start('crash', record.id).done;
  assert.equal(crashed.code, 17, crashed.error);
  const dir = path.join(project.packPath, '70-runbooks'), names = fs.readdirSync(dir).filter(name => name.endsWith('.md'));
  assert.equal(names.length, 1);
  const bytes = fs.readFileSync(path.join(dir, names[0]));
  assert.equal(listCandidates(project).length, 1);
  assert.throws(() => reviewCandidate(project, record.id, 'approve'), /queue is busy/);
  // Explicit test-only recovery after confirming that the crashed worker has exited.
  fs.rmdirSync(path.join(project.packPath, '00-system/pi-agent/.learning/.lock'));
  const recovered = reviewCandidate(project, record.id, 'approve');
  assert.deepEqual(fs.readFileSync(recovered.result.path), bytes);
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.md')).length, 1);
  assert.equal(listCandidates(project).length, 0);
});
