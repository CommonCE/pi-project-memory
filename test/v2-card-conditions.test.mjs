import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { normalizeCard } from '../src/v2-cards.mjs';
import { validateCardConditions } from '../src/v2-card-publication.mjs';
import { MemoryError, normalizeEntry } from '../src/v2-domain.mjs';

const locator = 'synthetic/output.log:12';
const sources = [{ locator, quote: 'Synthetic observation; no real calculation was executed.', source: 'tool-observation' }];
const known = value => ({ state: 'known', value, sources: structuredClone(sources) });
const unknown = () => ({ state: 'unknown', reason: 'Not supplied.' });
const pin = () => ({ id: randomUUID(), revision: 1 });
const fieldsFor = {
  systems: ['composition', 'structure', 'charge', 'spin', 'multiplicity', 'periodicity'],
  methods: ['model', 'basis', 'pseudopotential', 'dispersion', 'solvent', 'software', 'version', 'applicability'],
  runs: ['task', 'system', 'method', 'convergenceCriteria', 'validityScope'],
  results: ['propertyKey', 'qualifiers', 'run'],
  diagnostics: ['originalError', 'phase', 'originRun', 'hypotheses', 'confirmedCauses', 'parameterChanges', 'rerun'],
};
function entry(kind, fields = {}, extra = {}) {
  const base = normalizeEntry({ kind, title: 'Synthetic card', content: 'Not a real scientific observation.', evidence: [locator], ...extra });
  return { ...base, card: normalizeCard({ version: 1,
    fields: { ...Object.fromEntries(fieldsFor[kind].map(key => [key, unknown()])), ...fields },
    limitations: ['Synthetic data; no scientific certification.'],
  }, { kind, evidence: base.evidence }) };
}
const invalid = error => error instanceof MemoryError && error.code === 'invalid-schema';
function support(value, paths) {
  value.card.support = Object.fromEntries(paths.map(key => [key, structuredClone(sources)]));
  return value;
}
function result(runId = randomUUID(), revision = 1) {
  return support(entry('results', { propertyKey: known('energy'), qualifiers: known({}), run: known({ id: runId, revision }) },
    { result: { runId, property: 'energy', value: 0, unit: 'eV', definition: 'Synthetic total energy.' } }),
  ['result.property', 'result.value', 'result.unit', 'result.definition']);
}

test('M6 conditions allow explicit unknown descriptions but require every declaration', () => {
  for (const kind of ['systems', 'methods', 'runs', 'diagnostics']) {
    const value = entry(kind);
    assert.equal(validateCardConditions(value), undefined);
    const key = fieldsFor[kind][0];
    delete value.card.fields[key];
    assert.throws(() => validateCardConditions(value), invalid);
  }
  assert.equal(validateCardConditions(normalizeEntry({ kind: 'systems', title: 'Legacy', content: 'No card.' })), undefined);
});

test('M6 numeric results require known identity, fixed run, explicit unit and support', () => {
  const value = result();
  assert.equal(validateCardConditions(value), undefined);
  assert.equal(value.result.value, 0);
  for (const field of ['propertyKey', 'qualifiers', 'run']) {
    const changed = structuredClone(value); changed.card.fields[field] = unknown();
    assert.throws(() => validateCardConditions(changed), invalid);
  }
  for (const path of Object.keys(value.card.support)) {
    const changed = structuredClone(value); delete changed.card.support[path];
    assert.throws(() => validateCardConditions(changed), invalid);
  }
  const missing = structuredClone(value); delete missing.result;
  assert.throws(() => validateCardConditions(missing), invalid);
  const foreign = structuredClone(value); foreign.card.fields.run.value.id = randomUUID();
  assert.throws(() => validateCardConditions(foreign), invalid);
});

test('M6 run axes need attributed support and do not imply each other', () => {
  const value = support(entry('runs', {}, { run: { execution: 'terminated', termination: 'normal',
    convergence: 'not-converged', validity: 'unchecked', input: 'synthetic.inp', output: 'synthetic.out' } }),
  ['run.execution', 'run.termination', 'run.convergence', 'run.input', 'run.output']);
  assert.equal(validateCardConditions(value), undefined);
  assert.equal(value.run.convergence, 'not-converged');
  assert.equal(value.run.validity, 'unchecked');
  for (const path of Object.keys(value.card.support)) {
    const changed = structuredClone(value); delete changed.card.support[path];
    assert.throws(() => validateCardConditions(changed), invalid);
  }
  const accepted = structuredClone(value); accepted.run.validity = 'accepted-with-scope';
  accepted.card.support['run.validity'] = sources;
  assert.throws(() => validateCardConditions(accepted), invalid);
  accepted.card.fields.validityScope = known('Synthetic property only; not a general validity assessment.');
  assert.equal(validateCardConditions(accepted), undefined);
  const impossible = structuredClone(value); impossible.run.execution = 'prepared';
  assert.throws(() => validateCardConditions(impossible), invalid);
});

test('M6 submitted and terminated run cards require input identity and output or explicit absence', () => {
  const submitted = support(entry('runs', {}, { run: { execution: 'submitted' } }), ['run.execution']);
  assert.throws(() => validateCardConditions(submitted), invalid);
  submitted.run.input = 'synthetic.inp'; submitted.card.support['run.input'] = sources;
  assert.equal(validateCardConditions(submitted), undefined);
  submitted.run.execution = 'terminated';
  assert.throws(() => validateCardConditions(submitted), invalid);
  submitted.card.fields.outputAbsence = known('Synthetic output was not retained.');
  assert.equal(validateCardConditions(submitted), undefined);
  submitted.run.output = 'synthetic.out'; submitted.card.support['run.output'] = sources;
  assert.throws(() => validateCardConditions(submitted), invalid);
});

test('M6 performed reruns require distinct pinned origin and execution identities', () => {
  const origin = pin(), rerun = pin();
  const value = entry('diagnostics', { originRun: known(origin), rerun: known({ status: 'performed', run: rerun }) });
  assert.equal(validateCardConditions(value), undefined);
  value.card.fields.rerun.value.run = origin;
  assert.throws(() => validateCardConditions(value), invalid);
  value.card.fields.rerun.value.run = rerun;
  value.card.fields.originRun = unknown();
  assert.throws(() => validateCardConditions(value), invalid);
});

test('M6 card support permits only existing authoritative fields and attributed sources', () => {
  const value = result();
  assert.deepEqual(normalizeCard(value.card, { kind: 'results', evidence: value.evidence }), value.card);
  for (const support of [{ value: sources }, { 'result.value': [] }, { 'result.value': null },
    { 'result.value': [{ ...sources[0], locator: 'not-established' }] }]) {
    assert.throws(() => normalizeCard({ ...value.card, support }, { kind: 'results', evidence: value.evidence }), invalid);
  }
  assert.throws(() => normalizeCard({ ...entry('systems').card, support: { 'run.execution': sources } },
    { kind: 'systems', evidence: [locator] }), invalid);
});
