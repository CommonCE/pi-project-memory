import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getV2, initializeV2, rebuildV2, reviseV2, saveV2 } from '../src/v2-store.mjs';
import { proposeCandidateV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';

const locator = 'synthetic/output.log:12';
const sources = [{ locator, quote: 'Synthetic observation; no real calculation was executed.', source: 'tool-observation' }];
const known = value => ({ state: 'known', value, sources: structuredClone(sources) });
const unknown = () => ({ state: 'unknown', reason: 'Not supplied.' });
const code = value => error => error.code === value;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-m6-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated synthetic fixture');
  return initializeV2(root, { name: 'M6 publication' });
}
function base(kind, extra = {}) {
  return { kind, title: 'Synthetic card', content: 'No real calculation; unverified synthetic data.', evidence: [locator], ...extra };
}
function card(fields) { return { version: 1, fields, limitations: ['Synthetic data; no scientific certification.'] }; }
function system() {
  return base('systems', { card: card(Object.fromEntries(['composition', 'structure', 'charge', 'spin', 'multiplicity', 'periodicity'].map(key => [key, unknown()]))) });
}
function run(project, extra = {}) {
  return saveV2(project, base('runs', extra)).record;
}
function result(origin, qualifiers = {}, extra = {}) {
  return base('results', { result: { runId: origin.id, property: 'energy', value: 0, unit: 'eV', definition: 'Synthetic total energy.' },
    card: { ...card({ propertyKey: known('energy'), qualifiers: known(qualifiers), run: known({ id: origin.id, revision: origin.revision }) }),
      support: Object.fromEntries(['property', 'value', 'unit', 'definition'].map(key => [`result.${key}`, structuredClone(sources)])) }, ...extra });
}
function records(project) { return fs.readdirSync(path.join(project.memory, '.internal/records')).sort(); }

test('M6 publishes optional cards, keeps immutable history and rejects card downgrade', t => {
  const project = fixture(t), saved = saveV2(project, system()).record;
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.entry.card.version, 1);
  const file = path.join(project.memory, '.internal/records', `${saved.id}.1.md`), before = fs.readFileSync(file);
  const updated = reviseV2(project, saved.id, 1, { ...saved.entry, title: 'Explicit correction' }).record;
  assert.equal(updated.revision, 2);
  assert.deepEqual(fs.readFileSync(file), before);
  const { card: ignored, ...downgrade } = updated.entry;
  assert.throws(() => reviseV2(project, saved.id, 2, downgrade), code('invalid-schema'));
  assert.equal(getV2(project, saved.id).revision, 2);
  rebuildV2(project);
  assert.deepEqual(getV2(project, saved.id, { revision: 1 }).entry.card, saved.entry.card);
});

test('M6 rejects incomplete card conditions before any immutable publication', t => {
  const project = fixture(t), before = records(project);
  const incomplete = system(); delete incomplete.card.fields.charge;
  assert.throws(() => saveV2(project, incomplete), code('invalid-schema'));
  assert.deepEqual(records(project), before);
});

test('M6 fixed run references resolve actual revisions and preserve the source after updates', t => {
  const project = fixture(t), origin = run(project), saved = saveV2(project, result(origin)).record;
  const updated = reviseV2(project, origin.id, 1, { ...origin.entry, content: 'Later source correction; not improved scientific validity.' }).record;
  assert.equal(updated.revision, 2);
  assert.equal(getV2(project, saved.id).entry.card.fields.run.value.revision, 1);
  assert.equal(getV2(project, origin.id, { revision: 1 }).entry.run.validity, 'unchecked');
  const bad = result(origin, { frame: 'next' }); bad.card.fields.run.value.revision = 999;
  const before = records(project);
  assert.throws(() => saveV2(project, bad), code('invalid-reference'));
  assert.deepEqual(records(project), before);
  const foreign = saveV2(project, system()).record;
  const wrongKind = result(origin, { frame: 'next' }); wrongKind.card.fields.run.value = { id: foreign.id, revision: 1 };
  wrongKind.result.runId = foreign.id;
  assert.throws(() => saveV2(project, wrongKind), code('invalid-reference'));
});

