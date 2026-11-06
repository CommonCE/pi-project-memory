// Invented evidence, not a calculation or a recommendation of these settings.
export const chemistryScenariosVersion = 'm4-chemistry-scenarios-1';
export const preparedFixture = {
  id: 'prepared', kind: 'runs', title: 'Input written', query: 'Input written',
  messages: [
    { role: 'user', content: 'System synthetic-water; method PBE0/def2-SVP; software ORCA 6.1.1; charge 0; multiplicity 1. Prepare synthetic/prepared/input.inp only; do not execute or submit.' },
    { role: 'toolResult', toolName: 'synthetic-writer', content: 'Input written at synthetic/prepared/input.inp. No calculation has run; no energy is available. Execution, termination and convergence unknown; scientific validity unchecked.' },
    { role: 'assistant', stopReason: 'stop', content: 'Possible next step: inspect input. This is a suggestion, not a user commitment or permission to run.' },
  ],
  quotes: ['System synthetic-water', 'Input written at synthetic/prepared/input.inp.', 'Possible next step: inspect input.'],
  forbiddenTitle: 'calculation has run',
  facts: [
    { id: 'system-method', source: 0, text: 'System synthetic-water; method PBE0/def2-SVP' },
    { id: 'software-version', source: 0, text: 'software ORCA 6.1.1' },
    { id: 'charge-spin', source: 0, text: 'charge 0; multiplicity 1' },
    { id: 'no-execution-authority', source: 0, text: 'Prepare synthetic/prepared/input.inp only; do not execute or submit.' },
    { id: 'input-path', source: 1, text: 'Input written at synthetic/prepared/input.inp.' },
    { id: 'not-run-no-energy', source: 1, text: 'No calculation has run; no energy is available.' },
    { id: 'unknown-science', source: 1, text: 'Execution, termination and convergence unknown; scientific validity unchecked.' },
    { id: 'suggestion-not-permission', source: 2, text: 'This is a suggestion, not a user commitment or permission to run.' },
  ],
};
export const rerunFixtures = [
  {
    id: 'run-A', kind: 'diagnostics', title: 'SCF observation', query: 'SCF observation',
    messages: [
      { role: 'user', content: 'Record synthetic run-A. System synthetic-water; method PBE0/def2-SVP; software ORCA 6.1.1; charge 0; multiplicity 1. Keep this failed run separate.' },
      { role: 'toolResult', toolName: 'synthetic-reader', isError: true, content: 'SCF observation for run-A at synthetic/run-A/output.log. Last SCF iteration energy -10.25 Ha; not converged; error termination; not a validated total energy.' },
      { role: 'assistant', stopReason: 'stop', content: 'Hypothesis only: change basis from def2-SVP to def2-TZVP for a new run; no retry yet.' },
    ],
    quotes: ['Record synthetic run-A.', 'SCF observation for run-A', 'Hypothesis only: change basis'],
    forbiddenText: '-11.5 Ha',
    facts: [
      { id: 'system-method', source: 0, text: 'System synthetic-water; method PBE0/def2-SVP' },
      { id: 'software-charge-spin', source: 0, text: 'software ORCA 6.1.1; charge 0; multiplicity 1' },
      { id: 'run-path', source: 1, text: 'SCF observation for run-A at synthetic/run-A/output.log.' },
      { id: 'failed-energy', source: 1, text: 'Last SCF iteration energy -10.25 Ha; not converged; error termination; not a validated total energy.' },
      { id: 'unrun-method-change', source: 2, text: 'Hypothesis only: change basis from def2-SVP to def2-TZVP for a new run; no retry yet.' },
    ],
  },
  {
    id: 'run-B', kind: 'diagnostics', title: 'SCF observation', query: 'SCF observation',
    messages: [
      { role: 'user', content: 'User adopted method change from PBE0/def2-SVP to PBE0/def2-TZVP for independent synthetic run-B. System synthetic-water; software ORCA 6.1.1; charge 0; multiplicity 1.' },
      { role: 'toolResult', toolName: 'synthetic-reader', content: 'SCF observation for run-B at synthetic/run-B/output.log. Reported total energy -11.5 Ha; normal termination; SCF converged; scientific validity unchecked.' },
      { role: 'assistant', stopReason: 'stop', content: 'run-B does not revise run-A. Do not reuse the earlier failed energy for run-B. Next step: inspect validity evidence, not submit another run.' },
    ],
    quotes: ['User adopted method change', 'SCF observation for run-B', 'run-B does not revise run-A.'],
    forbiddenText: '-10.25 Ha',
    facts: [
      { id: 'adopted-method-change', source: 0, text: 'User adopted method change from PBE0/def2-SVP to PBE0/def2-TZVP for independent synthetic run-B.' },
      { id: 'system-software-charge-spin', source: 0, text: 'System synthetic-water; software ORCA 6.1.1; charge 0; multiplicity 1' },
      { id: 'run-path', source: 1, text: 'SCF observation for run-B at synthetic/run-B/output.log.' },
      { id: 'reported-energy-not-validity', source: 1, text: 'Reported total energy -11.5 Ha; normal termination; SCF converged; scientific validity unchecked.' },
      { id: 'no-rewrite', source: 2, text: 'run-B does not revise run-A.' },
      { id: 'next-not-submission', source: 2, text: 'Next step: inspect validity evidence, not submit another run.' },
    ],
  },
];
