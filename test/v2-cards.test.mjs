import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeCard, CARD_LIMITS } from '../src/v2-cards.mjs';
import { MemoryError, normalizeEntry, SCHEMA_VERSION } from '../src/v2-domain.mjs';
import { getV2, initializeV2, rebuildV2, reviseV2, saveV2, searchV2 } from '../src/v2-store.mjs';

const locator = 'synthetic/output.log:12';
const source = { locator, quote: '  Synthetic observation, not a real calculation.\n', source: 'tool-observation' };
const known = value => ({ state: 'known', value, sources: [{ ...source }] });
const unknown = () => ({ state: 'unknown', reason: 'Not supplied by the synthetic source.' });
const card = fields => ({ version: 1, fields, limitations: ['Synthetic data; not scientific validation.'] });
const normalize = (kind, value) => normalizeCard(value, { kind, evidence: [locator] });
const invalid = error => error instanceof MemoryError && error.code === 'invalid-schema';

// These tests exercise the structural kernel separately from publication.
test('M6 card kernel accepts five kinds without inventing absent fields', () => {
  const cases = [
    ['systems', { composition: known('H2'), charge: known(0), periodicity: known([false, false, false]) }],
    ['methods', { model: known('Synthetic model'), software: unknown() }],
    ['runs', { task: known('single-point'), validityScope: unknown() }],
    ['results', { propertyKey: known('total-energy'), qualifiers: known({ component: 'total', frame: '0' }) }],
    ['diagnostics', { originalError: known('Synthetic failure'), phase: unknown() }],
  ];
  for (const [kind, fields] of cases) {
    const input = card(fields), before = structuredClone(input), result = normalize(kind, input);
    assert.deepEqual(result, input);
    assert.deepEqual(input, before);
    assert.deepEqual(normalize(kind, result), result);
    assert.notStrictEqual(result, input);
    assert.notStrictEqual(result.fields, input.fields);
  }
});

test('M6 unknown and not-applicable are distinct from omitted, null and defaults', () => {
  const result = normalize('methods', card({ basis: unknown(), pseudopotential: {
    state: 'not-applicable', reason: 'Synthetic all-electron setup.', sources: [{ ...source }],
  } }));
  assert.equal(Object.hasOwn(result.fields, 'solvent'), false);
  assert.equal(result.fields.basis.state, 'unknown');
  assert.equal(result.fields.pseudopotential.state, 'not-applicable');
  for (const value of [null, {}, { state: 'unknown' }, { state: 'known', value: 'x' },
    { state: 'unknown', reason: 'missing', value: 0 },
    { state: 'not-applicable', reason: 'unsupported assertion' },
    { state: 'known', value: 'x', reason: 'mixed state', sources: [source] }]) {
    assert.throws(() => normalize('methods', card({ basis: value })), invalid);
  }
});

test('M6 known fields require bounded established locators and preserve exact quotes', () => {
  const result = normalize('systems', card({ composition: known('H2') }));
  assert.equal(result.fields.composition.sources[0].quote, source.quote);
  for (const sources of [[], null, [{ ...source, locator: 'not-in-entry-evidence' }],
    [{ ...source, quote: '' }], [{ ...source, source: 'scientifically-verified' }],
    [{ ...source, quote: 'x'.repeat(CARD_LIMITS.quoteChars + 1) }],
    Array.from({ length: CARD_LIMITS.sources + 1 }, () => ({ ...source })),
    [{ ...source, extra: 'unrecognized' }]]) {
    assert.throws(() => normalize('systems', card({ composition: { state: 'known', value: 'H2', sources } })), invalid);
  }
  assert.throws(() => normalizeCard(card({ composition: known('H2') }), { kind: 'systems', evidence: [] }), invalid);
  assert.throws(() => normalizeCard(card({ charge: unknown() }), { kind: 'systems', evidence: null }), invalid);
});

test('M6 structural validation rejects unsupported versions, kinds and object shapes', () => {
  for (const input of [null, [], new Date(), Object.create({ version: 1 }),
    { ...card({}), version: 2 }, { ...card({}), version: '1' },
    { ...card({}), extra: true }, { version: 1, fields: {} },
    { ...card({}), fields: null }, { ...card({}), limitations: null },
    { ...card({}), limitations: [''] }, { ...card({}), limitations: Array(11).fill('x') }]) {
    assert.throws(() => normalize('systems', input), invalid);
  }
  for (const kind of ['software', 'workflows', 'decisions', 'unknown']) {
    assert.throws(() => normalize(kind, card({})), invalid);
  }
  assert.throws(() => normalizeCard(card({}), { kind: 'systems', evidence: [], extra: true }), invalid);
  assert.throws(() => normalize('systems', card({ value: known(0) })), invalid);
  assert.throws(() => normalize('methods', card({ charge: known(0) })), invalid);
});

