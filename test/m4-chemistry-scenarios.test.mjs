import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparedFixture, rerunFixtures } from '../eval/m4-chemistry-scenarios-fixtures.mjs';
import { runPreparedGeneration, runRerunGeneration } from '../eval/m4-chemistry-scenarios.mjs';

const checkPassed = (report, id) => assert.equal(report.checks.find(check => check.id === id)?.passed, true, id);
function passed(report, count) {
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, true, JSON.stringify(report.checks.filter(check => !check.passed)));
  assert.equal(report.checks.length, count);
  assert.equal(new Set(report.checks.map(check => check.id)).size, count);
  checkPassed(report, 'sandbox-cleaned');
  assert.equal(report.modelSelectionQuality, 'unassessed');
  assert.equal(report.qualityVerdict, 'unassessed');
  assert.equal(report.modelUsage, 'not-applicable');
  assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(report.sourceSha256).every(hash => /^[a-f0-9]{64}$/.test(hash)));
}

test('prepared and rerun gold binds each fact and quote to its own synthetic source', () => {
  for (const item of [preparedFixture, ...rerunFixtures]) {
    assert.equal(new Set(item.facts.map(fact => fact.id)).size, item.facts.length);
    for (const fact of item.facts) {
      assert.ok(Number.isSafeInteger(fact.source));
      assert.ok(item.messages[fact.source].content.includes(fact.text), `${item.id}:${fact.id}`);
    }
    item.quotes.forEach((quote, index) => assert.ok(item.messages[index].content.includes(quote)));
  }
});

test('prepared input stays unexecuted in candidate, publication, query and fresh-process context', async () => {
  const report = await runPreparedGeneration();
  passed(report, 49);
  for (const phase of ['candidate', 'published', 'query', 'context']) {
    for (const fact of preparedFixture.facts) checkPassed(report, `prepared:${phase}:${fact.id}`);
  }
  checkPassed(report, 'prepared:structured-state-not-inferred');
  checkPassed(report, 'prepared:no-output-created');
});

test('grounded affirmative substring of a negation cannot pass the prepared title gate', async () => {
  const report = await runPreparedGeneration({ selection: 'misleading-title' });
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, false);
  assert.deepEqual(report.checks.filter(check => !check.passed).map(check => check.id),
    ['prepared:candidate-title', 'prepared:published-title']);
  checkPassed(report, 'prepared:queued');
  checkPassed(report, 'sandbox-cleaned');
});

test('method rerun keeps same-title records, old failure and each run association independent', async () => {
  const report = await runRerunGeneration();
  passed(report, 90);
  for (const item of rerunFixtures) {
    for (const phase of ['candidate', 'published', 'query', 'context']) {
      for (const fact of item.facts) checkPassed(report, `${item.id}:${phase}:${fact.id}`);
    }
    checkPassed(report, `${item.id}:other-record-excluded`);
    checkPassed(report, `${item.id}:context-identifies-run`);
  }
  checkPassed(report, 'rerun:old-record-unchanged');
});

test('legal but swapped run references fail identity and contamination checks after publication', async () => {
  const report = await runRerunGeneration({ selection: 'swapped-run' });
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, false);
  for (const item of rerunFixtures) {
    checkPassed(report, `${item.id}:queued`);
    assert.equal(report.checks.find(check => check.id === `${item.id}:correct-run-association`).passed, false);
    assert.equal(report.checks.find(check => check.id === `${item.id}:query-identity`).passed, false);
    assert.equal(report.checks.find(check => check.id === `${item.id}:context:foreign-energy-excluded`).passed, false);
  }
  checkPassed(report, 'sandbox-cleaned');
});

test('missing run links remain a generation failure that context filtering cannot repair', async () => {
  const report = await runRerunGeneration({ selection: 'missing-run' });
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, false);
  for (const item of rerunFixtures) {
    checkPassed(report, `${item.id}:queued`);
    assert.equal(report.checks.find(check => check.id === `${item.id}:correct-run-association`).passed, false);
    assert.equal(report.checks.find(check => check.id === `${item.id}:query-identity`).passed, false);
    assert.equal(report.checks.find(check => check.id === `${item.id}:context:foreign-energy-excluded`).passed, false);
  }
  checkPassed(report, 'sandbox-cleaned');
});

test('scenario selections reject unknown modes without allocating a sandbox', async () => {
  await assert.rejects(runPreparedGeneration({ selection: 'swapped-run' }), /Invalid prepared selection/);
  await assert.rejects(runRerunGeneration({ selection: 'misleading-title' }), /Invalid rerun selection/);
});

test('scenario CLI runs only the two fixed-response cases and rejects additional arguments', () => {
  const script = fileURLToPath(new URL('../eval/m4-chemistry-scenarios.mjs', import.meta.url));
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } };
  const child = spawnSync(process.execPath, [script], options);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.fixedResponseContractPassed, true);
  assert.deepEqual(report.reports.map(report => report.id), ['prepared', 'method-rerun']);
  const invalid = spawnSync(process.execPath, [script, '--submit'], options);
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
});
