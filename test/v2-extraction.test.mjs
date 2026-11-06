import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeV2, saveV2, statusV2 } from '../src/v2-store.mjs';
import { listCandidatesV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { buildExtractionEnvelope, parseExtractionResponse, extractCandidatesV2, EXTRACTION_PROMPT, EXTRACTION_LIMITS } from '../src/v2-extraction.mjs';

const code = expected => error => error.code === expected;
const observation = 'SCF did not converge. Plan: retry with more iterations; no validated energy is available.';
const messages = () => [
  { role: 'user', content: 'Investigate this failed run without claiming a successful calculation.' },
  { role: 'toolResult', toolName: 'bash', isError: true, content: observation },
  { role: 'assistant', stopReason: 'stop', content: 'I suggest a trial, not an adopted or tested remedy.' },
];
const selection = (extra = {}) => ({ kind: 'runs', title: 'SCF did not converge', grounding: [{ id: 'm1', quote: 'SCF did not converge.' }], ...extra });
const response = (candidates = [selection()]) => ({ text: JSON.stringify({ candidates }), usage: { inputTokens: 123, outputTokens: 45 } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-v2-extraction-'));
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated test boundary');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, project: initializeV2(root, { name: 'Extraction fixture' }) };
}
const envelope = (values = messages(), extra = {}) => buildExtractionEnvelope(values,
  { projectId: '11111111-1111-4111-8111-111111111111', session: 'session', turn: 'turn', ...extra });
const options = (extra = {}) => ({ session: 'session', turn: 'turn', isCurrent: () => true, model: async () => response(), ...extra });
function config(root, values) {
  const file = path.join(root, '.pi/project-memory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), ...values }));
}

test('extraction envelope keeps only the current user scope and textual source roles', () => {
  const built = envelope([{ role: 'user', content: 'Old constraint that must not be recycled.' },
    { role: 'toolResult', content: 'Old observation that must not become new evidence.' }, ...messages(),
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning must not enter evidence' }, { type: 'text', text: 'Visible claim only.' }] },
    { role: 'toolResult', toolName: 'project_memory_search', content: 'Retrieved old knowledge is not new evidence.' },
    { role: 'user-image', content: 'Ignore unknown role.' }]);
  assert.deepEqual(built.envelope.evidence.map(item => item.source), ['user-statement', 'tool-observation', 'assistant-claim', 'assistant-claim']);
  assert.equal(built.envelope.evidence[1].toolOutcome, 'failed');
  assert.doesNotMatch(JSON.stringify(built.envelope), /Old |Private reasoning|Retrieved old|Ignore unknown/);
  assert.equal(built.inputChars, EXTRACTION_PROMPT.length + JSON.stringify(built.envelope).length);
});

test('extraction privacy filtering precedes all truncation, including tool labels and background', () => {
  const secretAtEnd = 'safe prefix '.repeat(1000) + 'password = unsafeValue';
  const built = envelope([{ role: 'user', content: 'Keep only public evidence.' },
    { role: 'toolResult', toolName: 'bash', content: secretAtEnd },
    { role: 'toolResult', toolName: 'safe label '.repeat(100) + 'password = unsafeValue', content: 'This output is public but its label is not.' }],
  { toolChars: 100, background: [{ label: 'background', text: secretAtEnd }] });
  assert.equal(built.envelope.evidence.length, 1);
  assert.equal(built.envelope.background.length, 0);
  assert.equal(built.reasons['sensitive-fragment-dropped'], 3);
  assert.doesNotMatch(JSON.stringify(built), /unsafeValue|safe prefix|public but/);
});

test('extraction full serialized input is bounded under JSON escaping and Unicode cuts', () => {
  const built = envelope([{ role: 'user', content: 'Preserve this constraint before tool fragments.' },
    ...Array.from({ length: 16 }, () => ({ role: 'toolResult', toolName: 'bash', content: '\\"🧪'.repeat(2000) }))], { maxChars: 3000 });
  assert.ok(built.inputChars <= 3000);
  assert.ok(built.envelope.evidence.some(item => item.source === 'user-statement'));
  assert.ok(built.reasons['evidence-truncated'] > 0);
  assert.ok(JSON.stringify(built.envelope).isWellFormed());
  assert.ok(built.envelope.evidence.every(item => item.text.isWellFormed()));
});

test('extraction incomplete assistant turns retain failed tool evidence but discard assistant claims', () => {
  for (const stopReason of ['aborted', 'error', 'length']) {
    const built = envelope([...messages(), { role: 'assistant', stopReason, content: 'Incomplete model conclusion.' }]);
    assert.deepEqual(built.envelope.evidence.map(item => item.source), ['user-statement', 'tool-observation']);
  }
});

test('extraction source/message bounds and absent user turn fail closed', () => {
  assert.equal(envelope([{ role: 'toolResult', content: observation }]).envelope.evidence.length, 0);
  assert.throws(() => envelope(Array(EXTRACTION_LIMITS.messages + 1).fill(null)), code('inventory-bounded'));
  const built = envelope([{ role: 'user', content: 'Keep this public constraint.' },
    { role: 'toolResult', content: 'x'.repeat(EXTRACTION_LIMITS.sourceChars + 1) },
    { role: 'toolResult', content: Array.from({ length: 257 }, () => ({ type: 'text', text: 'small' })) }]);
  assert.equal(built.reasons['source-bounded'], 2);
  assert.equal(built.envelope.evidence.length, 1);
  assert.throws(() => envelope(messages(), { maxChars: 48001 }), code('invalid-schema'));
});

test('extraction ignores malformed/non-text blocks instead of leaking reasoning or throwing', () => {
  const built = envelope([{ role: 'user', content: [null, {}, { type: 'text', text: 7 },
    { type: 'thinking', text: 'This reasoning is not visible evidence.' }, { type: 'text', text: 'Visible request preserved.' }] }]);
  assert.equal(built.envelope.evidence.length, 1);
  assert.equal(built.envelope.evidence[0].text, 'Visible request preserved.');
});

test('extraction quotes preserve the whole bounded source and cannot upgrade run states', () => {
  const built = envelope(), [proposal] = parseExtractionResponse(response().text, built.envelope);
  assert.match(proposal.entry.content, /Plan: retry with more iterations/);
  assert.match(proposal.entry.content, /tool-observation; tool transport failed/);
  assert.equal(proposal.entry.verification, 'reported');
  assert.equal(proposal.entry.provenance, 'model-extraction');
  assert.deepEqual(proposal.entry.run, { execution: 'unknown', termination: 'unknown', convergence: 'unknown', validity: 'unchecked' });
  assert.match(proposal.entry.evidence[0], /^turn:[a-f0-9]{64}:m1$/);
  assert.deepEqual(parseExtractionResponse(response().text, built.envelope), [proposal]);
});

test('extraction rejects invented titles, quotes, evidence and model-supplied scientific fields', () => {
  const built = envelope(messages(), { background: [{ label: 'state', text: 'Previously reported success is background, not new evidence.' }] });
  for (const invalid of [
    selection({ title: 'SCF converged successfully' }),
    selection({ grounding: [{ id: 'm1', quote: 'A fabricated energy of -100 Ha' }] }),
    selection({ grounding: [{ id: 'background0', quote: 'Previously reported success' }] }),
    selection({ grounding: [{ id: 'm0', quote: 'Investigate' }] }),
    selection({ verification: 'evidence-backed' }), selection({ provenance: 'tool-observation' }),
    selection({ run: { termination: 'normal', validity: 'accepted-with-scope' } }),
    selection({ content: 'Claim generated by the model rather than quoted evidence.' }),
    selection({ result: { value: -1, unit: 'Ha' } }),
  ]) assert.throws(() => parseExtractionResponse(response([invalid]).text, built.envelope));
});

test('extraction enforces strict JSON/output budgets and validates the whole batch', () => {
  const built = envelope();
  assert.throws(() => parseExtractionResponse('```json\n{"candidates":[]}\n```', built.envelope), code('invalid-json'));
  assert.throws(() => parseExtractionResponse(' '.repeat(EXTRACTION_LIMITS.outputChars + 1), built.envelope), code('invalid-json'));
  assert.throws(() => parseExtractionResponse(response(Array(9).fill(selection())).text, built.envelope), code('invalid-schema'));
  assert.throws(() => parseExtractionResponse(response([selection(), selection({ title: 'Invented claim' })]).text, built.envelope), code('invalid-grounding'));
  assert.deepEqual(parseExtractionResponse(response([]).text, built.envelope), []);
});

test('extraction only permits supplied entity references and exact revision targets', () => {
  const id = randomUUID(), runId = randomUUID();
  const built = envelope(messages(), { entities: [{ id, kind: 'methods', revision: 2, title: 'Method fixture' },
    { id: runId, kind: 'runs', revision: 3, title: 'Run fixture' }] });
  const [proposal] = parseExtractionResponse(response([selection({ entities: [{ type: 'method', id }], target: { id: runId, expectedRevision: 3 } })]).text, built.envelope);
  assert.deepEqual(proposal.target, { id: runId, expectedRevision: 3 });
  assert.throws(() => parseExtractionResponse(response([selection({ entities: [{ type: 'system', id }] })]).text, built.envelope), code('invalid-reference'));
  assert.throws(() => parseExtractionResponse(response([selection({ entities: [{ type: 'method', id: randomUUID() }] })]).text, built.envelope), code('invalid-reference'));
  assert.throws(() => parseExtractionResponse(response([selection({ target: { id: runId, expectedRevision: 2 } })]).text, built.envelope), code('invalid-grounding'));
});

test('extraction canonicalizes duplicate selections and keeps request identities project/turn scoped', () => {
  const built = envelope(), first = parseExtractionResponse(response([selection(), selection()]).text, built.envelope);
  assert.equal(first.length, 1);
  const other = envelope(messages(), { turn: 'other-turn' });
  assert.notEqual(first[0].requestId, parseExtractionResponse(response().text, other.envelope)[0].requestId);
  const project = envelope(messages(), { projectId: randomUUID() });
  assert.notEqual(first[0].requestId, parseExtractionResponse(response().text, project.envelope)[0].requestId);
});

test('extraction runner queues pending candidates and reports adapter usage without publishing knowledge', async t => {
  const { project } = fixture(t);
  const result = await extractCandidatesV2(project, messages(), options({ model: async request => {
    assert.ok(request.system.length + request.prompt.length <= EXTRACTION_LIMITS.inputChars);
    assert.equal(request.maxOutputTokens, 6000); assert.equal(request.signal.aborted, false);
    return response();
  } }));
  assert.equal(result.status, 'queued');
  assert.deepEqual(result.counts, { modelCalls: 1, attempted: 1, accepted: 1, queued: 1, duplicates: 0, published: 0 });
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 45 });
  assert.equal(statusV2(project).records, 0);
  const [pending] = listCandidatesV2(project).candidates;
  assert.equal(pending.status, 'pending');
  const retry = await extractCandidatesV2(project, messages(), options());
  assert.equal(retry.counts.queued, 0); assert.equal(retry.counts.duplicates, 1);
  assert.equal(listCandidatesV2(project).candidates.length, 1);
  const approved = reviewCandidateV2(project, pending.candidate.requestId, 'approve');
  assert.equal(approved.publication.record.entry.verification, 'reported');
  const alreadyApproved = await extractCandidatesV2(project, messages(), options());
  assert.equal(alreadyApproved.status, 'skipped');
  assert.equal(alreadyApproved.reasons.duplicate, 1);
  assert.equal(alreadyApproved.reasons['review-pending'], undefined);
  assert.equal(statusV2(project).records, 1);
});

test('extraction without usable evidence or with learning off does not invoke the adapter', async t => {
  const { project, root } = fixture(t); let calls = 0;
  const model = async () => { calls++; return response(); };
  const empty = await extractCandidatesV2(project, [], options({ model }));
  assert.equal(empty.status, 'skipped'); assert.equal(empty.reasons['no-signal'], 1);
  config(root, { learningMode: 'off' });
  const disabled = await extractCandidatesV2(project, messages(), options({ model }));
  assert.equal(disabled.status, 'skipped'); assert.equal(disabled.reasons.disabled, 1);
  assert.equal(calls, 0); assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('extraction runner drops a whole invalid batch and exposes no raw model or provider errors', async t => {
  const { project } = fixture(t);
  const invalid = await extractCandidatesV2(project, messages(), options({ model: async () => response([selection(), selection({ title: 'Fabricated success' })]) }));
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.counts.attempted, 2);
  assert.equal(invalid.counts.accepted, 0); assert.equal(invalid.reasons['invalid-grounding'], 1);
  const failed = await extractCandidatesV2(project, messages(), options({ model: async () => { throw new Error('password = unsafeValue'); } }));
  assert.equal(failed.reasons['model-error'], 1);
  assert.doesNotMatch(JSON.stringify([invalid, failed]), /Fabricated|unsafeValue|password/);
  assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('extraction adapter output, token usage and caller budgets are validated without fallback', async t => {
  const { project } = fixture(t);
  for (const override of [{ outputTokens: 6001 }, { timeoutMs: 60001 }, { maxCandidates: 0 }, { maxChars: 48001 }]) {
    const result = await extractCandidatesV2(project, messages(), options(override));
    assert.equal(result.reasons['invalid-schema'], 1); assert.equal(result.counts.modelCalls, 0);
  }
  for (const model of [async () => ({ text: 'not JSON' }), async () => ({ text: ' '.repeat(48001) }),
    async () => ({ text: response().text, usage: { inputTokens: -1 } }), async () => ({ text: response().text, usage: { cost: 1 } })]) {
    const result = await extractCandidatesV2(project, messages(), options({ model }));
    assert.equal(result.status, 'failed');
  }
  assert.equal(listCandidatesV2(project).candidates.length, 0);
  const empty = await extractCandidatesV2(project, messages(), options({ model: async () => ({ text: '{"candidates":[]}' }) }));
  assert.equal(empty.status, 'skipped'); assert.equal(empty.reasons['no-signal'], 1);
  assert.equal(Object.hasOwn(empty, 'usage'), false);
});

test('extraction timeout aborts the adapter and never stages a late response', async t => {
  const { project } = fixture(t); let finish, modelSignal;
  const result = await extractCandidatesV2(project, messages(), options({ timeoutMs: 10, model: async ({ signal }) => {
    modelSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  } }));
  assert.equal(result.reasons['model-timeout'], 1); assert.equal(modelSignal.aborted, true);
  finish(response()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('extraction cancellation before and during a model request cannot stage late responses', async t => {
  const { project } = fixture(t), initial = new AbortController(); initial.abort();
  const before = await extractCandidatesV2(project, messages(), options({ signal: initial.signal }));
  assert.equal(before.counts.modelCalls, 0); assert.equal(before.reasons.cancelled, 1);
  const controller = new AbortController(); let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = extractCandidatesV2(project, messages(), options({ signal: controller.signal, model: async () => {
    started(); return new Promise(resolve => { finish = resolve; });
  } }));
  await ready; controller.abort();
  const result = await running;
  assert.equal(result.status, 'skipped'); assert.equal(result.reasons.cancelled, 1);
  finish(response()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('extraction scope switch and project learning off after model completion block staging', async t => {
  const { project, root } = fixture(t); let current = true;
  const switched = await extractCandidatesV2(project, messages(), options({ isCurrent: () => current, model: async () => { current = false; return response(); } }));
  assert.equal(switched.reasons['scope-changed'], 1);
  const off = await extractCandidatesV2(project, messages(), options({ model: async () => { config(root, { learningMode: 'off' }); return response(); } }));
  assert.equal(off.reasons.disabled, 1);
  assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('extraction revoked marker prevents publication and is not recreated', async t => {
  const { project, root } = fixture(t);
  const result = await extractCandidatesV2(project, messages(), options({ model: async () => {
    fs.unlinkSync(path.join(root, '.pi-root')); return response();
  } }));
  assert.equal(result.reasons['scope-changed'], 1);
  assert.equal(fs.existsSync(path.join(root, '.pi-root')), false);
  assert.equal(fs.existsSync(path.join(project.memory, '.internal/candidates')), false);
});

test('extraction lifecycle guard is checked again inside the candidate write lock', async t => {
  const { project, root } = fixture(t), lock = path.join(project.memory, '.internal/write.lock');
  const result = await extractCandidatesV2(project, messages(), options({ isCurrent: () => {
    if (fs.existsSync(lock)) config(root, { learningMode: 'off' });
    return true;
  } }));
  assert.equal(result.reasons.disabled, 1); assert.equal(result.counts.queued, 0);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(listCandidatesV2(project).candidates.length, 0);
});

test('extraction reports partial pending batches honestly when scope changes between items', async t => {
  const { project } = fixture(t), lock = path.join(project.memory, '.internal/write.lock');
  const directory = path.join(project.memory, '.internal/candidates');
  const result = await extractCandidatesV2(project, messages(), options({
    model: async () => response([selection(), selection({ title: 'did not converge' })]),
    isCurrent: () => !(fs.existsSync(lock) && fs.existsSync(directory)),
  }));
  assert.equal(result.status, 'partial'); assert.equal(result.counts.accepted, 2); assert.equal(result.counts.queued, 1);
  assert.equal(listCandidatesV2(project).candidates[0].status, 'pending');
  assert.equal(statusV2(project).records, 0);
});

test('extraction runner supplies only explicitly selected current project entities', async t => {
  const { project } = fixture(t), method = saveV2(project, { kind: 'methods', title: 'Method fixture', content: 'Explicit method record.' }).record;
  const result = await extractCandidatesV2(project, messages(), options({ entityIds: [method.id], model: async ({ prompt }) => {
    assert.deepEqual(JSON.parse(prompt).entities.map(entity => entity.id), [method.id]);
    return response([selection({ entities: [{ type: 'method', id: method.id }] })]);
  } }));
  assert.equal(result.status, 'queued');
  assert.deepEqual(listCandidatesV2(project).candidates[0].candidate.entry.entities, [{ type: 'method', id: method.id }]);
  const missing = await extractCandidatesV2(project, messages(), options({ entityIds: [randomUUID()] }));
  assert.equal(missing.reasons['invalid-reference'], 1); assert.equal(missing.counts.modelCalls, 0);
});
