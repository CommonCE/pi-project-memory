import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initializeV2 } from '../src/v2-store.mjs';
import { appendWorkV2, readWorkingV2, rebuildWorkingV2 } from '../src/v2-working.mjs';

const worker = `
import fs from 'node:fs';
import {resolveV2} from ${JSON.stringify(new URL('../src/v2-store.mjs', import.meta.url).href)};
import {appendWorkV2,updateWorkingV2} from ${JSON.stringify(new URL('../src/v2-working.mjs', import.meta.url).href)};
const [mode,turn]=process.argv.slice(1),project=resolveV2(process.cwd());
if(mode==='crash') {
 const rename=fs.renameSync;
 fs.renameSync=(source,target)=>{if(String(target).endsWith('/overview.md'))process.exit(17);return rename(source,target);};
}
try {
 const saved=mode==='state'?updateWorkingV2(project,'state',0,{goal:'Concurrent task '+turn}):appendWorkV2(project,{kind:'turn',session:'same-session',turn,outcome:'failed',goal:'Synthetic SCF failure',observations:[{label:'failed tool read',text:'SCF NOT CONVERGED; synthetic fixture only.'}],claims:[]});
 console.log(JSON.stringify({ok:true,id:saved.event.id,duplicate:saved.duplicate}));
} catch(error){console.log(JSON.stringify({ok:false,code:error.code}));process.exitCode=2;}
`;
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-work-concurrent-')), root = path.join(temp, 'repo');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
  const project = initializeV2(root), children = new Set();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(temp, { recursive: true, force: true }); });
  const start = (mode, turn) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', worker, mode, turn], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.on('error', reject);
    child.on('close', exitCode => { children.delete(child); resolve({ exitCode, stderr, value: stdout.trim() ? JSON.parse(stdout.trim()) : undefined }); });
  });
  return { root, project, start };
}

test('working journal shares the project write lock and deduplicates concurrent retries', { timeout: 10000 }, async t => {
  const h = fixture(t), results = await Promise.all(Array.from({ length: 6 }, () => h.start('turn', 'same-turn')));
  assert.ok(results.some(value => value.exitCode === 0));
  for (const result of results) if (result.exitCode !== 0) assert.equal(result.value.code, 'busy');
  assert.equal(readWorkingV2(h.project).events.length, 1);
});
test('working state compare-and-swap permits only one concurrent revision', { timeout: 10000 }, async t => {
  const h = fixture(t), results = await Promise.all(Array.from({ length: 6 }, (_, i) => h.start('state', String(i))));
  assert.equal(results.filter(value => value.exitCode === 0).length, 1);
  for (const result of results) if (result.exitCode !== 0) assert.ok(['busy', 'revision-conflict'].includes(result.value.code));
  assert.equal(readWorkingV2(h.project).revisions.state, 1);
});
test('working canonical event survives a projection crash and explicit lock recovery', { timeout: 10000 }, async t => {
  const h = fixture(t), crashed = await h.start('crash', 'crashed-turn');
  assert.equal(crashed.exitCode, 17, crashed.stderr);
  assert.equal(readWorkingV2(h.project).events.length, 1);
  const blocked = await h.start('turn', 'crashed-turn'); assert.equal(blocked.value.code, 'busy');
  // Child has exited; only this disposable fixture's lock is removed explicitly.
  fs.rmdirSync(path.join(h.project.memory, '.internal/write.lock'));
  const retry = await h.start('turn', 'crashed-turn'); assert.equal(retry.exitCode, 0, retry.stderr);
  assert.equal(retry.value.duplicate, true);
  assert.equal(readWorkingV2(h.project).events.length, 1);
  assert.equal(rebuildWorkingV2(h.project).rebuilt, 1);
});
test('working rebuild preflights edited root views before any replacement', t => {
  const h = fixture(t);
  appendWorkV2(h.project, { kind: 'turn', session: 's', turn: 't', outcome: 'failed', observations: [{ label: 'failed tool read', text: 'Synthetic failure.' }], claims: [] });
  const overview = path.join(h.project.memory, 'overview.md'), state = path.join(h.project.memory, 'state.md');
  fs.appendFileSync(state, '\nMANUAL_STATE\n');
  const before = fs.readFileSync(overview);
  assert.throws(() => rebuildWorkingV2(h.project), error => error.code === 'view-conflict');
  assert.deepEqual(fs.readFileSync(overview), before);
  assert.match(fs.readFileSync(state, 'utf8'), /MANUAL_STATE/);
});
