import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildContext, DIRECTORY, FORMAT, initialize, LIMITS, readCheckpoint, readNote, readState, resolveProject, reviewCheckpoint, save, saveCheckpoint, search, setCheckpointEnabled, status } from '../src/memory.mjs';
import { createVectorStore } from '../src/recall.mjs';

const moduleURL = new URL('../src/memory.mjs', import.meta.url).href;
const cli = fileURLToPath(new URL('../bin/pi-project-memory.mjs', import.meta.url));
const code = expected => error => error.code === expected;
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-current-notes-'));
  const root = path.join(temp, 'project with spaces'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, '.pi-root'), 'fixture boundary');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, root, project: initialize(root) };
}
const note = (overrides = {}) => ({ target: 'note', title: 'SCF failure handling', content: 'SCF NOT CONVERGED. Energy -12.34 hartree is a failed-step value, not a usable final energy. ORCA 6.1.1, charge 0, spin multiplicity 1.', sources: ['calc/a/run.out:42-48'], conditions: 'Only system A, PBE/def2-SVP; no claim about other runs.', status: 'active', ...overrides });
const task = '# Current task\nDiagnose SCF failure for system A.\nBlocker: SCF not converged.\nImportant files: calc/a/run.out, src/parser.mjs.\nNext: inspect the input; no execution authorization.';
function cliRun(root, args, input) {
  const child = spawnSync(process.execPath, [cli, ...args], { cwd: root, input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function child(script) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', data => { stdout += data; }); process.stderr.on('data', data => { stderr += data; });
    process.on('error', reject); process.on('close', exit => resolve({ exit, stdout, stderr }));
  });
}

test('checkpoint is opt-in, excluded from recall, and accepted only with a current hash', t => {
  const { root, project } = fixture(t);
  const input = { expected: null, base: null, content: 'Draft-only parser findings.' };
  assert.throws(() => saveCheckpoint(project, input), code('checkpoint-disabled'));
  assert.equal(fs.existsSync(path.join(project.memory, 'checkpoint.md')), false);
  const enabled = setCheckpointEnabled(project, true);
  assert.throws(() => saveCheckpoint(project, { ...input, expected: enabled.expected, content: 'password=do-not-save' }), code('secret-looking-content'));
  const draft = saveCheckpoint(project, { ...input, expected: enabled.expected });
  assert.equal(readCheckpoint(resolveProject(root)).content, input.content);
  assert.equal(readState(project), null);
  assert.doesNotMatch(buildContext(project, 'parser').content, /Draft-only/);
  assert.deepEqual(search(project, 'parser').hits, []);
  assert.throws(() => saveCheckpoint(project, { ...input, expected: enabled.expected }), code('conflict'));
  const off = setCheckpointEnabled(project, false);
  assert.equal(off.content, draft.content);
  assert.throws(() => reviewCheckpoint(project, 'accept', draft.expected), code('conflict'));
  assert.equal(readState(project), null);
  assert.equal(reviewCheckpoint(project, 'accept', off.expected).content, '');
  assert.equal(readState(project).content, draft.content);
  assert.equal(readCheckpoint(project).enabled, false);
});

test('checkpoint cannot overwrite newer formal state and remains separately discardable', t => {
  const { project } = fixture(t);
  const enabled = setCheckpointEnabled(project, true);
  const draft = saveCheckpoint(project, { expected: enabled.expected, base: null, content: 'Old task progress.' });
  const newer = save(project, { target: 'state', expected: null, content: 'Different task.' });
  assert.throws(() => reviewCheckpoint(project, 'accept', draft.expected), code('conflict'));
  assert.throws(() => saveCheckpoint(project, { expected: draft.expected, base: null, content: 'Stale turn draft.' }), code('conflict'));
  assert.equal(readState(project).expected, newer.expected);
  assert.equal(readCheckpoint(project).expected, draft.expected);
  assert.equal(reviewCheckpoint(project, 'discard', draft.expected).content, '');
  assert.equal(readState(project).expected, newer.expected);
});

test('retrying checkpoint acceptance after a cleanup failure does not rewrite state', t => {
  const { project } = fixture(t), original = fs.renameSync;
  const enabled = setCheckpointEnabled(project, true);
  const draft = saveCheckpoint(project, { expected: enabled.expected, base: null, content: 'Verified progress.' });
  try {
    fs.renameSync = (source, target) => {
      if (target === path.join(project.memory, 'checkpoint.md')) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      return original(source, target);
    };
    assert.throws(() => reviewCheckpoint(project, 'accept', draft.expected), code('ENOSPC'));
  } finally { fs.renameSync = original; }
  const published = readState(project);
  assert.equal(published.content, draft.content);
  assert.equal(readCheckpoint(project).expected, draft.expected);
  assert.equal(reviewCheckpoint(project, 'accept', draft.expected).content, '');
  assert.equal(readState(project).expected, published.expected);
});

