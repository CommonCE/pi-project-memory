import { assertSafe } from './core.mjs';
import { normalizeCard } from './v2-cards.mjs';

export const SCHEMA_VERSION = 2;
export const KINDS = Object.freeze(['systems', 'methods', 'runs', 'results', 'diagnostics', 'software', 'workflows', 'decisions']);
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const LIMITS = Object.freeze({ recordBytes: 250000, records: 10000, totalBytes: 50 * 1024 * 1024 });
export const EXTRACTION_LIMITS = Object.freeze({ inputChars: 48000, toolChars: 8000, outputChars: 48000,
  outputTokens: 6000, timeoutMs: 60000, candidates: 8, messages: 2000, sourceChars: 250000 });

export function validateExtractionSettings(value) {
  object(value, ['maxChars', 'toolChars', 'outputTokens', 'timeoutMs', 'maxCandidates'], 'extraction settings');
  const bounds = { maxChars: [2048, EXTRACTION_LIMITS.inputChars], toolChars: [80, EXTRACTION_LIMITS.toolChars],
    outputTokens: [1, EXTRACTION_LIMITS.outputTokens], timeoutMs: [1, EXTRACTION_LIMITS.timeoutMs], maxCandidates: [1, EXTRACTION_LIMITS.candidates] };
  for (const [key, setting] of Object.entries(value)) {
    const [min, max] = bounds[key];
    requireValue(Number.isSafeInteger(setting) && setting >= min && setting <= max, 'invalid-schema', `Invalid extraction ${key}`);
  }
  return { ...value };
}

export class MemoryError extends Error {
  constructor(code, message = code) { super(message); this.name = 'MemoryError'; this.code = code; }
}
export function requireValue(condition, code, message) {
  if (!condition) throw new MemoryError(code, message);
}
export function object(value, keys, label) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-schema', `${label} must be an object`);
  requireValue(Object.keys(value).every(key => keys.includes(key)), 'invalid-schema', `Unknown ${label} field`);
}
export function text(value, max, label, multiline = false) {
  requireValue(typeof value === 'string' && value.isWellFormed() && value.trim().length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
    && (multiline || !/[\r\n]/.test(value)), 'invalid-schema', `Invalid ${label}`);
  return value.trim();
}
// Preserve both ends and make omissions visible. Budgets use UTF-16 code units.
// Unlike evidence filtering, this only formats already validated reference text.
export function boundedExcerpt(value, maxChars) {
  requireValue(typeof value === 'string' && value.isWellFormed() && Number.isSafeInteger(maxChars) && maxChars >= 0, 'invalid-schema');
  if (value.length <= maxChars) return value;
  const marker = '\n[... bounded excerpt ...]\n';
  if (maxChars < marker.length) return '';
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2), tail = Math.floor(available / 2);
  const start = value.slice(0, head).replace(/[\uD800-\uDBFF]$/, '');
  const end = tail ? value.slice(-tail).replace(/^[\uDC00-\uDFFF]/, '') : '';
  return start + marker + end;
}
export function enumValue(value, options, label) {
  requireValue(options.includes(value), 'invalid-schema', `Invalid ${label}`);
  return value;
}
export function uuid(value) {
  requireValue(typeof value === 'string' && UUID.test(value), 'invalid-schema', 'Expected a UUID v4');
  return value;
}
function stringList(value, maxItems, itemChars, label) {
  requireValue(Array.isArray(value) && value.length <= maxItems, 'invalid-schema', `Invalid ${label}`);
  return [...new Set(value.map(item => text(item, itemChars, label)))].sort();
}

// Scope paths preserve filesystem spelling; no Unicode or whitespace normalization.
export function normalizeScope(value) {
  if (value === undefined) return { path: '.', inherit: true };
  object(value, ['path', 'inherit'], 'scope');
  requireValue(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'invalid-schema', 'scope must be a plain object');
  const { path, inherit = true } = value;
  requireValue(typeof path === 'string' && path.isWellFormed() && path.length >= 1 && path.length <= 400
    && !/[\\\\\x00-\x1f\x7f-\x9f]/.test(path) && !/^(?:\/|[A-Za-z]:)/.test(path), 'invalid-schema', 'Invalid scope path');
  const parts = path.split('/');
  requireValue(path === '.' || (parts.length <= 32 && parts.every(part => part && part !== '.' && part !== '..' && part.trim() === part)), 'invalid-schema', 'Invalid scope segments');
  requireValue(typeof inherit === 'boolean', 'invalid-schema', 'scope.inherit must be boolean');
  return { path, inherit };
}

