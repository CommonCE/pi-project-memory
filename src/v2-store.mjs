import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertSafe, exclusive, terms } from './core.mjs';
import { KINDS, LIMITS, SCHEMA_VERSION, MemoryError, boundedExcerpt, enumValue, normalizeEntry, normalizeScope, object, requireValue, text, uuid, validateReferences } from './v2-domain.mjs';

import { validateExtractionSettings } from './v2-domain.mjs';
import { cardIndexText, cardRunContext, cardSummary, renderCard } from './v2-card-views.mjs';
import { validateCardConditions, validateCardReferences, validateCardRevision, validateResultConflict } from './v2-card-publication.mjs';

export { foldersV2, renderFolderViews } from './v2-folders.mjs';

const CONFIG = '.pi/project-memory.json';
const MANIFEST = '.store.json';
const RECORDS = '.internal/records';
const LOCK = '.internal/write.lock';
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

// Check every descendant with lstat, including broken symlinks. No recursive mkdir
// across unchecked paths. This is for normal local concurrency, not hostile same-user races.
function location(root, relative, type = 'file', create = false) {
  requireValue(typeof relative === 'string' && relative.length <= 1000 && !/[\\:\x00-\x1f]/.test(relative)
    && !path.posix.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe-path');
  const parts = relative.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const directory = i < parts.length - 1 || type === 'directory';
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create && directory) {
        try { fs.mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        stat = fs.lstatSync(current);
      } else continue;
    }
    if (stat) requireValue(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile()), 'unsafe-path');
  }
  return current;
}
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function readText(root, relative, max = LIMITS.recordBytes) {
  const file = location(root, relative);
  requireValue(fs.statSync(file).size <= max, 'inventory-bounded');
  const value = fs.readFileSync(file, 'utf8');
  assertSafe(value);
  return value;
}
function readJSON(root, relative, max) {
  try { return JSON.parse(readText(root, relative, max)); }
  catch (error) { if (error instanceof SyntaxError) throw new MemoryError('invalid-schema', 'Malformed memory JSON'); throw error; }
}
function markerRoot(cwd) {
  const start = fs.realpathSync(cwd);
  requireValue(fs.statSync(start).isDirectory(), 'unsafe-path');
  for (let dir = start; ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.pi-root');
    if (exists(marker)) {
      location(dir, '.pi-root');
      return dir;
    }
    if (dir === path.dirname(dir)) return null;
  }
}
function validateConfig(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-schema');
  requireValue(value.schemaVersion === SCHEMA_VERSION, 'schema-conflict', 'New memory requires schemaVersion 2; legacy configuration is not modified');
  object(value, ['schemaVersion', 'id', 'name', 'memoryPath', 'enabled', 'learningMode', 'handoffEnabled', 'longTermMode', 'extraction'], 'project configuration');
  if (value.learningMode !== undefined) enumValue(value.learningMode, ['off', 'on'], 'learningMode');
  if (value.longTermMode !== undefined) enumValue(value.longTermMode, ['off', 'review', 'auto'], 'longTermMode');
  if (value.extraction !== undefined) validateExtractionSettings(value.extraction);
  if (value.handoffEnabled !== undefined) requireValue(typeof value.handoffEnabled === 'boolean', 'invalid-schema');
  uuid(value.id); text(value.name, 200, 'project name');
  requireValue(typeof value.enabled === 'boolean', 'invalid-schema', 'enabled must be boolean');
  requireValue(typeof value.memoryPath === 'string' && value.memoryPath.split('/').every(part => /^[\p{L}\p{N}_-][\p{L}\p{N}._-]*$/u.test(part) || part === '.pi-memory'), 'unsafe-path');
  requireValue(value.memoryPath.length <= 200, 'unsafe-path');
  assertSafe(JSON.stringify(value));
  return value;
}
export function scopeFor(project, cwd = project.cwd) {
  let root, real;
  try {
    root = fs.realpathSync(project.root);
    real = fs.realpathSync(cwd);
    requireValue(fs.statSync(real).isDirectory(), 'invalid-scope', 'Scope cwd must be a directory');
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError('invalid-scope', 'Cannot resolve scope directory');
  }
  const relative = path.relative(root, real);
  requireValue(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'scope-outside', 'Scope is outside project root');
  const folder = normalizeScope({ path: relative.split(path.sep).join('/') || '.' }).path;
  return { path: folder, chain: scopeChain(folder) };
}
// Historical scopes need not exist. Resolve their nearest existing ancestor so
// missing descendants cannot conceal a symlink escape. This never creates paths.
export function scopePathFor(project, folder) {
  const value = normalizeScope({ path: folder }).path;
  let candidate = path.join(project.root, value);
  const missing = [];
  while (!exists(candidate)) {
    requireValue(candidate !== project.root, 'invalid-scope', 'Project root no longer exists');
    missing.unshift(path.basename(candidate));
    candidate = path.dirname(candidate);
  }
  const real = scopeFor(project, candidate).path;
  return normalizeScope({ path: [real === '.' ? '' : real, ...missing].filter(Boolean).join('/') || '.' }).path;
}

