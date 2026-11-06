// Coverage claims are bounded to the frozen synthetic fixtures, not real science.
const ref = (runner, id) => ({ runner, id });
export const matrixVersion = 'm4-matrix-1';
export const matrix = [
  { id: 'P1', title: 'Plans and suggestions are not executed results', refs: [ref('extraction', 'P1')],
    remaining: ['Add an explicit multi-source user-plan / assistant-suggestion / adopted-decision contrast.'] },
  { id: 'P2', title: 'Tool transport completion is not scientific success', refs: [ref('extraction', 'P2')],
    remaining: [] },
  { id: 'F1', title: 'Failed energy and untested recovery retain limitations', refs: [ref('extraction', 'F1')], remaining: [] },
  { id: 'F2', title: 'A successful new run does not rewrite an earlier failure', refs: [ref('extraction', 'F2'), ref('integration', 'R1')], remaining: [] },
  { id: 'E1', title: 'Same-name methods keep their applicable scope', refs: [ref('extraction', 'E1-A'), ref('extraction', 'E1-B'), ref('integration', 'E1')],
    remaining: ['Add typed numerical results as cross-method contamination negatives.'] },
  { id: 'E2', title: 'Same-name systems and explicit revisions stay distinct', refs: [ref('integration', 'E2')],
    remaining: [] },
  { id: 'R1', title: 'Independent runs retain their own paths and scientific states', refs: [ref('extraction', 'R1'), ref('integration', 'R1')],
    remaining: ['Assert each output path and prepared/running unknown fields independently in typed retrieval.'] },
  { id: 'Q1', title: 'Unpublished candidates stay outside knowledge channels', refs: [ref('integration', 'Q1')], remaining: [] },
  { id: 'Q2', title: 'Publication and approval do not certify knowledge', refs: [ref('integration', 'Q2'), ref('offline', 'A1')],
    remaining: [] },
  { id: 'C1', title: 'Calculation continuation preserves blockers and restrictions', refs: [ref('integration', 'C1')],
    remaining: ['Add quality assertions across actual offline Pi session transitions; a fresh Node process is not a Pi session.'] },
  { id: 'C2', title: 'Software continuation preserves the actual test scope', refs: [ref('extraction', 'C2'), ref('integration', 'C2')],
    remaining: ['Add quality assertions across actual offline Pi session transitions.'] },
  { id: 'I1', title: 'Project, marker and synthetic privacy boundaries', refs: [ref('offline', 'I1')], remaining: [] },
  { id: 'B1', title: 'Deduplication and bounded excerpts keep complementary facts', refs: [ref('offline', 'B1')],
    remaining: ['Extend budget/order variants; original tail-loss fixture passes, not arbitrary middle or unselected lines.'] },
];

export const runnerContracts = {
  extraction: { suite: 'm4-extraction-1', gate: 'preservationPassed',
    ids: ['P1', 'P2', 'F1', 'F2', 'E1-A', 'E1-B', 'R1', 'C2'], variants: ['plain', 'before', 'after'] },
  integration: { suite: 'm4-integration-1', gate: 'syntheticContractPassed',
    ids: ['Q1', 'Q2', 'E1', 'E2', 'R1', 'C1', 'C2'], variants: ['plain', 'before', 'after'],
    minimumChecks: { Q1: 10, Q2: 27, E1: 7, E2: 16, R1: 10, C1: 12, C2: 12 },
    requiredChecks: { Q2: ['user', 'auto'].flatMap(reviewer => ['publication-current', 'not-certified', 'source-preserved',
      'run-states-unknown', 'query-identity', 'query-verification', 'context-identity', 'context-label']
      .map(check => `unresolved-${reviewer}-${check}`)),
      E2: ['same-name-methods-not-merged', 'method-current-revision-only', 'method-current-query-content',
      'method-old-revision-auditable', 'method-current-content-restored', 'method-old-content-excluded',
      'other-method-excluded', 'only-active-method-selected'] } },
  offline: { suite: 'm4-offline-1', gate: 'syntheticContractPassed', ids: ['I1', 'B1', 'A1', 'COMPARE'], variants: [null],
    minimumChecks: { I1: 11, B1: 12, A1: 10, COMPARE: 49 },
    requiredChecks: { B1: ['long-limitation-1-recoverable', 'long-limitation-2-recoverable'],
      A1: ['auto-run-state-unknown', 'auto-respects-human-rejection'] } },
};

export const remainingRequirements = [
  { id: 'negative-controls', status: 'partial', detail: 'Existing unit controls are not a complete per-row positive/negative evaluation manifest.' },
  { id: 'order-variants', status: 'partial', detail: 'Extended cases have no full before/after replay; integration after checks only context identities.' },
  { id: 'cross-version', status: 'partial', detail: 'Eight common explicitly seeded text tasks only; not equivalent extraction or lifecycle APIs.' },
  { id: 'semantic-review', status: 'not-run', detail: 'Independent human review has not been performed.' },
  { id: 'documentation-portability', status: 'partial', detail: 'Targeted path-pattern checks only; user-facing documentation cleanup remains unfinished.' },
  { id: 'real-sample', status: 'not-authorized', detail: 'Real model/task sample evaluation requires separate authorization, data scope and cost bounds.' },
];
