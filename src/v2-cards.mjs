import { assertSafe } from './core.mjs';
import { LIMITS, UUID, enumValue, object, requireValue, text, uuid } from './v2-domain.mjs';

// Structural kernel. Entry normalization preserves this canonical shape;
// publication conditions and reference/conflict guards live in the store seam.
export const CARD_LIMITS = Object.freeze({ textChars: 2000, quoteChars: 500, sources: 4,
  listItems: 20, limitations: 10, qualifiers: 16 });

const FIELDS = Object.freeze({
  systems: { composition: 'text', structure: 'text', charge: 'number', spin: 'spin',
    multiplicity: 'positive-integer', periodicity: 'periodicity' },
  methods: { model: 'text', basis: 'text', pseudopotential: 'text', dispersion: 'text',
    solvent: 'text', software: 'text', version: 'text', applicability: 'text' },
  runs: { task: 'text', system: 'reference', method: 'reference', convergenceCriteria: 'text',
    validityScope: 'text', outputAbsence: 'text' },
  results: { propertyKey: 'text', qualifiers: 'qualifiers', run: 'reference' },
  diagnostics: { originalError: 'text', phase: 'text', originRun: 'reference', hypotheses: 'text-list',
    confirmedCauses: 'text-list', parameterChanges: 'changes', rerun: 'rerun' },
});

