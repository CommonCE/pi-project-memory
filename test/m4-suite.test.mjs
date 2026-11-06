import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessReports, exitCode, planReport, runSuite } from '../eval/m4-suite.mjs';
import { matrix, runnerContracts } from '../eval/m4-matrix.mjs';

let suite;
test.before(async () => { suite = await runSuite(); });
const changed = change => { const reports = structuredClone(suite.reports); change(reports); return assessReports(reports); };

test('all thirteen design rows have bounded evidence references and explicit gap lists', () => {
  assert.equal(matrix.length, 13);
  assert.equal(new Set(matrix.map(row => row.id)).size, 13);
  for (const row of matrix) {
    assert.ok(Array.isArray(row.remaining));
    assert.ok(row.refs.length > 0);
    for (const ref of row.refs) assert.ok(runnerContracts[ref.runner].ids.includes(ref.id));
  }
});

test('unified execution passes offline checks but cannot claim M4 acceptance', () => {
  assert.equal(suite.offlineChecksPassed, true, JSON.stringify(suite.validation));
  assert.equal(suite.plannedCoverageComplete, false);
  assert.equal(suite.m4AcceptancePassed, false);
  assert.equal(suite.qualityVerdict, 'unassessed');
  assert.equal(suite.acceptanceStatus, 'incomplete');
  assert.equal(suite.coverage.filter(row => row.status === 'covered-in-fixed-fixtures').length, 7);
  assert.equal(suite.coverage.filter(row => row.status === 'partial').length, 6);
  assert.ok(Object.values(suite.validation).every(item => item.passed));
  assert.match(suite.matrixSha256, /^[a-f0-9]{64}$/);
  assert.equal(exitCode(suite), 0);
  assert.equal(exitCode(suite, true), 1);
});

test('missing whole runners and empty reports fail closed', () => {
  assert.equal(assessReports({}).offlineChecksPassed, false);
  assert.equal(assessReports(null).offlineChecksPassed, false);
  const result = changed(reports => { delete reports.integration; });
  assert.equal(result.offlineChecksPassed, false);
  assert.ok(result.coverage.some(row => row.status === 'blocked'));
});

test('missing or duplicated cases cannot improve the denominator', () => {
  for (const mutate of [
    reports => { reports.extraction.cases.pop(); },
    reports => { reports.integration.cases.push(reports.integration.cases[0]); },
    reports => { reports.offline.cases = []; },
  ]) assert.equal(changed(mutate).offlineChecksPassed, false);
});

test('a forged passing parent gate cannot hide a failed child or a skipped case', () => {
  const failure = changed(reports => { reports.offline.cases[1].checks[0].passed = false; });
  assert.equal(failure.offlineChecksPassed, false);
  assert.equal(exitCode(failure), 1);
  assert.equal(changed(reports => { reports.integration.cases[0].skipped = true; }).offlineChecksPassed, false);
});

test('actual/expected mismatches, deleted checks and duplicate check identities are rejected', () => {
  for (const mutate of [
    reports => { reports.offline.cases[0].checks[0].actual = 'wrong'; },
    reports => { reports.offline.cases[0].checks.pop(); },
    reports => { reports.offline.cases[0].checks[0] = reports.offline.cases[0].checks[1]; },
    reports => { delete reports.offline.cases[0].checks[0].actual; },
    reports => { const check = reports.offline.cases[0].checks[0]; check.actual = NaN; check.expected = NaN; },
    reports => { const check = reports.offline.cases[0].checks[0]; check.actual = undefined; check.expected = undefined; },
    reports => { reports.integration.cases[0].executionError = 'synthetic-error'; },
  ]) assert.equal(changed(mutate).offlineChecksPassed, false);
});

test('method revision checks cannot be renamed away behind a passing parent gate', () => {
  const result = changed(reports => {
    for (const item of reports.integration.cases.filter(item => item.id === 'E2')) {
      const check = item.checks.find(check => check.factId === 'method-old-content-excluded');
      check.factId = 'unrelated-padding-check';
    }
  });
  assert.equal(result.offlineChecksPassed, false);
  assert.ok(result.validation.integration.problems.some(problem => problem.includes('missing-check:')));
});

test('unresolved publication labels are mandatory despite a forged passing parent', () => {
  for (const reviewer of ['user', 'auto']) {
    const result = changed(reports => {
      for (const item of reports.integration.cases.filter(item => item.id === 'Q2')) {
        item.checks.find(check => check.factId === `unresolved-${reviewer}-context-label`).factId = 'padding';
      }
    });
    assert.equal(result.offlineChecksPassed, false);
    assert.ok(result.validation.integration.problems.some(problem => problem.includes('missing-check:')));
  }
});

test('extraction facts retain the frozen per-case denominator and aggregate counts', () => {
  for (const mutate of [
    reports => { reports.extraction.cases[0].required = 0; reports.extraction.cases[0].recovered = 0; },
    reports => { reports.extraction.cases[0].recovered = NaN; },
    reports => { reports.extraction.required = 0; },
  ]) assert.equal(changed(mutate).offlineChecksPassed, false);
});

test('wrong suite identities, hashes and unexpected runners do not pass', () => {
  for (const mutate of [
    reports => { reports.offline.suite = 'invented'; },
    reports => { reports.extraction.fixtureSha256 = 'not-a-hash'; },
    reports => { reports.unknown = {}; },
  ]) assert.equal(changed(mutate).offlineChecksPassed, false);
});

test('a plan is a side-effect-free manifest, not an execution report', () => {
  const plan = planReport();
  assert.equal(plan.action, 'plan-only');
  assert.equal(plan.m4AcceptancePassed, false);
  assert.equal(plan.matrix.length, 13);
  assert.equal(plan.reports, undefined);
});

test('strict CLI returns 1 for incomplete M4 coverage even when all offline checks pass', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../eval/m4-suite.mjs', import.meta.url)), '--require-complete'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  const report = JSON.parse(child.stdout);
  assert.equal(report.offlineChecksPassed, true);
  assert.equal(report.plannedCoverageComplete, false);
  assert.equal(report.m4AcceptancePassed, false);
});

test('invalid CLI arguments stop before any evaluation report is produced', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../eval/m4-suite.mjs', import.meta.url)), '--unknown'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 8192, env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.status, 2);
  assert.equal(child.stdout, '');
});
