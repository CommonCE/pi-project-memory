import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runEvaluation } from './m4-extraction.mjs';
import { runIntegration } from './m4-integration.mjs';
import { runOfflineEvaluation } from './m4-offline.mjs';
import { fixtures } from './m4-fixtures.mjs';
import { matrixVersion, matrix, runnerContracts, remainingRequirements } from './m4-matrix.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const key = (id, variant) => JSON.stringify([id, variant ?? null]);
const factCounts = new Map(fixtures.map(item => [item.id, item.facts.length]));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function jsonValue(value, ancestors = new Set(), depth = 0) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || depth > 32 || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(item => jsonValue(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

// Pure validation of deterministic local reports, not a trust/security boundary.
// Missing, duplicated, malformed or failed cases cannot shrink the expected suite.
export function assessReports(reports) {
  const validation = {};
  for (const [name, contract] of Object.entries(runnerContracts)) {
    const problems = [], report = reports?.[name];
    const expected = new Set(contract.ids.flatMap(id => contract.variants.map(variant => key(id, variant))));
    const seen = new Set();
    if (!report || report.suite !== contract.suite) problems.push('suite-identity');
    if (!hash(report?.fixtureSha256)) problems.push('fixture-hash');
    if (report?.[contract.gate] !== true) problems.push('runner-gate');
    if (!Array.isArray(report?.cases)) {
      problems.push('missing-cases');
    } else {
      for (const item of report.cases) {
        if (!item || typeof item !== 'object') { problems.push('invalid-case'); continue; }
        const identity = key(item.id, item.variant);
        if (!expected.has(identity)) problems.push(`unexpected-case:${identity}`);
        if (seen.has(identity)) problems.push(`duplicate-case:${identity}`);
        seen.add(identity);
        if (Object.hasOwn(item, 'executionError') || Object.hasOwn(item, 'skipped')) problems.push(`incomplete-case:${identity}`);
        if (name === 'extraction') {
          if (!Array.isArray(item.errors) || item.errors.length || !Number.isSafeInteger(item.required)
            || item.required !== factCounts.get(item.id) || item.recovered !== item.required) problems.push(`fact-coverage:${identity}`);
        } else {
          if (item.passed !== true || !Array.isArray(item.checks)) { problems.push(`case-gate:${identity}`); continue; }
          const minimum = (contract.minimumChecks[item.id] ?? Infinity) + (item.variant === 'after' ? 2 : 0);
          if (item.checks.length < minimum) problems.push(`check-denominator:${identity}`);
          const checkIds = new Set();
          for (const check of item.checks) {
            if (!check || typeof check.factId !== 'string' || !check.factId || checkIds.has(check.factId)
              || check.passed !== true || !Object.hasOwn(check, 'actual') || !Object.hasOwn(check, 'expected')
              || !jsonValue(check.actual) || !jsonValue(check.expected)
              || !isDeepStrictEqual(check.actual, check.expected)) problems.push(`invalid-or-failed-check:${identity}`);
            if (check?.factId) checkIds.add(check.factId);
          }
          for (const id of ['sandbox-cleaned', ...(contract.requiredChecks?.[item.id] ?? [])]) {
            if (!checkIds.has(id)) problems.push(`missing-check:${identity}:${id}`);
          }
          if (!item.checks.some(check => check?.factId === 'sandbox-cleaned' && check.actual === true && check.expected === true)) {
            problems.push(`sandbox-not-cleaned:${identity}`);
          }
        }
      }
      for (const identity of expected) if (!seen.has(identity)) problems.push(`missing-case:${identity}`);
      if (name === 'extraction') {
        const recovered = report.cases.reduce((sum, item) => sum + (Number.isSafeInteger(item?.recovered) ? item.recovered : NaN), 0);
        const required = report.cases.reduce((sum, item) => sum + (Number.isSafeInteger(item?.required) ? item.required : NaN), 0);
        if (report.recovered !== recovered || report.required !== required) problems.push('aggregate-denominator');
      }
    }
    validation[name] = { passed: problems.length === 0, expectedCases: expected.size, observedCases: report?.cases?.length ?? null, problems };
  }
  if (reports && Object.keys(reports).some(name => !Object.hasOwn(runnerContracts, name))) {
    validation.unexpectedRunner = { passed: false, problems: ['unexpected-runner'] };
  }
  const coverage = matrix.map(row => {
    const missing = row.refs.filter(ref => !validation[ref.runner]?.passed).map(ref => `${ref.runner}:${ref.id}`);
    return { ...row, status: missing.length ? 'blocked' : row.remaining.length ? 'partial' : 'covered-in-fixed-fixtures', missing };
  });
  const offlineChecksPassed = Object.values(validation).every(item => item.passed);
  const plannedCoverageComplete = coverage.every(row => row.status === 'covered-in-fixed-fixtures')
    && remainingRequirements.every(item => item.status === 'passed');
  return { offlineChecksPassed, plannedCoverageComplete, m4AcceptancePassed: false,
    acceptanceStatus: 'incomplete', qualityVerdict: 'unassessed', validation, coverage,
    remainingRequirements, modelUsage: 'not-applicable' };
}

export function planReport() {
  return { suite: matrixVersion, action: 'plan-only', matrix, remainingRequirements,
    sideEffects: 'none; no sandboxes, models or calculations', m4AcceptancePassed: false };
}

// Runs sequentially: new disposable sandboxes only; reports go to stdout, not disk.
export async function runSuite() {
  const reports = {};
  for (const [name, run] of [['extraction', runEvaluation], ['integration', runIntegration], ['offline', runOfflineEvaluation]]) {
    try { reports[name] = await run(); }
    catch { reports[name] = { executionError: 'runner-error' }; }
  }
  const sources = ['./m4-suite.mjs', './m4-matrix.mjs', './m4-extraction.mjs', './m4-fixtures.mjs', './m4-integration.mjs',
    './m4-integration-fixtures.mjs', './m4-offline.mjs', '../src/core.mjs', '../src/learning.mjs', '../src/v2-domain.mjs',
    '../src/v2-store.mjs', '../src/v2-working.mjs', '../src/v2-candidates.mjs', '../src/v2-extraction.mjs'];
  return { suite: matrixVersion, node: process.version, ...assessReports(reports),
    matrixSha256: digest(JSON.stringify({ matrixVersion, matrix, runnerContracts, remainingRequirements })),
    sourceSha256: Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(new URL(file, import.meta.url)))])), reports,
    exitPolicy: 'Default exit 0 means executed offline checks passed, NOT M4 acceptance. --require-complete also requires planned coverage.' };
}

export function exitCode(report, requireComplete = false) {
  return report.offlineChecksPassed === true && (!requireComplete || report.plannedCoverageComplete === true) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--plan', '--require-complete'].includes(args[0]))) {
    console.error('Usage: node eval/m4-suite.mjs [--plan|--require-complete]');
    process.exitCode = 2;
  } else if (args[0] === '--plan') {
    console.log(JSON.stringify(planReport(), null, 2));
  } else {
    const report = await runSuite();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode(report, args[0] === '--require-complete');
  }
}
