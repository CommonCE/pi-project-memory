import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeV2, resolveV2, saveV2, reviseV2, searchV2, getV2 } from '../src/v2-store.mjs';
import { buildWorkingContext, updateWorkingV2 } from '../src/v2-working.mjs';

test('T7 synthetic chemistry: root method shared; failed NEB and opt results never cross folders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-chemistry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = initializeV2(root);
  for (const folder of ['opt', 'neb']) fs.mkdirSync(path.join(root, folder));
  const opt = resolveV2(path.join(root, 'opt')), neb = resolveV2(path.join(root, 'neb'));
  const method = saveV2(project, { kind: 'methods', title: 'PBE fixture method', content: 'SCOPE_CHEM PBE synthetic setup; charge=0; spin=0; not a validated calculation.' }).record;
  const optRun = saveV2(opt, { kind: 'runs', title: 'OPT run', content: 'SCOPE_CHEM synthetic ORCA 6.1.1 fixture',
    run: { software: 'ORCA', version: '6.1.1', execution: 'terminated', termination: 'normal', convergence: 'converged', validity: 'unchecked' } }).record;
  const nebRun = saveV2(neb, { kind: 'runs', title: 'NEB run', content: 'SCOPE_CHEM synthetic CP2K 2026.2 fixture',
    run: { software: 'CP2K', version: '2026.2', execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked' } }).record;
  const result = saveV2(opt, { kind: 'results', title: 'OPT zero reference', content: 'SCOPE_CHEM zero relative energy, validity unchecked.', evidence: ['synthetic:opt/output'],
    result: { runId: optRun.id, property: 'relative energy', value: 0, unit: 'eV', definition: 'Synthetic relative reference, not an absolute energy.' } }).record;
  const diagnostic = saveV2(neb, { kind: 'diagnostics', title: 'NEB SCF failure', content: 'SCOPE_CHEM SCF failed; no validated NEB energy; remedy is an unrun hypothesis, not authorization.',
    entities: [{ type: 'run', id: nebRun.id }], verification: 'unresolved', evidence: ['synthetic:neb/output'] }).record;
  assert.deepEqual(optRun.entry.scope, { path: 'opt', inherit: true });
  assert.deepEqual(nebRun.entry.scope, { path: 'neb', inherit: true });
  const ids = p => searchV2(p, 'SCOPE_CHEM').hits.map(hit => hit.id);
  assert.deepEqual(new Set(ids(opt)), new Set([optRun.id, result.id, method.id]));
  assert.deepEqual(new Set(ids(neb)), new Set([nebRun.id, diagnostic.id, method.id]));
  assert.deepEqual(ids(project), [method.id]);
  updateWorkingV2(project, 'state', 0, { goal: 'SCOPE_CHEM inspect NEB failure', blockers: ['SCF failed; do not rerun'] }, { scope: { path: 'neb' } });
  const context = buildWorkingContext(neb, 'SCOPE_CHEM', { firstTurn: true });
  assert.match(context.content, /not-converged/);
  assert.match(context.content, /validity=unchecked/);
  assert.doesNotMatch(context.content, /OPT zero reference|OPT run/);
  const revised = reviseV2(project, diagnostic.id, 1, { kind: 'diagnostics', title: 'NEB SCF failure', content: 'SCOPE_CHEM still unresolved, no rerun.' }).record;
  assert.equal(revised.entry.scope.path, 'neb');
  assert.equal(getV2(project, result.id).entry.result.value, 0);
  assert.equal(searchV2(neb, 'SCOPE_CHEM', { entityId: result.id }).hits[0].scope.path, 'opt');
});
