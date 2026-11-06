import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withSandbox } from './m4-integration.mjs';
import { fixtures } from './m4-fixtures.mjs';
import { loadConfig, resolveProject, initialize, saveNote, search, brief } from '../src/core.mjs';
import { initializeV2, resolveV2, saveV2, searchV2, getV2 } from '../src/v2-store.mjs';
import { listCandidatesV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { buildWorkingContext } from '../src/v2-working.mjs';
import { buildExtractionEnvelope, parseExtractionResponse, extractCandidatesV2 } from '../src/v2-extraction.mjs';

const version = 'm4-offline-1';
const longPrefix = 'M4LONG shared calibration introduction. '.repeat(100);
const limits = ['Distinct limitation A: no validated energy.', 'Distinct limitation B: no retry has run.'];
const gold = { version, limits, boundaryCanary: 'FOREIGN_PROJECT_CANARY', budget: 12000, retrievalLimit: 4,
  unassessed: ['independent semantic/scientific review', 'real model selection', 'Pi host/session lifecycle',
    'full privacy guarantee', 'difficult keyword-overlap negatives', 'full v1/v2 lifecycle and extraction comparison'] };
const add = (project, content, extra = {}) => saveV2(project, { kind: 'software', title: 'Synthetic observation', content, ...extra }).record;
const labels = context => context.paths.filter(label => label.startsWith('knowledge: '));

const scenarios = {
  async I1({ base, root, project }, check) {
    add(project, 'M4ISOLATION local project observation.');
    const foreignRoot = path.join(base, 'foreign'); fs.mkdirSync(foreignRoot);
    const foreign = initializeV2(foreignRoot, { name: 'Synthetic foreign project', nested: true });
    add(foreign, 'M4ISOLATION FOREIGN_PROJECT_CANARY.');
    const local = searchV2(project, 'M4ISOLATION');
    check('local-hit-present', local.hits.length, 1);
    check('foreign-hit-absent', JSON.stringify(local).includes(gold.boundaryCanary), false);
    check('foreign-context-absent', buildWorkingContext(project, 'M4ISOLATION').content.includes(gold.boundaryCanary), false);
    const unmarked = path.join(base, 'unmarked'); fs.mkdirSync(unmarked);
    check('no-marker-disabled', resolveV2(unmarked).enabled, false);
    check('no-marker-no-hits', searchV2(resolveV2(unmarked), 'M4ISOLATION').hits.length, 0);
    check('no-marker-not-created', fs.existsSync(path.join(unmarked, '.pi-root')), false);
    const messages = [{ role: 'user', content: 'Preserve public synthetic observations only.' },
      { role: 'toolResult', toolName: 'synthetic-reader', content: 'Public prefix. '.repeat(100) + 'password = M4_FAKE_SENTINEL' }];
    const built = buildExtractionEnvelope(messages, { projectId: project.id, session: 'privacy-fixture', turn: 'one', toolChars: 100 });
    check('filter-before-truncation', built.reasons['sensitive-fragment-dropped'], 1);
    check('sentinel-not-transmitted', JSON.stringify(built.envelope).includes('M4_FAKE_SENTINEL'), false);
    let refused = false;
    try { add(project, 'password = M4_FAKE_SENTINEL'); } catch { refused = true; }
    check('explicit-save-refuses-sentinel', refused, true);
    fs.unlinkSync(path.join(root, '.pi-root'));
    check('revoked-marker-disables-reparsed-project', resolveV2(root).enabled, false);
  },
  async B1({ project }, check) {
    const shared = { sourceTurn: 'turn:synthetic-short', evidence: ['turn:synthetic-short:m1'] };
    add(project, 'M4SHORT common observation.', shared);
    add(project, 'M4SHORT common observation.', shared);
    add(project, 'M4SHORT complementary observation; no validation.', shared);
    const short = searchV2(project, 'M4SHORT', { deduplicateSources: true });
    check('duplicate-collapsed', short.deduplicated, 1);
    check('short-complement-retained', short.hits.length, 2);
    const ids = limits.map(limit => add(project, longPrefix + limit,
      { sourceTurn: 'turn:synthetic-long', evidence: ['turn:synthetic-long:m1'] }).id).sort();
    const full = searchV2(project, 'M4LONG', { deduplicateSources: true });
    check('full-content-identity-not-prefix', full.hits.map(hit => hit.id).sort(), ids);
    check('complement-not-deduplicated', full.deduplicated, 0);
    const context = buildWorkingContext(project, 'M4LONG');
    check('both-long-records-in-context', labels(context).length, 2);
    // Must not bless a lost limitation just because retrieval IDs were correct.
    for (let i = 0; i < limits.length; i++) check(`long-limitation-${i + 1}-recoverable`, context.content.includes(limits[i]), true);
    const text = 'Truncated source observation. ' + 'Synthetic padding. '.repeat(100) + 'Important tail: no success is established.';
    const built = buildExtractionEnvelope([{ role: 'user', content: 'Keep bounded evidence explicitly unverified.' },
      { role: 'toolResult', toolName: 'synthetic-reader', content: text }],
    { projectId: project.id, session: 'bounded-fixture', turn: 'one', toolChars: 100 });
    const source = built.envelope.evidence.find(item => item.id === 'm1');
    check('evidence-truncation-visible', source.truncated, true);
    const parsed = parseExtractionResponse(JSON.stringify({ candidates: [{ kind: 'software', title: 'Truncated source',
      grounding: [{ id: 'm1', quote: 'Truncated source observation.' }] }] }), built.envelope);
    check('published-text-marks-truncation', parsed[0].entry.content.includes('bounded/truncated'), true);
    check('truncation-not-science-certification', parsed[0].entry.verification, 'reported');
    check('context-budget', context.chars <= gold.budget, true);
  },
  async A1({ project }, check) {
    const messages = [{ role: 'user', content: 'Preserve failure evidence without inferring success.' },
      { role: 'toolResult', toolName: 'synthetic-reader', isError: true,
        content: 'Synthetic SCF failed. Recovery is a hypothesis; no retry has run. Last iteration energy -10.25 Ha; not validated.' }];
    const response = { text: JSON.stringify({ candidates: [{ kind: 'runs', title: 'Synthetic SCF failed',
      grounding: [{ id: 'm1', quote: 'Synthetic SCF failed.' }] }] }) };
    const options = { session: 'auto-fixture', turn: 'published', isCurrent: () => true, mode: 'auto',
      timeoutMs: 1000, model: async () => response };
    const first = await extractCandidatesV2(project, messages, options);
    check('auto-published', first.counts.published, 1);
    const published = listCandidatesV2(project).candidates.find(item => item.status === 'approved');
    check('auto-reviewer', published.reviewer, 'auto');
    const entry = getV2(project, published.id).entry;
    check('auto-verification-unchanged', entry.verification, 'reported');
    check('auto-run-state-unknown', entry.run, { execution: 'unknown', termination: 'unknown', convergence: 'unknown', validity: 'unchecked' });
    check('auto-negation-retained', entry.content.includes('Recovery is a hypothesis; no retry has run.'), true);
    const repeat = await extractCandidatesV2(project, messages, options);
    check('auto-idempotent', repeat.counts.published, 0);
    const reviewOptions = { ...options, turn: 'rejected', mode: 'review' };
    await extractCandidatesV2(project, messages, reviewOptions);
    const rejected = listCandidatesV2(project).candidates.find(item => item.status === 'pending');
    reviewCandidateV2(project, rejected.candidate.requestId, 'reject');
    const retried = await extractCandidatesV2(project, messages, { ...reviewOptions, mode: 'auto' });
    check('auto-respects-human-rejection', retried.reasons['review-rejected'], 1);
    check('rejected-not-published', retried.counts.published, 0);
    check('knowledge-count-stable', searchV2(project, 'Synthetic SCF failed').hits.length, 1);
  },
  async COMPARE({ base, project }, check) {
    // Separate root, home, vault and config. Never reads the real home/config.
    const root = path.join(base, 'v1'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.pi-root'), '');
    const cfg = { ...loadConfig({ home: path.join(base, 'home'), env: {} }), contextChars: gold.budget };
    const v1 = initialize(resolveProject(root, cfg), cfg);
    const records = fixtures.map(item => {
      const content = [...(item.priorSources ?? []), item]
        .map(source => `Unverified synthetic evidence [${source.source}].\n${source.text}`).join('\n\n');
      const old = saveNote(v1, { type: 'observation', title: item.title, content, status: 'active' });
      const current = saveV2(project, { kind: item.kind, title: item.title, content, verification: 'reported' }).record;
      return { item, old, current };
    });
    const measurements = [];
    for (const { item, old, current } of records) {
      const query = item.quote;
      const startedV1 = performance.now();
      const oldSearch = search(v1, query, cfg, gold.retrievalLimit);
      const oldContext = brief(v1, oldSearch, cfg);
      const v1Ms = performance.now() - startedV1;
      const startedV2 = performance.now();
      const newSearch = searchV2(project, query, { limit: gold.retrievalLimit });
      const newContext = buildWorkingContext(project, query, { maxChars: gold.budget });
      const v2Ms = performance.now() - startedV2;
      const oldHit = oldSearch.hits.find(hit => hit.relativePath === old.relativePath);
      const newHit = newSearch.hits.find(hit => hit.id === current.id);
      check(`${item.id}-v1-target-hit`, !!oldHit, true);
      check(`${item.id}-v2-target-hit`, !!newHit, true);
      const coverage = {};
      for (const [label, context] of [['v1', oldContext], ['v2', newContext.content]]) {
        const found = item.facts.filter(fact => context.includes(fact.text)).length;
        coverage[label] = { recovered: found, required: item.facts.length };
        check(`${item.id}-${label}-fact-coverage`, found, item.facts.length);
        check(`${item.id}-${label}-budget`, context.length <= gold.budget, true);
      }
      measurements.push({ id: item.id, coverage, contextChars: { v1: oldContext.length, v2: newContext.chars }, latencyMs: { v1: v1Ms, v2: v2Ms } });
    }
    return { measurements, comparisonScope: 'identical explicitly seeded text, queries, top-4 search and 12000-unit context caps; no extraction or lifecycle equivalence',
      unsupported: ['v1 typed entities/revision API', 'v1 reported verification field', 'v1 v2-style state/overview continuation API'], modelUsage: 'not-applicable' };
  },
};

export async function runOfflineEvaluation() {
  const cases = [];
  for (const [id, scenario] of Object.entries(scenarios)) {
    let base, details, executionError;
    const checks = [], start = performance.now();
    const check = (factId, actual, expected) => checks.push({ factId, actual, expected, passed: isDeepStrictEqual(actual, expected) });
    try { details = await withSandbox(async sandbox => { base = sandbox.base; return scenario(sandbox, check); }); }
    catch (error) { executionError = error.code ?? error.name ?? 'execution-error'; }
    check('sandbox-cleaned', base ? !fs.existsSync(base) : false, true);
    cases.push({ id, checks, ...(details ? { details } : {}), ...(executionError ? { executionError } : {}),
      passed: !executionError && checks.every(item => item.passed), elapsedMs: performance.now() - start });
  }
  const files = ['./m4-offline.mjs', './m4-fixtures.mjs', './m4-integration.mjs', '../src/core.mjs', '../src/v2-store.mjs', '../src/v2-working.mjs', '../src/v2-candidates.mjs', '../src/v2-extraction.mjs', '../src/v2-domain.mjs'];
  return { suite: version, node: process.version, fixtureSha256: createHash('sha256').update(JSON.stringify({ gold, fixtures })).digest('hex'),
    sourceSha256: Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    syntheticContractPassed: cases.every(item => item.passed), qualityVerdict: 'unassessed', cases, unassessed: gold.unassessed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node eval/m4-offline.mjs (new disposable OS-temp sandboxes; JSON to stdout)');
    process.exitCode = 2;
  } else {
    const report = await runOfflineEvaluation();
    console.log(JSON.stringify(report, null, 2));
    if (!report.syntheticContractPassed) process.exitCode = 1;
  }
}
