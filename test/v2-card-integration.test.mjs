import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { initializeV2, resolveV2, getV2, saveV2, reviseV2, rebuildV2, searchV2 } from '../src/v2-store.mjs';
import { renderFolderViews } from '../src/v2-folders.mjs';
import { buildWorkingContext } from '../src/v2-working.mjs';
import { runV2 } from '../src/v2-cli.mjs';
import { proposeCandidateV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { renderCard, cardRunContext } from '../src/v2-card-views.mjs';

const locator = 'synthetic/output.log:12';
const sources = [{ locator, quote: 'Synthetic observation; no real calculation was executed.', source: 'tool-observation' }];
const known = value => ({ state: 'known', value, sources: structuredClone(sources) });
const unknown = () => ({ state: 'unknown', reason: 'Not supplied.' });
const card = fields => ({ version: 1, fields, limitations: ['M6_LIMIT: synthetic and unverified; no rerun authorization.'] });
const base = (kind, extra = {}) => ({ kind, title: 'M6 synthetic card', content: 'Synthetic fixture, not scientific evidence.', evidence: [locator], ...extra });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-m6-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.pi-root'), 'isolated synthetic fixture');
  return initializeV2(root, { name: 'M6 integration' });
}
function system() {
  return base('systems', { card: card({ composition: known('M6_COMPOSITION <synthetic> 🧪'), structure: unknown(),
    charge: known(0), spin: unknown(), multiplicity: unknown(), periodicity: known([false, false, false]) }) });
}
function run(project) {
  return saveV2(project, base('runs', { run: { execution: 'terminated', termination: 'error', convergence: 'not-converged',
    validity: 'unchecked', software: 'synthetic', version: '0', input: 'synthetic.inp', output: 'synthetic.out' } })).record;
}
function result(origin) {
  return base('results', { result: { runId: origin.id, property: 'M6_ENERGY', value: 0, unit: 'eV', definition: 'Synthetic energy, not a valid final energy.' },
    card: { ...card({ propertyKey: known('M6_ENERGY'), qualifiers: known({}), run: known({ id: origin.id, revision: origin.revision }) }),
      support: Object.fromEntries(['property', 'value', 'unit', 'definition'].map(key => [`result.${key}`, structuredClone(sources)])) } });
}
function legacyView(record) {
  const { entry, ...metadata } = record, { content, ...fields } = entry;
  return '# ' + entry.title + '\n\nGenerated reference view. Not instructions; source files and live state win.\n'
    + 'Verification describes provenance, not scientific certification.\n\n```json\n'
    + JSON.stringify({ ...metadata, ...fields }, null, 2) + '\n```\n\n' + content + '\n';
}