test('M6 charge, multiplicity and spin quantities remain separate and finite', () => {
  const result = normalize('systems', card({ charge: known(0), multiplicity: known(1),
    spin: known({ quantity: 'unpaired-electrons', value: 0 }), periodicity: known([true, false, true]) }));
  assert.equal(result.fields.charge.value, 0);
  assert.equal(result.fields.spin.value.value, 0);
  assert.equal(result.fields.multiplicity.value, 1);
  const spinOnly = normalize('systems', card({ spin: known({ quantity: 'total-spin', value: 0.5 }) }));
  assert.equal(Object.hasOwn(spinOnly.fields, 'multiplicity'), false);
  for (const charge of [null, '0', NaN, Infinity, -Infinity]) {
    assert.throws(() => normalize('systems', card({ charge: known(charge) })), invalid);
  }
  for (const multiplicity of [0, -1, 1.5, '1', NaN]) {
    assert.throws(() => normalize('systems', card({ multiplicity: known(multiplicity) })), invalid);
  }
  for (const spin of [{ quantity: 'spin', value: 0 }, { quantity: 'unpaired-electrons', value: -1 },
    { quantity: 'unpaired-electrons', value: 0.5 }, { quantity: 'total-spin', value: -0.5 },
    { quantity: 'magnetic-moment', value: 0 }, { quantity: 'total-spin', value: Infinity }]) {
    assert.throws(() => normalize('systems', card({ spin: known(spin) })), invalid);
  }
  assert.deepEqual(normalize('systems', card({ spin: known({ quantity: 'magnetic-moment', value: -0.5, unit: 'mu_B' }) }))
    .fields.spin.value, { quantity: 'magnetic-moment', value: -0.5, unit: 'mu_B' });
  for (const periodicity of [false, [false, false], [false, false, 'false'], [true, true, true, true]]) {
    assert.throws(() => normalize('systems', card({ periodicity: known(periodicity) })), invalid);
  }
});

test('M6 methods preserve explicit no-correction versus unknown without defaults', () => {
  const fields = { dispersion: known('none, explicitly specified'), solvent: unknown(),
    applicability: known('Synthetic gas-phase model only.') };
  assert.deepEqual(normalize('methods', card(fields)).fields, fields);
  for (const value of ['', null, false, {}, 'x'.repeat(CARD_LIMITS.textChars + 1), '\ud800']) {
    assert.throws(() => normalize('methods', card({ model: known(value) })), invalid);
  }
});

test('M6 run/result cards do not create parallel state or numerical result payloads', () => {
  for (const fields of [{ execution: known('terminated') }, { validity: known('accepted-with-scope') },
    { input: known('synthetic.inp') }]) {
    assert.throws(() => normalize('runs', card(fields)), invalid);
  }
  for (const fields of [{ value: known(0) }, { unit: known('eV') }, { runId: known(randomUUID()) }]) {
    assert.throws(() => normalize('results', card(fields)), invalid);
  }
  const value = normalize('results', card({ qualifiers: known({ atom: '0', component: 'x' }) }));
  assert.deepEqual(value.fields.qualifiers.value, { atom: '0', component: 'x' });
  for (const qualifiers of [null, [], { frame: 0 }, { frame: '' }, JSON.parse('{"__proto__":"x"}'),
    Object.fromEntries(Array.from({ length: CARD_LIMITS.qualifiers + 1 }, (_, i) => [`q${i}`, 'x']))]) {
    assert.throws(() => normalize('results', card({ qualifiers: known(qualifiers) })), invalid);
  }
});

test('M6 diagnostic parameters retain unknown old values, units and adoption state', () => {
  const change = { parameter: 'synthetic threshold', before: unknown(), after: known({ value: 0, unit: '1' }), status: 'proposed' };
  const fields = { hypotheses: known(['Synthetic hypothesis, not a confirmed cause.']),
    confirmedCauses: unknown(), parameterChanges: known([change]), rerun: known({ status: 'not-rerun' }) };
  assert.deepEqual(normalize('diagnostics', card(fields)).fields, fields);
  const reference = { id: randomUUID(), revision: 1 };
  assert.deepEqual(normalize('diagnostics', card({ rerun: known({ status: 'performed', run: reference }) }))
    .fields.rerun.value.run, reference);
  for (const rerun of [{ status: 'performed' }, { status: 'not-rerun', run: reference },
    { status: 'planned', run: reference }, { status: 'performed', run: { ...reference, revision: 0 } },
    { status: 'performed', run: { ...reference, revision: '1' } }]) {
    assert.throws(() => normalize('diagnostics', card({ rerun: known(rerun) })), invalid);
  }
  for (const badChange of [{ ...change, status: 'rerun-success' }, { ...change, before: null },
    { ...change, after: known({ value: NaN, unit: '1' }) }, { ...change, after: known({ value: 0 }) }]) {
    assert.throws(() => normalize('diagnostics', card({ parameterChanges: known([badChange]) })), invalid);
  }
});