test('fresh processes recover current task, blockers, files, next steps and relevant notes', t => {
  const h = fixture(t);
  cliRun(h.root, ['state', 'save'], { content: task, expected: null });
  const saved = cliRun(h.root, ['save'], noteWithoutTarget(note()));
  const context = cliRun(h.root, ['context', '继续']);
  for (const value of ['SCF not converged', 'src/parser.mjs', 'inspect the input', 'no execution authorization', '-12.34 hartree', 'ORCA 6.1.1', 'charge 0', 'multiplicity 1', 'calc/a/run.out:42-48']) assert.ok(context.content.includes(value), value);
  assert.ok(context.paths.includes(`notes/${saved.id}.md`));
  assert.ok(context.chars <= LIMITS.contextChars);
  assert.equal(context.chars, context.content.length);
  assert.equal(readState(resolveProject(h.root)).content, task);
});
function noteWithoutTarget(value) { const { target, ...fields } = value; return fields; }

test('unmarked directories do not read legacy data or create a store', t => {
  const h = fixture(t), outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside);
  // If TMPDIR has a marker, an explicit sibling boundary still tests isolation.
  const project = resolveProject(outside);
  if (project.root === null) {
    assert.equal(project.reason, 'no-marker');
    assert.deepEqual(search(project, 'SCF').hits, []);
    assert.equal(buildContext(project).content, '');
  }
  assert.equal(fs.existsSync(path.join(outside, DIRECTORY)), false);
});

test('nearest marker isolates independent, nested and copied projects; old handles are revoked', t => {
  const h = fixture(t), saved = save(h.project, note());
  const child = path.join(h.root, 'child'); fs.mkdirSync(child);
  assert.equal(resolveProject(child).id, h.project.id);
  assert.equal(initialize(child).id, h.project.id);
  fs.writeFileSync(path.join(child, '.pi-root'), 'separate project');
  const nested = initialize(child);
  assert.deepEqual(search(nested, 'SCF').hits, []);
  assert.throws(() => readNote(nested, saved.id), code('not-found'));
  const captured = resolveProject(child);
  fs.unlinkSync(path.join(child, '.pi-root'));
  assert.throws(() => save(captured, note()), code('scope-changed'));
  const sibling = path.join(h.temp, 'sibling'); fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, '.pi-root'), '');
  fs.cpSync(h.project.memory, path.join(sibling, DIRECTORY), { recursive: true });
  const copy = resolveProject(sibling), first = readNote(copy, saved.id);
  save(copy, { target: 'note', id: first.id, expected: first.expected, content: 'SCF independent copied result' });
  assert.equal(readNote(h.project, saved.id).content, saved.content);
  assert.equal(fs.existsSync(path.join(h.root, '.gitignore')), false);
});

test('marker removal revokes existing state and note access', t => {
  const h = fixture(t); fs.unlinkSync(path.join(h.root, '.pi-root'));
  assert.throws(() => readState(h.project), code('scope-changed'));
  assert.throws(() => save(h.project, note()), code('scope-changed'));
});

test('legacy config, packs and scientific outputs remain byte-for-byte untouched', t => {
  const h = fixture(t), old = path.join(h.root, '.pi'); fs.mkdirSync(old);
  const config = path.join(old, 'project-memory.json'); fs.writeFileSync(config, '{legacy malformed config');
  const pack = path.join(h.root, '.pi-memory'); fs.mkdirSync(pack); fs.writeFileSync(path.join(pack, 'state.md'), 'OLD_UNVERIFIED_SUCCESS');
  const output = path.join(h.root, 'run.out'); fs.writeFileSync(output, 'scientific output');
  const before = [config, path.join(pack, 'state.md'), output].map(file => fs.readFileSync(file));
  const resolved = resolveProject(h.root);
  assert.deepEqual(resolved.legacy, ['.pi/project-memory.json', '.pi-memory']);
  assert.equal(initialize(h.root).id, h.project.id);
  assert.doesNotMatch(buildContext(resolved, 'success').content, /OLD_UNVERIFIED_SUCCESS/);
  [config, path.join(pack, 'state.md'), output].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
  const legacyOnly = path.join(h.temp, 'legacy-only'); fs.mkdirSync(legacyOnly); fs.writeFileSync(path.join(legacyOnly, '.pi-root'), '');
  fs.mkdirSync(path.join(legacyOnly, '.pi-memory'));
  assert.equal(resolveProject(legacyOnly).reason, 'legacy-format');
  assert.equal(initialize(legacyOnly).enabled, true);
  assert.deepEqual(fs.readdirSync(path.join(legacyOnly, '.pi-memory')), []);
});

