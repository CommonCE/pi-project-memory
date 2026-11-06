import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from '../eval/m4-fixtures.mjs';
import { validateGold, buildCase, scoreProposals, runEvaluation } from '../eval/m4-extraction.mjs';
import { parseExtractionResponse } from '../src/v2-extraction.mjs';

function parsed(item, change = candidate => candidate) {
  const built = buildCase(item);
  return parseExtractionResponse(JSON.stringify({ candidates: [change(built.candidate)] }), built.envelope);
}
const failed = fixtures.find(item => item.id === 'F1');

test('gold rejects empty suites, duplicate identities and ungrounded facts', () => {
  assert.throws(() => validateGold([]));
  assert.throws(() => validateGold([failed, failed]));
  assert.throws(() => validateGold([{ ...failed, facts: [{ id: 'invented', text: 'Invented successful result.' }] }]));
  assert.throws(() => validateGold([{ ...failed, facts: [failed.facts[0], failed.facts[0]] }]));
  validateGold(fixtures);
});

test('fixed-response extraction preserves fixture facts without claiming quality validation', () => {
  const report = runEvaluation();
  assert.equal(report.cases.length, fixtures.length * 3);
  assert.equal(report.preservationPassed, true);
  assert.equal(report.recovered, report.required);
  assert.equal(report.required, 45);
  assert.equal(report.qualityVerdict, 'unassessed');
  assert.equal(report.modelUsage, 'not-applicable');
  assert.ok(report.unassessed.includes('Q1 pending/rejected/publication isolation'));
  assert.ok(report.cases.every(item => item.inputChars <= 48000));
  assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
  assert.equal(runEvaluation().fixtureSha256, report.fixtureSha256);
});

test('missing candidates cannot pass by shrinking the fact denominator', () => {
  const score = scoreProposals(failed, []);
  assert.equal(score.required, failed.facts.length);
  assert.equal(score.recovered, 0);
  assert.deepEqual(score.errors, ['candidate-count']);
});

test('losing failure qualifiers is caught even when the energy remains', () => {
  const proposals = parsed(failed);
  proposals[0].entry.content = proposals[0].entry.content.replace('not converged, error termination, not a validated total energy.', 'successful.');
  assert.ok(proposals[0].entry.content.includes('-10.25 Ha'));
  const score = scoreProposals(failed, proposals);
  assert.ok(score.errors.includes('missing-fact-or-qualifier'));
  assert.ok(score.errors.includes('full-source-preservation'));
});

test('a grounded but misleading title is accepted by parser and rejected by fixture scoring', () => {
  const proposals = parsed(failed, candidate => ({ ...candidate, title: 'converged',
    grounding: [{ id: candidate.grounding[0].id, quote: 'not converged, error termination, not a validated total energy.' }] }));
  const score = scoreProposals(failed, proposals);
  assert.equal(score.recovered, score.required);
  assert.ok(score.errors.includes('forbidden-title'));
});

test('invented quotes fail production grounding validation', () => {
  assert.throws(() => parsed(failed, candidate => ({ ...candidate,
    grounding: [{ id: candidate.grounding[0].id, quote: 'The calculation succeeded without any errors.' }] })),
  error => error.code === 'invalid-grounding');
});

test('same titles do not hide wrong method association', () => {
  const a = fixtures.find(item => item.id === 'E1-A');
  const b = fixtures.find(item => item.id === 'E1-B');
  const proposals = parsed(a, candidate => ({ ...candidate, entities: b.refs }));
  assert.equal(proposals[0].entry.title, b.title);
  assert.ok(scoreProposals(a, proposals).errors.includes('entity-association'));
});

test('review-style verification promotion and scientific fields are scored as errors', () => {
  const proposals = parsed(failed);
  proposals[0].entry.verification = 'user-confirmed';
  proposals[0].entry.run = { termination: 'normal', convergence: 'converged', validity: 'accepted-with-scope' };
  const score = scoreProposals(failed, proposals);
  assert.ok(score.errors.includes('verification'));
  assert.ok(score.errors.includes('structured-science'));
});

test('source provenance changes cannot pass on text preservation alone', () => {
  const proposals = parsed(failed);
  proposals[0].entry.content = proposals[0].entry.content.replace('tool transport failed', 'tool transport completed');
  assert.ok(scoreProposals(failed, proposals).errors.includes('source-label'));
});

test('P2 keeps contradictory assistant and tool observations bound to their own sources', () => {
  const item = fixtures.find(item => item.id === 'P2');
  for (const variant of ['plain', 'before', 'after']) {
    const built = buildCase(item, variant);
    assert.deepEqual(built.candidate.grounding.map(ref => built.envelope.evidence.find(source => source.id === ref.id).source),
      ['assistant-claim', 'tool-observation']);
    const proposals = parseExtractionResponse(JSON.stringify({ candidates: [{
      ...built.candidate, grounding: [...built.candidate.grounding].reverse(),
    }] }), built.envelope);
    assert.deepEqual(scoreProposals(item, proposals).errors, []);
    proposals[0].entry.content = proposals[0].entry.content
      .replace('[assistant-claim]', '[swapped]').replace('[tool-observation; tool transport completed]', '[assistant-claim]')
      .replace('[swapped]', '[tool-observation; tool transport completed]');
    assert.ok(scoreProposals(item, proposals).errors.includes('source-association'));
  }
});

test('P2 assistant-only success selection is legal grounding but fails preservation scoring', () => {
  const item = fixtures.find(item => item.id === 'P2');
  const proposals = parsed(item, candidate => ({ ...candidate, title: 'run-A successfully converged',
    grounding: [candidate.grounding[0]] }));
  const score = scoreProposals(item, proposals);
  assert.ok(score.errors.includes('forbidden-title'));
  assert.ok(score.errors.includes('missing-fact-or-qualifier'));
  assert.ok(score.errors.includes('full-source-preservation'));
  assert.ok(score.errors.includes('source-association'));
  assert.throws(() => validateGold([{ ...item, facts: [{ ...item.facts[0], sourceIndex: 0 }] }]));
  for (const sourceIndex of [null, -1, 2, 0.5, '0']) {
    assert.throws(() => validateGold([{ ...item, facts: [{ ...item.facts[0], sourceIndex }] }]));
  }
  assert.throws(() => validateGold([{ ...item, priorSources: {} }]));
});

test('before and after distractors never become the selected evidence', () => {
  for (const item of fixtures) {
    for (const variant of ['before', 'after']) {
      const built = buildCase(item, variant);
      const proposals = parseExtractionResponse(JSON.stringify({ candidates: [built.candidate] }), built.envelope);
      assert.equal(proposals.length, 1);
      assert.ok(!proposals[0].entry.content.includes('Unrelated run-Z'));
      assert.deepEqual(scoreProposals(item, proposals).errors, []);
    }
  }
});
