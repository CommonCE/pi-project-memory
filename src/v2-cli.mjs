import { MemoryError, normalizeScope, object, requireValue } from './v2-domain.mjs';
import { accessV2, foldersV2, renderFolderViews, scopeFor, getV2, initializeV2, rebuildV2, resolveV2, reviseV2, saveV2, searchV2, statusV2 } from './v2-store.mjs';
import { appendWorkV2, buildWorkingContext, readBriefV2, readWorkingV2, rebuildWorkingV2, updateWorkingV2 } from './v2-working.mjs';
import { listCandidatesV2, proposeCandidateV2, reviewCandidateV2 } from './v2-candidates.mjs';

async function inputJSON(input) {
  const chunks = []; let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    requireValue(bytes <= 200000, 'input-too-large');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new MemoryError('invalid-json', 'Malformed input JSON'); }
}

// Explicit file operations only; no global settings, registry, models or scheduler access.
export async function runV2(args, { cwd = process.cwd(), input = process.stdin } = {}) {
  const [command = 'status', ...rest] = args;
  if (command === 'init') {
    const nested = rest.includes('--nested');
    requireValue(rest.filter(arg => arg === '--nested').length <= 1 && rest.filter(arg => arg !== '--nested').length <= 1
      && rest.every(arg => !arg.startsWith('--') || arg === '--nested'), 'invalid-arguments', 'Usage: v2 init ["name"] [--nested]');
    return initializeV2(cwd, { name: rest.find(arg => arg !== '--nested'), nested });
  }
  const project = resolveV2(cwd);
  switch (command) {
    case 'status': {
      requireValue(rest.length === 0, 'invalid-arguments');
      const work = readWorkingV2(project);
      return { ...statusV2(project), workEvents: work.events.length, workRevisions: work.revisions };
    }
    case 'save': {
      requireValue(rest.length === 0, 'invalid-arguments');
      const value = await inputJSON(input);
      object(value, ['entry', 'requestId'], 'save request');
      return saveV2(project, { ...value.entry, scope: value.entry?.scope === undefined ? { path: scopeFor(project).path } : value.entry.scope }, value.requestId === undefined ? {} : { requestId: value.requestId });
    }
    case 'revise': {
      requireValue(rest.length === 0, 'invalid-arguments');
      const value = await inputJSON(input);
      object(value, ['id', 'expectedRevision', 'entry', 'requestId'], 'revision request');
      const previous = getV2(project, value.id);
      return reviseV2(project, value.id, value.expectedRevision, { ...value.entry, ...(value.entry?.scope === undefined && previous.entry.scope !== undefined ? { scope: previous.entry.scope } : {}) }, value.requestId === undefined ? {} : { requestId: value.requestId });
    }
    case 'get': {
      requireValue(rest.length === 1 || rest.length === 2, 'invalid-arguments', 'Usage: v2 get <uuid> [revision]');
      requireValue(rest.length === 1 || /^[1-9]\d*$/.test(rest[1]), 'invalid-arguments');
      return getV2(project, rest[0], rest.length === 2 ? { revision: Number(rest[1]) } : {});
    }
    case 'propose': requireValue(rest.length === 0, 'invalid-arguments'); return proposeCandidateV2(project, await inputJSON(input));
    case 'candidates': requireValue(rest.length === 0, 'invalid-arguments'); return listCandidatesV2(project);
    case 'review': requireValue(rest.length === 2, 'invalid-arguments', 'Usage: v2 review <uuid> approve|reject'); return reviewCandidateV2(project, rest[0], rest[1]);
    case 'folder': {
      const [action, folder, ...extra] = rest;
      requireValue(extra.length === 0, 'invalid-arguments');
      if (action === 'list') { requireValue(folder === undefined, 'invalid-arguments'); return foldersV2(project); }
      if (action === 'rebuild') {
        requireValue(folder === undefined || folder === '--force', 'invalid-arguments');
        const result = renderFolderViews(project, { force: folder === '--force' });
        requireValue(result.conflicts.length === 0, 'conflict', `Edited folder views: ${result.conflicts.join(', ')}`);
        return result;
      }
      requireValue(action === 'show', 'invalid-arguments', 'Usage: v2 folder list|show [rel]|rebuild [--force]');
      const selected = folder === undefined ? scopeFor(project).path : normalizeScope({ path: folder }).path;
      const found = foldersV2(project).folders.find(item => item.path === selected);
      requireValue(!!found, 'not-found', 'No memory for folder');
      return accessV2(project, false, io => {
        const file = `folders/${found.hash}.md`;
        requireValue(io.exists(file), 'not-found', 'Run v2 folder rebuild first');
        return { folder: found, content: io.read(file, 500000) };
      });
    }
    case 'search': {
      const options = {}, query = [];
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (['--all', '--all-folders'].includes(flag)) {
          const key = flag === '--all' ? 'includeInactive' : 'allFolders';
          requireValue(options[key] === undefined, 'invalid-arguments'); options[key] = true;
        } else if (['--folder', '--entity'].includes(flag)) {
          const key = flag === '--folder' ? 'folder' : 'entityId';
          requireValue(options[key] === undefined && rest[i + 1] !== undefined && !rest[i + 1].startsWith('--'), 'invalid-arguments');
          options[key] = rest[++i];
        } else { requireValue(!flag.startsWith('--'), 'invalid-arguments'); query.push(flag); }
      }
      requireValue(query.length > 0, 'invalid-arguments', 'Usage: v2 search <query> [--folder <rel>] [--all-folders]');
      return searchV2(project, query.join(' '), options);
    }
    case 'brief': {
      requireValue(rest.length === 0 || (rest.length === 2 && rest[0] === '--folder' && !rest[1].startsWith('--')),
        'invalid-arguments', 'Usage: v2 brief [--folder <rel>]');
      return readBriefV2(project, rest.length ? { folder: rest[1] } : {});
    }
    case 'work': requireValue(rest.length === 0, 'invalid-arguments'); return readWorkingV2(project);
    case 'context': return buildWorkingContext(project, rest.join(' '));
    case 'record': {
      requireValue(rest.length === 0, 'invalid-arguments');
      const payload = await inputJSON(input);
      return appendWorkV2(project, { ...payload, scope: payload.scope === undefined ? { path: scopeFor(project).path } : payload.scope });
    }
    case 'state':
    case 'overview': {
      requireValue(rest.length === 0, 'invalid-arguments');
      const value = await inputJSON(input);
      object(value, ['expectedRevision', 'value', 'requestId', 'scope'], 'working update');
      return updateWorkingV2(project, command, value.expectedRevision, value.value, {
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        scope: value.scope === undefined ? { path: command === 'overview' ? '.' : scopeFor(project).path } : value.scope,
      });
    }
    case 'rebuild-work': requireValue(rest.length === 0, 'invalid-arguments'); return rebuildWorkingV2(project);
    case 'rebuild': requireValue(rest.length === 0, 'invalid-arguments'); return rebuildV2(project);
    default: throw new MemoryError('invalid-arguments', 'Commands: v2 init ["name"] [--nested] | status | save | revise | get <uuid> [revision] | search [--all] <query> | rebuild | brief [--folder <rel>] | work | context [query] | record | state | overview | folder list|show [rel]|rebuild [--force] | rebuild-work | propose | candidates | review <uuid> approve|reject');
  }
}
