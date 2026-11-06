import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { initializeV2, resolveV2, saveV2, reviseV2, getV2, searchV2 } from '../src/v2-store.mjs';
import { proposeCandidateV2, reviewCandidateV2, listCandidatesV2 } from '../src/v2-candidates.mjs';
import { appendWorkV2, collectWorkTurn, updateWorkingV2, buildWorkingContext } from '../src/v2-working.mjs';
import { MemoryError } from '../src/v2-domain.mjs';
import { integrationVersion, variants, gold, integrationUnassessed } from './m4-integration-fixtures.mjs';

// Side effects: initialize only a NEW OS-temp sandbox; remove it even on failure.
// Never accepts an existing project/output path. No jobs, models or shell commands.
export function withSandbox(action) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-m4-eval-'));
  const cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  let result;
  try {
    const root = path.join(base, 'project');
    fs.mkdirSync(root);
    const project = initializeV2(root, { name: 'Synthetic M4 sandbox', nested: true });
    result = action({ base, root, project });
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
  return result;
}
const save = (project, kind, content, extra = {}) => saveV2(project, {
  kind, title: 'Same synthetic title', content, provenance: 'tool-observation', verification: 'reported', ...extra,
}).record;
const ids = hits => hits.map(hit => hit.id).sort();
const knowledgeIds = context => context.paths.filter(label => label.startsWith('knowledge: '))
  .map(label => /\/([a-f0-9-]+)\.md/.exec(label)?.[1]).sort();
const state = (project, goal, entities = []) => updateWorkingV2(project, 'state', 0, { goal, entities });

function stage(project, tag) {
  const requestId = randomUUID();
  proposeCandidateV2(project, { requestId, entry: { kind: 'runs', title: `Lifecycle ${tag}`,
    content: `Synthetic lifecycle ${tag}; not scientifically verified.`, provenance: 'model-extraction', verification: 'reported' } });
  return requestId;
}
function interruptPublication(project, id) {
  return reviewCandidateV2(project, id, 'approve', { beforePublish: () => {
    const item = listCandidatesV2(project).candidates.find(item => item.candidate.requestId === id);
    if (item.status === 'approved') throw new MemoryError('scope-changed', 'Synthetic interruption after approval intent');
  } });
}

