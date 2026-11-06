import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withSandbox } from '../eval/m4-integration.mjs';
import { runOfflineEvaluation } from '../eval/m4-offline.mjs';

let report;
test.before(async () => { report = await runOfflineEvaluation(); });

test('async sandboxes remain initialized during awaited work, then clean up', async () => {
  let base;
  const result = await withSandbox(async sandbox => {
    base = sandbox.base;
    await Promise.resolve();
    assert.equal(fs.existsSync(sandbox.root + '/.pi-root'), true);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(fs.existsSync(base), false);
});

test('async rejection also cleans every sandbox artifact', async () => {
  let base;
  await assert.rejects(withSandbox(async sandbox => {
    base = sandbox.base;
    await Promise.resolve();
    throw new Error('intentional async failure');
  }), /intentional async failure/);
  assert.equal(fs.existsSync(base), false);
});

test('project boundaries and synthetic privacy checks pass without remote calls', () => {
  const item = report.cases.find(item => item.id === 'I1');
  assert.equal(item.passed, true);
  assert.ok(item.checks.every(check => check.passed));
});

test('auto preserves reported uncertainty and does not override a human rejection', () => {
  const item = report.cases.find(item => item.id === 'A1');
  assert.equal(item.passed, true);
  assert.ok(item.checks.find(check => check.factId === 'auto-run-state-unknown').passed);
  assert.ok(item.checks.find(check => check.factId === 'auto-respects-human-rejection').passed);
});

test('identical explicitly seeded corpus compares common v1/v2 text retrieval, not unsupported APIs', () => {
  const item = report.cases.find(item => item.id === 'COMPARE');
  assert.equal(item.passed, true);
  assert.equal(item.details.measurements.length, 8);
  for (const label of ['v1', 'v2']) {
    assert.equal(item.details.measurements.reduce((sum, sample) => sum + sample.coverage[label].required, 0), 15);
    assert.equal(item.details.measurements.find(sample => sample.id === 'P2').coverage[label].recovered, 2);
  }
  for (const sample of item.details.measurements) {
    for (const label of ['v1', 'v2']) {
      assert.equal(sample.coverage[label].recovered, sample.coverage[label].required);
      assert.ok(sample.contextChars[label] <= 12000);
    }
  }
  assert.ok(item.details.unsupported.length > 0);
});

test('both long-source limitations must survive the quality gate after the B1 fix', () => {
  assert.deepEqual(report.cases.filter(item => !item.passed), []);
  const b1 = report.cases.find(item => item.id === 'B1');
  for (const factId of ['long-limitation-1-recoverable', 'long-limitation-2-recoverable']) {
    assert.ok(b1.checks.find(check => check.factId === factId)?.passed);
  }
  assert.equal(report.syntheticContractPassed, true);
  assert.equal(report.qualityVerdict, 'unassessed');
  assert.ok(report.cases.every(item => item.checks.find(check => check.factId === 'sandbox-cleaned').passed));
});

test('CLI returns exit 0 only when every offline quality check passes', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../eval/m4-offline.mjs', import.meta.url))], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024, env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  const decoded = JSON.parse(child.stdout);
  assert.equal(decoded.syntheticContractPassed, true);
  assert.equal(decoded.cases.find(item => item.id === 'B1').passed, true);
});
