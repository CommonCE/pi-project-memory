import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chemistryFixture, runChemistryGeneration } from '../eval/m4-chemistry-generation.mjs';

test('chemistry gold locates every fact in an explicit synthetic source', () => {
  assert.equal(new Set(chemistryFixture.facts.map(fact => fact.id)).size, 10);
  for (const fact of chemistryFixture.facts) {
    assert.ok(Number.isSafeInteger(fact.source));
    assert.ok(chemistryFixture.messages[fact.source].content.includes(fact.text), fact.id);
  }
});

test('actual extraction, review and fresh-process retrieval retain chemistry facts without certifying them', async () => {
  const report = await runChemistryGeneration();
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, true, JSON.stringify(report.checks.filter(check => !check.passed)));
  assert.equal(report.checks.length, 56);
  for (const phase of ['candidate', 'published', 'query', 'fresh-process-context']) {
    for (const fact of chemistryFixture.facts) {
      assert.equal(report.checks.find(check => check.id === `${phase}:${fact.id}`)?.passed, true);
    }
  }
  assert.equal(report.modelSelectionQuality, 'unassessed');
  assert.equal(report.qualityVerdict, 'unassessed');
  assert.equal(report.modelUsage, 'not-applicable');
  assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(report.sourceSha256).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  assert.equal(report.checks.find(check => check.id === 'sandbox-cleaned').passed, true);
});

test('legal assistant-only selection passes grounding and approval but fails the chemistry usefulness gate', async () => {
  const report = await runChemistryGeneration({ selection: 'assistant-only' });
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, false);
  for (const id of ['generation-queued', 'pending-status', 'approval-not-certification', 'sandbox-cleaned']) {
    assert.equal(report.checks.find(check => check.id === id).passed, true);
  }
  for (const phase of ['candidate', 'published', 'fresh-process-context']) {
    assert.equal(report.checks.find(check => check.id === `${phase}:energy-with-limits`).passed, false);
    assert.equal(report.checks.find(check => check.id === `${phase}:method`).passed, false);
  }
});

test('unbounded or invented chemistry evaluation selection is rejected before execution', async () => {
  await assert.rejects(runChemistryGeneration({ selection: 'real-model' }), /Invalid fixed selection/);
});

test('chemistry CLI reports only the fixed-response contract and rejects extra arguments', () => {
  const script = fileURLToPath(new URL('../eval/m4-chemistry-generation.mjs', import.meta.url));
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } };
  const run = spawnSync(process.execPath, [script], options);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).fixedResponseContractPassed, true);
  const invalid = spawnSync(process.execPath, [script, '--real-model'], options);
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
});
