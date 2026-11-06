import { createHash } from 'node:crypto';
import { accessV2 } from './v2-store.mjs';
import { LIMITS, MemoryError, enumValue, normalizeEntry, object, requireValue, uuid, validateReferences } from './v2-domain.mjs';

const DIRECTORY = '.internal/candidates';
export const CANDIDATE_LIMITS = Object.freeze({ files: 10000, bytes: 50 * 1024 * 1024, fileBytes: LIMITS.recordBytes });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const filename = (id, type) => `${DIRECTORY}/${id}.${type}.json`;

function proposal(value) {
  object(value, ['requestId', 'entry', 'target'], 'candidate request');
  const requestId = uuid(value.requestId);
  const entry = normalizeEntry(value.entry);
  requireValue(['model-extraction', 'assistant-claim'].includes(entry.provenance)
    && ['reported', 'unresolved'].includes(entry.verification), 'invalid-grounding', 'Candidates cannot certify their own provenance or verification');
  requireValue(!entry.card && !entry.result && (!entry.run || entry.run.validity === 'unchecked'), 'invalid-grounding', 'Cards, structured results and run validity require an explicit grounding contract');
  requireValue(entry.lifecycle === 'current', 'invalid-schema');
  const result = { requestId, entry };
  if (value.target !== undefined) {
    object(value.target, ['id', 'expectedRevision'], 'candidate target');
    requireValue(Number.isSafeInteger(value.target.expectedRevision) && value.target.expectedRevision >= 1, 'invalid-schema');
    result.target = { id: uuid(value.target.id), expectedRevision: value.target.expectedRevision };
  }
  return result;
}
function load(io) {
  const names = io.list(DIRECTORY);
  requireValue(names.length <= CANDIDATE_LIMITS.files, 'inventory-bounded');
  const candidates = new Map(), decisions = new Map(); let bytes = 0;
  for (const name of names) {
    if (name.startsWith('.pi-memory-') && name.endsWith('.tmp')) continue;
    const match = name.match(/^([a-f0-9-]{36})\.(candidate|decision)\.json$/);
    requireValue(!!match, 'invalid-record'); uuid(match[1]);
    const raw = io.read(`${DIRECTORY}/${name}`, CANDIDATE_LIMITS.fileBytes);
    bytes += Buffer.byteLength(raw); requireValue(bytes <= CANDIDATE_LIMITS.bytes, 'inventory-bounded');
    let event;
    try { event = JSON.parse(raw); } catch { throw new MemoryError('invalid-record'); }
    object(event, ['schemaVersion', 'projectId', 'payload', 'digest'], 'candidate event');
    requireValue(event.schemaVersion === 2 && event.projectId === io.project.id && event.digest === hash(event.payload) && encode(event) === raw, 'invalid-record');
    const payload = event.payload;
    if (match[2] === 'candidate') {
      requireValue(JSON.stringify(proposal(payload)) === JSON.stringify(payload) && payload.requestId === match[1], 'invalid-record');
      candidates.set(match[1], event);
    } else {
      object(payload, ['requestId', 'candidateDigest', 'decision', 'reviewer'], 'candidate decision');
      if (payload.reviewer !== undefined) enumValue(payload.reviewer, ['user', 'auto'], 'reviewer');
      requireValue(payload.requestId === match[1], 'invalid-record');
      enumValue(payload.decision, ['approve', 'reject'], 'decision');
      decisions.set(match[1], event);
    }
  }
  for (const [id, event] of decisions) requireValue(candidates.get(id)?.digest === event.payload.candidateDigest, 'invalid-record');
  return { candidates, decisions, bytes, files: names.length };
}
function publish(io, state, id, type, payload) {
  const event = { schemaVersion: 2, projectId: io.project.id, payload, digest: hash(payload) };
  const raw = encode(event), bytes = Buffer.byteLength(raw);
  requireValue(bytes <= CANDIDATE_LIMITS.fileBytes && state.files + 1 <= CANDIDATE_LIMITS.files
    && state.bytes + bytes <= CANDIDATE_LIMITS.bytes, 'inventory-bounded');
  io.publish(filename(id, type), raw);
  return event;
}
function validateTarget(io, candidate) {
  const latest = new Map(io.knowledge().map(record => [record.id, record]));
  const previous = candidate.target && latest.get(candidate.target.id);
  if (candidate.target) {
    requireValue(previous?.revision === candidate.target.expectedRevision, 'revision-conflict');
    requireValue(previous.entry.kind === candidate.entry.kind, 'invalid-schema');
    requireValue(!previous.entry.card, 'invalid-grounding', 'Candidates cannot replace structured cards');
  }
  validateReferences(candidate.entry, latest, candidate.target?.id);
}

