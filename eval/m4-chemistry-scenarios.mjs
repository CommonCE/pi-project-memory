import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withSandbox } from './m4-integration.mjs';
import { restoreChemistryContext } from './m4-chemistry-generation.mjs';
import { chemistryScenariosVersion, preparedFixture, rerunFixtures } from './m4-chemistry-scenarios-fixtures.mjs';
import { extractCandidatesV2 } from '../src/v2-extraction.mjs';
import { listCandidatesV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { getV2, saveV2, searchV2 } from '../src/v2-store.mjs';
import { updateWorkingV2 } from '../src/v2-working.mjs';

const ids = hits => hits.map(hit => hit.id).sort();
const unknownRun = { execution: 'unknown', termination: 'unknown', convergence: 'unknown', validity: 'unchecked' };
function facts(check, item, phase, text) {
  for (const fact of item.facts) check(`${item.id}:${phase}:${fact.id}`, text.includes(fact.text), true);
  if (item.forbiddenText) check(`${item.id}:${phase}:foreign-energy-excluded`, text.includes(item.forbiddenText), false);
}
async function generate(project, item, check, { entityIds = [], selectedId, systemId, selection }) {
  const before = ids(searchV2(project, item.query).hits);
  const extraction = await extractCandidatesV2(project, item.messages, {
    session: 'synthetic-chemistry-scenarios', turn: item.id, mode: 'review', entityIds, isCurrent: () => true,
    model: async request => {
      const envelope = JSON.parse(request.prompt);
      check(`${item.id}:supplied-entity-scope`, envelope.entities.map(entity => entity.id).sort(), [...entityIds].sort());
      let runId;
      if (systemId) {
        // A deterministic context consumer, not an autonomous model evaluation.
        const matches = envelope.entities.filter(entity => entity.kind === 'runs'
          && entity.context?.source === 'background-only'
          && entity.context.text.includes(`Identity anchor only for ${item.id}.`));
        check(`${item.id}:context-identifies-run`, matches.map(entity => entity.id), [selectedId]);
        runId = matches.length === 1 ? matches[0].id : undefined;
        if (selection === 'swapped-run') runId = envelope.entities.find(entity => entity.kind === 'runs' && entity.id !== runId)?.id;
        if (selection === 'missing-run') runId = undefined;
      }
      const grounding = item.quotes.map((quote, index) => ({ id: `m${index}`, quote }));
      if (selection === 'misleading-title') grounding[1].quote = 'No calculation has run; no energy is available.';
      return { text: JSON.stringify({ candidates: [{ kind: item.kind,
        title: selection === 'misleading-title' ? item.forbiddenTitle : item.title, grounding,
        entities: [...(systemId ? [{ type: 'system', id: systemId }] : []),
          ...(runId ? [{ type: 'run', id: runId }] : [])] }] }) };
    },
  });
  check(`${item.id}:queued`, extraction.status, 'queued');
  check(`${item.id}:one-adapter-call`, extraction.counts.modelCalls, 1);
  check(`${item.id}:not-auto-published`, extraction.counts.published, 0);
  const pending = listCandidatesV2(project).candidates.filter(item => item.status === 'pending');
  check(`${item.id}:one-pending`, pending.length, 1);
  check(`${item.id}:pending-outside-knowledge`, ids(searchV2(project, item.query).hits), before);
  const entry = pending[0].candidate.entry;
  facts(check, item, 'candidate', entry.content);
  check(`${item.id}:candidate-title`, entry.title, item.title);
  const record = reviewCandidateV2(project, pending[0].candidate.requestId, 'approve').publication.record;
  facts(check, item, 'published', record.entry.content);
  check(`${item.id}:published-title`, record.entry.title, item.title);
  check(`${item.id}:not-certified`, record.entry.verification, 'reported');
  check(`${item.id}:source-preserved`, record.entry.provenance, 'model-extraction');
  check(`${item.id}:no-structured-result`, record.entry.result === undefined, true);
  if (item.kind === 'runs') check(`${item.id}:structured-state-not-inferred`, record.entry.run, unknownRun);
  return record;
}
async function evaluate(id, selection, fixtures, action) {
  const checks = [];
  const check = (id, actual, expected) => checks.push({ id, actual, expected, passed: isDeepStrictEqual(actual, expected) });
  let base, executionError;
  try {
    await withSandbox(async sandbox => { base = sandbox.base; await action(sandbox, check); });
  } catch (error) { executionError = error.code ?? error.name ?? 'execution-error'; }
  check('sandbox-cleaned', !!base && !fs.existsSync(base), true);
  const files = ['./m4-chemistry-scenarios.mjs', './m4-chemistry-scenarios-fixtures.mjs', './m4-chemistry-generation.mjs',
    './m4-integration.mjs', '../src/v2-extraction.mjs', '../src/v2-store.mjs', '../src/v2-candidates.mjs',
    '../src/v2-working.mjs', '../src/v2-domain.mjs', '../src/core.mjs'];
  return { suite: chemistryScenariosVersion, id, selection, node: process.version,
    fixtureSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
    sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    scope: 'synthetic fixed responses and explicit identity anchors; fresh Node process, not Pi session or real rerun',
    modelUsage: 'not-applicable', modelSelectionQuality: 'unassessed', qualityVerdict: 'unassessed',
    ...(executionError ? { executionError } : {}), checks,
    fixedResponseContractPassed: !executionError && checks.every(check => check.passed) };
}
export async function runPreparedGeneration({ selection = 'conservative' } = {}) {
  if (!['conservative', 'misleading-title'].includes(selection)) throw new Error('Invalid prepared selection');
  return evaluate('prepared', selection, preparedFixture, async ({ root, project }, check) => {
    fs.mkdirSync(path.join(root, 'synthetic/prepared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'synthetic/prepared/input.inp'), 'Synthetic placeholder, not runnable.\n');
    const item = preparedFixture;
    const record = await generate(project, item, check, { selection });
    const hits = searchV2(project, item.query).hits;
    check('prepared:query-identity', ids(hits), [record.id]);
    facts(check, item, 'query', hits.length === 1 ? hits[0].excerpt : '');
    updateWorkingV2(project, 'state', 0, { goal: 'Continue input inspection' });
    const context = restoreChemistryContext(root);
    facts(check, item, 'context', context.content);
    check('prepared:context-identity', context.paths.some(label => label.includes(`/${record.id}.md`)), true);
    check('prepared:context-budget', context.chars <= 12000, true);
    check('prepared:no-output-created', fs.existsSync(path.join(root, 'synthetic/prepared/output.log')), false);
  });
}
export async function runRerunGeneration({ selection = 'conservative' } = {}) {
  if (!['conservative', 'swapped-run', 'missing-run'].includes(selection)) throw new Error('Invalid rerun selection');
  return evaluate('method-rerun', selection, rerunFixtures, async ({ root, project }, check) => {
    // Explicit identity anchors are preconditions, not automatically generated facts.
    const system = saveV2(project, { kind: 'systems', title: 'Synthetic system identity',
      content: 'Shared identity anchor only; no source facts.' }).record;
    const anchors = rerunFixtures.map(item => saveV2(project, { kind: 'runs', title: 'Synthetic run identity',
      content: `Identity anchor only for ${item.id}.` }).record);
    const records = [];
    for (const [index, item] of rerunFixtures.entries()) {
      fs.mkdirSync(path.join(root, `synthetic/${item.id}`), { recursive: true });
      fs.writeFileSync(path.join(root, `synthetic/${item.id}/output.log`), item.messages[1].content);
      records.push(await generate(project, item, check, { selection, systemId: system.id,
        entityIds: [system.id, ...anchors.map(anchor => anchor.id)],
        selectedId: anchors[index].id }));
      check(`${item.id}:correct-run-association`, records[index].entry.entities,
        [{ type: 'run', id: anchors[index].id }, { type: 'system', id: system.id }]);
    }
    check('rerun:independent-records', records[0].id !== records[1].id, true);
    check('rerun:same-titles-not-merged', ids(searchV2(project, 'SCF observation').hits), records.map(record => record.id).sort());
    check('rerun:old-record-unchanged', getV2(project, records[0].id), records[0]);
    for (const [index, item] of rerunFixtures.entries()) {
      const hits = searchV2(project, item.query, { entityId: anchors[index].id }).hits;
      check(`${item.id}:query-identity`, ids(hits), [records[index].id]);
      facts(check, item, 'query', hits.length === 1 ? hits[0].excerpt : '');
      // State contains identity only, no method, energy or source facts.
      updateWorkingV2(project, 'state', index, { goal: 'Continue chemistry inspection', entities: [system.id, anchors[index].id] });
      const context = restoreChemistryContext(root);
      facts(check, item, 'context', context.content);
      check(`${item.id}:context-selected`, context.paths.some(label => label.includes(`/${records[index].id}.md`)), true);
      check(`${item.id}:other-record-excluded`, context.paths.some(label => label.includes(`/${records[1 - index].id}.md`)), false);
      check(`${item.id}:context-budget`, context.chars <= 12000, true);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node eval/m4-chemistry-scenarios.mjs (new disposable sandboxes; no calculations/models)');
    process.exitCode = 2;
  } else {
    const reports = [await runPreparedGeneration(), await runRerunGeneration()];
    console.log(JSON.stringify({ reports, fixedResponseContractPassed: reports.every(report => report.fixedResponseContractPassed) }, null, 2));
    if (!reports.every(report => report.fixedResponseContractPassed)) process.exitCode = 1;
  }
}