test('M6 run cards pin declared system/method entities and reject missing or foreign pins', t => {
  const project = fixture(t), entity = saveV2(project, system()).record;
  const value = base('runs', { entities: [{ type: 'system', id: entity.id }],
    card: card({ task: unknown(), system: known({ id: entity.id, revision: 1 }), method: unknown(),
      convergenceCriteria: unknown(), validityScope: unknown() }) });
  assert.equal(saveV2(project, value).record.entry.card.fields.system.value.id, entity.id);
  const missingEntity = { ...value, entities: [] };
  assert.throws(() => saveV2(project, missingEntity), code('invalid-reference'));
  const wrongRevision = structuredClone(value); wrongRevision.card.fields.system.value.revision = 9;
  assert.throws(() => saveV2(project, wrongRevision), code('invalid-reference'));
});

test('M6 same-property conflicts ignore units and require explicit revision', t => {
  const project = fixture(t), origin = run(project), saved = saveV2(project, result(origin)).record;
  const duplicate = result(origin); duplicate.result.unit = 'Hartree'; duplicate.result.value = -1;
  assert.throws(() => saveV2(project, duplicate), code('result-conflict'));
  const correction = { ...saved.entry, result: { ...saved.entry.result, value: -1, unit: 'Hartree' } };
  assert.equal(reviseV2(project, saved.id, 1, correction).record.revision, 2);
  assert.throws(() => reviseV2(project, saved.id, 1, correction), code('revision-conflict'));
  const changedIdentity = { ...correction, card: structuredClone(correction.card) };
  changedIdentity.card.fields.qualifiers.value = { component: 'x' };
  assert.throws(() => reviseV2(project, saved.id, 2, changedIdentity), code('invalid-schema'));
  assert.equal(saveV2(project, result(origin, { component: 'x' })).record.revision, 1);
  assert.equal(saveV2(project, result(origin, { component: 'y' })).record.revision, 1);
});

test('M6 cardless results cannot bypass conflicts and legacy collisions stay readable', t => {
  const project = fixture(t), origin = run(project), legacy = result(origin);
  delete legacy.card;
  const old = saveV2(project, legacy).record;
  assert.throws(() => saveV2(project, result(origin)), code('result-conflict'));
  assert.equal(getV2(project, old.id).entry.result.value, 0);
  // Explicitly adding a card to the original record is not a duplicate result.
  const upgraded = reviseV2(project, old.id, 1, result(origin)).record;
  assert.throws(() => saveV2(project, legacy), code('result-conflict'));
  assert.equal(getV2(project, upgraded.id).revision, 2);
});

function writeSyntheticRecord(project, record) {
  const file = path.join(project.memory, '.internal/records', `${record.id}.${record.revision}.md`);
  fs.writeFileSync(file, '# Immutable memory revision\n\n```json\n' + JSON.stringify(record, null, 2) + '\n```\n');
}

test('M6 genuinely duplicated legacy history remains readable without permitting new collisions', t => {
  const project = fixture(t), origin = run(project), value = result(origin); delete value.card;
  const first = saveV2(project, value).record;
  const historicalDuplicate = { ...first, id: randomUUID() };
  // Emulate pre-M6 immutable records, not a new publication through M6.
  writeSyntheticRecord(project, historicalDuplicate);
  assert.equal(getV2(project, historicalDuplicate.id).entry.result.value, 0);
  rebuildV2(project);
  assert.throws(() => saveV2(project, value), code('result-conflict'));
  assert.equal(reviseV2(project, first.id, 1, { ...first.entry, title: 'Metadata-only legacy correction' }).record.revision, 2);
  assert.throws(() => reviseV2(project, first.id, 2, result(origin)), code('result-conflict'));
  reviseV2(project, historicalDuplicate.id, 1, { ...historicalDuplicate.entry, lifecycle: 'superseded' });
  assert.equal(reviseV2(project, first.id, 2, result(origin)).record.revision, 3);
});

