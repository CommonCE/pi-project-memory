import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withSandbox } from '../eval/m4-integration.mjs';
import { saveV2 } from '../src/v2-store.mjs';
import { listCandidatesV2 } from '../src/v2-candidates.mjs';
import { buildExtractionEnvelope, parseExtractionResponse, extractCandidatesV2, EXTRACTION_PROMPT, EXTRACTION_LIMITS } from '../src/v2-extraction.mjs';

const messages = [{ role: 'user', content: 'Inspect synthetic run-B; do not submit or execute.' }];
const code = expected => error => error.code === expected;
const identity = context => ({ id: randomUUID(), kind: 'runs', revision: 1, title: 'Same-name run', context });
const build = (entities, extra = {}) => buildExtractionEnvelope(messages, {
  projectId: '11111111-1111-4111-8111-111111111111', session: 'synthetic-context', turn: 'inspect', entities, ...extra,
});
const candidate = extra => ({ kind: 'diagnostics', title: 'Inspect synthetic run-B',
  grounding: [{ id: 'm0', quote: 'Inspect synthetic run-B' }], ...extra });
const response = candidates => JSON.stringify({ candidates });

test('same-title entity descriptions distinguish identities but never become grounding or new content', () => {
  const entities = [identity('BACKGROUND_ONLY_A: synthetic/run-A/input.inp; old failure.'),
    identity('BACKGROUND_ONLY_B: synthetic/run-B/input.inp; reported success is not scientific validation.')];
  const { envelope } = build(entities);
  assert.deepEqual(envelope.entities.map(entity => entity.title), ['Same-name run', 'Same-name run']);
  assert.notEqual(envelope.entities[0].context.text, envelope.entities[1].context.text);
  for (const [index, entity] of envelope.entities.entries()) {
    assert.deepEqual(entity.context, { source: 'background-only', text: entities[index].context, truncated: false });
  }
  const [proposal] = parseExtractionResponse(response([candidate({ entities: [{ type: 'run', id: entities[1].id }] })]), envelope);
  assert.equal(proposal.entry.verification, 'reported');
  assert.equal(proposal.entry.provenance, 'model-extraction');
  assert.equal(proposal.entry.result, undefined);
  assert.doesNotMatch(proposal.entry.content, /BACKGROUND_ONLY|reported success/);
  for (const grounding of [
    [{ id: entities[1].id, quote: entities[1].context }],
    [{ id: 'm0', quote: entities[1].context }],
  ]) assert.throws(() => parseExtractionResponse(response([candidate({ grounding })]), envelope), code('invalid-grounding'));
  assert.throws(() => parseExtractionResponse(response([candidate({ title: 'reported success' })]), envelope), code('invalid-grounding'));
});

test('ambiguous follow-up stays unlinked instead of guessing a same-title origin or a speculative rerun', () => {
  const entities = [identity('Identity run-A; method PBE0/def2-SVP.'), identity('Identity run-B; method PBE0/def2-TZVP.')];
  const advice = 'Hypothesis only: change basis from def2-SVP to def2-TZVP for a new run; no retry yet. Originating run unspecified.';
  const { envelope } = buildExtractionEnvelope([{ role: 'user', content: 'Record this diagnostic hypothesis; originating run unknown.' },
    { role: 'assistant', stopReason: 'stop', content: advice }], {
    projectId: '11111111-1111-4111-8111-111111111111', session: 'synthetic-context', turn: 'ambiguous', entities,
  });
  const [proposal] = parseExtractionResponse(response([{ kind: 'diagnostics', title: 'Hypothesis only',
    grounding: [{ id: 'm1', quote: advice }], entities: [] }]), envelope);
  assert.deepEqual(proposal.entry.entities, []);
  assert.equal(proposal.target, undefined);
  assert.equal(proposal.entry.run, undefined);
  assert.equal(proposal.entry.result, undefined);
  assert.equal(proposal.entry.verification, 'reported');
  assert.ok(proposal.entry.content.includes(advice));
  assert.doesNotMatch(proposal.entry.content, /Identity run-[AB]/);
});

test('entity context privacy filtering happens before truncation and preserves safe identity metadata', () => {
  const sensitive = identity('safe prefix '.repeat(1000) + 'password = unsafeValue');
  const built = build([sensitive]);
  assert.equal(built.envelope.entities[0].id, sensitive.id);
  assert.equal(built.envelope.entities[0].context, undefined);
  assert.equal(built.reasons['sensitive-fragment-dropped'], 1);
  assert.doesNotMatch(JSON.stringify(built), /unsafeValue|safe prefix/);
});

