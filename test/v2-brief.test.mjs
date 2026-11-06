import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeV2, resolveV2, saveV2 } from '../src/v2-store.mjs';
import * as working from '../src/v2-working.mjs';
import { runV2 } from '../src/v2-cli.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-brief-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'calc/a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'calc/b'), { recursive: true });
  const project = initializeV2(root);
  return { root, project, child: resolveV2(path.join(root, 'calc/a')) };
}

function files(root) {
  return fs.readdirSync(root, { recursive: true }).sort().filter(name => fs.statSync(path.join(root, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(root, name)).toString('base64')]);
}

test('manual brief reuses first-turn content and does not write memory', t => {
  const { root, project, child } = fixture(t);
  saveV2(project, { kind: 'runs', title: 'Inherited run', content: 'Recorded, not verified' });
  saveV2(project, { kind: 'runs', title: 'Sibling secret', content: 'Private sibling', scope: { path: 'calc/b' } });
  const before = files(root);
  t.mock.method(Date, 'now', () => 1700000000000);
  const brief = working.readBriefV2(child);
  assert.equal(brief.folder, 'calc/a');
  assert.equal(brief.content, working.buildWorkingContext(child, '继续', { firstTurn: true }).brief);
  assert.equal(brief.chars, brief.content.length);
  assert(brief.chars <= 1200);
  assert.match(brief.content, /Inherited run/);
  assert.match(brief.content, /conv=unknown/);
  assert.match(brief.content, /does not authorize/);
  assert.doesNotMatch(brief.content, /Sibling secret/);
  assert.deepEqual(files(root), before);
});

test('CLI brief selects a historical folder and preserves an empty project', async t => {
  const { root, project } = fixture(t);
  const before = files(root);
  const historical = await runV2(['brief', '--folder', 'old/missing'], { cwd: root });
  assert.equal(historical.folder, 'old/missing');
  assert.match(historical.content, /No prior memory/);
  assert.equal(historical.content, working.readBriefV2(project, { folder: 'old/missing' }).content);
  assert.equal((await runV2(['brief'], { cwd: root })).folder, '.');
  assert.deepEqual(files(root), before);
});

test('brief without a project stays disabled and creates nothing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm7-disabled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await runV2(['brief'], { cwd: root }), { content: '', chars: 0, folder: null });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('brief rejects malformed arguments and escaping paths', async t => {
  const { root, project } = fixture(t);
  for (const args of [['extra'], ['--folder'], ['--all-folders'], ['--folder', '.','--folder', '.']]) {
    await assert.rejects(runV2(['brief', ...args], { cwd: root }), { code: 'invalid-arguments' });
  }
  await assert.rejects(runV2(['brief', '--folder', '../outside'], { cwd: root }), { code: 'invalid-schema' });
  assert.throws(() => working.readBriefV2(project, { extra: true }), { code: 'invalid-schema' });
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(runV2(['brief', '--folder', 'escape/missing'], { cwd: root }), { code: 'scope-outside' });
});

test('manual brief preserves Unicode and the existing 1200-character limit', t => {
  const { root, project } = fixture(t);
  const folder = Array(32).fill('中文目录123456').join('/');
  fs.mkdirSync(path.join(root, folder), { recursive: true });
  saveV2(project, { kind: 'runs', title: '🧪'.repeat(100), content: 'Unicode fixture', scope: { path: folder } });
  const brief = working.readBriefV2(project, { folder });
  assert(brief.chars <= 1200);
  assert(brief.content.isWellFormed());
  assert.match(brief.content, /Boundary:/);
});