// Explicit staging by default. Extraction adapters can additionally require a
// lifecycle guard; it never replaces the store's own scope checks.
export function proposeCandidateV2(project, value, options = {}) {
  object(options, ['beforePublish'], 'candidate staging options');
  const { beforePublish } = options;
  requireValue(beforePublish === undefined || typeof beforePublish === 'function', 'invalid-schema');
  const candidate = proposal(value);
  return accessV2(project, true, io => {
    beforePublish?.();
    const state = load(io), existing = state.candidates.get(candidate.requestId);
    if (existing) {
      requireValue(existing.digest === hash(candidate), 'request-conflict');
      const decision = state.decisions.get(candidate.requestId)?.payload.decision;
      return { candidate: existing.payload, duplicate: true, status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'pending' };
    }
    requireValue(!io.publications().some(record => record.requestId === candidate.requestId), 'request-conflict');
    validateTarget(io, candidate);
    beforePublish?.();
    publish(io, state, candidate.requestId, 'candidate', candidate);
    return { candidate, duplicate: false, status: 'pending' };
  });
}
export function listCandidatesV2(project) {
  return accessV2(project, false, io => {
    const state = load(io), records = new Map(io.publications().filter(record => record.requestId).map(record => [record.requestId, record]));
    return { candidates: [...state.candidates.values()].map(event => {
      const candidate = event.payload, decision = state.decisions.get(candidate.requestId)?.payload.decision;
      const record = decision === 'approve' ? records.get(candidate.requestId) : undefined;
      return { candidate, status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'pending',
        ...(decision ? { reviewer: state.decisions.get(candidate.requestId).payload.reviewer ?? 'user' } : {}),
        ...(decision === 'approve' ? { publication: record ? 'committed' : 'pending', ...(record ? { id: record.id, revision: record.revision } : {}) } : {}) };
    }) };
  });
}
export function reviewCandidateV2(project, id, decision, options = {}) {
  object(options, ['beforePublish', 'reviewer'], 'review options');
  const { beforePublish, reviewer = 'user' } = options;
  requireValue(beforePublish === undefined || typeof beforePublish === 'function', 'invalid-schema');
  enumValue(reviewer, ['user', 'auto'], 'reviewer');
  uuid(id); enumValue(decision, ['approve', 'reject'], 'decision');
  return accessV2(project, true, io => {
    beforePublish?.();
    const state = load(io), event = state.candidates.get(id);
    requireValue(!!event, 'not-found');
    const previous = state.decisions.get(id);
    if (previous) requireValue(previous.payload.decision === decision, 'review-conflict', 'A recorded review decision cannot be reversed');
    if (!previous) {
      if (decision === 'approve') {
        requireValue(!io.publications().some(record => record.requestId === id), 'request-conflict');
        validateTarget(io, event.payload);
      }
      beforePublish?.();
      publish(io, state, id, 'decision', { requestId: id, candidateDigest: event.digest, decision, reviewer });
    }
    if (decision === 'reject') return { status: 'rejected', duplicate: !!previous };
    // The immutable decision is the commit intent. A crash before/after record
    // publication is recoverable by the same requestId, under the shared lock.
    const candidate = event.payload;
    try {
      beforePublish?.();
      const publication = io.publishKnowledge(candidate.entry, { ...candidate.target, requestId: id }, beforePublish);
      return { status: 'approved', publication, duplicate: !!previous };
    } catch (error) {
      return { status: 'approved', publication: { status: 'pending', reason: error instanceof MemoryError ? error.code : 'publication-io-error' }, duplicate: !!previous };
    }
  });
}
