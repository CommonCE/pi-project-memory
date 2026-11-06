import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeV2, resolveV2, saveV2, reviseV2, getV2, searchV2 } from '../src/v2-store.mjs';
import { proposeCandidateV2, reviewCandidateV2, listCandidatesV2 } from '../src/v2-candidates.mjs';
import { buildWorkingContext, updateWorkingV2, readBriefV2 } from '../src/v2-working.mjs';

// Small deterministic user-visible journeys; no extraction model or host process.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['science', 'dev', 'cluster', 'other']) fs.mkdirSync(path.join(root, dir));
  const project = initializeV2(root);
  return { root, project };
}
function originals(project) {
  const dir = path.join(project.memory, '.internal/records');
  return fs.readdirSync(dir).map(name => [path.join(dir, name), fs.readFileSync(path.join(dir, name))]);
}
function continueIn(root, folder, query, maxChars = 12000) {
  // Re-resolve from disk rather than reuse an in-memory project; not a Pi session.
  return buildWorkingContext(resolveV2(path.join(root, folder)), query, { firstTurn: true, maxChars });
}
function report(t, name, context, required, extra = {}) {
  const recovered = required.filter(text => context.content.includes(text));
  t.diagnostic(JSON.stringify({ journey: name, required: required.length, recovered: recovered.length,
    injectionUTF16: context.chars, briefUTF16: context.brief.length,
    omissionNotice: context.content.includes('[omitted:'), modelCost: 'not measured', ...extra }));
  assert.equal(recovered.length, required.length, `Missing: ${required.filter(text => !recovered.includes(text))}`);
  assert.equal(context.chars, context.content.length);
  assert(context.chars <= 12000); assert(context.brief.length <= 1200);
}

test('P1 science: pinned failed source, independent run, units and explicit correction', t => {
  const { root, project } = fixture(t), scope = { path: 'science' };
  const locator = 'synthetic/output.log:12';
  const sources = [{ locator, quote: 'Synthetic failed run, not scientific evidence.', source: 'tool-observation' }];
  const known = value => ({ state: 'known', value, sources });
  const run = saveV2(project, { kind: 'runs', title: 'P1_OLD_RUN', content: 'Synthetic software 0; charge=0; spin unknown; no calculation.', scope,
    run: { execution: 'terminated', termination: 'error', convergence: 'not-converged', software: 'synthetic', version: '0' } }).record;
  const entry = { kind: 'results', title: 'P1_ENERGY', content: 'Intermediate only; spin unknown; not a final energy.', scope, evidence: [locator],
    result: { runId: run.id, property: 'P1_ENERGY', value: 0, unit: 'eV', definition: 'Synthetic intermediate only.' },
    card: { version: 1, fields: { propertyKey: known('P1_ENERGY'), qualifiers: known({}), run: known({ id: run.id, revision: 1 }) },
      limitations: ['spin unknown; no rerun authorization'],
      support: Object.fromEntries(['property', 'value', 'unit', 'definition'].map(key => [`result.${key}`, sources])) } };
  const result = saveV2(project, entry).record;
  const newer = saveV2(project, { kind: 'runs', title: 'P1_NEW_RUN', content: 'Independent synthetic software 1 run; not the old source.', scope,
    run: { execution: 'terminated', termination: 'normal', convergence: 'converged', software: 'synthetic', version: '1' } }).record;
  reviseV2(project, run.id, 1, { ...run.entry, content: 'Later source claim; cannot rewrite pinned result.', run: { ...run.entry.run, convergence: 'converged' } });
  const child = resolveV2(path.join(root, 'science'));
  updateWorkingV2(child, 'state', 0, { goal: 'Inspect P1_ENERGY', entities: [run.id, result.id], blockers: ['spin unknown'], notes: ['Plan only: inspect source; no rerun authorization'] }, { scope });
  const hit = searchV2(child, 'P1_ENERGY').hits.find(hit => hit.id === result.id);
  assert.equal(hit.sourceRun.revision, 1); assert.equal(hit.sourceRun.updated, true);
  assert.equal(hit.sourceRun.run.convergence, 'not-converged'); assert.equal(hit.result.value, 0);
  const context = continueIn(root, 'science', '继续 P1_ENERGY');
  report(t, 'science', context, ['P1_ENERGY', 'eV', 'not-converged', 'spin unknown', locator, 'not execution authorization']);
  const injected = context.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert(!injected.some(item => item.id === newer.id));
  const before = originals(project);
  reviseV2(project, result.id, 1, { ...entry, content: 'Explicit transcription correction; still intermediate.', result: { ...entry.result, value: -1 } });
  assert.equal(getV2(child, result.id).entry.result.value, -1);
  assert.equal(getV2(child, result.id, { revision: 1 }).entry.result.value, 0);
  const corrected = searchV2(child, 'P1_ENERGY').hits.find(item => item.id === result.id);
  assert.equal(corrected.sourceRun.revision, 1); assert.equal(corrected.result.unit, 'eV');
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
  const small = continueIn(root, 'science', '继续 P1_ENERGY', 1000);
  assert(small.chars <= 1000); assert.match(small.content, /omitted/);
  t.diagnostic(JSON.stringify({ journey: 'science-small-budget', injectionUTF16: small.chars,
    retrievalFound: true, contextHasResultJSON: small.content.includes(`"id":"${result.id}"`), classification: 'context omission, not retrieval miss' }));
});

