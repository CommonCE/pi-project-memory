import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedExcerpt } from '../src/v2-domain.mjs';
import { saveV2, searchV2 } from '../src/v2-store.mjs';
import { buildWorkingContext } from '../src/v2-working.mjs';
import { withSandbox } from '../eval/m4-integration.mjs';

const objects = context => context.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));

test('bounded excerpts preserve short values and reject invalid inputs', () => {
  assert.equal(boundedExcerpt('short', 5), 'short');
  assert.equal(boundedExcerpt('', 0), '');
  assert.equal(boundedExcerpt('longer', 2), '');
  for (const size of [-1, 1.5, NaN, Infinity, '100']) {
    assert.throws(() => boundedExcerpt('valid', size), error => error.code === 'invalid-schema');
  }
  assert.throws(() => boundedExcerpt('\ud800', 100), error => error.code === 'invalid-schema');
});

test('bounded excerpts retain the tail and mark omission without splitting surrogate pairs', () => {
  const source = 'HEAD-' + '😀🧪'.repeat(100) + '-NO_VALID_ENERGY';
  for (let budget = 40; budget <= 160; budget++) {
    const excerpt = boundedExcerpt(source, budget);
    assert.ok(excerpt.length <= budget);
    assert.ok(excerpt.isWellFormed());
    assert.match(excerpt, /bounded excerpt/);
    if (budget >= 80) {
      assert.ok(excerpt.startsWith('HEAD-'));
      assert.ok(excerpt.endsWith('-NO_VALID_ENERGY'));
    }
  }
});

test('same-prefix long records keep independent limitations in search and complete context JSON', () => {
  withSandbox(({ project }) => {
    const prefix = 'M4EXCERPT shared long introduction. '.repeat(100);
    const limits = ['Limit A: energy is not validated.', 'Limit B: no retry has run.'];
    for (const limit of limits) saveV2(project, { kind: 'software', title: 'Same title', content: prefix + limit,
      sourceTurn: 'turn:synthetic-reference', evidence: ['turn:synthetic-reference:m1'] });
    const hits = searchV2(project, 'M4EXCERPT', { deduplicateSources: true }).hits;
    assert.equal(hits.length, 2);
    for (const limit of limits) assert.ok(hits.some(hit => hit.excerpt.endsWith(limit)));
    for (const hit of hits) {
      assert.ok(hit.excerpt.length <= 1400);
      assert.match(hit.excerpt, /bounded excerpt/);
    }
    const context = buildWorkingContext(project, 'M4EXCERPT');
    const records = objects(context);
    assert.equal(records.length, 2);
    for (const limit of limits) assert.ok(records.some(record => record.excerpt.endsWith(limit)));
    assert.ok(records.every(record => record.verification === 'reported' && record.requiresVerification));
    assert.ok(context.chars <= 12000);
  });
});

test('model-extracted search keeps complementary nonmatching sources beyond seven lines', () => {
  withSandbox(({ project }) => {
    const content = ['SCF_MARKER failed; no validated energy.',
      ...Array.from({ length: 8 }, (_, index) => `Source detail ${index}.`),
      'Hypothesis only: iterations 40 to 80; no retry has run.'].join('\n');
    saveV2(project, { kind: 'diagnostics', title: 'Failed run', content,
      provenance: 'model-extraction', verification: 'reported' });
    const [hit] = searchV2(project, 'SCF_MARKER').hits;
    assert.equal(hit.excerpt, content);
    assert.equal(hit.requiresVerification, true);
    const explicit = saveV2(project, { kind: 'diagnostics', title: 'Explicit control', content });
    assert.equal(searchV2(project, 'SCF_MARKER').hits.find(hit => hit.id === explicit.record.id).excerpt,
      'SCF_MARKER failed; no validated energy.');
  });
});

test('JSON escaping is budgeted before insertion and failed run metadata is not cut', () => {
  withSandbox(({ project }) => {
    saveV2(project, { kind: 'runs', title: 'Escaped failure',
      content: 'M4ESCAPE ' + '\\"🧪'.repeat(2000) + ' TAIL_NO_SUCCESS',
      run: { execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked' } });
    for (const maxChars of [1000, 1500, 3000, 12000]) {
      const context = buildWorkingContext(project, 'M4ESCAPE', { maxChars });
      assert.ok(context.chars <= maxChars);
      assert.equal(context.chars, context.content.length);
      assert.ok(context.content.isWellFormed());
      const records = objects(context);
      assert.ok(records.length > 0 || context.content.includes('knowledge omitted: insufficient context budget'));
      for (const record of records) {
        assert.equal(record.run.termination, 'error');
        assert.equal(record.run.convergence, 'not-converged');
        assert.equal(record.run.validity, 'unchecked');
        assert.equal(record.verification, 'reported');
        assert.ok(record.excerpt.isWellFormed());
        assert.ok(record.excerpt.endsWith('TAIL_NO_SUCCESS'));
      }
    }
  });
});

test('extracted run metadata gets bounded headroom without increasing total context budgets', () => {
  withSandbox(({ project }) => {
    saveV2(project, { kind: 'runs', title: 'Prepared input', provenance: 'model-extraction',
      content: 'HEADROOM ' + 'reference '.repeat(85) + '\nNo calculation has run; no energy is available.',
      sourceTurn: 'turn:synthetic',
      evidence: Array.from({ length: 3 }, (_, index) => `turn:synthetic:${'x'.repeat(120)}:m${index}`) });
    const [hit] = searchV2(project, 'HEADROOM').hits;
    const size = JSON.stringify(hit).length;
    assert.ok(size > 1600 && size <= 2048, `fixture size: ${size}`);
    const complete = objects(buildWorkingContext(project, 'HEADROOM'));
    assert.equal(complete[0].excerpt, hit.excerpt);
    assert.equal(complete[0].run.execution, 'unknown');
    const explicit = saveV2(project, { kind: 'runs', title: 'Explicit control',
      content: 'EXPLICIT_ONLY ' + hit.excerpt + '\nExplicit control.', sourceTurn: 'turn:explicit-control', evidence: hit.evidence }).record;
    const control = objects(buildWorkingContext(project, 'HEADROOM')).find(record => record.id === explicit.id);
    assert.ok(control);
    assert.ok(JSON.stringify(control).length <= 1600);
    for (const maxChars of [1000, 1500, 2000, 3000, 12000]) {
      const context = buildWorkingContext(project, 'HEADROOM', { maxChars });
      assert.ok(context.chars <= maxChars);
      assert.equal(context.chars, context.content.length);
      assert.ok(objects(context).length > 0 || context.content.includes('knowledge omitted: insufficient context budget'));
      for (const record of objects(context)) {
        assert.ok(JSON.stringify(record).length <= 2048);
        assert.equal(record.run.execution, 'unknown');
        assert.equal(record.run.validity, 'unchecked');
      }
    }
  });
});

test('oversized metadata yields a visible omission, never partially serialized scientific fields', () => {
  withSandbox(({ project }) => {
    saveV2(project, { kind: 'runs', title: 'Large metadata', content: 'M4META failure is unresolved.',
      evidence: Array.from({ length: 10 }, (_, i) => `turn:synthetic-${i}:` + 'x'.repeat(400)),
      run: { termination: 'error', convergence: 'not-converged', validity: 'unchecked' } });
    const context = buildWorkingContext(project, 'M4META');
    assert.equal(objects(context).length, 0);
    assert.match(context.content, /knowledge omitted: insufficient context budget; inspect source/);
    assert.ok(context.chars <= 12000);
  });
});