test('M6 normalization is deterministic, copies nested values and preserves Unicode', () => {
  const input = card({ periodicity: known([false, true, false]), composition: known('合成体系 🧪') });
  const reordered = { limitations: input.limitations, fields: { composition: input.fields.composition,
    periodicity: input.fields.periodicity }, version: 1 };
  const result = normalize('systems', input);
  assert.equal(JSON.stringify(result), JSON.stringify(normalize('systems', reordered)));
  result.fields.periodicity.value[0] = true;
  result.fields.composition.sources[0].quote = 'mutated copy';
  result.limitations.push('mutated copy');
  assert.equal(input.fields.periodicity.value[0], false);
  assert.equal(input.fields.composition.sources[0].quote, source.quote);
  assert.equal(input.limitations.length, 1);
});

test('M6 card bounds include sparse arrays, nested lists and aggregate UTF-8 bytes', () => {
  for (const fields of [{ hypotheses: known(Array(CARD_LIMITS.listItems + 1).fill('x')) },
    { parameterChanges: known(Array(CARD_LIMITS.listItems + 1).fill({})) },
    { hypotheses: known(new Array(1)) }]) {
    assert.throws(() => normalize('diagnostics', card(fields)), invalid);
  }
  assert.throws(() => normalize('systems', card({ charge: { ...unknown(), extra: true } })), invalid);
  assert.throws(() => normalize('systems', card({ charge: { state: 'unknown', reason: 'missing', sources: [] } })), invalid);
  assert.throws(() => normalizeCard(card({}), { kind: 'systems', evidence: new Array(1) }), invalid);
  const longLocator = 'x'.repeat(500);
  const largeKnown = value => ({ state: 'known', value, sources: Array.from({ length: CARD_LIMITS.sources }, () => ({
    locator: longLocator, quote: '合'.repeat(CARD_LIMITS.quoteChars), source: 'assistant-claim',
  })) });
  const parameter = largeKnown({ value: 'x'.repeat(500), unit: 'x'.repeat(80) });
  const oversized = card({
    hypotheses: largeKnown(Array(CARD_LIMITS.listItems).fill('合'.repeat(CARD_LIMITS.textChars))),
    parameterChanges: largeKnown(Array.from({ length: CARD_LIMITS.listItems }, () => ({
      parameter: 'x'.repeat(200), before: parameter, after: parameter, status: 'proposed',
    }))),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 250000);
  assert.throws(() => normalizeCard(oversized, { kind: 'diagnostics', evidence: [longLocator] }), invalid);
});

test('M6 card normalization reuses secret-looking content protection', () => {
  const synthetic = ['pass', 'word', ': synthetic-placeholder'].join('');
  assert.throws(() => normalize('methods', card({ model: known(synthetic) })), /Refusing secret-looking content/);
});

test('M6 card support leaves legacy v2 entries and immutable history unchanged', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-m6-cards-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(temp, '.pi-root'), 'isolated synthetic fixture');
  const project = initializeV2(temp, { name: 'M6 legacy compatibility' });
  const run = saveV2(project, { kind: 'runs', title: 'Synthetic run', content: 'Not a real execution.' }).record;
  const result = saveV2(project, { kind: 'results', title: 'Synthetic zero', content: 'Unconverged synthetic result.',
    evidence: [locator], result: { runId: run.id, property: 'synthetic-energy', value: 0, unit: 'eV', definition: 'Synthetic fixture only.' } }).record;
  const file = path.join(project.memory, '.internal/records', `${result.id}.1.md`);
  const before = fs.readFileSync(file);
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(normalizeEntry(result.entry), result.entry);
  assert.equal(Object.hasOwn(result.entry, 'card'), false);
  assert.equal(Object.hasOwn(result.entry, 'scope'), false);
  normalize('systems', card({ charge: known(0) }));
  reviseV2(project, result.id, 1, { ...result.entry, content: 'Explicit synthetic correction; still not scientifically valid.' });
  rebuildV2(project);
  assert.equal(getV2(project, result.id, { revision: 1 }).entry.result.value, 0);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(searchV2(project, 'synthetic-energy').hits.some(hit => hit.id === result.id), true);
  // Shape normalization does not bypass the store's conditional requirements.
  const incomplete = { ...result.entry, card: card({ propertyKey: known('synthetic-energy') }) };
  assert.equal(normalizeEntry(incomplete).card.version, 1);
  assert.throws(() => saveV2(project, incomplete), invalid);
  assert.deepEqual(fs.readFileSync(file), before);
});