const scenarios = {
  Q1({ project }, check) {
    const published = save(project, 'runs', 'Synthetic lifecycle PUBLISHED_CONTROL; still unverified.');
    const pending = stage(project, 'PENDING_MARKER');
    const rejected = stage(project, 'REJECTED_MARKER');
    const interrupted = stage(project, 'INTERRUPTED_MARKER');
    reviewCandidateV2(project, rejected, 'reject');
    const result = interruptPublication(project, interrupted);
    check('interruption-is-publication-pending', result.publication.status, 'pending');
    const listed = listCandidatesV2(project).candidates;
    check('pending-state', listed.find(item => item.candidate.requestId === pending).status, 'pending');
    check('rejected-state', listed.find(item => item.candidate.requestId === rejected).status, 'rejected');
    const item = listed.find(item => item.candidate.requestId === interrupted);
    check('approved-intent', [item.status, item.publication], ['approved', 'pending']);
    check('knowledge-only-published', ids(searchV2(project, 'Synthetic lifecycle').hits), [published.id]);
    appendWorkV2(project, { kind: 'turn', session: 'synthetic-q1', turn: 't1', outcome: 'completed',
      goal: 'Inspect synthetic lifecycle without certifying pending knowledge.',
      observations: [{ label: 'synthetic-reader', text: 'PENDING_MARKER is a raw working observation, not published knowledge.' }], claims: [] });
    const context = buildWorkingContext(project, 'Synthetic lifecycle');
    check('raw-working-observation-retained', context.content.includes('PENDING_MARKER'), true);
    check('working-channel-is-not-knowledge', knowledgeIds(context), [published.id]);
    check('unpublished-content-not-in-knowledge', searchV2(project, 'INTERRUPTED_MARKER').hits.length, 0);
    check('reported-control-marked', context.content.includes('requires verification'), true);
  },
  Q2({ project }, check) {
    const id = stage(project, 'RESUME_MARKER');
    interruptPublication(project, id);
    const resumed = reviewCandidateV2(project, id, 'approve');
    check('recovered-publication', resumed.publication.projection, 'current');
    const record = resumed.publication.record;
    check('review-does-not-certify', record.entry.verification, gold.Q2.verification);
    check('source-stays-model-extraction', record.entry.provenance, 'model-extraction');
    check('run-states-stay-unknown', record.entry.run, gold.Q2.run);
    check('publication-now-visible', ids(searchV2(project, 'RESUME_MARKER').hits), [record.id]);
    const retry = reviewCandidateV2(project, id, 'approve');
    check('retry-preserves-record', retry.publication.record.id, record.id);
    const older = save(project, 'runs', 'Synthetic lifecycle SUPERSEDED_MARKER.');
    const archived = save(project, 'runs', 'Synthetic lifecycle ARCHIVED_MARKER.');
    reviseV2(project, older.id, 1, { ...older.entry, lifecycle: 'superseded' });
    reviseV2(project, archived.id, 1, { ...archived.entry, lifecycle: 'archived' });
    check('inactive-excluded', ids(searchV2(project, 'Synthetic lifecycle').hits), [record.id]);
    check('inactive-exists-for-audit', searchV2(project, 'Synthetic lifecycle', { includeInactive: true }).hits.length, 3);
    const context = buildWorkingContext(project, 'Synthetic lifecycle');
    check('only-current-in-default-context', knowledgeIds(context), [record.id]);
    check('verification-label-survives', context.content.includes('requires verification'), true);

    for (const [reviewer, marker] of Object.entries(gold.Q2.unresolved.markers)) {
      const requestId = randomUUID();
      proposeCandidateV2(project, { requestId, entry: { kind: 'runs', title: marker,
        content: `Synthetic lifecycle ${marker}; unresolved observation, not scientifically verified.`,
        provenance: 'model-extraction', verification: gold.Q2.unresolved.verification } });
      const published = reviewCandidateV2(project, requestId, 'approve', { reviewer }).publication;
      const prefix = `unresolved-${reviewer}`;
      check(`${prefix}-publication-current`, published.projection, 'current');
      check(`${prefix}-not-certified`, published.record.entry.verification, gold.Q2.unresolved.verification);
      check(`${prefix}-source-preserved`, published.record.entry.provenance, 'model-extraction');
      check(`${prefix}-run-states-unknown`, published.record.entry.run, gold.Q2.run);
      const hits = searchV2(project, marker).hits;
      check(`${prefix}-query-identity`, ids(hits), [published.record.id]);
      check(`${prefix}-query-verification`, hits.map(hit => [hit.verification, hit.requiresVerification]), [['unresolved', true]]);
      const unresolvedContext = buildWorkingContext(project, marker);
      check(`${prefix}-context-identity`, knowledgeIds(unresolvedContext), [published.record.id]);
      check(`${prefix}-context-label`, unresolvedContext.paths.some(label =>
        label.startsWith('knowledge: ') && label.includes('[unresolved; requires verification]')), true);
    }
  },
  E1({ project }, check) {
    const a = save(project, 'methods', 'Synthetic method-A settings.');
    const b = save(project, 'methods', 'Synthetic method-B settings.');
    const active = save(project, 'runs', 'Calibration method-A basis-A dispersion-A.', { entities: [{ type: 'method', id: a.id }] });
    const foreign = save(project, 'runs', 'Calibration method-B basis-B without dispersion.', { entities: [{ type: 'method', id: b.id }] });
    check('ambiguous-query-keeps-both', ids(searchV2(project, 'Calibration', { kind: 'runs' }).hits), [active.id, foreign.id].sort());
    check('explicit-filter-active-only', ids(searchV2(project, 'Calibration', { kind: 'runs', entityId: a.id }).hits), [active.id]);
    state(project, 'Continue Calibration', [a.id]);
    const context = buildWorkingContext(project, '继续');
    check('active-fact-restored', context.content.includes(gold.E1.active), true);
    check('foreign-fact-excluded', context.content.includes(gold.E1.foreign), false);
    check('active-record-selected', knowledgeIds(context).includes(active.id), true);
    check('foreign-record-not-selected', knowledgeIds(context).includes(foreign.id), false);
  },
  E2({ project }, check) {
    const a = save(project, 'systems', 'Calibration system-A geometry revision one.');
    const b = save(project, 'systems', 'Calibration system-B unrelated geometry.');
    reviseV2(project, a.id, 1, { ...a.entry, content: 'Calibration system-A geometry revision two.' });
    const hits = searchV2(project, 'Calibration', { kind: 'systems' }).hits;
    check('same-name-systems-not-merged', ids(hits), [a.id, b.id].sort());
    check('current-revision-only', hits.find(hit => hit.id === a.id).revision, 2);
    check('old-revision-exists', getV2(project, a.id, { revision: 1 }).entry.content, gold.E2.old);
    state(project, 'Continue Calibration', [a.id]);
    const context = buildWorkingContext(project, '继续');
    check('current-content-restored', context.content.includes(gold.E2.current), true);
    check('old-content-excluded', context.content.includes(gold.E2.old), false);
    check('other-system-excluded', context.content.includes(gold.E2.other), false);
    check('only-active-system-selected', knowledgeIds(context), [a.id]);

    const method = save(project, 'methods', gold.E2.methodOld);
    const otherMethod = save(project, 'methods', gold.E2.methodOther);
    reviseV2(project, method.id, 1, { ...method.entry, content: gold.E2.methodCurrent });
    const methods = searchV2(project, 'Calibration', { kind: 'methods' }).hits;
    check('same-name-methods-not-merged', ids(methods), [method.id, otherMethod.id].sort());
    check('method-current-revision-only', methods.find(hit => hit.id === method.id).revision, 2);
    check('method-current-query-content', methods.find(hit => hit.id === method.id).excerpt.includes(gold.E2.methodCurrent), true);
    check('method-old-revision-auditable', getV2(project, method.id, { revision: 1 }).entry.content, gold.E2.methodOld);
    updateWorkingV2(project, 'state', 1, { goal: 'Continue Calibration', entities: [method.id] });
    const methodContext = buildWorkingContext(project, '继续');
    check('method-current-content-restored', methodContext.content.includes(gold.E2.methodCurrent), true);
    check('method-old-content-excluded', methodContext.content.includes(gold.E2.methodOld), false);
    check('other-method-excluded', methodContext.content.includes(gold.E2.methodOther), false);
    check('only-active-method-selected', knowledgeIds(methodContext), [method.id]);
  },
  R1({ root, project }, check) {
    // Create the cited synthetic evidence; no invented real calculation locator.
    fs.mkdirSync(path.join(root, 'synthetic'));
    fs.writeFileSync(path.join(root, 'synthetic/failed.out'), 'Last SCF iteration energy -10.25 Ha; SCF not converged; error termination. Synthetic only.\n');
    fs.writeFileSync(path.join(root, 'synthetic/success.out'), 'Reported energy -11.5 Ha; normal termination; SCF converged; validity unchecked. Synthetic only.\n');
    const method = save(project, 'methods', 'Synthetic common method settings.');
    const failed = save(project, 'runs', 'Calibration failed run-A.', { entities: [{ type: 'method', id: method.id }],
      run: { execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked', output: 'synthetic/failed.out' } });
    const successful = save(project, 'runs', 'Calibration successful run-B, validity unchecked.', { entities: [{ type: 'method', id: method.id }],
      run: { execution: 'terminated', termination: 'normal', convergence: 'converged', validity: 'unchecked', output: 'synthetic/success.out' } });
    const energyA = save(project, 'results', 'Calibration failed iteration value, not a validated total energy.', {
      evidence: ['synthetic/failed.out'], result: { runId: failed.id, property: 'SCF iteration energy', value: -10.25, unit: 'Ha', definition: 'Last SCF iteration energy; not converged; not a validated total energy.' } });
    const energyB = save(project, 'results', 'Calibration reported run-B energy, validity unchecked.', {
      evidence: ['synthetic/success.out'], result: { runId: successful.id, property: 'reported energy', value: -11.5, unit: 'Ha', definition: 'Reported converged energy; scientific validity unchecked.' } });
    const hits = searchV2(project, 'Calibration', { kind: 'results' }).hits;
    const a = hits.find(hit => hit.id === energyA.id), b = hits.find(hit => hit.id === energyB.id);
    check('both-results-independent', ids(hits), [energyA.id, energyB.id].sort());
    check('failed-value-and-unit', [a.result.value, a.result.unit, a.result.definition], [gold.R1.failedValue, gold.R1.unit, gold.R1.failedDefinition]);
    check('successful-value-and-unit', [b.result.value, b.result.unit], [gold.R1.successfulValue, gold.R1.unit]);
    for (const [label, actual, expected] of [['failed', a.resultRun, gold.R1.failedRun], ['successful', b.resultRun, gold.R1.successfulRun]]) {
      check(`${label}-run-status`, Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected);
    }
    check('failed-result-scoped', ids(searchV2(project, 'Calibration', { kind: 'results', entityId: failed.id }).hits), [energyA.id]);
    state(project, 'Continue Calibration', [failed.id]);
    const context = buildWorkingContext(project, '继续');
    check('failed-result-in-context', knowledgeIds(context).includes(energyA.id), true);
    check('other-result-not-in-context', knowledgeIds(context).includes(energyB.id), false);
    check('failure-definition-preserved', context.content.includes(gold.R1.failedDefinition), true);
  },
  C1(sandbox, check) { continuation('C1', sandbox, check); },
  C2(sandbox, check) { continuation('C2', sandbox, check); },
};

function continuation(id, { root, project }, check) {
  const item = gold[id];
  const messages = [
    { role: 'user', content: `${item.goal} Agreed next step: ${item.next}` },
    { role: 'toolResult', toolName: 'synthetic-reader', isError: true, content: item.observation },
    { role: 'assistant', stopReason: 'stop', content: item.unverified },
  ];
  appendWorkV2(project, collectWorkTurn(messages, { session: 'synthetic-old-session', turn: `${id}-source` }));
  // Explicit synthetic user attribution, not an inference from assistant advice.
  updateWorkingV2(project, 'state', 0, { goal: item.goal, blockers: [item.blocker], nextSteps: [item.next],
    artifacts: [item.artifact], notes: [item.unverified], provenance: 'user-confirmation', evidence: [`Synthetic user statement: ${item.next}`] });
  const script = `import {resolveV2} from ${JSON.stringify(new URL('../src/v2-store.mjs', import.meta.url).href)};
import {buildWorkingContext} from ${JSON.stringify(new URL('../src/v2-working.mjs', import.meta.url).href)};
process.stdout.write(JSON.stringify(buildWorkingContext(resolveV2(process.argv[1]), '继续')));`;
  const context = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' },
  }));
  for (const key of ['goal', 'blocker', 'next', 'artifact', 'observation', 'unverified']) {
    check(`fresh-process-${key}`, context.content.includes(item[key]), true);
  }
  check('unverified-label', context.content.includes('Assistant claims / unverified snapshots'), true);
  check('not-execution-authorization', context.content.includes('not execution authorization'), true);
  check('no-invented-knowledge', knowledgeIds(context).length, 0);
  check('context-length-accounted', context.chars, context.content.length);
  check('context-budget', context.chars <= 12000, true);
  // A fresh process is stronger than a retained project object, but not a Pi session.
}