function supportPaths(kind) {
  return kind === 'runs' ? ['execution', 'termination', 'convergence', 'validity', 'software', 'version', 'input', 'output'].map(key => `run.${key}`)
    : kind === 'results' ? ['property', 'value', 'unit', 'definition'].map(key => `result.${key}`) : [];
}
function plain(value, keys, label) {
  object(value, keys, label);
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null, 'invalid-schema', `${label} must be a plain object`);
}
function list(value, max, label, normalize, min = 0) {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max, 'invalid-schema', `Invalid ${label}`);
  // Sparse JS arrays are not JSON arrays with omitted fields.
  requireValue(Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean), 'invalid-schema', `Sparse ${label}`);
  return value.map(normalize);
}
function finite(value, label) {
  requireValue(typeof value === 'number' && Number.isFinite(value), 'invalid-schema', `${label} must be finite`);
  return value;
}
function integer(value, label, min) {
  requireValue(Number.isSafeInteger(value) && value >= min, 'invalid-schema', `Invalid ${label}`);
  return value;
}
function sources(value, evidence, label) {
  return list(value, CARD_LIMITS.sources, `${label}.sources`, source => {
    plain(source, ['locator', 'quote', 'source'], 'card source');
    const locator = text(source.locator, 500, 'source.locator');
    requireValue(evidence.includes(locator), 'invalid-schema', 'Card source locator must be present in entry evidence');
    // Validate without trimming: a quote is an exact, attributed fragment.
    text(source.quote, CARD_LIMITS.quoteChars, 'source.quote', true);
    return { locator, quote: source.quote,
      source: enumValue(source.source, ['user-statement', 'tool-observation', 'assistant-claim'], 'source.source') };
  }, 1);
}
function field(value, type, evidence, label) {
  plain(value, ['state', 'value', 'reason', 'sources'], label);
  const state = enumValue(value.state, ['known', 'unknown', 'not-applicable'], `${label}.state`);
  if (state === 'known') {
    requireValue(!Object.hasOwn(value, 'reason'), 'invalid-schema', 'Known fields cannot contain an unknown reason');
    return { state, value: typed(value.value, type, evidence, label), sources: sources(value.sources, evidence, label) };
  }
  requireValue(!Object.hasOwn(value, 'value'), 'invalid-schema', 'Unknown or inapplicable fields cannot contain values');
  const result = { state, reason: text(value.reason, 1000, `${label}.reason`, true) };
  if (state === 'not-applicable') result.sources = sources(value.sources, evidence, label);
  else requireValue(!Object.hasOwn(value, 'sources'), 'invalid-schema', 'Unknown fields record a reason, not a sourced value');
  return result;
}
function spin(value) {
  plain(value, ['quantity', 'value', 'unit'], 'spin');
  const quantity = enumValue(value.quantity, ['total-spin', 'unpaired-electrons', 'magnetic-moment'], 'spin.quantity');
  const number = finite(value.value, 'spin.value');
  if (quantity === 'unpaired-electrons') integer(number, 'unpaired-electrons', 0);
  if (quantity === 'total-spin') requireValue(number >= 0, 'invalid-schema', 'Total spin cannot be negative');
  const result = { quantity, value: number };
  if (quantity === 'magnetic-moment') result.unit = text(value.unit, 80, 'spin.unit');
  else requireValue(!Object.hasOwn(value, 'unit'), 'invalid-schema', 'This spin quantity has no unit field');
  return result;
}
function qualifiers(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-schema', 'Invalid qualifiers');
  const keys = Object.keys(value).sort();
  requireValue(keys.length <= CARD_LIMITS.qualifiers, 'invalid-schema', 'Too many qualifiers');
  plain(value, keys, 'qualifiers');
  const result = {};
  for (const key of keys) {
    requireValue(!['__proto__', 'prototype', 'constructor'].includes(key)
      && text(key, 80, 'qualifier key') === key, 'invalid-schema', 'Invalid qualifier key');
    result[key] = text(value[key], 200, 'qualifier value');
  }
  return result;
}
function parameterValue(value) {
  plain(value, ['value', 'unit'], 'parameter value');
  const unit = text(value.unit, 80, 'parameter unit');
  let normalized;
  if (typeof value.value === 'number') normalized = finite(value.value, 'parameter value');
  else if (typeof value.value === 'boolean') normalized = value.value;
  else normalized = text(value.value, 500, 'parameter value');
  return { value: normalized, unit };
}
function changes(value, evidence) {
  return list(value, CARD_LIMITS.listItems, 'parameterChanges', change => {
    plain(change, ['parameter', 'before', 'after', 'status'], 'parameter change');
    return { parameter: text(change.parameter, 200, 'parameter'),
      before: field(change.before, 'parameter', evidence, 'before'),
      after: field(change.after, 'parameter', evidence, 'after'),
      status: enumValue(change.status, ['proposed', 'adopted', 'applied'], 'parameter change status') };
  });
}
function reference(value) {
  plain(value, ['id', 'revision'], 'card reference');
  return { id: uuid(value.id), revision: integer(value.revision, 'card reference revision', 1) };
}
function rerun(value) {
  plain(value, ['status', 'run'], 'rerun');
  const status = enumValue(value.status, ['not-rerun', 'planned', 'performed'], 'rerun.status');
  if (status !== 'performed') {
    requireValue(!Object.hasOwn(value, 'run'), 'invalid-schema', 'An unperformed rerun cannot identify an execution');
    return { status };
  }
  return { status, run: reference(value.run) };
}
function typed(value, type, evidence, label) {
  switch (type) {
    case 'text': return text(value, CARD_LIMITS.textChars, label, true);
    case 'number': return finite(value, label);
    case 'positive-integer': return integer(value, label, 1);
    case 'spin': return spin(value);
    case 'periodicity': {
      const result = list(value, 3, label, item => {
        requireValue(typeof item === 'boolean', 'invalid-schema', 'Periodicity requires booleans');
        return item;
      }, 3);
      return result;
    }
    case 'qualifiers': return qualifiers(value);
    case 'text-list': return list(value, CARD_LIMITS.listItems, label, item => text(item, CARD_LIMITS.textChars, label, true));
    case 'parameter': return parameterValue(value);
    case 'changes': return changes(value, evidence);
    case 'rerun': return rerun(value);
    case 'reference': return reference(value);
    default: requireValue(false, 'invalid-schema', 'Unsupported card value type');
  }
}