test('M6 inventory rejects canonical-looking dangling pins and card downgrade history', t => {
  const project = fixture(t), origin = run(project), saved = saveV2(project, result(origin)).record;
  const dangling = structuredClone(saved); dangling.entry.card.fields.run.value.revision = 999;
  writeSyntheticRecord(project, dangling);
  assert.throws(() => getV2(project, saved.id), code('invalid-reference'));
  writeSyntheticRecord(project, saved);
  const updated = reviseV2(project, saved.id, 1, { ...saved.entry, content: 'Explicit synthetic correction.' }).record;
  delete updated.entry.card;
  writeSyntheticRecord(project, updated);
  assert.throws(() => getV2(project, saved.id), code('invalid-schema'));
});

test('M6 conflicts are global across sibling scopes and lifecycle reactivation is checked', t => {
  const project = fixture(t), origin = run(project);
  const first = saveV2(project, result(origin, {}, { scope: { path: 'calc/a', inherit: false } })).record;
  const other = result(origin, {}, { scope: { path: 'calc/b', inherit: false } });
  assert.throws(() => saveV2(project, other), code('result-conflict'));
  const archived = saveV2(project, { ...other, lifecycle: 'archived' }).record;
  assert.throws(() => reviseV2(project, archived.id, 1, { ...archived.entry, lifecycle: 'current' }), code('result-conflict'));
  reviseV2(project, first.id, 1, { ...first.entry, lifecycle: 'superseded' });
  assert.equal(reviseV2(project, archived.id, 1, { ...archived.entry, lifecycle: 'current' }).record.revision, 2);
});

test('M6 retries return the original publication without conflicting with themselves', t => {
  const project = fixture(t), origin = run(project), requestId = randomUUID(), value = result(origin);
  const first = saveV2(project, value, { requestId });
  const retry = saveV2(project, value, { requestId });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.id, first.record.id);
  assert.equal(records(project).length, 2);
});

test('M6 candidates cannot carry cards or erase a card added after staging', t => {
  const project = fixture(t);
  assert.throws(() => proposeCandidateV2(project, { requestId: randomUUID(),
    entry: { ...system(), provenance: 'assistant-claim', verification: 'reported' } }), code('invalid-grounding'));
  const saved = saveV2(project, base('systems')).record, requestId = randomUUID();
  proposeCandidateV2(project, { requestId, entry: base('systems'), target: { id: saved.id, expectedRevision: 1 } });
  reviseV2(project, saved.id, 1, system());
  assert.throws(() => reviewCandidateV2(project, requestId, 'approve'), code('revision-conflict'));
  const fresh = { requestId: randomUUID(), entry: base('systems'), target: { id: saved.id, expectedRevision: 2 } };
  assert.throws(() => proposeCandidateV2(project, fresh), code('invalid-grounding'));
  assert.equal(getV2(project, saved.id).revision, 2);
});

function childSave(project, entry, requestId) {
  const script = `import { resolveV2, saveV2 } from ${JSON.stringify(new URL('../src/v2-store.mjs', import.meta.url).href)};
    try { const value = saveV2(resolveV2(process.argv[1]), JSON.parse(process.argv[2]), { requestId: process.argv[3] });
      console.log(JSON.stringify({ status: 'saved', id: value.record.id })); }
    catch (error) { console.log(JSON.stringify({ status: error.code ?? 'unexpected' })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, project.root, JSON.stringify(entry), requestId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
    child.on('error', reject);
    child.on('close', status => {
      if (status !== 0) { reject(new Error(`Child failed: ${status}: ${error}`)); return; }
      try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); }
    });
  });
}
test('M6 concurrent same-property publication never commits two current results', { timeout: 10000 }, async t => {
  const project = fixture(t), origin = run(project), value = result(origin);
  const results = await Promise.all([childSave(project, value, randomUUID()), childSave(project, value, randomUUID())]);
  assert.equal(results.filter(item => item.status === 'saved').length, 1);
  assert.ok(results.every(item => ['saved', 'busy', 'result-conflict'].includes(item.status)));
  assert.equal(records(project).length, 2);
});