for (const sample of [
  { folder: 'dev', kind: 'software', token: 'P1_PARSER', original: 'Parser 1; fixture only; plan to test, NOT tests passed.',
    corrected: 'Parser 2 correction; tests not run; only synthetic reproduction.', condition: 'Applies only to parser 2; tests not run' },
  { folder: 'cluster', kind: 'diagnostics', token: 'P1_CLUSTER', original: 'Synthetic scheduler error; cause unknown; historical authorization only.',
    corrected: 'Correction: synthetic timeout, NOT out-of-memory; cause unknown; no current submission authorization.', condition: 'Applies only to synthetic scheduler 0; cause unknown' },
]) test(`P1 ${sample.folder}: candidate review, continuation, correction and scope isolation`, t => {
  const { root, project } = fixture(t), scope = { path: sample.folder };
  const entry = { kind: sample.kind, title: sample.token, content: sample.original, scope };
  const request = { requestId: randomUUID(), entry };
  assert.equal(proposeCandidateV2(project, request).duplicate, false);
  assert.equal(proposeCandidateV2(project, request).duplicate, true);
  assert.equal(searchV2(project, sample.token, { allFolders: true }).hits.length, 0);
  const rejected = { requestId: randomUUID(), entry: { ...entry, title: `${sample.token}_BAD`, content: 'Unsupported claim: all tests passed, all future submissions authorized.' } };
  proposeCandidateV2(project, rejected);
  reviewCandidateV2(project, rejected.requestId, 'reject');
  const record = reviewCandidateV2(project, request.requestId, 'approve').publication.record;
  assert.equal(record.entry.verification, 'reported');
  const child = resolveV2(path.join(root, sample.folder));
  updateWorkingV2(child, 'state', 0, { goal: `Continue ${sample.token}`, entities: [record.id], blockers: [sample.condition],
    provenance: 'user-confirmation', evidence: ['synthetic/user-turn:1'],
    nextSteps: ['Plan only; not executed; obtain current authorization before action.'] }, { scope });
  const before = originals(project);
  const correction = { ...entry, content: sample.corrected };
  const update = { requestId: randomUUID(), target: { id: record.id, expectedRevision: 1 }, entry: correction };
  proposeCandidateV2(project, update);
  const revised = reviewCandidateV2(project, update.requestId, 'approve').publication.record;
  assert.equal(revised.revision, 2); assert.equal(revised.id, record.id);
  assert.equal(getV2(child, record.id, { revision: 1 }).entry.content, sample.original);
  const hit = searchV2(child, sample.token).hits.find(item => item.id === record.id);
  assert.equal(hit.revision, 2); assert.equal(hit.verification, 'reported');
  const context = continueIn(root, sample.folder, `继续 ${sample.token}`);
  report(t, sample.folder, context, [sample.token, sample.corrected, sample.condition, 'not execution authorization'],
    { proposals: 3, retryDuplicates: 1, semanticDuplicates: 0, reviewDecisions: 3, rejected: 1, pending: listCandidatesV2(project).candidates.filter(item => item.status === 'pending').length });
  assert.doesNotMatch(context.content, /Unsupported claim/);
  for (const folder of ['other', sample.folder === 'dev' ? 'cluster' : 'dev']) {
    const sibling = resolveV2(path.join(root, folder));
    assert.equal(searchV2(sibling, sample.token).hits.length, 0);
    assert.doesNotMatch(continueIn(root, folder, sample.token).content, new RegExp(sample.token));
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-p1-other-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const foreign = initializeV2(outside);
  assert.equal(searchV2(foreign, sample.token).hits.length, 0);
  assert.doesNotMatch(readBriefV2(foreign).content, new RegExp(sample.token));
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
});