// Structural validation only: no file reads, evidence verification, scientific
// certification, reference resolution, publication or inference of missing data.
export function normalizeCard(input, options) {
  plain(options, ['kind', 'evidence'], 'card options');
  const kind = enumValue(options.kind, Object.keys(FIELDS), 'card kind');
  const evidence = list(options.evidence, 10, 'card evidence', item => text(item, 500, 'evidence'));
  plain(input, ['version', 'fields', 'limitations', 'support'], 'card');
  requireValue(input.version === 1, 'invalid-schema', 'Unsupported card version');
  const schema = FIELDS[kind];
  plain(input.fields, Object.keys(schema), 'card fields');
  const fields = {};
  for (const key of Object.keys(input.fields).sort()) fields[key] = field(input.fields[key], schema[key], evidence, key);
  const limitations = list(input.limitations, CARD_LIMITS.limitations, 'card limitations', item => text(item, 1000, 'limitation', true));
  const result = { version: 1, fields, limitations };
  if (input.support !== undefined) {
    const allowed = supportPaths(kind);
    plain(input.support, allowed, 'card support');
    result.support = {};
    for (const key of Object.keys(input.support).sort()) result.support[key] = sources(input.support[key], evidence, key);
  }
  const encoded = JSON.stringify(result);
  requireValue(Buffer.byteLength(encoded) <= LIMITS.recordBytes, 'invalid-schema', 'Card exceeds record byte limit');
  assertSafe(encoded);
  return result;
}

// Build the tool's structural schema from the same field/type table. The store
// remains authoritative for evidence membership, cross-field conditions and pins.
export function createCardSchema(Type) {
  const string = maxLength => Type.String({ minLength: 1, maxLength });
  const choice = values => Type.Union(values.map(value => Type.Literal(value)));
  const object = properties => Type.Object(properties, { additionalProperties: false });
  const array = (items, maxItems, minItems = 0) => Type.Array(items, { minItems, maxItems });
  const reference = () => object({ id: Type.String({ pattern: UUID.source }),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) });
  const source = object({ locator: string(500), quote: string(CARD_LIMITS.quoteChars),
    source: choice(['user-statement', 'tool-observation', 'assistant-claim']) });
  const sources = () => array(source, CARD_LIMITS.sources, 1);
  const field = type => Type.Union([
    object({ state: Type.Literal('known'), value: typed(type), sources: sources() }),
    object({ state: Type.Literal('unknown'), reason: string(1000) }),
    object({ state: Type.Literal('not-applicable'), reason: string(1000), sources: sources() }),
  ]);
  const typed = type => {
    switch (type) {
      case 'text': return string(CARD_LIMITS.textChars);
      case 'number': return Type.Number();
      case 'positive-integer': return Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
      case 'reference': return reference();
      case 'periodicity': return array(Type.Boolean(), 3, 3);
      case 'text-list': return array(string(CARD_LIMITS.textChars), CARD_LIMITS.listItems);
      case 'qualifiers': return Type.Object({}, { maxProperties: CARD_LIMITS.qualifiers,
        propertyNames: { type: 'string', minLength: 1, maxLength: 80, not: { enum: ['__proto__', 'prototype', 'constructor'] } },
        additionalProperties: { type: 'string', minLength: 1, maxLength: 200 } });
      case 'spin': return Type.Union([
        object({ quantity: Type.Literal('total-spin'), value: Type.Number({ minimum: 0 }) }),
        object({ quantity: Type.Literal('unpaired-electrons'), value: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }),
        object({ quantity: Type.Literal('magnetic-moment'), value: Type.Number(), unit: string(80) }),
      ]);
      case 'parameter': return object({ value: Type.Union([Type.Number(), Type.Boolean(), string(500)]), unit: string(80) });
      case 'changes': return array(object({ parameter: string(200), before: field('parameter'), after: field('parameter'),
        status: choice(['proposed', 'adopted', 'applied']) }), CARD_LIMITS.listItems);
      case 'rerun': return Type.Union([object({ status: choice(['not-rerun', 'planned']) }),
        object({ status: Type.Literal('performed'), run: reference() })]);
      default: requireValue(false, 'invalid-schema', 'Unsupported card schema type');
    }
  };
  return Type.Union(Object.entries(FIELDS).map(([kind, fields]) => object({
    version: Type.Literal(1),
    fields: object(Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, key === 'outputAbsence' ? Type.Optional(field(type)) : field(type)]))),
    limitations: array(string(1000), CARD_LIMITS.limitations, kind === 'results' ? 1 : 0),
    support: Type.Optional(object(Object.fromEntries(supportPaths(kind).map(key => [key, Type.Optional(sources())])))),
  })));
}
