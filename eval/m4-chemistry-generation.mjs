import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { withSandbox } from './m4-integration.mjs';
import { extractCandidatesV2 } from '../src/v2-extraction.mjs';
import { listCandidatesV2, reviewCandidateV2 } from '../src/v2-candidates.mjs';
import { searchV2 } from '../src/v2-store.mjs';
import { updateWorkingV2 } from '../src/v2-working.mjs';

// Invented transcript and frozen gold; no scientific software is executed.
export const chemistryFixture = {
  version: 'm4-chemistry-generation-1',
  messages: [
    { role: 'user', content: 'Continue synthetic SCF failure. System synthetic-water; method PBE0/def2-SVP; software ORCA 6.1.1; charge 0; multiplicity 1. Run path synthetic/run-B. Inspect only; do not run or submit calculations.' },
    { role: 'toolResult', toolName: 'synthetic-reader', isError: true,
      content: 'SCF failed at synthetic/run-B/output.log. Last SCF iteration energy -10.25 Ha; not converged; error termination; not a validated total energy.' },
    { role: 'assistant', stopReason: 'stop',
      content: 'Hypothesis: increase iterations from 40 to 80. Not adopted by the user; no retry has run. Proposed next step: inspect synthetic/run-B/input.inp; not permission to execute.' },
  ],
  quotes: ['System synthetic-water', 'SCF failed at synthetic/run-B/output.log.', 'Hypothesis: increase iterations from 40 to 80.'],
  facts: [
    { id: 'system', source: 0, text: 'System synthetic-water' },
    { id: 'method', source: 0, text: 'method PBE0/def2-SVP' },
    { id: 'software-version', source: 0, text: 'software ORCA 6.1.1' },
    { id: 'charge-spin', source: 0, text: 'charge 0; multiplicity 1' },
    { id: 'execution-boundary', source: 0, text: 'Inspect only; do not run or submit calculations.' },
    { id: 'failure-path', source: 1, text: 'SCF failed at synthetic/run-B/output.log.' },
    { id: 'energy-with-limits', source: 1, text: 'Last SCF iteration energy -10.25 Ha; not converged; error termination; not a validated total energy.' },
    { id: 'hypothesis-old-new', source: 2, text: 'Hypothesis: increase iterations from 40 to 80.' },
    { id: 'not-adopted-not-run', source: 2, text: 'Not adopted by the user; no retry has run.' },
    { id: 'next-step-not-permission', source: 2, text: 'Proposed next step: inspect synthetic/run-B/input.inp; not permission to execute.' },
  ],
};

