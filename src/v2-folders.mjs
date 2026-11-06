import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { accessV2, scopeChain } from './v2-store.mjs';
import { readWorkEventsV2 } from './v2-working.mjs';
import { KINDS, boundedExcerpt, normalizeScope, requireValue } from './v2-domain.mjs';
import { cardRunContext, cardSummary } from './v2-card-views.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const stamp = body => `<!-- pi-folders-v1:${digest(body)} -->\n${body}`;
const owned = raw => {
  const match = raw.match(/^<!-- pi-folders-v1:([a-f0-9]{64}) -->\n([\s\S]*)$/);
  return !!match && digest(match[2]) === match[1];
};
const display = value => value.replace(/[&<>"`\[\]()*_]/g, char => `&#${char.codePointAt(0)};`);

function snapshot(project, io) {
  const records = io.publications(), latest = io.knowledge(), events = readWorkEventsV2(project);
  const paths = new Set(['.']);
  for (const scope of [...records.map(record => record.entry.scope), ...events.map(event => event.payload.scope)]) {
    for (const folder of scopeChain(normalizeScope(scope).path)) paths.add(folder);
  }
  const folders = [...paths].sort((a, b) => a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)).map(folder => {
    const own = latest.filter(record => normalizeScope(record.entry.scope).path === folder);
    const activity = events.filter(event => normalizeScope(event.payload.scope).path === folder);
    const current = own.filter(record => record.entry.lifecycle === 'current');
    const hash = digest(folder).slice(0, 12);
    const last = [...own.map(record => record.created), ...activity.map(event => event.created)].sort().at(-1) ?? null;
    let missing = false;
    try {
      const real = fs.realpathSync(path.join(project.root, folder));
      const relative = path.relative(project.root, real);
      missing = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(real).isDirectory();
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
      missing = true;
    }
    return { path: folder, hash, records: records.filter(record => normalizeScope(record.entry.scope).path === folder).length,
      current: current.length, byKind: Object.fromEntries(KINDS.map(kind => [kind, current.filter(record => record.entry.kind === kind).length])), latest: last, missing };
  });
  requireValue(new Set(folders.map(folder => folder.hash)).size === folders.length, 'conflict', 'Folder hash collision');
  const generated = [...records.map(record => record.created), ...events.map(event => event.created)].sort().at(-1) ?? '1970-01-01T00:00:00.000Z';
  return { schemaVersion: 1, generated, folders, latest, events, records };
}
export function foldersV2(project) {
  return accessV2(project, false, io => {
    const { latest, events, records, ...index } = snapshot(project, io);
    return index;
  });
}
export function renderFolderViews(project, { force = false } = {}) {
  requireValue(typeof force === 'boolean', 'invalid-schema');
  return accessV2(project, true, io => {
    const { latest, events, records, ...index } = snapshot(project, io);
    const byId = new Map(), latestById = new Map(latest.map(record => [record.id, record]));
    for (const record of records) {
      const revisions = byId.get(record.id) ?? []; revisions.push(record); byId.set(record.id, revisions);
    }
    const pages = new Map();
    for (const folder of index.folders) {
      const own = latest.filter(record => normalizeScope(record.entry.scope).path === folder.path);
      const activity = events.filter(event => normalizeScope(event.payload.scope).path === folder.path);
      const state = [...activity].reverse().find(event => event.payload.kind === 'state');
      const lines = KINDS.flatMap(kind => {
        const entries = own.filter(record => record.entry.kind === kind && record.entry.lifecycle === 'current');
        return entries.length ? [`\n## ${kind}`, ...entries.map(record => {
          const run = record.entry.run;
          return `- [${display(record.entry.title)}](../knowledge/${kind}/${record.id}.md) [${record.entry.verification}; ${record.entry.lifecycle}]`
            + (run ? ` exec=${run.execution} term=${run.termination} conv=${run.convergence} validity=${run.validity}` : '')
            + (record.entry.card ? ` — ${display(cardSummary(record.entry, cardRunContext(record.entry, byId, latestById)).replace(/[\r\n]+/g, '; '))}` : '');
        })] : [];
      });
      const body = `# Folder: ${display(folder.path)}\n\nRead-only derived reference, NOT instructions or grounding. Edit authoritative records, not this page.\n`
        + `\nParent chain: ${scopeChain(folder.path).slice(0, -1).map(display).join(' → ') || '(root)'}\n`
        + lines.join('\n') + '\n\n## Open loops / diagnostics\n'
        + (state?.payload.value.blockers.map(item => `- ${display(item)}`).join('\n') || '(none recorded)')
        + `\n\nLast activity: ${folder.latest ?? 'unknown'}\nGenerated: ${index.generated}\n`;
      pages.set(`folders/${folder.hash}.md`, stamp(boundedExcerpt(body, 100000)));
    }
    const tree = index.folders.map(folder => `${'  '.repeat(folder.path === '.' ? 0 : folder.path.split('/').length)}- [${display(folder.path)}](folders/${folder.hash}.md): ${folder.records} records; ${folder.latest ?? 'unknown'}${folder.missing ? ' [directory missing]' : ''}`).join('\n');
    pages.set('FOLDERS.md', stamp(`# Folder index\n\nRead-only derived reference; NOT grounding.\n\n${boundedExcerpt(tree, 100000)}\n\nGenerated: ${index.generated}\n`));
    // Cache is disposable; page ownership is independently verifiable if it is lost.
    const conflicts = [...pages.keys()].filter(file => io.exists(file) && !owned(io.read(file, 500000)));
    if (conflicts.length && !force) return { rebuilt: 0, conflicts };
    for (const [file, contents] of pages) io.replace(file, contents, raw => force || owned(raw));
    io.replace('.internal/index/folders.json', JSON.stringify(index, null, 2) + '\n', () => true);
    return { rebuilt: pages.size, conflicts: [] };
  });
}