test('context descriptions are optional, strictly typed and source-bounded rather than coerced', () => {
  for (const context of [null, 0, false, {}, []]) assert.throws(() => build([identity(context)]), code('invalid-schema'));
  const legacy = identity(undefined);
  const plain = build([legacy]);
  assert.equal(plain.envelope.entities[0].context, undefined);
  const huge = build([identity('x'.repeat(EXTRACTION_LIMITS.sourceChars + 1))]);
  assert.equal(huge.envelope.entities[0].context, undefined);
  assert.equal(huge.reasons['source-bounded'], 1);
});

test('all identities precede optional context, and serialized descriptions obey Unicode and global budgets', () => {
  const entities = Array.from({ length: 8 }, () => identity('\\"🧪'.repeat(500)));
  const baseline = build(entities.map(({ context, ...entity }) => entity));
  const maxChars = baseline.inputChars + 80;
  const tight = build(entities, { maxChars });
  assert.deepEqual(tight.envelope.entities.map(entity => entity.id), entities.map(entity => entity.id));
  assert.ok(tight.inputChars <= maxChars);
  assert.equal(tight.reasons['entity-context-truncated'], entities.length);
  assert.ok(tight.envelope.entities.every(entity => entity.context === undefined));
  const background = [{ label: 'state', text: 'CURRENT_TASK '.repeat(20) }];
  const taskBase = build(entities.map(({ context, ...entity }) => entity), { background });
  const withTask = build(entities.map(entity => ({ ...entity, context: 'Short optional description.' })),
    { background, maxChars: taskBase.inputChars + 10 });
  assert.deepEqual(withTask.envelope.background, taskBase.envelope.background);
  assert.ok(withTask.envelope.entities.every(entity => entity.context === undefined));
  const roomy = build(entities);
  assert.ok(roomy.inputChars <= EXTRACTION_LIMITS.inputChars);
  assert.equal(roomy.inputChars, EXTRACTION_PROMPT.length + JSON.stringify(roomy.envelope).length);
  for (const entity of roomy.envelope.entities) {
    assert.equal(entity.context.source, 'background-only');
    assert.equal(entity.context.truncated, true);
    assert.ok(entity.context.text.length <= 800);
    assert.ok(entity.context.text.isWellFormed());
  }
});

test('actual extraction supplies selected run content and unverified metadata without copying them into memory', async () => {
  await withSandbox(async ({ project }) => {
    const runs = ['A', 'B', 'UNSELECTED'].map(label => saveV2(project, { kind: 'runs', title: 'Same-name run',
      content: `Synthetic identity ${label}; no calculation executed in this test.`,
      run: { execution: 'prepared', input: `synthetic/run-${label}/input.inp`, software: 'ORCA', version: '6.1.1' } }).record);
    const result = await extractCandidatesV2(project, messages, {
      session: 'synthetic-context', turn: 'inspect', mode: 'review', entityIds: runs.slice(0, 2).map(run => run.id), isCurrent: () => true,
      model: async ({ prompt }) => {
        const envelope = JSON.parse(prompt);
        assert.deepEqual(envelope.entities.map(entity => entity.id), runs.slice(0, 2).map(run => run.id));
        assert.doesNotMatch(prompt, /UNSELECTED/);
        const matches = envelope.entities.filter(entity => entity.context.text.includes('synthetic/run-B/input.inp'));
        assert.equal(matches.length, 1);
        assert.equal(matches[0].context.source, 'background-only');
        assert.match(matches[0].context.text, /"execution":"prepared"/);
        assert.match(matches[0].context.text, /"convergence":"unknown"/);
        assert.match(matches[0].context.text, /"validity":"unchecked"/);
        return { text: response([candidate({ entities: [{ type: 'run', id: matches[0].id }] })]) };
      },
    });
    assert.equal(result.status, 'queued');
    assert.equal(result.counts.modelCalls, 1);
    assert.equal(result.counts.published, 0);
    const [pending] = listCandidatesV2(project).candidates;
    assert.deepEqual(pending.candidate.entry.entities, [{ type: 'run', id: runs[1].id }]);
    assert.equal(pending.candidate.entry.run, undefined);
    assert.equal(pending.candidate.entry.result, undefined);
    assert.doesNotMatch(pending.candidate.entry.content, /Synthetic identity|Run metadata|convergence|ORCA/);
  });
});
