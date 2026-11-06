// Synthetic evidence only. Version independently from production schemas.
export const version = 'm4-extraction-1';
export const projectId = '11111111-1111-4111-8111-111111111111';
const methodA = '22222222-2222-4222-8222-222222222222';
const methodB = '33333333-3333-4333-8333-333333333333';
export const entities = [
  { id: methodA, revision: 1, kind: 'methods', title: 'Same method title' },
  { id: methodB, revision: 1, kind: 'methods', title: 'Same method title' },
];

export const fixtures = [
  {
    id: 'P1', kind: 'runs', title: 'Prepare run-A', source: 'user-statement',
    text: 'Prepare run-A at synthetic/run-A. This is a plan only; no calculation has been executed. Suggested iterations: 40 to 80; not adopted or tested.',
    quote: 'Prepare run-A at synthetic/run-A.',
    facts: [
      { id: 'plan', text: 'This is a plan only; no calculation has been executed.' },
      { id: 'suggestion', text: 'Suggested iterations: 40 to 80; not adopted or tested.' },
    ],
    forbiddenTitles: ['calculation has been executed'],
  },
  {
    id: 'P2', kind: 'runs', title: 'Input written', source: 'tool-observation',
    text: 'Input written for run-A at synthetic/run-A/input.inp. Tool transport completed; execution, termination, convergence and validity remain unknown.',
    quote: 'Input written for run-A',
    priorSources: [{ source: 'assistant-claim',
      text: 'run-A successfully converged and produced valid results. This is an assistant claim with no supporting execution observation.',
      quote: 'run-A successfully converged and produced valid results.' }],
    facts: [
      { id: 'transport-not-success', text: 'Tool transport completed; execution, termination, convergence and validity remain unknown.' },
      { id: 'assistant-claim-not-observation', sourceIndex: 0,
        text: 'run-A successfully converged and produced valid results. This is an assistant claim with no supporting execution observation.' },
    ],
    forbiddenTitles: ['run-A successfully converged'],
  },
  {
    id: 'F1', kind: 'diagnostics', title: 'SCF failed', source: 'tool-observation', failed: true,
    text: 'SCF failed for run-B at synthetic/run-B/output.log. Last SCF iteration energy: -10.25 Ha; not converged, error termination, not a validated total energy. Hypothesis: increase iterations from 40 to 80; no retry has run.',
    quote: 'SCF failed for run-B',
    facts: [
      { id: 'energy-with-limits', text: 'Last SCF iteration energy: -10.25 Ha; not converged, error termination, not a validated total energy.' },
      { id: 'unverified-remedy', text: 'Hypothesis: increase iterations from 40 to 80; no retry has run.' },
    ],
    forbiddenTitles: ['converged', 'validated total energy'],
  },
  {
    id: 'F2', kind: 'runs', title: 'run-C normal termination', source: 'tool-observation',
    text: 'run-C normal termination and SCF convergence reported at synthetic/run-C/output.log. Scientific validity remains unchecked. run-B remains failed; no revision of run-B is intended.',
    quote: 'run-C normal termination and SCF convergence reported',
    facts: [
      { id: 'validity-unknown', text: 'Scientific validity remains unchecked.' },
      { id: 'prior-failure', text: 'run-B remains failed; no revision of run-B is intended.' },
    ],
    forbiddenTitles: [],
  },
  {
    id: 'E1-A', kind: 'methods', title: 'Same method title', source: 'tool-observation',
    text: 'Same method title: method-A uses synthetic basis-A with dispersion-A for system-A only. This does not specify method-B settings.',
    quote: 'Same method title: method-A', refs: [{ type: 'method', id: methodA }],
    facts: [{ id: 'scope', text: 'method-A uses synthetic basis-A with dispersion-A for system-A only.' }],
    forbiddenTitles: [],
  },
  {
    id: 'E1-B', kind: 'methods', title: 'Same method title', source: 'tool-observation',
    text: 'Same method title: method-B uses synthetic basis-B without dispersion for system-A only. This does not replace method-A.',
    quote: 'Same method title: method-B', refs: [{ type: 'method', id: methodB }],
    facts: [{ id: 'scope', text: 'method-B uses synthetic basis-B without dispersion for system-A only.' }],
    forbiddenTitles: [],
  },
  {
    id: 'R1', kind: 'runs', title: 'run-D prepared', source: 'tool-observation',
    text: 'run-D prepared at synthetic/run-D/input.inp; execution is prepared, termination unknown, convergence unknown, validity unchecked. run-E running at synthetic/run-E/output.log; termination unknown, convergence unknown, validity unchecked. These are independent runs.',
    quote: 'run-D prepared at synthetic/run-D/input.inp',
    facts: [
      { id: 'prepared-run', text: 'run-D prepared at synthetic/run-D/input.inp; execution is prepared, termination unknown, convergence unknown, validity unchecked.' },
      { id: 'running-run', text: 'run-E running at synthetic/run-E/output.log; termination unknown, convergence unknown, validity unchecked.' },
    ],
    forbiddenTitles: [],
  },
  {
    id: 'C2', kind: 'software', title: 'Parser change', source: 'tool-observation',
    text: 'Parser change in synthetic/parser.mjs. Syntax check passed; unit check failed; host check skipped; integration check not run. Blocker: missing fixture. Proposed next step: inspect synthetic/parser.test.mjs; not yet user-approved. Software checks do not validate chemistry.',
    quote: 'Parser change in synthetic/parser.mjs.',
    facts: [
      { id: 'check-scope', text: 'Syntax check passed; unit check failed; host check skipped; integration check not run.' },
      { id: 'next-step', text: 'Blocker: missing fixture. Proposed next step: inspect synthetic/parser.test.mjs; not yet user-approved.' },
      { id: 'science-limit', text: 'Software checks do not validate chemistry.' },
    ],
    forbiddenTitles: [],
  },
];

// These cannot be certified by an in-memory extraction evaluation.
export const unassessed = [
  'E1 active-entity retrieval', 'E2 revisions and same-name systems',
  'R1 run-specific retrieval', 'Q1 pending/rejected/publication isolation',
  'Q2 published lifecycle and review verification', 'C1 cross-session calculation continuation',
  'C2 cross-session software continuation', 'I1 project/marker/privacy isolation',
  'B1 context deduplication and truncation', 'v1/v2 comparison',
  'independent human semantic review', 'real model selection quality',
];
