import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import path from 'node:path';
import { buildContext, initialize, readCheckpoint, readNote, readState, requireValue, resolveProject, reviewCheckpoint, save, saveCheckpoint, search, setCheckpointEnabled, status } from './src/memory.mjs';

const Choice = (values: string[]) => Type.Union(values.map(value => Type.Literal(value)));
const Expected = Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]);
const result = (details: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details });
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const CONTEXT = 'project-memory-context';
const FOOTER = 'project-memory';
const showMemoryStatus = (ctx: ExtensionContext, enabled: boolean, hits?: number) => {
  if (ctx.hasUI) ctx.ui.setStatus(FOOTER, enabled ? `memory: on · manual save · auto recall · hits ${hits ?? '—'}` : 'memory: off');
};

export default function projectMemory(pi: ExtensionAPI) {
  let prompt = '', warning = '';
  let checkpointTurn: { root: string; id: string; expected: string; base: string | null } | undefined;
  const notify = (ctx: ExtensionContext, message: string, failed = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, failed ? 'warning' : 'info');
    else pi.sendMessage({ customType: 'project-memory-status', content: message, display: true });
  };
  pi.on('session_start', (_event, ctx) => {
    prompt = ''; warning = ''; checkpointTurn = undefined;
    try {
      const project = resolveProject(ctx.cwd);
      showMemoryStatus(ctx, project.enabled);
      if (project.legacy.length) notify(ctx, `Legacy memory detected (${project.legacy.join(', ')}); it is not loaded or migrated. Current-state/notes storage: .pi-memory-local. Run /memory-init explicitly if needed.`);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.setStatus(FOOTER, 'memory: error');
      notify(ctx, `Memory unavailable: ${reason(error)}`, true);
      return;
    }
    if (ctx.hasUI) {
      try {
        if (readCheckpoint(resolveProject(ctx.cwd)).content) notify(ctx, 'A checkpoint draft is waiting. Use /memory checkpoint show to review it.');
      } catch (error) { notify(ctx, `Checkpoint unavailable: ${reason(error)}`, true); }
    }
  });
  pi.on('session_shutdown', (_event, ctx) => {
    checkpointTurn = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(FOOTER, undefined);
  });
  pi.on('agent_settled', () => { checkpointTurn = undefined; });
  pi.on('before_agent_start', (event, ctx) => {
    prompt = event.messageType === 'custom' ? '' : event.prompt ?? '';
    checkpointTurn = undefined;
    const options = event.systemPromptOptions, sections = options?.sections;
    if (sections) delete sections.project_memory_checkpoint;
    if (!sections || !options.selectedTools?.includes('project_memory_save') || ctx.mode !== 'tui' || event.messageType !== 'user') return;
    try {
      const project = resolveProject(ctx.cwd), draft = readCheckpoint(project);
      if (!draft.enabled) return;
      checkpointTurn = { root: project.root, id: project.id, expected: draft.expected, base: readState(project)?.expected ?? null };
      sections.project_memory_checkpoint = 'The user enabled automatic checkpoint drafts for this project. After meaningful task progress, before your final reply, call project_memory_save once with target "checkpoint" and content only. Draft a concise, self-contained handoff: current task, verified progress or failures, blockers, relevant files, and next step. Preserve uncertainty and relevant scientific conditions. Skip questions, routine turns, explicit no-save requests, and turns that already saved the formal current state. Never include secrets, sensitive data, raw transcripts or unverified claims as facts. This writes only a reviewable draft; never update formal state or long-term notes automatically. Do not perform extra work just to create a draft.';
    } catch (error) { notify(ctx, `Checkpoint unavailable: ${reason(error)}`, true); }
  });
  // Context is ephemeral and refreshed before EVERY model call, including the
  // call immediately after a correction tool. Old injections never accumulate.
  pi.on('context', (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === 'custom' && message.customType === CONTEXT));
    try {
      const project = resolveProject(ctx.cwd);
      const context = buildContext(project, prompt);
      warning = '';
      if (context.content) messages.push({ role: 'custom', customType: CONTEXT, content: context.content, display: false, timestamp: Date.now() });
      showMemoryStatus(ctx, project.enabled, context.paths.filter(file => file.startsWith('notes/')).length);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.setStatus(FOOTER, 'memory: error');
      const message = `Memory context unavailable: ${reason(error)}`;
      if (warning !== message) { notify(ctx, message, true); warning = message; }
    }
    return { messages };
  });
  pi.registerCommand('memory-init', {
    description: 'Initialize isolated current-state/notes storage: /memory-init [name]',
    handler: async (args, ctx) => {
      try {
        const project = initialize(ctx.cwd, args.trim() ? { name: args.trim() } : {});
        showMemoryStatus(ctx, project.enabled);
        notify(ctx, JSON.stringify(project, null, 2));
      } catch (error) { notify(ctx, reason(error), true); }
    },
  });
  pi.registerCommand('memory', {
    description: 'Memory: status | state | context [query] | search [--all] <query> | get <id> | checkpoint',
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
          case 'checkpoint': {
            requireValue(ctx.hasUI, 'invalid-input', 'Checkpoint commands require an interactive UI');
            const [action = 'show', expected, ...extra] = rest;
            const reviewing = action === 'accept' || action === 'discard';
            requireValue(extra.length === 0 && (reviewing ? Boolean(expected) : expected === undefined && ['on', 'off', 'show'].includes(action)), 'invalid-input', 'Usage: /memory checkpoint on | off | show | accept <hash> | discard <hash>');
            if (action === 'show') value = readCheckpoint(project);
            else if (reviewing) {
              const review = () => reviewCheckpoint(project, action, expected);
              value = action === 'accept' && project.enabled ? await withFileMutationQueue(path.join(project.memory, 'state.md'), review) : review();
            } else {
              const draft = setCheckpointEnabled(project, action === 'on');
              value = { enabled: draft.enabled, pending: Boolean(draft.content) };
            }
            break;
          }
          default: throw new Error('Commands: status | state | context [query] | search [--all] <query> | get <id> | checkpoint');
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
    description: 'Save target state or note. State content is Markdown describing the task, blockers, important files and next steps; expected is null initially. New notes require title, content, sources, conditions; status defaults to unverified. To correct a note, supply its id, expected hash and changed fields. To withdraw it, supply id, expected and status inactive. Target checkpoint takes only content and is available only when the current turn explicitly enables checkpoint draft guidance. It never modifies formal state or notes. No automatic history or migration.',
    promptGuidelines: [
      'Use project_memory_save for requested durable knowledge and task checkpoints; read current expected hashes before replacing state or notes. Correct the same note id instead of creating a second fact.',
      'In project_memory_save preserve sources, applicability, uncertainty, system/method/software version, charge/spin and units when relevant. Distinguish failure, preparation and achieved results. Sources and normal termination do not certify a conclusion; memory never authorizes execution.',
    ],
    parameters: Type.Object({ target: Choice(['state', 'note', 'checkpoint']), id: Type.Optional(Type.String()), expected: Type.Optional(Expected),
      content: Type.Optional(Type.String({ maxLength: 16000 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      sources: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 })), conditions: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })), status: Type.Optional(Choice(['active', 'unverified', 'inactive'])) }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireValue(!signal?.aborted, 'cancelled');
      const project = resolveProject(ctx.cwd);
      if (params.target === 'checkpoint') {
        const turn = checkpointTurn;
        requireValue(ctx.mode === 'tui' && turn && project.enabled && project.root === turn.root && project.id === turn.id,
          'checkpoint-disabled', 'No automatic checkpoint draft is available for this turn');
        requireValue(Object.keys(params).every(key => key === 'target' || key === 'content'), 'invalid-input', 'Checkpoint drafts take only content');
        const draft = saveCheckpoint(project, { expected: turn.expected, base: turn.base, content: params.content });
        checkpointTurn = undefined;
        return result({ saved: draft.expected !== turn.expected });
      }
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
