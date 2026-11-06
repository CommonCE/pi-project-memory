import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeV2, resolveV2, saveV2 } from '../src/v2-store.mjs';
import { appendWorkV2, buildWorkingContext, collectWorkTurn, readWorkingV2, updateWorkingV2 } from '../src/v2-working.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-context-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'calc/neb'), { recursive: true });
  fs.mkdirSync(path.join(root, 'calc/opt'), { recursive: true });
  return { root, project: initializeV2(root), child: () => resolveV2(path.join(root, 'calc/neb')) };
}
test('T4 scoped events, closest explicit state, root overview and first-turn brief', t => {
  const { project, child } = fixture(t);
  updateWorkingV2(project, 'overview', 0, { content: 'ROOT OVERVIEW' });
  updateWorkingV2(project, 'state', 0, { goal: 'LOCAL NEB', blockers: ['NEB open loop'] }, { scope: { path: 'calc/neb' } });
  updateWorkingV2(project, 'state', 1, { goal: 'SIBLING SECRET' }, { scope: { path: 'calc/opt' } });
  updateWorkingV2(project, 'state', 2, { goal: 'ROOT FALLBACK' });
  saveV2(project, { kind: 'runs', title: 'NEB run', content: 'NEB recorded', scope: { path: 'calc/neb' }, run: { convergence: 'unknown' } });
  const payload = collectWorkTurn([{ role: 'toolResult', toolName: 'bash', content: 'recorded observation' }],
    { session: 's', turn: 't', scope: { path: 'calc/neb' } });
  assert.deepEqual(payload.scope, { path: 'calc/neb', inherit: true });
  appendWorkV2(project, payload);
  const working = readWorkingV2(child());
  assert(!working.state.includes('SIBLING SECRET'));
  const context = buildWorkingContext(child(), '继续', { firstTurn: true });
  assert.match(context.content, /Folder: calc\/neb/);
  assert.match(context.content, /ROOT OVERVIEW/);
  assert.match(context.content, /LOCAL NEB/);
  assert.doesNotMatch(context.content, /SIBLING SECRET|ROOT FALLBACK/);
  assert.match(context.brief, /conv=unknown/);
  assert.match(context.brief, /Pending review: 0/);
  assert.match(context.brief, /NEB open loop/);
  assert.equal(context.content.split('NEB open loop').length - 1, 1);
  assert.match(context.brief, /seconds? ago/);
  assert.match(context.brief, /assistant_claim/);
  assert.match(context.brief, /does not authorize/);
  assert(context.brief.length <= 1200);
  assert.equal(buildWorkingContext(child(), '继续', { firstTurn: false }).brief, '');
});

test('T4 long Unicode paths and fields keep all brief sections inside 1200 characters', t => {
  const { root, project } = fixture(t);
  const folder = Array(32).fill('中文目录123456').join('/');
  fs.mkdirSync(path.join(root, folder), { recursive: true });
  const child = resolveV2(path.join(root, folder));
  saveV2(child, { kind: 'runs', title: '🧪'.repeat(100), content: 'Unicode fixture' });
  updateWorkingV2(project, 'state', 0, { goal: '🧪'.repeat(500), blockers: Array(8).fill('🧪'.repeat(250)) }, { scope: { path: folder } });
  const context = buildWorkingContext(child, '继续', { firstTurn: true });
  assert(context.brief.length <= 1200);
  assert(context.content.isWellFormed());
  for (const label of ['Folder:', 'Last activity:', 'Last run:', 'Open loops', 'Pending review:', 'Key memory:', 'Boundary:', 'exec=unknown', 'conv=unknown']) assert(context.brief.includes(label));
});

test('T4 no history, inheritance and hard budget include explicit omissions', t => {
  const { project, child } = fixture(t);
  assert.match(buildWorkingContext(child(), '继续', { firstTurn: true }).brief, /No prior memory for this folder/);
  updateWorkingV2(project, 'state', 0, { goal: 'PRIVATE ROOT' }, { scope: { path: '.', inherit: false } });
  assert.equal(readWorkingV2(child()).events.length, 0);
  updateWorkingV2(project, 'state', 1, { goal: 'x'.repeat(1200), notes: Array(8).fill('n'.repeat(500)) }, { scope: { path: 'calc' } });
  const context = buildWorkingContext(child(), '继续', { firstTurn: true, maxChars: 1000 });
  assert(context.chars <= 1000);
  assert.match(context.content, /\[omitted:/);
  assert.equal(context.chars, context.content.length);
  assert(context.content.isWellFormed());
  assert.throws(() => buildWorkingContext(child(), '', { maxChars: 12001 }), { code: 'invalid-schema' });
});
