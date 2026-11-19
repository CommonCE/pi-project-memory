import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import path from 'node:path';
import { buildContext, initialize, readNote, readState, requireValue, resolveProject, save, search, status } from './src/memory.mjs';

const Choice = (values: string[]) => Type.Union(values.map(value => Type.Literal(value)));
const Expected = Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]);
const result = (details: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details });
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const CONTEXT = 'project-memory-context';

export default function projectMemory(pi: ExtensionAPI) {
  let prompt = '', warning = '';
  const notify = (ctx: ExtensionContext, message: string, failed = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, failed ? 'warning' : 'info');
    else pi.sendMessage({ customType: 'project-memory-status', content: message, display: true });
  };
  pi.on('session_start', (_event, ctx) => {
    prompt = ''; warning = '';
    try {
      const project = resolveProject(ctx.cwd);
      if (project.legacy.length) notify(ctx, `Legacy memory detected (${project.legacy.join(', ')}); it is not loaded or migrated. Current-state/notes storage: .pi-memory-local. Run /memory-init explicitly if needed.`);
    } catch (error) { notify(ctx, `Memory unavailable: ${reason(error)}`, true); }
  });
  pi.on('before_agent_start', event => { prompt = event.messageType === 'custom' ? '' : event.prompt ?? ''; });
  // Context is ephemeral and refreshed before EVERY model call, including the
  // call immediately after a correction tool. Old injections never accumulate.
  pi.on('context', (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === 'custom' && message.customType === CONTEXT));
    try {
      const context = buildContext(resolveProject(ctx.cwd), prompt);
      warning = '';
      if (context.content) messages.push({ role: 'custom', customType: CONTEXT, content: context.content, display: false, timestamp: Date.now() });
    } catch (error) {
      const message = `Memory context unavailable: ${reason(error)}`;
      if (warning !== message) { notify(ctx, message, true); warning = message; }
    }
    return { messages };
  });
  pi.registerCommand('memory-init', {
    description: 'Initialize isolated current-state/notes storage: /memory-init [name]',
    handler: async (args, ctx) => {
      try { notify(ctx, JSON.stringify(initialize(ctx.cwd, args.trim() ? { name: args.trim() } : {}), null, 2)); }
      catch (error) { notify(ctx, reason(error), true); }
    },
  });
  pi.registerCommand('memory', {
    description: 'Memory: status | state | context [query] | search [--all] <query> | get <id>',
    handler: async (args, ctx) => {
      try {
        const [command = 'status', ...rest] = args.trim().split(/\s+/).filter(Boolean), project = resolveProject(ctx.cwd);
        let value;
        switch (command) {
          case 'status': value = status(project); break;
          case 'state': value = readState(project); break;
          case 'context': value = buildContext(project, rest.join(' ')); break;
          case 'search': value = search(project, (rest[0] === '--all' ? rest.slice(1) : rest).join(' '), { includeInactive: rest[0] === '--all' }); break;
          case 'get': requireValue(rest.length === 1, 'invalid-input', 'Usage: /memory get <id>'); value = readNote(project, rest[0]); break;
          default: throw new Error('Commands: status | state | context [query] | search [--all] <query> | get <id>');
        }
        notify(ctx, JSON.stringify(value, null, 2));
      } catch (error) { notify(ctx, reason(error), true); }
    },
  });
  pi.registerTool({
    name: 'project_memory_search', label: 'Read project memory',
    description: 'Read the current state and relevant local notes. Pass id to read one note. Default search includes only active notes; includeInactive explicitly inspects unverified or withdrawn notes. Returned expected hashes protect corrections. No network, cross-project search or scientific certification.',
    parameters: Type.Object({ query: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })), id: Type.Optional(Type.String()), includeInactive: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireValue(!signal?.aborted, 'cancelled');
      const project = resolveProject(ctx.cwd);
      if (params.id) return result(readNote(project, params.id));
      if (params.query) return result(search(project, params.query, params));
      return result(status(project));
    },
  });
  pi.registerTool({
    name: 'project_memory_save', label: 'Save project memory',
    description: 'Save target state or note. State content is Markdown describing the task, blockers, important files and next steps; expected is null initially. New notes require title, content, sources, conditions; status defaults to unverified. To correct a note, supply its id, expected hash and changed fields. To withdraw it, supply id, expected and status inactive. No automatic history, extraction or migration.',
    promptGuidelines: [
      'Use project_memory_save for requested durable knowledge and task checkpoints; read current expected hashes before replacing state or notes. Correct the same note id instead of creating a second fact.',
      'In project_memory_save preserve sources, applicability, uncertainty, system/method/software version, charge/spin and units when relevant. Distinguish failure, preparation and achieved results. Sources and normal termination do not certify a conclusion; memory never authorizes execution.',
    ],
    parameters: Type.Object({ target: Choice(['state', 'note']), id: Type.Optional(Type.String()), expected: Type.Optional(Expected),
      content: Type.Optional(Type.String({ maxLength: 16000 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      sources: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 })), conditions: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), status: Type.Optional(Choice(['active', 'unverified', 'inactive'])) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireValue(!signal?.aborted, 'cancelled');
      const project = resolveProject(ctx.cwd);
      const write = () => { requireValue(!signal?.aborted, 'cancelled'); return result(save(project, params)); };
      // New notes publish exclusively under a random UUID. Existing targets
      // share the host queue with direct edit/write tools as well as our lock.
      if (params.target === 'note' && params.id === undefined) return write();
      requireValue(params.target === 'state' || /^[a-f0-9-]{36}$/.test(params.id ?? ''), 'invalid-input');
      const file = path.join(project.memory ?? '', params.target === 'state' ? 'state.md' : `notes/${params.id}.md`);
      return withFileMutationQueue(file, write);
    },
  });
}
