import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runChemistryFollowup } from '../eval/m4-chemistry-followup.mjs';
import { preparedFixture, rerunFixtures } from '../eval/m4-chemistry-scenarios-fixtures.mjs';
import { buildExtractionEnvelope, EXTRACTION_PROMPT } from '../src/v2-extraction.mjs';

const checked = (report, id) => assert.equal(report.checks.find(check => check.id === id)?.passed, true, id);
const failed = (report, id) => assert.equal(report.checks.find(check => check.id === id)?.passed, false, id);
function contract(report, count) {
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, true, JSON.stringify(report.checks.filter(check => !check.passed)));
  assert.equal(report.checks.length, count);
  assert.equal(new Set(report.checks.map(check => check.id)).size, count);
  assert.equal(report.modelSelectionQuality, 'unassessed');
  assert.equal(report.qualityVerdict, 'unassessed');
  assert.equal(report.modelUsage, 'not-applicable');
  assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(report.sourceSha256).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  checked(report, 'sandbox-cleaned');
}
function acceptedNegative(report) {
  assert.equal(report.executionError, undefined);
  assert.equal(report.fixedResponseContractPassed, false);
  for (const id of ['extraction:queued', 'extraction:one-fixed-adapter-call', 'extraction:not-auto-published',
    'candidate:outside-knowledge', 'candidate:no-revision-target', 'published:still-reported',
    'published:no-structured-result', 'published:run-state-not-inferred', 'sandbox-cleaned']) checked(report, id);
}

test('prepared follow-up preserves advice without turning it into execution permission', async () => {
  const report = await runChemistryFollowup({ scenario: 'prepared' });
  contract(report, 55);
  for (const phase of ['candidate', 'published', 'scoped', 'context']) {
    for (const fact of preparedFixture.facts) checked(report, `${phase}:${fact.id}`);
  }
  checked(report, 'followup:origin-grounded');
  checked(report, 'followup:advice-grounded');
  checked(report, 'prepared:no-output');
});

test('separate hypothesis remains tied to its failed origin through approval, search and fresh-process context', async () => {
  const report = await runChemistryFollowup();
  contract(report, 46);
  for (const phase of ['candidate', 'published', 'scoped', 'context']) {
    for (const fact of rerunFixtures[0].facts) checked(report, `${phase}:${fact.id}`);
  }
  for (const id of ['adapter:origin-from-source-and-context', 'followup:correct-run', 'followup:origin-grounded',
    'foreign-run:no-advice', 'anchors:unchanged', 'context:foreign-anchor-excluded']) checked(report, id);
});

test('observed unlinked hypothesis is selected, not omitted, but fails run-scoped continuation', async () => {
  const report = await runChemistryFollowup({ selection: 'unlinked' });
  acceptedNegative(report);
  for (const phase of ['candidate', 'published']) {
    for (const fact of rerunFixtures[0].facts) checked(report, `${phase}:${fact.id}`);
  }
  checked(report, 'followup:selected');
  checked(report, 'followup:advice-grounded');
  checked(report, 'broad:advice-retained');
  checked(report, 'anchors:unchanged');
  failed(report, 'followup:origin-grounded');
  failed(report, 'followup:correct-run');
  failed(report, 'scoped:complementary-records');
  failed(report, 'scoped:unrun-method-change');
});

test('grounded hypothesis with the speculative rerun reference still fails semantic association', async () => {
  const report = await runChemistryFollowup({ selection: 'swapped' });
  acceptedNegative(report);
  checked(report, 'followup:origin-grounded');
  checked(report, 'followup:advice-grounded');
  checked(report, 'broad:advice-retained');
  checked(report, 'anchors:unchanged');
  failed(report, 'followup:correct-run');
  failed(report, 'foreign-run:no-advice');
  failed(report, 'scoped:unrun-method-change');
});

for (const scenario of ['prepared', 'failed-run']) test(`${scenario} omission is distinct from a retained but unlinked follow-up`, async () => {
  const report = await runChemistryFollowup({ scenario, selection: 'omitted' });
  acceptedNegative(report);
  const id = scenario === 'prepared' ? 'suggestion-not-permission' : 'unrun-method-change';
  for (const phase of ['candidate', 'published', 'scoped', 'context']) failed(report, `${phase}:${id}`);
  failed(report, 'followup:selected');
  failed(report, 'broad:advice-retained');
});

test('follow-up selection does not change the minimum supported envelope budget', () => {
  const built = buildExtractionEnvelope([], { projectId: '11111111-1111-4111-8111-111111111111',
    session: 'synthetic-followup', turn: 'budget', maxChars: 2048 });
  assert.ok(built.inputChars <= 2048);
  assert.equal(built.inputChars, EXTRACTION_PROMPT.length + JSON.stringify(built.envelope).length);
});

test('unknown follow-up modes are rejected before sandbox allocation', async () => {
  await assert.rejects(runChemistryFollowup({ scenario: 'unknown' }), /Invalid follow-up scenario/);
  await assert.rejects(runChemistryFollowup({ selection: 'guess' }), /Invalid follow-up selection/);
  await assert.rejects(runChemistryFollowup({ scenario: 'prepared', selection: 'swapped' }), /Invalid follow-up selection/);
});

test('follow-up CLI uses fixed responses only and rejects model or submission arguments', () => {
  const script = fileURLToPath(new URL('../eval/m4-chemistry-followup.mjs', import.meta.url));
  const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' } };
  const child = spawnSync(process.execPath, [script], options);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.fixedResponseContractPassed, true);
  assert.deepEqual(report.reports.map(report => report.scenario), ['prepared', 'failed-run']);
  for (const argument of ['--model', '--submit']) {
    const invalid = spawnSync(process.execPath, [script, argument], options);
    assert.equal(invalid.error, undefined);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
  }
});