// No free-form JSON payloads: validate public fields before they enter records or views.
export function normalizeEntry(input) {
  object(input, ['kind', 'title', 'content', 'tags', 'verification', 'provenance', 'lifecycle', 'evidence', 'entities', 'sourceTurn', 'run', 'result', 'scope', 'card'], 'entry');
  requireValue(Object.values(input).every(value => value !== null), 'invalid-schema', 'Null entry fields are not omitted values');
  const kind = enumValue(input.kind, KINDS, 'kind');
  const result = {
    kind, title: text(input.title, 200, 'title'), content: text(input.content, 100000, 'content', true),
    tags: stringList(input.tags ?? [], 20, 80, 'tags'),
    verification: enumValue(input.verification ?? 'reported', ['reported', 'evidence-backed', 'user-confirmed', 'unresolved'], 'verification'),
    provenance: enumValue(input.provenance ?? 'assistant-claim', ['user-confirmation', 'tool-observation', 'assistant-claim', 'model-extraction'], 'provenance'),
    lifecycle: enumValue(input.lifecycle ?? 'current', ['current', 'superseded', 'archived'], 'lifecycle'),
    evidence: stringList(input.evidence ?? [], 10, 500, 'evidence'),
    entities: [],
  };
  requireValue(Array.isArray(input.entities ?? []) && (input.entities ?? []).length <= 20, 'invalid-schema', 'Invalid entities');
  result.entities = (input.entities ?? []).map(ref => {
    object(ref, ['type', 'id'], 'entity reference');
    return { type: enumValue(ref.type, ['system', 'method', 'run', 'component'], 'entity type'), id: uuid(ref.id) };
  }).sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  requireValue(new Set(result.entities.map(ref => `${ref.type}:${ref.id}`)).size === result.entities.length, 'invalid-schema', 'Duplicate entity reference');
  if (input.sourceTurn !== undefined) result.sourceTurn = text(input.sourceTurn, 200, 'sourceTurn');
  if (result.verification === 'evidence-backed') requireValue(result.evidence.length > 0, 'invalid-schema', 'Evidence-backed entries require evidence locators');
  if (result.verification === 'user-confirmed') requireValue(result.provenance === 'user-confirmation' && result.evidence.length > 0, 'invalid-schema', 'User-confirmed entries require confirmation provenance and evidence');
  if (input.run !== undefined || kind === 'runs') {
    requireValue(kind === 'runs', 'invalid-schema', 'run fields are only valid for runs');
    const run = input.run ?? {};
    object(run, ['execution', 'termination', 'convergence', 'validity', 'software', 'version', 'input', 'output'], 'run');
    requireValue(Object.values(run).every(value => value !== null), 'invalid-schema', 'Null run fields are not omitted values');
    result.run = {
      execution: enumValue(run.execution ?? 'unknown', ['unknown', 'prepared', 'submitted', 'running', 'terminated'], 'execution'),
      termination: enumValue(run.termination ?? 'unknown', ['unknown', 'normal', 'error', 'cancelled'], 'termination'),
      convergence: enumValue(run.convergence ?? 'unknown', ['unknown', 'converged', 'not-converged', 'not-applicable'], 'convergence'),
      validity: enumValue(run.validity ?? 'unchecked', ['unchecked', 'accepted-with-scope', 'rejected'], 'validity'),
    };
    for (const key of ['software', 'version', 'input', 'output']) if (run[key] !== undefined) result.run[key] = text(run[key], 500, `run.${key}`);
  }
  if (input.result !== undefined) {
    requireValue(kind === 'results', 'invalid-schema', 'result fields are only valid for results');
    const value = input.result;
    object(value, ['runId', 'property', 'value', 'unit', 'definition'], 'result');
    requireValue(typeof value.value === 'number' && Number.isFinite(value.value), 'invalid-schema', 'Result value must be finite');
    requireValue(result.evidence.length > 0, 'invalid-schema', 'Structured results require evidence locators');
    result.result = { runId: uuid(value.runId), property: text(value.property, 200, 'property'), value: value.value,
      unit: text(value.unit, 80, 'unit'), definition: text(value.definition, 1000, 'definition') };
  }
  // Omitted scope remains omitted in immutable legacy records and their digests.
  if (input.scope !== undefined) result.scope = normalizeScope(input.scope);
  if (input.card !== undefined) result.card = normalizeCard(input.card, { kind, evidence: result.evidence });
  assertSafe(JSON.stringify(result));
  return result;
}

export function validateReferences(entry, latest, ownId) {
  const kinds = { system: 'systems', method: 'methods', run: 'runs', component: 'software' };
  for (const ref of entry.entities) {
    requireValue(ref.id !== ownId && latest.get(ref.id)?.entry.kind === kinds[ref.type], 'invalid-reference', 'Entity reference is missing, self-referential or has a different kind');
  }
  if (entry.result) requireValue(latest.get(entry.result.runId)?.entry.kind === 'runs', 'invalid-reference', 'Result must reference an existing run');
}