export function runIntegration({ caseIds = Object.keys(scenarios), orders = variants } = {}) {
  if (!Array.isArray(caseIds) || !caseIds.length || new Set(caseIds).size !== caseIds.length
    || caseIds.some(id => !Object.hasOwn(scenarios, id)) || !Array.isArray(orders) || !orders.length
    || new Set(orders).size !== orders.length || orders.some(order => !variants.includes(order))) throw new Error('Invalid bounded evaluation selection');
  const cases = [];
  for (const id of caseIds) for (const variant of orders) {
    const checks = [], start = performance.now();
    let base;
    const check = (factId, actual, expected) => checks.push({ factId, passed: isDeepStrictEqual(actual, expected), actual, expected });
    let executionError;
    try {
      withSandbox(sandbox => {
        base = sandbox.base;
        const distract = () => saveV2(sandbox.project, { kind: 'software', title: 'ZZDISTRACTOR', content: 'UNRELATED_EVAL_DISTRACTOR_ONLY' });
        if (variant === 'before') distract();
        scenarios[id](sandbox, check);
        if (variant === 'after') {
          const prompt = ['Q1', 'Q2'].includes(id) ? 'Synthetic lifecycle' : '继续';
          const baseline = buildWorkingContext(resolveV2(sandbox.root), prompt);
          distract();
          // Recheck identities after insertion, not a replay of staged operations.
          const context = buildWorkingContext(resolveV2(sandbox.root), prompt);
          check('trailing-distractor-excluded', context.content.includes('UNRELATED_EVAL_DISTRACTOR_ONLY'), false);
          check('trailing-knowledge-identities-stable', knowledgeIds(context), knowledgeIds(baseline));
        }
      });
    } catch (error) {
      executionError = error.code ?? error.name ?? 'execution-error';
    }
    check('sandbox-cleaned', base ? !fs.existsSync(base) : !executionError, true);
    cases.push({ id, name: gold[id].name, variant, checks, ...(executionError ? { executionError } : {}),
      passed: !executionError && checks.length > 1 && checks.every(item => item.passed), elapsedMs: performance.now() - start });
  }
  const sourceFiles = ['./m4-integration.mjs', './m4-integration-fixtures.mjs', '../src/v2-store.mjs', '../src/v2-candidates.mjs', '../src/v2-working.mjs', '../src/v2-domain.mjs', '../src/core.mjs'];
  const sourceSha256 = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')]));
  return { suite: integrationVersion, node: process.version,
    fixtureSha256: createHash('sha256').update(JSON.stringify({ integrationVersion, variants, gold, integrationUnassessed })).digest('hex'),
    sourceSha256, scope: 'synthetic direct APIs and fresh Node process; no Pi host or models',
    syntheticContractPassed: cases.every(item => item.passed), qualityVerdict: 'unassessed', modelUsage: 'not-applicable',
    cases, unassessed: integrationUnassessed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node eval/m4-integration.mjs (new disposable OS-temp sandboxes; JSON to stdout)');
    process.exitCode = 2;
  } else {
    const report = runIntegration();
    console.log(JSON.stringify(report, null, 2));
    if (!report.syntheticContractPassed) process.exitCode = 1;
  }
}
