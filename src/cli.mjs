import { buildContext, initialize, LIMITS, MemoryError, readNote, readState, requireValue, resolveProject, save, search, status } from './memory.mjs';

const HELP = `pi-project-memory init [name]
pi-project-memory status
pi-project-memory state                 # read current state and expected token
pi-project-memory state save            # stdin: {"content":"...","expected":null|"hash"}
pi-project-memory save                  # stdin: note fields, optional id + expected
pi-project-memory invalidate <id>       # stdin: {"expected":"hash"}
pi-project-memory get <id>
pi-project-memory search [--all] <query>
pi-project-memory context [query]
All data is local. Legacy v1/v2 commands and data are not migrated.`;
async function inputJSON(input) {
  let size = 0;
  const chunks = [];
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    requireValue(size <= LIMITS.fileBytes, 'limit-exceeded', 'JSON input exceeds byte limit');
    chunks.push(bytes);
  }
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
  catch { throw new MemoryError('invalid-input', 'Expected valid UTF-8 on stdin'); }
  try { return JSON.parse(raw); }
  catch { throw new MemoryError('invalid-input', 'Expected one JSON object on stdin'); }
}
export async function run(args, { cwd = process.cwd(), input = process.stdin } = {}) {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') return { help: HELP };
  if (command === 'v2' || command === 'setup') throw new MemoryError('legacy-command', 'Legacy commands were retired. Use init explicitly for isolated current-state/notes storage; no data is migrated.');
  if (command === 'init') {
    requireValue(rest.length <= 1, 'invalid-input', 'Usage: init [name]');
    return initialize(cwd, { name: rest[0] });
  }
  const project = resolveProject(cwd);
  if (command === 'status') { requireValue(rest.length === 0, 'invalid-input'); return status(project); }
  requireValue(project.enabled, project.reason ?? 'not-initialized', `Memory unavailable (${project.reason}); run init explicitly. Legacy data remains untouched.`);
  switch (command) {
    case 'state':
      requireValue(rest.length === 0 || (rest.length === 1 && rest[0] === 'save'), 'invalid-input');
      return rest.length ? save(project, { ...await inputJSON(input), target: 'state' }) : readState(project);
    case 'save': requireValue(rest.length === 0, 'invalid-input'); return save(project, { ...await inputJSON(input), target: 'note' });
    case 'invalidate': {
      requireValue(rest.length === 1, 'invalid-input');
      const value = await inputJSON(input);
      requireValue(value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'expected'), 'invalid-input', 'invalidate expects only an expected token');
      return save(project, { target: 'note', id: rest[0], expected: value.expected, status: 'inactive' });
    }
    case 'get': requireValue(rest.length === 1, 'invalid-input'); return readNote(project, rest[0]);
    case 'search': {
      const all = rest[0] === '--all', query = (all ? rest.slice(1) : rest).join(' ');
      return search(project, query, { includeInactive: all });
    }
    case 'context': return buildContext(project, rest.join(' '));
    default: throw new MemoryError('invalid-input', HELP);
  }
}