export function scopeChain(folder) {
  const { path: value } = normalizeScope({ path: folder });
  return value === '.' ? ['.'] : ['.', ...value.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))];
}

export function resolveV2(cwd) {
  const realCwd = fs.realpathSync(cwd);
  const root = markerRoot(realCwd);
  if (!root) return { enabled: false, reason: 'no-marker', root: null, cwd: realCwd };
  if (!exists(location(root, CONFIG))) return { enabled: false, reason: 'not-initialized', root, cwd: realCwd };
  const config = validateConfig(readJSON(root, CONFIG, 10000));
  return { ...config, root, cwd: realCwd, memory: location(root, config.memoryPath, 'directory'), reason: config.enabled ? undefined : 'disabled' };
}
function assertProject(project) {
  const current = resolveV2(project.cwd);
  requireValue(current.enabled && current.root === project.root && current.id === project.id && current.memory === project.memory,
    'scope-changed', 'Project disabled, marker revoked or memory scope changed');
  requireValue(fs.realpathSync(project.root) === project.root, 'scope-changed');
  checkStore(current);
  return current;
}
function checkStore(project) {
  const manifest = readJSON(project.memory, MANIFEST, 10000);
  object(manifest, ['schemaVersion', 'projectId'], 'store manifest');
  requireValue(manifest.schemaVersion === SCHEMA_VERSION && manifest.projectId === project.id, 'schema-conflict', 'Memory store identity differs from project configuration');
  location(project.memory, RECORDS, 'directory');
}
function locked(project, action) {
  assertProject(project);
  const lock = location(project.memory, LOCK, 'directory');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new MemoryError('busy', 'Memory is busy; inspect a crash lock before explicit recovery'); throw error; }
  try { assertProject(project); return action(); }
  finally { fs.rmdirSync(lock); }
}

