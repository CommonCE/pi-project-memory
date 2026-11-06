import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withSandbox, runIntegration } from '../eval/m4-integration.mjs';

// All writes are confined to freshly allocated OS-temp sandboxes, then removed.
test('sandbox initializes only its owned project and cleans successful runs', () => {
  let base;
  const result = withSandbox(sandbox => {
    base = sandbox.base;
    assert.ok(fs.existsSync(path.join(sandbox.root, '.pi-root')));
    assert.equal(fs.existsSync(path.join(base, '.pi-root')), false);
    return 'complete';
  });
  assert.equal(result, 'complete');
  assert.equal(fs.existsSync(base), false);
});

test('sandbox cleans its marker and files even if evaluation fails', () => {
  let base;
  assert.throws(() => withSandbox(sandbox => {
    base = sandbox.base;
    fs.writeFileSync(path.join(sandbox.root, 'synthetic-output'), 'disposable');
    throw new Error('intentional evaluation failure');
  }), /intentional evaluation failure/);
  assert.equal(fs.existsSync(base), false);
});

test('integration suite has explicit checks and reports scientific quality as unassessed', () => {
  const report = runIntegration();
  const failures = report.cases.filter(item => !item.passed).map(item => ({ id: item.id, variant: item.variant,
    executionError: item.executionError, checks: item.checks.filter(check => !check.passed) }));
  assert.deepEqual(failures, []);
  assert.equal(report.syntheticContractPassed, true);
  assert.equal(report.cases.length, 21);
  assert.equal(report.cases.reduce((sum, item) => sum + item.checks.length, 0), 296);
  assert.ok(report.cases.every(item => item.checks.length >= 7));
  assert.ok(report.cases.every(item => item.checks.some(check => check.factId === 'sandbox-cleaned' && check.passed)));
  assert.equal(report.qualityVerdict, 'unassessed');
  assert.equal(report.modelUsage, 'not-applicable');
  assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(report.sourceSha256).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  assert.ok(report.unassessed.includes('v1/v2 comparison'));
});

test('method revisions preserve explicit identity and exclude stale and unrelated same-name settings', () => {
  const report = runIntegration({ caseIds: ['E2'] });
  for (const item of report.cases) {
    assert.equal(item.passed, true, JSON.stringify(item));
    for (const factId of ['same-name-methods-not-merged', 'method-current-revision-only', 'method-current-query-content',
      'method-old-revision-auditable', 'method-current-content-restored', 'method-old-content-excluded',
      'other-method-excluded', 'only-active-method-selected', 'sandbox-cleaned']) {
      assert.equal(item.checks.find(check => check.factId === factId)?.passed, true, factId);
    }
  }
});

test('human and auto publication preserve unresolved labels in knowledge queries and context', () => {
  for (const item of runIntegration({ caseIds: ['Q2'] }).cases) {
    assert.equal(item.passed, true, JSON.stringify(item));
    for (const reviewer of ['user', 'auto']) {
      for (const suffix of ['publication-current', 'not-certified', 'source-preserved', 'run-states-unknown',
        'query-identity', 'query-verification', 'context-identity', 'context-label']) {
        const factId = `unresolved-${reviewer}-${suffix}`;
        assert.equal(item.checks.find(check => check.factId === factId)?.passed, true, factId);
      }
    }
  }
});

test('invalid or unbounded integration selections fail before allocating a sandbox', () => {
  for (const options of [
    { caseIds: [] }, { caseIds: ['Q1', 'Q1'] }, { caseIds: ['invented'] },
    { caseIds: 'Q1' }, { orders: [] }, { orders: ['plain', 'plain'] }, { orders: ['invented'] },
  ]) assert.throws(() => runIntegration(options), /Invalid bounded evaluation selection/);
});

test('publication pending and raw working evidence are evaluated in separate channels', () => {
  const result = runIntegration({ caseIds: ['Q1'], orders: ['plain'] }).cases[0];
  assert.equal(result.passed, true);
  for (const factId of ['approved-intent', 'knowledge-only-published', 'raw-working-observation-retained', 'working-channel-is-not-knowledge']) {
    assert.ok(result.checks.find(item => item.factId === factId)?.passed);
  }
});

test('fresh-process continuations recover restrictions as well as next-step locations', () => {
  const report = runIntegration({ caseIds: ['C1', 'C2'], orders: ['plain'] });
  for (const item of report.cases) {
    assert.equal(item.passed, true);
    for (const factId of ['fresh-process-blocker', 'fresh-process-next', 'fresh-process-unverified', 'not-execution-authorization', 'no-invented-knowledge']) {
      assert.ok(item.checks.find(check => check.factId === factId)?.passed);
    }
  }
});