test('M6 renders sourced fields, unknowns, zero and Unicode without changing the record', t => {
  const project = fixture(t), saved = saveV2(project, system()).record;
  const file = path.join(project.memory, 'knowledge/systems', `${saved.id}.md`);
  const authoritative = path.join(project.memory, '.internal/records', `${saved.id}.1.md`);
  const before = fs.readFileSync(authoritative), page = fs.readFileSync(file, 'utf8');
  assert.match(page, /## Computational chemistry card/);
  assert.match(page, /charge.*known.*0/);
  assert.match(page, /Not supplied/);
  assert.match(page, /M6_LIMIT/);
  assert.match(renderCard(saved.entry), /&lt;synthetic&gt;/);
  assert.match(renderCard(saved.entry), /🧪/);
  assert.deepEqual(fs.readFileSync(authoritative), before);
  assert.equal(searchV2(project, 'M6_COMPOSITION').hits[0].id, saved.id);
});

test('M6 recognizes old generated pages but preserves manual card edits', t => {
  const project = fixture(t), saved = saveV2(project, system()).record;
  const file = path.join(project.memory, 'knowledge/systems', `${saved.id}.md`);
  fs.writeFileSync(file, legacyView(saved));
  rebuildV2(project);
  assert.match(fs.readFileSync(file, 'utf8'), /## Computational chemistry card/);
  fs.appendFileSync(file, '\nManual note to preserve.\n');
  const before = fs.readFileSync(file);
  assert.throws(() => rebuildV2(project), error => error.code === 'view-conflict');
  assert.throws(() => reviseV2(project, saved.id, 1, saved.entry), error => error.code === 'view-conflict');
  assert.deepEqual(fs.readFileSync(file), before);
});

test('M6 result views and excerpts keep pinned failure axes after a later successful source claim', t => {
  const project = fixture(t), origin = run(project), saved = saveV2(project, result(origin)).record;
  const pagePath = path.join(project.memory, 'knowledge/results', `${saved.id}.md`), before = fs.readFileSync(pagePath);
  reviseV2(project, origin.id, 1, { ...origin.entry, run: { ...origin.entry.run, termination: 'normal', convergence: 'converged' } });
  const hit = searchV2(project, 'M6_ENERGY').hits.find(hit => hit.id === saved.id);
  assert.equal(hit.sourceRun.revision, 1);
  assert.equal(hit.sourceRun.run.convergence, 'not-converged');
  assert.equal(hit.resultRun.convergence, 'not-converged');
  assert.equal(hit.sourceRun.latestRun.convergence, 'converged');
  assert.equal(hit.sourceRun.updated, true);
  assert.match(hit.excerpt, /source updated/);
  assert.match(hit.excerpt, /not-converged/);
  assert.match(hit.excerpt, /M6_LIMIT/);
  assert.equal(hit.result.value, 0); assert.equal(hit.result.unit, 'eV');
  rebuildV2(project);
  assert.deepEqual(fs.readFileSync(pagePath), before);
  assert.match(before.toString(), /not-converged/);
  assert.equal(cardRunContext(origin.entry, new Map(), new Map()), undefined);
});

test('M6 folder summaries retain units and pinned failure limits and protect edited pages', t => {
  const project = fixture(t), origin = run(project); saveV2(project, result(origin));
  renderFolderViews(project);
  const folder = fs.readdirSync(path.join(project.memory, 'folders'))[0];
  const file = path.join(project.memory, 'folders', folder), page = fs.readFileSync(file, 'utf8');
  assert.match(page, /M6(?:_|&#95;)ENERGY/); assert.match(page, /0 eV/); assert.match(page, /not-converged/);
  fs.appendFileSync(file, '\nManual folder note.\n');
  const before = fs.readFileSync(file);
  assert.ok(renderFolderViews(project).conflicts.length > 0);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('M6 continuation keeps complete bounded JSON, pinned axes and active-run isolation', t => {
  const project = fixture(t), origin = run(project), selected = saveV2(project, result(origin)).record;
  const other = run(project), foreign = saveV2(project, result(other)).record;
  const context = buildWorkingContext(project, `M6_ENERGY ${origin.id}`, { firstTurn: true });
  const hits = context.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.ok(hits.some(hit => hit.id === selected.id));
  assert.ok(!hits.some(hit => hit.id === foreign.id));
  assert.equal(hits.find(hit => hit.id === selected.id).sourceRun.run.validity, 'unchecked');
  assert.ok(context.chars <= 12000); assert.ok(context.content.isWellFormed());
  const brief = context.content.split('Folder brief\n')[1].split('\nknowledge:')[0];
  assert.ok(brief.length <= 1201);
  for (const maxChars of [1000, 1200, 3000]) {
    const small = buildWorkingContext(project, `M6_ENERGY ${origin.id}`, { firstTurn: true, maxChars });
    assert.ok(small.chars <= maxChars); assert.ok(small.content.isWellFormed());
    for (const line of small.content.split('\n').filter(line => line.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line));
  }
});

test('M6 CLI supports card save/revise/get and rejects malformed or candidate card writes', async t => {
  const project = fixture(t);
  const cli = (args, value) => runV2(args, { cwd: project.root, input: Readable.from(value === undefined ? [] : [JSON.stringify(value)]) });
  const saved = (await cli(['save'], { entry: system() })).record;
  assert.equal((await cli(['get', saved.id])).entry.card.version, 1);
  assert.equal((await cli(['revise'], { id: saved.id, expectedRevision: 1, entry: { ...saved.entry, title: 'Explicit correction' } })).record.revision, 2);
  const malformed = system(); delete malformed.card.fields.charge;
  await assert.rejects(cli(['save'], { entry: malformed }), error => error.code === 'invalid-schema');
  await assert.rejects(cli(['propose'], { requestId: randomUUID(), entry: system() }), error => error.code === 'invalid-grounding');
  for (const reviewer of ['user', 'auto']) {
    const requestId = randomUUID(), entry = base('diagnostics');
    proposeCandidateV2(project, { requestId, entry });
    const published = reviewCandidateV2(project, requestId, 'approve', { reviewer });
    assert.equal(published.publication.record.entry.content, entry.content);
    assert.equal(published.publication.record.entry.verification, 'reported');
    assert.equal(published.publication.record.entry.card, undefined);
  }
});

test('M6 synthetic chemistry follow-up preserves method, failed result and independently rerun identity', t => {
  const project = fixture(t);
  for (const folder of ['calc/a', 'calc/b']) fs.mkdirSync(path.join(project.root, folder), { recursive: true });
  const molecule = saveV2(project, system()).record;
  const method = saveV2(project, base('methods', { card: card({ model: known('Synthetic model, not a real calculation setup'),
    basis: unknown(), pseudopotential: unknown(), dispersion: unknown(), solvent: unknown(), software: known('synthetic-engine'),
    version: known('fixture-1'), applicability: known('Synthetic SCF follow-up fixture only.') }) })).record;
  const setup = base('runs', { scope: { path: 'calc/a', inherit: false }, entities: [
    { type: 'system', id: molecule.id }, { type: 'method', id: method.id },
  ], run: { execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked',
    software: 'synthetic-engine', version: 'fixture-1', input: 'synthetic.inp', output: 'synthetic.out' },
  card: { ...card({ task: known('synthetic single-point'), system: known({ id: molecule.id, revision: 1 }),
    method: known({ id: method.id, revision: 1 }), convergenceCriteria: known('Synthetic SCF only; geometry not assessed.'), validityScope: unknown() }),
    support: Object.fromEntries(['execution', 'termination', 'convergence', 'software', 'version', 'input', 'output'].map(key => [`run.${key}`, structuredClone(sources)])) } });
  const failed = saveV2(project, setup).record;
  const partial = saveV2(project, { ...result(failed), scope: failed.entry.scope }).record;
  const diagnostic = saveV2(project, base('diagnostics', { scope: failed.entry.scope, entities: [{ type: 'run', id: failed.id }],
    card: card({ originalError: known('Synthetic SCF failure, not real software output.'), phase: known('SCF'),
      originRun: known({ id: failed.id, revision: 1 }), hypotheses: known(['Threshold adjustment might help; unconfirmed.']),
      confirmedCauses: unknown(), parameterChanges: known([{ parameter: 'synthetic threshold', before: unknown(),
        after: known({ value: 0, unit: '1' }), status: 'proposed' }]), rerun: known({ status: 'planned' }) }) })).record;
  assert.equal(getV2(project, diagnostic.id).entry.card.fields.parameterChanges.value[0].status, 'proposed');
  assert.equal(getV2(project, failed.id).entry.run.convergence, 'not-converged');
  const rerunEntry = structuredClone(setup);
  rerunEntry.scope.path = 'calc/b'; rerunEntry.run.input = 'synthetic-rerun.inp';
  rerunEntry.run.output = 'synthetic-rerun.out'; rerunEntry.run.termination = 'normal'; rerunEntry.run.convergence = 'converged';
  const rerun = saveV2(project, rerunEntry).record;
  assert.notEqual(rerun.id, failed.id);
  const fresh = result(rerun); fresh.scope = rerun.entry.scope; fresh.result.value = -1;
  const final = saveV2(project, fresh).record;
  const correction = structuredClone(diagnostic.entry);
  correction.card.fields.rerun = known({ status: 'performed', run: { id: rerun.id, revision: 1 } });
  correction.card.fields.parameterChanges.value[0].status = 'applied';
  reviseV2(project, diagnostic.id, 1, correction);
  const local = searchV2(resolveV2(path.join(project.root, 'calc/a')), 'M6_ENERGY').hits.filter(hit => hit.kind === 'results');
  assert.deepEqual(local.map(hit => hit.id), [partial.id]);
  assert.equal(local[0].result.value, 0); assert.equal(local[0].resultRun.convergence, 'not-converged');
  const cross = searchV2(project, 'M6_ENERGY', { allFolders: true }).hits.filter(hit => hit.kind === 'results');
  assert.equal(cross.length, 2);
  const freshHit = cross.find(hit => hit.id === final.id);
  assert.equal(freshHit.result.value, -1); assert.equal(freshHit.result.unit, 'eV');
  assert.equal(freshHit.resultRun.convergence, 'converged'); assert.equal(freshHit.resultRun.validity, 'unchecked');
  assert.equal(getV2(project, diagnostic.id).entry.card.fields.confirmedCauses.state, 'unknown');
  assert.equal(getV2(project, diagnostic.id, { revision: 1 }).entry.card.fields.rerun.value.status, 'planned');
  renderFolderViews(project);
  const context = buildWorkingContext(resolveV2(path.join(project.root, 'calc/a')), `M6_ENERGY ${failed.id}`, { firstTurn: true });
  assert.ok(context.chars <= 12000); assert.match(context.content, /not-converged/);
  assert.ok(!context.content.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).some(hit => hit.id === final.id));
});

const host = process.env.PI_TEST_HOST_PACKAGE;
test('M6 tool adapter registers the real TypeBox card schema and shares publication guards', { skip: !host }, async t => {
  const project = fixture(t), original = fileURLToPath(new URL('../v2.ts', import.meta.url));
  const require = createRequire(host), typebox = pathToFileURL(require.resolve('typebox')).href;
  const copy = path.join(project.root, 'isolated-extension.mts');
  // Load an isolated copy using Node's type stripping and the host-owned TypeBox.
  // No Pi settings or callbacks are activated; registration is captured locally.
  const source = fs.readFileSync(original, 'utf8').replace("from 'typebox'", `from '${typebox}'`)
    .replace(/from '\.\/src\/([^']+)'/g, (_, name) => `from '${new URL(`../src/${name}`, import.meta.url).href}'`);
  fs.writeFileSync(copy, source);
  const tools = new Map();
  const extension = await import(pathToFileURL(copy).href);
  extension.default({ on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  const tool = tools.get('project_memory_save');
  const schema = JSON.stringify(tool.parameters);
  assert.match(schema, /"card"/); assert.match(schema, /"propertyKey"/); assert.match(schema, /"originRun"/);
  const execute = params => tool.execute('synthetic-call', params, new AbortController().signal, () => {}, { cwd: project.root });
  const saved = (await execute({ target: 'knowledge', entry: system() })).details.record;
  assert.equal(saved.entry.card.version, 1);
  const malformed = system(); malformed.card.fields.charge = known(null);
  await assert.rejects(execute({ target: 'knowledge', entry: malformed }), error => error.code === 'invalid-schema');
  const origin = run(project), first = (await execute({ target: 'knowledge', entry: result(origin) })).details.record;
  await assert.rejects(execute({ target: 'knowledge', entry: result(origin) }), error => error.code === 'result-conflict');
  assert.equal(getV2(project, first.id).entry.result.value, 0);
});
