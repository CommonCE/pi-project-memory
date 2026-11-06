import { normalizeEntry, requireValue, text } from './v2-domain.mjs';
import { normalizeCard } from './v2-cards.mjs';

const REQUIRED = Object.freeze({
  systems: ['composition', 'structure', 'charge', 'spin', 'multiplicity', 'periodicity'],
  methods: ['model', 'basis', 'pseudopotential', 'dispersion', 'solvent', 'software', 'version', 'applicability'],
  runs: ['task', 'system', 'method', 'convergenceCriteria', 'validityScope'],
  results: ['propertyKey', 'qualifiers', 'run'],
  diagnostics: ['originalError', 'phase', 'originRun', 'hypotheses', 'confirmedCauses', 'parameterChanges', 'rerun'],
});
const isKnown = field => field?.state === 'known';
const requireKnown = (fields, key) => requireValue(isKnown(fields[key]), 'invalid-schema', `Card ${key} must be known`);

// Pure, entry-local publication conditions. This does not resolve references or
// certify quotes, execution, convergence, causality or scientific validity.
export function validateCardConditions(entry) {
  if (entry.card === undefined) return;
  const { card: input, ...base } = entry;
  const normalized = normalizeEntry(base);
  const card = normalizeCard(input, { kind: normalized.kind, evidence: normalized.evidence });
  const fields = card.fields;
  for (const key of REQUIRED[normalized.kind]) {
    requireValue(Object.hasOwn(fields, key), 'invalid-schema', `Card ${key} requires an explicit declaration`);
  }
  const support = card.support ?? {};
  for (const key of Object.keys(support)) {
    const [group, name] = key.split('.');
    requireValue(Object.hasOwn(normalized[group] ?? {}, name), 'invalid-schema', 'Support cannot refer to an absent authoritative field');
  }
  const supported = key => requireValue(support[key]?.length > 0, 'invalid-schema', `Card ${key} requires attributed support`);
  if (normalized.kind === 'runs') {
    const run = normalized.run;
    for (const key of ['execution', 'termination', 'convergence', 'validity']) {
      if (run[key] !== (key === 'validity' ? 'unchecked' : 'unknown')) supported(`run.${key}`);
    }
    for (const key of ['software', 'version', 'input', 'output']) if (run[key] !== undefined) supported(`run.${key}`);
    if (run.termination !== 'unknown') {
      requireValue(run.execution === 'terminated', 'invalid-schema', 'A termination observation requires a terminated execution');
    }
    if (['submitted', 'running', 'terminated'].includes(run.execution)) {
      requireValue(run.input !== undefined, 'invalid-schema', 'Executed or submitted run cards require input identity');
    }
    if (run.execution === 'terminated') {
      requireValue(run.output !== undefined || isKnown(fields.outputAbsence), 'invalid-schema', 'Terminated run cards require output or an explicit absence explanation');
    }
    requireValue(!(run.output !== undefined && isKnown(fields.outputAbsence)), 'invalid-schema', 'Output and output absence cannot both be asserted');
    if (run.validity === 'accepted-with-scope') requireKnown(fields, 'validityScope');
  }
  if (normalized.kind === 'results') {
    requireValue(normalized.result !== undefined, 'invalid-schema', 'Result cards require the authoritative structured result');
    for (const key of REQUIRED.results) requireKnown(fields, key);
    const key = fields.propertyKey.value;
    requireValue(text(key, 200, 'propertyKey') === key, 'invalid-schema', 'Invalid propertyKey');
    requireValue(fields.run.value.id === normalized.result.runId, 'invalid-schema', 'Pinned run must match result.runId');
    for (const key of ['property', 'value', 'unit', 'definition']) supported(`result.${key}`);
    requireValue(card.limitations.length > 0, 'invalid-schema', 'Result cards require explicit limitations');
  }
  if (normalized.kind === 'diagnostics' && isKnown(fields.rerun) && fields.rerun.value.status === 'performed') {
    requireKnown(fields, 'originRun');
    requireValue(fields.originRun.value.id !== fields.rerun.value.run.id, 'invalid-schema', 'A rerun must identify a distinct execution');
  }
}

// Call under the store lock for publication, and against the full inventory for
// reads. A latest-record lookup alone cannot resolve a fixed historical pin.
export function validateCardReferences(entry, byId, ownId) {
  if (!entry.card) return;
  const fields = entry.card.fields, pins = [];
  const add = (field, kind, entityType) => {
    if (isKnown(field)) pins.push({ pin: field.value, kind, entityType });
  };
  if (entry.kind === 'runs') {
    add(fields.system, 'systems', 'system'); add(fields.method, 'methods', 'method');
  }
  if (entry.kind === 'results') add(fields.run, 'runs');
  if (entry.kind === 'diagnostics') {
    add(fields.originRun, 'runs', 'run');
    if (isKnown(fields.rerun) && fields.rerun.value.status === 'performed') {
      pins.push({ pin: fields.rerun.value.run, kind: 'runs' });
    }
  }
  for (const { pin, kind, entityType } of pins) {
    const record = byId.get(pin.id)?.find(record => record.revision === pin.revision);
    requireValue(pin.id !== ownId && record?.entry.kind === kind, 'invalid-reference', 'Card pin is missing, self-referential or has a different kind');
    if (entityType) requireValue(entry.entities.some(ref => ref.type === entityType && ref.id === pin.id),
      'invalid-reference', 'Card pin must match a declared entity reference');
  }
}

function identity(entry) {
  if (!entry.card) return undefined;
  const fields = entry.card.fields;
  const qualifiers = fields.qualifiers.value;
  return { key: fields.propertyKey.value, qualifiers: JSON.stringify(Object.fromEntries(Object.keys(qualifiers).sort().map(key => [key, qualifiers[key]]))) };
}
export function validateCardRevision(entry, previous) {
  if (!previous?.card) return;
  requireValue(entry.card !== undefined, 'invalid-schema', 'A card cannot be implicitly removed by a revision');
  if (previous.kind === 'results') {
    const before = identity(previous), after = identity(entry);
    requireValue(entry.result?.runId === previous.result.runId && before.key === after.key && before.qualifiers === after.qualifiers,
      'invalid-schema', 'A result identity change requires a new record, not a revision');
  }
}

// This operates on all current records, never the folder-filtered search view.
// Historical legacy collisions remain readable; publication cannot add one.
export function validateResultConflict(entry, latest, ownId, previous) {
  if (!entry.result || entry.lifecycle !== 'current') return;
  if (!entry.card && !previous?.card && previous?.lifecycle === entry.lifecycle
    && JSON.stringify(previous.result) === JSON.stringify(entry.result)) return;
  const incoming = identity(entry);
  for (const record of latest.values()) {
    const other = record.entry;
    if (record.id === ownId || !other.result || other.lifecycle !== 'current' || other.result.runId !== entry.result.runId) continue;
    const existing = identity(other);
    let conflict;
    if (incoming && existing) {
      conflict = incoming.key === existing.key ? incoming.qualifiers === existing.qualifiers
        : entry.result.property === other.result.property;
    } else {
      conflict = entry.result.property === other.result.property
        || incoming?.key === other.result.property || existing?.key === entry.result.property;
    }
    requireValue(!conflict, 'result-conflict', 'A current same-run property already exists; inspect it and revise explicitly');
  }
}
