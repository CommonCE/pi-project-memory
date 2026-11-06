import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withSandbox } from './m4-integration.mjs';
import { restoreChemistryContext } from './m4-chemistry-generation.mjs';
import { preparedFixture, rerunFixtures } from './m4-chemistry-scenarios-fixtures.mjs';
import { EXTRACTION_PROMPT, extractCandidatesV2 } from '../src/v2-extraction.mjs';
import { listCandidatesV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { getV2, saveV2, searchV2 } from '../src/v2-store.mjs';
import { updateWorkingV2 } from '../src/v2-working.mjs';

const fixtureFor = scenario => scenario === 'prepared' ? preparedFixture : rerunFixtures[0];
const ids = records => records.map(record => record.id).sort();
const text = records => records.map(record => record.entry.content).join('\n\n');
const evidenceHas = (entry, id) => entry?.evidence.some(locator => locator.endsWith(`:${id}`)) ?? false;

// Reconstructed synthetic response shapes, not a replay of private sessions or a model judge.
export async function runChemistryFollowup({ scenario = 'failed-run', selection = 'linked' } = {}) {
  if (!['prepared', 'failed-run'].includes(scenario)) throw new Error('Invalid follow-up scenario');
  const allowed = scenario === 'prepared' ? ['linked', 'omitted'] : ['linked', 'unlinked', 'swapped', 'omitted'];
  if (!allowed.includes(selection)) throw new Error('Invalid follow-up selection');
  const item = fixtureFor(scenario), checks = [];
  const check = (id, actual, expected) => checks.push({ id, actual, expected, passed: isDeepStrictEqual(actual, expected) });
  const facts = (phase, content) => {
    for (const fact of item.facts) check(`${phase}:${fact.id}`, content.includes(fact.text), true);
  };
  let base, executionError;
  try {
    await withSandbox(async sandbox => {
      base = sandbox.base;
      const { project, root } = sandbox;
      const anchors = scenario === 'failed-run' ? ['A', 'B'].map(label => saveV2(project, {
        kind: 'runs', title: 'Same-name synthetic run', content: `Identity anchor only for run-${label}.`,
      }).record) : [];
      const query = scenario === 'prepared' ? 'input' : 'run-A';
      const followupTitle = scenario === 'prepared' ? 'Possible next step' : 'Hypothesis only';
      const folder = path.join(root, 'synthetic', scenario === 'prepared' ? 'prepared' : 'run-A');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, scenario === 'prepared' ? 'input.inp' : 'output.log'),
        scenario === 'prepared' ? 'Synthetic placeholder, not runnable.\n' : item.messages[1].content);
      const before = ids(searchV2(project, item.query).hits);
      const result = await extractCandidatesV2(project, item.messages, {
        session: 'synthetic-followup', turn: scenario, mode: 'review', maxCandidates: 2,
        entityIds: anchors.map(anchor => anchor.id), isCurrent: () => true,
        model: async request => {
          const envelope = JSON.parse(request.prompt);
          check('adapter:production-prompt', request.system, EXTRACTION_PROMPT);
          check('adapter:selected-identities-only', envelope.entities.map(entity => entity.id).sort(), ids(anchors));
          let origin;
          if (anchors.length) {
            // Read the explicit source anchor, then disambiguate the supplied same-title identities.
            const label = /Record synthetic (run-[AB])\./.exec(envelope.evidence.find(source => source.id === 'm0')?.text ?? '')?.[1];
            const matches = label ? envelope.entities.filter(entity => entity.kind === 'runs'
              && entity.context?.source === 'background-only'
              && entity.context.text.includes(`Identity anchor only for ${label}.`)) : [];
            check('adapter:origin-from-source-and-context', matches.map(entity => entity.id), [anchors[0].id]);
            origin = matches.length === 1 ? matches[0].id : undefined;
          }
          const ref = id => id ? [{ type: 'run', id }] : [];
          const grounding = indexes => indexes.map(index => ({ id: `m${index}`, quote: item.quotes[index] }));
          const candidates = [{ kind: item.kind, title: item.title, grounding: grounding([0, 1]), entities: ref(origin) }];
          if (selection !== 'omitted') {
            const followupRun = selection === 'unlinked' ? undefined : selection === 'swapped'
              ? envelope.entities.find(entity => entity.kind === 'runs' && entity.id !== origin)?.id : origin;
            candidates.push({ kind: scenario === 'prepared' ? 'workflows' : 'diagnostics', title: followupTitle,
              grounding: grounding(selection === 'unlinked' ? [2] : [0, 2]), entities: ref(followupRun) });
          }
          return { text: JSON.stringify({ candidates }) };
        },
      });
      check('extraction:queued', result.status, 'queued');
      check('extraction:one-fixed-adapter-call', result.counts.modelCalls, 1);
      check('extraction:not-auto-published', result.counts.published, 0);
      const pending = listCandidatesV2(project).candidates.filter(candidate => candidate.status === 'pending');
      check('candidate:complementary-records', pending.length, 2);
      check('candidate:outside-knowledge', ids(searchV2(project, item.query).hits), before);
      const entries = pending.map(candidate => ({ entry: candidate.candidate.entry }));
      facts('candidate', text(entries));
      check('candidate:no-background-grounding', text(entries).includes('Identity anchor only'), false);
      check('candidate:no-revision-target', pending.every(candidate => candidate.candidate.target === undefined), true);
      const followup = pending.find(candidate => candidate.candidate.entry.title === followupTitle)?.candidate.entry;
      check('followup:selected', !!followup, true);
      check('followup:origin-grounded', evidenceHas(followup, 'm0'), true);
      check('followup:advice-grounded', evidenceHas(followup, 'm2'), true);
      check('followup:correct-run', followup?.entities ?? [], anchors.length ? [{ type: 'run', id: anchors[0].id }] : []);
      const records = pending.map(candidate => reviewCandidateV2(project, candidate.candidate.requestId, 'approve').publication.record);
      facts('published', text(records));
      check('published:still-reported', records.every(record => record.entry.verification === 'reported'), true);
      check('published:source-preserved', records.every(record => record.entry.provenance === 'model-extraction'), true);
      check('published:no-structured-result', records.every(record => record.entry.result === undefined), true);
      check('published:run-state-not-inferred', records.every(record => record.entry.run === undefined
        || isDeepStrictEqual(record.entry.run, { execution: 'unknown', termination: 'unknown', convergence: 'unknown', validity: 'unchecked' })), true);
      const followupRecord = records.find(record => record.entry.title === followupTitle);
      const broad = searchV2(project, followupTitle).hits;
      check('broad:advice-retained', broad.some(hit => hit.id === followupRecord?.id && hit.excerpt.includes(item.messages[2].content)), true);
      const hits = searchV2(project, query, anchors.length ? { entityId: anchors[0].id } : {}).hits
        .filter(hit => !anchors.some(anchor => anchor.id === hit.id));
      check('scoped:complementary-records', ids(hits), ids(records));
      facts('scoped', hits.map(hit => hit.excerpt).join('\n\n'));
      if (anchors.length) {
        check('foreign-run:no-advice', searchV2(project, followupTitle, { entityId: anchors[1].id }).hits
          .some(hit => hit.id === followupRecord?.id), false);
        check('anchors:unchanged', anchors.map(anchor => getV2(project, anchor.id)), anchors);
      }
      // Identity and goal only; do not seed the desired advice or scientific answers into state.
      updateWorkingV2(project, 'state', 0, { goal: scenario === 'prepared' ? 'Continue input inspection'
        : 'Continue run-A inspection and diagnostic follow-up', entities: anchors.length ? [anchors[0].id] : [] });
      const context = restoreChemistryContext(root);
      facts('context', context.content);
      check('context:followup-selected', !!followupRecord && context.paths.some(label => label.includes(`/${followupRecord.id}.md`)), true);
      check('context:budget', context.chars <= 12000, true);
      if (anchors.length) check('context:foreign-anchor-excluded', context.paths.some(label => label.includes(`/${anchors[1].id}.md`)), false);
      else check('prepared:no-output', fs.existsSync(path.join(folder, 'output.log')), false);
    });
  } catch (error) { executionError = error.code ?? error.name ?? 'execution-error'; }
  check('sandbox-cleaned', !!base && !fs.existsSync(base), true);
  const sources = ['./m4-chemistry-followup.mjs', './m4-chemistry-scenarios-fixtures.mjs', './m4-chemistry-generation.mjs',
    './m4-integration.mjs', '../src/v2-extraction.mjs', '../src/v2-candidates.mjs', '../src/v2-store.mjs',
    '../src/v2-working.mjs', '../src/v2-domain.mjs', '../src/core.mjs'];
  return { suite: 'm4-chemistry-followup-1', scenario, selection, node: process.version,
    fixtureSha256: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
    sourceSha256: Object.fromEntries(sources.map(source => [source, createHash('sha256').update(fs.readFileSync(new URL(source, import.meta.url))).digest('hex')])),
    scope: 'synthetic response shapes and explicit identity anchors; fresh Node process, not Pi continuation or a real model improvement test',
    modelUsage: 'not-applicable', modelSelectionQuality: 'unassessed', qualityVerdict: 'unassessed',
    ...(executionError ? { executionError } : {}), checks,
    fixedResponseContractPassed: !executionError && checks.every(check => check.passed) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node eval/m4-chemistry-followup.mjs (disposable sandboxes; no calculations/models)');
    process.exitCode = 2;
  } else {
    const reports = [await runChemistryFollowup({ scenario: 'prepared' }), await runChemistryFollowup()];
    console.log(JSON.stringify({ reports, fixedResponseContractPassed: reports.every(report => report.fixedResponseContractPassed) }, null, 2));
    if (!reports.every(report => report.fixedResponseContractPassed)) process.exitCode = 1;
  }
}