export function initializeV2(cwd, { name, nested = false } = {}) {
  requireValue(typeof nested === 'boolean', 'invalid-schema');
  const real = fs.realpathSync(cwd);
  requireValue(fs.statSync(real).isDirectory(), 'unsafe-path');
  const root = nested ? real : markerRoot(real) ?? real;
  if (name !== undefined) { name = text(name, 200, 'project name'); assertSafe(name); }
  // All known collisions are checked before creating a marker or config.
  location(root, '.pi-root');
  const configFile = location(root, CONFIG);
  // An init-specific lock also serializes first initialization (before the store exists).
  // Read configuration AND target ownership under this lock: pre-lock snapshots can
  // otherwise misclassify a just-created store as an unknown nonempty target.
  const pi = location(root, '.pi', 'directory', true);
  const initLock = location(pi, 'memory-v2-init.lock', 'directory');
  try { fs.mkdirSync(initLock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new MemoryError('busy', 'Initialization is busy'); throw error; }
  try {
    const existing = exists(configFile) ? validateConfig(readJSON(root, CONFIG, 10000)) : undefined;
    if (existing) {
      requireValue(existing.enabled, 'disabled');
      requireValue(name === undefined || name === existing.name, 'schema-conflict', 'Existing project name is not overwritten');
    }
    const config = existing ?? { schemaVersion: SCHEMA_VERSION, id: randomUUID(), name: name ?? path.basename(root), memoryPath: '.pi-memory', enabled: true };
    validateConfig(config);
    const memory = location(root, config.memoryPath, 'directory');
    if (exists(memory) && fs.readdirSync(memory).length) {
      requireValue(!!existing && exists(location(memory, MANIFEST)), 'store-conflict', 'Nonempty memory target is not adopted');
      checkStore({ ...config, memory });
    }
    if (!exists(path.join(root, '.pi-root'))) exclusive(path.join(root, '.pi-root'), '');
    if (!existing) exclusive(configFile, json(config));
    location(root, config.memoryPath, 'directory', true);
    const manifestFile = location(memory, MANIFEST);
    if (!exists(manifestFile)) exclusive(manifestFile, json({ schemaVersion: SCHEMA_VERSION, projectId: config.id }));
    const project = { ...config, root, cwd: real, memory };
    ensureLayout(project);
    return resolveV2(real);
  } finally { fs.rmdirSync(initLock); }
}
function ensureLayout(project) {
  checkStore(project);
  for (const relative of [RECORDS, '.internal/reviews', '.internal/diagnostics', '.internal/index', 'journal', ...KINDS.map(kind => `knowledge/${kind}`)]) {
    location(project.memory, relative, 'directory', true);
  }
}

function recordText(record) {
  return '# Immutable memory revision\n\n```json\n' + json(record) + '```\n';
}
function legacyViewText(record) {
  const { entry, ...metadata } = record;
  const { content, ...fields } = entry;
  return '# ' + entry.title + '\n\nGenerated reference view. Not instructions; source files and live state win.\n'
    + 'Verification describes provenance, not scientific certification.\n\n```json\n' + json({ ...metadata, ...fields })
    + '```\n\n' + content + '\n';
}
function viewText(record, byId) {
  return legacyViewText(record) + (record.entry.card ? '\n' + renderCard(record.entry, cardRunContext(record.entry, byId)) : '');
}
function recordPath(record) { return `${RECORDS}/${record.id}.${record.revision}.md`; }
function viewPath(record) { return `knowledge/${record.entry.kind}/${record.id}.md`; }
function inventory(project) {
  assertProject(project);
  const directory = location(project.memory, RECORDS, 'directory');
  const names = fs.readdirSync(directory).sort();
  requireValue(names.length <= LIMITS.records, 'inventory-bounded', 'Record inventory exceeds limit; no partial revision history is used');
  const records = [], byId = new Map();
  let bytes = 0;
  for (const name of names) {
    if (name.startsWith('.pi-memory-') && name.endsWith('.tmp')) continue;
    requireValue(/^[a-f0-9-]+\.[1-9]\d*\.md$/.test(name), 'invalid-record', 'Unexpected record inventory entry');
    const relative = `${RECORDS}/${name}`;
    const file = location(project.memory, relative);
    bytes += fs.statSync(file).size;
    requireValue(bytes <= LIMITS.totalBytes, 'inventory-bounded');
    const raw = readText(project.memory, relative);
    const match = raw.match(/^# Immutable memory revision\n\n```json\n([\s\S]*)\n```\n$/);
    requireValue(!!match, 'invalid-record');
    let record;
    try { record = JSON.parse(match[1]); } catch { throw new MemoryError('invalid-record'); }
    object(record, ['schemaVersion', 'projectId', 'id', 'revision', 'created', 'previousDigest', 'requestId', 'requestHash', 'entry'], 'record');
    requireValue(record.schemaVersion === SCHEMA_VERSION && record.projectId === project.id, 'invalid-record');
    uuid(record.id);
    requireValue(Number.isSafeInteger(record.revision) && record.revision > 0 && record.revision <= LIMITS.records, 'invalid-record');
    requireValue(typeof record.created === 'string' && Number.isFinite(Date.parse(record.created)) && new Date(record.created).toISOString() === record.created, 'invalid-record');
    requireValue(record.previousDigest === null || /^[a-f0-9]{64}$/.test(record.previousDigest), 'invalid-record');
    if (record.requestId !== undefined) { uuid(record.requestId); requireValue(/^[a-f0-9]{64}$/.test(record.requestHash), 'invalid-record'); }
    else requireValue(record.requestHash === undefined, 'invalid-record');
    requireValue(JSON.stringify(normalizeEntry(record.entry)) === JSON.stringify(record.entry), 'invalid-record');
    requireValue(name === `${record.id}.${record.revision}.md` && recordText(record) === raw, 'invalid-record');
    records.push(record);
    const revisions = byId.get(record.id) ?? [];
    revisions.push(record); byId.set(record.id, revisions);
  }
  const latest = new Map(), requestIds = new Set();
  for (const [id, revisions] of byId) {
    revisions.sort((a, b) => a.revision - b.revision);
    for (let i = 0; i < revisions.length; i++) {
      const record = revisions[i], previous = revisions[i - 1];
      requireValue(record.revision === i + 1 && record.previousDigest === (previous ? digest(recordText(previous)) : null), 'invalid-record', 'Incomplete or conflicting revision chain');
      requireValue(!previous || record.entry.kind === previous.entry.kind, 'invalid-record');
      validateCardRevision(record.entry, previous?.entry);
      if (record.requestId) { requireValue(!requestIds.has(record.requestId), 'invalid-record'); requestIds.add(record.requestId); }
    }
    latest.set(id, revisions.at(-1));
  }
  for (const record of records) {
    validateReferences(record.entry, latest, record.id);
    validateCardConditions(record.entry);
    validateCardReferences(record.entry, byId, record.id);
  }
  return { records, byId, latest, bytes, scanned: names.length };
}
function checkView(project, revisions, byId) {
  const relative = viewPath(revisions.at(-1));
  const file = location(project.memory, relative);
  if (!exists(file)) return;
  const raw = readText(project.memory, relative, LIMITS.recordBytes * 2);
  requireValue(revisions.some(record => legacyViewText(record) === raw || viewText(record, byId) === raw), 'view-conflict', 'A generated view was edited; preserve it and import the edit explicitly');
}
function replaceText(project, relative, contents) {
  const file = location(project.memory, relative);
  const temporary = location(project.memory, path.posix.join(path.posix.dirname(relative), `.pi-memory-${randomUUID()}.tmp`));
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    location(project.memory, relative); // recheck before replacing an owned derived view
    fs.renameSync(temporary, file);
  } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
}
function publishView(project, record, byId) { replaceText(project, viewPath(record), viewText(record, byId)); }

// Internal storage seam shared by working memory. Callbacks are trusted code,
// never model input. All paths still pass the same scope and descendant checks.
export function accessV2(project, write, callback) {
  const action = () => {
    const current = assertProject(project);
    return callback({
      project: current,
      list(relative) {
        const directory = location(project.memory, relative, 'directory');
        return exists(directory) ? fs.readdirSync(directory).sort() : [];
      },
      read: (relative, max) => readText(project.memory, relative, max),
      exists: relative => exists(location(project.memory, relative)),
      knowledge: () => [...inventory(project).latest.values()],
      publications: () => inventory(project).records,
      publishKnowledge(entry, options = {}, beforePublish) {
        requireValue(write, 'read-only');
        requireValue(beforePublish === undefined || typeof beforePublish === 'function', 'invalid-schema');
        object(options, ['id', 'expectedRevision', 'requestId'], 'publication options');
        return commit(project, entry, options, true, beforePublish);
      },
      publish(relative, contents) {
        requireValue(write, 'read-only');
        location(project.memory, path.posix.dirname(relative), 'directory', true);
        assertProject(project);
        exclusive(location(project.memory, relative), contents);
      },
      replace(relative, contents, owned) {
        requireValue(write, 'read-only');
        const file = location(project.memory, relative);
        if (exists(file)) requireValue(owned(readText(project.memory, relative, LIMITS.recordBytes * 2)), 'view-conflict', 'Working view was manually edited; preserve it before explicit recovery');
        assertProject(project);
        const parent = path.posix.dirname(relative);
        if (parent !== '.') location(project.memory, parent, 'directory', true);
        replaceText(project, relative, contents);
      },
    });
  };
  return write ? locked(project, action) : action();
}

// The canonical record is the commit point. Projection errors after publication
// are returned explicitly, not thrown as though the record had never been saved.
function projectRecord(project, record, duplicate, beforePublish, byId) {
  try { beforePublish?.(); publishView(project, record, byId); return { record, duplicate, projection: 'current', path: viewPath(record) }; }
  catch (error) { return { record, duplicate, projection: 'pending', reason: error instanceof MemoryError ? error.code : 'projection-io-error', path: viewPath(record) }; }
}
function commit(project, input, { id, expectedRevision, requestId } = {}, lockHeld = false, beforePublish) {
  let entry = normalizeEntry(input);
  if (entry.scope) entry = normalizeEntry({ ...entry, scope: { ...entry.scope, path: scopePathFor(project, entry.scope.path) } });
  if (id !== undefined) uuid(id);
  requireValue(id === undefined ? expectedRevision === undefined : Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'invalid-schema', 'Revisions require id and expectedRevision');
  if (requestId !== undefined) uuid(requestId);
  const requestHash = digest(JSON.stringify({ entry, id: id ?? null, expectedRevision: expectedRevision ?? null }));
  const action = () => {
    assertProject(project);
    const state = inventory(project);
    if (requestId) {
      const duplicate = state.records.find(record => record.requestId === requestId);
      if (duplicate) {
        requireValue(duplicate.requestHash === requestHash, 'request-conflict', 'requestId was already used for different content');
        const revisions = state.byId.get(duplicate.id);
        checkView(project, revisions, state.byId);
        // Retry of an older operation must not roll the current view backwards.
        const projected = projectRecord(project, revisions.at(-1), true, beforePublish, state.byId);
        return { ...projected, record: duplicate };
      }
    }
    if (entry.scope) requireValue(scopePathFor(project, entry.scope.path) === entry.scope.path, 'scope-changed');
    const previous = id ? state.latest.get(id) : undefined;
    requireValue(id === undefined || previous?.revision === expectedRevision, 'revision-conflict', 'Expected revision is not current');
    requireValue(!previous || entry.kind === previous.entry.kind, 'invalid-schema', 'A revision cannot change kind');
    const record = { schemaVersion: SCHEMA_VERSION, projectId: project.id, id: id ?? randomUUID(), revision: (previous?.revision ?? 0) + 1,
      created: new Date().toISOString(), previousDigest: previous ? digest(recordText(previous)) : null,
      ...(requestId ? { requestId, requestHash } : {}), entry };
    validateReferences(entry, state.latest, record.id);
    validateCardConditions(entry);
    validateCardReferences(entry, state.byId, record.id);
    validateCardRevision(entry, previous?.entry);
    validateResultConflict(entry, state.latest, record.id, previous?.entry);
    if (previous) checkView(project, state.byId.get(id), state.byId);
    else requireValue(!exists(location(project.memory, viewPath(record))), 'view-conflict');
    const serialized = recordText(record);
    requireValue(Buffer.byteLength(serialized) <= LIMITS.recordBytes && state.scanned + 1 <= LIMITS.records && state.bytes + Buffer.byteLength(serialized) <= LIMITS.totalBytes, 'inventory-bounded');
    assertProject(project);
    beforePublish?.();
    exclusive(location(project.memory, recordPath(record)), serialized);
    return projectRecord(project, record, false, beforePublish, state.byId);
  };
  return lockHeld ? action() : locked(project, action);
}
export function saveV2(project, entry, options = {}) {
  object(options, ['requestId'], 'save options');
  assertProject(project);
  const folder = scopeFor(project).path;
  return commit(project, entry?.scope === undefined && folder !== '.' ? { ...entry, scope: { path: folder } } : entry, options);
}
export function reviseV2(project, id, expectedRevision, entry, options = {}) {
  object(options, ['requestId'], 'revision options');
  uuid(id);
  requireValue(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'invalid-schema', 'Revision requires a positive expectedRevision');
  const previous = getV2(project, id);
  return commit(project, entry?.scope === undefined && previous.entry.scope !== undefined ? { ...entry, scope: previous.entry.scope } : entry, { ...options, id, expectedRevision });
}
export function getV2(project, id, { revision } = {}) {
  uuid(id);
  if (revision !== undefined) requireValue(Number.isSafeInteger(revision) && revision > 0, 'invalid-schema');
  const state = inventory(project);
  const record = revision === undefined ? state.latest.get(id) : state.byId.get(id)?.find(item => item.revision === revision);
  requireValue(!!record, 'not-found');
  return record;
}
export function rebuildV2(project) {
  return locked(project, () => {
    const state = inventory(project);
    // Check every target before modifying any view. Never overwrite a manual edit.
    for (const revisions of state.byId.values()) checkView(project, revisions, state.byId);
    for (const record of state.latest.values()) {
      location(project.memory, `knowledge/${record.entry.kind}`, 'directory', true);
      publishView(project, record, state.byId);
    }
    return { rebuilt: state.latest.size };
  });
}
export function statusV2(project) {
  if (!project.enabled) return { enabled: false, reason: project.reason, root: project.root };
  const state = inventory(project);
  return { enabled: true, schemaVersion: SCHEMA_VERSION, id: project.id, name: project.name, root: project.root, memory: project.memory,
    records: state.records.length, entities: state.latest.size, bytes: state.bytes, limits: LIMITS,
    workingMemory: 'available-with-v2-extension', learningMode: project.learningMode ?? 'on',
    longTermMode: project.longTermMode ?? 'review', extraction: project.extraction ?? {},
    automaticLearning: false, defaultContext: false };
}
export function scopeVisible(scope, folder) {
  const value = normalizeScope(scope);
  return value.path === folder || (value.inherit && scopeChain(folder).includes(value.path));
}
export function searchV2(project, query, { limit = 8, includeInactive = false, kind, entityId, entityIds = [], deduplicateSources = false, folder, allFolders = false } = {}) {
  text(query, 4000, 'query');
  requireValue(Number.isInteger(limit) && limit >= 1 && limit <= 20 && typeof includeInactive === 'boolean', 'invalid-schema');
  if (kind !== undefined) enumValue(kind, KINDS, 'kind');
  if (entityId !== undefined) uuid(entityId);
  requireValue(Array.isArray(entityIds) && entityIds.length <= 20 && typeof deduplicateSources === 'boolean', 'invalid-schema');
  entityIds.forEach(uuid);
  const active = new Set(entityIds);
  if (!project.enabled) return { hits: [], backend: 'local-bm25-v2', reason: project.reason };
  requireValue(typeof allFolders === 'boolean', 'invalid-schema');
  folder = folder === undefined ? scopeFor(project).path : scopePathFor(project, folder);
  const state = inventory(project), q = [...new Set(terms(query))].slice(0, 100);
  const relatedIds = record => [record.id, ...record.entry.entities.map(ref => ref.id), ...(record.entry.result ? [record.entry.result.runId] : [])];
  const docs = [...state.latest.values()].filter(record => (includeInactive || record.entry.lifecycle === 'current')
    && (!kind || record.entry.kind === kind) && (!entityId || relatedIds(record).includes(entityId))
    && (allFolders || scopeVisible(record.entry.scope, folder) || (entityId && relatedIds(record).includes(entityId)) || relatedIds(record).some(id => active.has(id))));
  const indexed = docs.map(record => {
    const body = [record.entry.content,
      ...(record.entry.run ? [`Run: ${JSON.stringify(record.entry.run)}`] : []),
      ...(record.entry.result ? [`Result: ${JSON.stringify(record.entry.result)}`] : []),
      ...(record.entry.card ? [cardIndexText(record.entry)] : [])].join('\n');
    const tokens = terms(body), counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { record, body, counts, title: new Set(terms(`${record.entry.title} ${record.entry.tags.join(' ')}`)), length: tokens.length };
  });
  const avg = indexed.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, indexed.length) || 1;
  const df = new Map(q.map(term => [term, indexed.filter(doc => doc.counts.has(term) || doc.title.has(term)).length]));
  const hits = indexed.map(({ record, body, counts, title, length }) => {
    let score = 0;
    for (const term of q) {
      const tf = (counts.get(term) ?? 0) + (title.has(term) ? 4 : 0);
      if (tf) score += Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / avg));
    }
    const related = new Set([record.id, ...record.entry.entities.map(ref => ref.id), ...(record.entry.result ? [record.entry.result.runId] : [])]);
    const entityMatches = [...active].filter(id => related.has(id)).length;
    score += entityMatches * 4;
    const lines = body.split('\n');
    const matching = lines.filter(line => q.some(term => line.normalize('NFKC').toLowerCase().includes(term)));
    // Extracted records carry complementary sources; matching lines alone can
    // discard an unrun remedy or a failed-energy qualifier from another source.
    const sourceRun = cardRunContext(record.entry, state.byId, state.latest);
    const summary = cardSummary(record.entry, sourceRun);
    const excerptSource = summary || (record.entry.provenance === 'model-extraction'
      ? body : (matching.length ? matching : lines).slice(0, 7).join('\n'));
    const scope = normalizeScope(record.entry.scope);
    const scopeRank = scope.path === '.' ? 0 : scope.path === folder ? 2 : scopeChain(folder).includes(scope.path) && scope.inherit ? 1 : -1;
    return { id: record.id, revision: record.revision, scope, scopeRank, kind: record.entry.kind, title: record.entry.title,
      verification: record.entry.verification, provenance: record.entry.provenance, lifecycle: record.entry.lifecycle,
      evidence: record.entry.evidence, entities: record.entry.entities, run: record.entry.run, result: record.entry.result,
      resultRun: record.entry.result ? (sourceRun
        ? state.byId.get(sourceRun.id).find(record => record.revision === sourceRun.revision).entry.run
        : state.latest.get(record.entry.result.runId).entry.run) : undefined,
      ...(record.entry.card ? { cardSummary: boundedExcerpt(summary, 600), sourceRun } : {}),
      requiresVerification: ['reported', 'unresolved'].includes(record.entry.verification),
      sourceTurn: record.entry.sourceTurn, entityMatches,
      path: viewPath(record), score, excerpt: boundedExcerpt(excerptSource, 1400) };
  }).filter(hit => hit.score > 0).sort((a, b) => b.entityMatches - a.entityMatches || b.scopeRank - a.scopeRank || b.score - a.score || a.id.localeCompare(b.id));
  const contentDigests = new Map(deduplicateSources ? indexed.map(doc => [doc.record.id, digest(doc.body)]) : []);
  const seen = new Set(); let deduplicated = 0;
  const selected = hits.filter(hit => {
    if (!deduplicateSources || !hit.sourceTurn) return true;
    const key = JSON.stringify([hit.kind, hit.scope, hit.sourceTurn, hit.evidence, hit.entities, hit.result, contentDigests.get(hit.id)]);
    if (seen.has(key)) { deduplicated++; return false; }
    seen.add(key); return true;
  }).slice(0, limit);
  return { hits: selected, backend: 'local-bm25-v2', scanned: state.records.length, truncated: false, deduplicated };
}
