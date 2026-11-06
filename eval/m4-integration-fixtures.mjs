// All names, settings, observations and numbers are invented evaluation data.
export const integrationVersion = 'm4-integration-1';
export const variants = ['plain', 'before', 'after'];
export const gold = {
  Q1: { name: 'Unpublished candidates stay outside knowledge', states: ['pending', 'rejected', 'publication-pending'] },
  Q2: { name: 'Resume publication without scientific certification', verification: 'reported',
    unresolved: { verification: 'unresolved', markers: { user: 'UNRESOLVED_USER_MARKER', auto: 'UNRESOLVED_AUTO_MARKER' } },
    run: { execution: 'unknown', termination: 'unknown', convergence: 'unknown', validity: 'unchecked' } },
  E1: { name: 'Same-name methods keep their scope', active: 'Calibration method-A basis-A dispersion-A.', foreign: 'Calibration method-B basis-B without dispersion.' },
  E2: { name: 'Current revisions and same-name systems stay distinct', current: 'Calibration system-A geometry revision two.', old: 'Calibration system-A geometry revision one.', other: 'Calibration system-B unrelated geometry.',
    methodCurrent: 'Calibration method-A settings revision two.', methodOld: 'Calibration method-A settings revision one.',
    methodOther: 'Calibration method-B unrelated settings.' },
  R1: { name: 'Failed and successful runs retain separate result meanings', failedValue: -10.25, successfulValue: -11.5, unit: 'Ha',
    failedDefinition: 'Last SCF iteration energy; not converged; not a validated total energy.',
    failedRun: { execution: 'terminated', termination: 'error', convergence: 'not-converged', validity: 'unchecked' },
    successfulRun: { execution: 'terminated', termination: 'normal', convergence: 'converged', validity: 'unchecked' } },
  C1: { name: 'Calculation continuation from a fresh process',
    goal: 'Inspect synthetic system-A with synthetic method-A at synthetic/run-B; do not submit calculations.',
    blocker: 'SCF did not converge; no validated total energy.',
    next: 'Inspect synthetic/run-B/input.inp before considering any retry.',
    artifact: 'synthetic/run-B/output.log',
    observation: 'SCF failed. Last iteration energy -10.25 Ha; convergence not achieved; scientific validity unchecked.',
    unverified: 'Hypothesis only: increase iterations from 40 to 80. No retry has run.' },
  C2: { name: 'Software continuation from a fresh process',
    goal: 'Continue the parser change in synthetic/parser.mjs; do not claim scientific validation.',
    blocker: 'Unit check failed: missing fixture.',
    next: 'Inspect synthetic/parser.test.mjs; do not run integration checks yet.',
    artifact: 'synthetic/parser.mjs',
    observation: 'Syntax check passed; unit check failed; host check skipped; integration check not run.',
    unverified: 'Hypothesis only: the fixture needs an update. The proposed fix has not been tested.' },
};
export const integrationUnassessed = [
  'Pi host/session lifecycle and remote model quality', 'v1/v2 comparison',
  'independent human semantic and scientific review', 'full privacy/filtering evaluation',
  'context deduplication and truncation quality', 'combinatorial failures and recovery beyond these fixtures',
];