test('unknown new-format targets are refused without adoption or overwrite', t => {
  const h = fixture(t), root = path.join(h.temp, 'unknown'); fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, DIRECTORY)); fs.writeFileSync(path.join(root, DIRECTORY, 'private.md'), 'keep');
  assert.throws(() => initialize(root), code('store-conflict'));
  assert.equal(fs.readFileSync(path.join(root, DIRECTORY, 'private.md'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
  const manifest = path.join(h.project.memory, 'format.json');
  fs.writeFileSync(manifest, JSON.stringify({ format: 'other-format', id: h.project.id, name: 'unknown' }));
  assert.throws(() => resolveProject(h.root), code('format-conflict'));
});

test('correction replaces one authority; stale tokens cannot undo correction or withdrawal', t => {
  const h = fixture(t), first = save(h.project, note({ content: 'SCF OLD_FALSE_CLAIM' }));
  const changed = save(h.project, { target: 'note', id: first.id, expected: first.expected, content: 'SCF corrected: run failed, no final energy.' });
  assert.equal(changed.id, first.id);
  assert.deepEqual(fs.readdirSync(path.join(h.project.memory, 'notes')), [`${first.id}.md`]);
  assert.doesNotMatch(buildContext(resolveProject(h.root), 'SCF').content, /OLD_FALSE_CLAIM/);
  assert.match(buildContext(h.project, 'SCF').content, /run failed/);
  assert.throws(() => save(h.project, { target: 'note', id: first.id, expected: first.expected, content: 'undo' }), code('conflict'));
  const invalid = save(h.project, { target: 'note', id: first.id, expected: changed.expected, status: 'inactive' });
  assert.deepEqual(search(h.project, 'SCF').hits, []);
  assert.doesNotMatch(buildContext(h.project, 'SCF').content, /run failed/);
  assert.equal(search(h.project, 'SCF', { includeInactive: true }).hits[0].status, 'inactive');
  assert.throws(() => save(h.project, { target: 'note', id: first.id, expected: changed.expected, status: 'active' }), code('conflict'));
  assert.equal(readNote(h.project, first.id).expected, invalid.expected);
});

test('unverified is the default; references never auto-promote scientific validity', t => {
  const h = fixture(t), input = note(); delete input.status;
  const saved = save(h.project, input);
  assert.equal(saved.status, 'unverified');
  assert.deepEqual(search(h.project, 'SCF').hits, []);
  assert.doesNotMatch(buildContext(h.project, 'SCF').content, /failed-step/);
  assert.equal(search(h.project, 'SCF', { includeInactive: true }).hits[0].status, 'unverified');
  assert.equal(readNote(h.project, saved.id).content, input.content);
});

test('state replacement discards obsolete goals; clearing state is explicit', t => {
  const h = fixture(t), first = save(h.project, { target: 'state', expected: null, content: 'SCF OBSOLETE_GOAL' });
  const current = save(h.project, { target: 'state', expected: first.expected, content: task });
  assert.doesNotMatch(buildContext(h.project).content, /OBSOLETE_GOAL/);
  assert.throws(() => save(h.project, { target: 'state', expected: null, content: 'stale' }), code('conflict'));
  assert.throws(() => save(h.project, { target: 'state', content: 'missing expected' }), code('invalid-input'));
  save(h.project, { target: 'state', expected: current.expected, content: '' });
  assert.equal(readState(h.project).content, '');
});

test('manual edits are authoritative and invalidate previously read hashes', t => {
  const h = fixture(t), saved = save(h.project, note());
  const file = path.join(h.project.memory, 'notes', `${saved.id}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('SCF NOT CONVERGED', 'SCF MANUAL_CORRECTION'));
  assert.match(buildContext(h.project, 'SCF').content, /MANUAL_CORRECTION/);
  assert.throws(() => save(h.project, { target: 'note', id: saved.id, expected: saved.expected, status: 'inactive' }), code('conflict'));
  fs.writeFileSync(file, 'malformed');
  assert.throws(() => buildContext(h.project, 'SCF'), code('invalid-format'));
});

test('a UTF-8 BOM affects the whole-file hash and invalidates an old write token', t => {
  const h = fixture(t), saved = save(h.project, { target: 'state', expected: null, content: task });
  const file = path.join(h.project.memory, 'state.md');
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(file)]);
  fs.writeFileSync(file, bytes);
  const current = readState(h.project);
  assert.equal(current.content, task);
  assert.equal(current.expected, createHash('sha256').update(bytes).digest('hex'));
  assert.throws(() => save(h.project, { target: 'state', expected: saved.expected, content: 'stale' }), code('conflict'));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(save(h.project, { target: 'state', expected: current.expected, content: 'fresh' }).content, 'fresh');
});

test('rename failure preserves existing bytes and releases locks and temporary files', t => {
  const h = fixture(t), saved = save(h.project, note());
  const file = path.join(h.project.memory, 'notes', `${saved.id}.md`), before = fs.readFileSync(file), original = fs.renameSync;
  try {
    fs.renameSync = () => { const error = new Error('injected ENOSPC'); error.code = 'ENOSPC'; throw error; };
    assert.throws(() => save(h.project, { target: 'note', id: saved.id, expected: saved.expected, content: 'replacement' }), code('ENOSPC'));
  } finally { fs.renameSync = original; }
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(h.project.memory, '.write-lock')), false);
  assert.ok(fs.readdirSync(h.project.memory).every(name => !name.startsWith('.write-')));
});

test('failed new publication leaves no partial note', t => {
  const h = fixture(t), original = fs.linkSync;
  try {
    fs.linkSync = () => { throw new Error('injected publish failure'); };
    assert.throws(() => save(h.project, note()), /injected publish failure/);
  } finally { fs.linkSync = original; }
  assert.deepEqual(fs.readdirSync(path.join(h.project.memory, 'notes')), []);
  assert.equal(status(h.project).notes.length, 0);
});

test('concurrent processes with one expected hash produce one winner and an explicit conflict', async t => {
  const h = fixture(t), saved = save(h.project, note());
  const scripts = ['first concurrent correction', 'second concurrent correction'].map(content => `
    import {resolveProject,save} from ${JSON.stringify(moduleURL)};
    try { const result = save(resolveProject(${JSON.stringify(h.root)}), ${JSON.stringify({ target: 'note', id: saved.id, expected: saved.expected, content })}); console.log(JSON.stringify({ok:true,content:result.content})); }
    catch(error) { console.log(JSON.stringify({ok:false,code:error.code})); }
  `);
  const results = await Promise.all(scripts.map(child));
  results.forEach(result => assert.equal(result.exit, 0, result.stderr));
  const output = results.map(result => JSON.parse(result.stdout));
  assert.equal(output.filter(result => result.ok).length, 1);
  assert.ok(['busy', 'conflict'].includes(output.find(result => !result.ok).code));
  assert.equal(readNote(h.project, saved.id).content, output.find(result => result.ok).content);
});

test('process interruption before publication leaves a complete old file and a visible crash lock', async t => {
  const h = fixture(t), saved = save(h.project, note());
  const result = await child(`
    import fs from 'node:fs'; import {resolveProject,save} from ${JSON.stringify(moduleURL)};
    fs.renameSync = () => process.exit(23);
    save(resolveProject(${JSON.stringify(h.root)}), ${JSON.stringify({ target: 'note', id: saved.id, expected: saved.expected, content: 'never published' })});
  `);
  assert.equal(result.exit, 23);
  assert.equal(readNote(h.project, saved.id).content, saved.content);
  assert.match(buildContext(h.project, 'SCF').content, /NOT CONVERGED/);
  assert.equal(fs.existsSync(path.join(h.project.memory, '.write-lock')), true);
  assert.throws(() => save(h.project, note()), code('busy'));
});

test('a manual change during publication is detected before replacing its content', t => {
  const h = fixture(t), saved = save(h.project, note()), original = fs.fsyncSync;
  const file = path.join(h.project.memory, 'notes', `${saved.id}.md`), manual = fs.readFileSync(file, 'utf8').replace('SCF NOT CONVERGED', 'SCF manual change');
  try {
    fs.fsyncSync = fd => { original(fd); fs.writeFileSync(file, manual); };
    assert.throws(() => save(h.project, { target: 'note', id: saved.id, expected: saved.expected, content: 'overwrite' }), code('conflict'));
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), manual);
});

test('symlinked stores, note files, directories and markers cannot escape project boundaries', t => {
  const h = fixture(t), outside = path.join(h.temp, 'outside.md'); fs.writeFileSync(outside, 'keep outside');
  const saved = save(h.project, note()), file = path.join(h.project.memory, 'notes', `${saved.id}.md`);
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => readNote(h.project, saved.id), code('unsafe-path'));
  assert.throws(() => save(h.project, { target: 'note', id: saved.id, expected: saved.expected, content: 'overwrite' }), code('unsafe-path'));
  fs.unlinkSync(file); fs.rmdirSync(path.join(h.project.memory, 'notes'));
  fs.symlinkSync(h.temp, path.join(h.project.memory, 'notes'));
  assert.throws(() => resolveProject(h.root), code('unsafe-path'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside');
  assert.throws(() => readNote(h.project, '../outside'), code('unsafe-path'));
  fs.unlinkSync(path.join(h.root, '.pi-root')); fs.symlinkSync(outside, path.join(h.root, '.pi-root'));
  assert.throws(() => resolveProject(h.root), code('unsafe-path'));
});

test('strict inputs, malformed bytes, secrets and size limits fail without corrupting prior content', t => {
  const h = fixture(t), saved = save(h.project, note());
  for (const change of [{ title: null }, { sources: 'not an array' }, { status: 'verified' }, { content: 'api_key=unsafe-example-value' }, { content: 'x'.repeat(LIMITS.noteChars + 1) }, { entities: [] }]) {
    assert.throws(() => save(h.project, { target: 'note', id: saved.id, expected: saved.expected, ...change }));
    assert.equal(readNote(h.project, saved.id).expected, saved.expected);
  }
  assert.throws(() => save(h.project, { target: 'state', expected: null, content: 'x'.repeat(LIMITS.stateChars + 1) }), code('invalid-input'));
  fs.writeFileSync(path.join(h.project.memory, 'notes', `${saved.id}.md`), Buffer.from([0xff, 0xfe]));
  assert.throws(() => buildContext(h.project, 'SCF'), code('invalid-format'));
});

test('CLI rejects malformed UTF-8 JSON before writing a note', t => {
  const h = fixture(t);
  const input = Buffer.concat([
    Buffer.from('{"title":"fixture","content":"'), Buffer.from([0xff]), Buffer.from('","sources":[],"conditions":"fixture"}'),
  ]);
  const result = spawnSync(process.execPath, [cli, 'save'], { cwd: h.root, input, encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /invalid-input.*UTF-8/);
  assert.deepEqual(status(h.project).notes, []);
});

test('default context has a hard bound and never drops a middle scientific qualifier', t => {
  const h = fixture(t);
  save(h.project, { target: 'state', expected: null, content: task });
  const content = 'SCF '.repeat(300) + 'MIDDLE_NEGATION: NOT a converged energy; only failed-step -9.5 hartree. ' + 'boundary '.repeat(250);
  const saved = save(h.project, note({ content }));
  for (const maxChars of [512, 1200, 8000, LIMITS.contextChars]) {
    const context = buildContext(h.project, 'SCF', { maxChars });
    assert.ok(context.chars <= maxChars, `${context.chars} > ${maxChars}`);
    if (context.paths.includes(`notes/${saved.id}.md`)) assert.ok(context.content.includes(content));
    else assert.doesNotMatch(context.content, /MIDDLE_NEGATION/);
  }
  assert.equal(readNote(h.project, saved.id).content, content);
  assert.throws(() => buildContext(h.project, '', { maxChars: LIMITS.contextChars + 1 }), code('invalid-input'));
});

test('sparse vector recall supports Chinese and English, is deterministic, and has finite cosine scores', t => {
  const h = fixture(t);
  const a = save(h.project, note({ title: '收敛故障排查', content: '收敛故障需要检查输入，失败能量单位 hartree。' }));
  save(h.project, note({ title: 'UI colors', content: 'CSS foreground background color', conditions: 'Frontend styles only.' }));
  assert.equal(search(h.project, '收敛故障').hits[0].id, a.id);
  assert.deepEqual(search(h.project, 'unrelated-vocabulary').hits, []);
  const store = createVectorStore([{ id: a.id, title: 'SCF', conditions: 'system A', content: 'SCF failure' }]);
  assert.deepEqual(store.search('SCF', 5), store.search('SCF', 5));
  assert.ok(store.search('SCF', 5).every(hit => Number.isFinite(hit.score) && hit.score > 0 && hit.score <= 1 + 1e-12));
  assert.deepEqual(store.search('继续', 5), []);
  assert.equal(fs.existsSync(path.join(h.project.memory, 'vectors.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.project.memory, 'format.json'), 'utf8')).format, FORMAT);
});