// Read-only recovery in a fresh process, not a Pi session transition.
export function restoreChemistryContext(root) {
  const script = `import {resolveV2} from ${JSON.stringify(new URL('../src/v2-store.mjs', import.meta.url).href)};
import {buildWorkingContext} from ${JSON.stringify(new URL('../src/v2-working.mjs', import.meta.url).href)};
process.stdout.write(JSON.stringify(buildWorkingContext(resolveV2(process.argv[1]), '继续')));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root], {
    cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, env: { ...process.env, NODE_OPTIONS: '' },
  }));
}

// Selection is scripted, NOT evidence of autonomous model selection quality.
export async function runChemistryGeneration({ selection = 'conservative' } = {}) {
  if (!['conservative', 'assistant-only'].includes(selection)) throw new Error('Invalid fixed selection');
  const checks = [];
  const check = (id, actual, expected) => checks.push({ id, actual, expected, passed: isDeepStrictEqual(actual, expected) });
  const facts = (phase, content) => {
    for (const fact of chemistryFixture.facts) check(`${phase}:${fact.id}`, content.includes(fact.text), true);
  };
  let base, executionError;
  try {
    await withSandbox(async sandbox => {
      base = sandbox.base;
      const { project, root } = sandbox;
      fs.mkdirSync(path.join(root, 'synthetic/run-B'), { recursive: true });
      fs.writeFileSync(path.join(root, 'synthetic/run-B/output.log'), chemistryFixture.messages[1].content);
      fs.writeFileSync(path.join(root, 'synthetic/run-B/input.inp'), 'Synthetic placeholder only; not a runnable calculation.\n');
      const extraction = await extractCandidatesV2(project, chemistryFixture.messages, {
        session: 'synthetic-chemistry', turn: 'failure-and-proposal', mode: 'review', isCurrent: () => true,
        model: async request => {
          const envelope = JSON.parse(request.prompt);
          const indices = selection === 'conservative' ? [0, 1, 2] : [2];
          const grounding = indices.map(index => ({ id: `m${index}`, quote: chemistryFixture.quotes[index] }));
          check('adapter-received-sources', envelope.evidence.map(source => source.id).sort(), ['m0', 'm1', 'm2']);
          return { text: JSON.stringify({ candidates: [{ kind: 'diagnostics',
            title: selection === 'conservative' ? 'SCF failed' : 'Hypothesis', grounding }] }) };
        },
      });
      check('generation-queued', extraction.status, 'queued');
      check('single-adapter-call', extraction.counts.modelCalls, 1);
      check('review-not-auto-published', extraction.counts.published, 0);
      const pending = listCandidatesV2(project).candidates;
      check('one-pending-candidate', pending.length, 1);
      check('pending-status', pending[0].status, 'pending');
      facts('candidate', pending[0].candidate.entry.content);
      check('pending-outside-knowledge', searchV2(project, 'SCF').hits.length, 0);
      const approved = reviewCandidateV2(project, pending[0].candidate.requestId, 'approve').publication.record;
      facts('published', approved.entry.content);
      check('approval-not-certification', approved.entry.verification, 'reported');
      check('source-model-extraction', approved.entry.provenance, 'model-extraction');
      check('no-structured-result', approved.entry.result === undefined, true);
      const hits = searchV2(project, 'SCF').hits;
      check('query-record-identity', hits.map(hit => hit.id), [approved.id]);
      // Missing hits fail both identity and every fact, not an execution exception.
      facts('query', hits.length === 1 ? hits[0].excerpt : '');
      check('query-requires-verification', hits.map(hit => hit.requiresVerification), [true]);
      // Deliberately do not copy source facts/answers into state or journal.
      updateWorkingV2(project, 'state', 0, { goal: 'Continue synthetic SCF failure' });
      const context = restoreChemistryContext(root);
      facts('fresh-process-context', context.content);
      check('context-published-identity', context.paths.some(label => label.includes(`/${approved.id}.md`)), true);
      check('context-verification-label', context.content.includes('requires verification'), true);
      check('context-budget', context.chars <= 12000, true);
    });
  } catch (error) { executionError = error.code ?? error.name ?? 'execution-error'; }
  check('sandbox-cleaned', !!base && !fs.existsSync(base), true);
  const files = ['./m4-chemistry-generation.mjs', './m4-integration.mjs', '../src/v2-extraction.mjs',
    '../src/v2-candidates.mjs', '../src/v2-store.mjs', '../src/v2-working.mjs', '../src/v2-domain.mjs', '../src/core.mjs'];
  return { suite: chemistryFixture.version, selection, node: process.version,
    sourceSha256: Object.fromEntries(files.map(file => [file,
      createHash('sha256').update(fs.readFileSync(new URL(file, import.meta.url))).digest('hex')])),
    fixtureSha256: createHash('sha256').update(JSON.stringify(chemistryFixture)).digest('hex'),
    scope: 'fixed-response extraction API through review, retrieval and fresh Node process; not a Pi session',
    modelUsage: 'not-applicable', modelSelectionQuality: 'unassessed', qualityVerdict: 'unassessed',
    ...(executionError ? { executionError } : {}), checks,
    fixedResponseContractPassed: !executionError && checks.every(item => item.passed) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    console.error('Usage: node eval/m4-chemistry-generation.mjs (new disposable sandbox; no remote model)');
    process.exitCode = 2;
  } else {
    const report = await runChemistryGeneration();
    console.log(JSON.stringify(report, null, 2));
    if (!report.fixedResponseContractPassed) process.exitCode = 1;
  }
}
