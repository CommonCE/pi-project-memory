import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { KINDS, MemoryError, UUID, normalizeScope, requireValue } from './src/v2-domain.mjs';
import { getV2, initializeV2, resolveV2, reviseV2, saveV2, searchV2, scopeFor, statusV2 } from './src/v2-store.mjs';
import { appendWorkV2, buildWorkingContext, collectWorkTurn, readBriefV2, readWorkingV2, updateWorkingV2 } from './src/v2-working.mjs';
import { listCandidatesV2, reviewCandidateV2 } from './src/v2-candidates.mjs';
import { extractCandidatesV2, EXTRACTION_LIMITS } from './src/v2-extraction.mjs';
import { createCardSchema } from './src/v2-cards.mjs';

const Id = Type.String({ pattern: UUID.source });
const Short = Type.String({ minLength: 1, maxLength: 500 });
const Strings = Type.Array(Short, { maxItems: 10 });
const Choice = (values: readonly string[]) => Type.Union(values.map(value => Type.Literal(value)));
const Entry = Type.Object({
  kind: Choice(KINDS), title: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 100000 }),
  tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 20 })),
  verification: Type.Optional(Choice(['reported', 'evidence-backed', 'user-confirmed', 'unresolved'])),
  provenance: Type.Optional(Choice(['assistant-claim', 'user-confirmation', 'tool-observation', 'model-extraction'])),
  lifecycle: Type.Optional(Choice(['current', 'superseded', 'archived'])), evidence: Type.Optional(Strings),
  entities: Type.Optional(Type.Array(Type.Object({ type: Choice(['system', 'method', 'run', 'component']), id: Id }), { maxItems: 20 })),
  sourceTurn: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  run: Type.Optional(Type.Object({
    execution: Type.Optional(Choice(['unknown', 'prepared', 'submitted', 'running', 'terminated'])),
    termination: Type.Optional(Choice(['unknown', 'normal', 'error', 'cancelled'])),
    convergence: Type.Optional(Choice(['unknown', 'converged', 'not-converged', 'not-applicable'])),
    validity: Type.Optional(Choice(['unchecked', 'accepted-with-scope', 'rejected'])),
    software: Type.Optional(Short), version: Type.Optional(Short), input: Type.Optional(Short), output: Type.Optional(Short),
  })),
  result: Type.Optional(Type.Object({ runId: Id, property: Type.String({ minLength: 1, maxLength: 200 }), value: Type.Number(), unit: Type.String({ minLength: 1, maxLength: 80 }), definition: Type.String({ minLength: 1, maxLength: 1000 }) })),
  card: Type.Optional(createCardSchema(Type)),
});
const State = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 1200 }), blockers: Type.Optional(Type.Array(Short, { maxItems: 8 })), nextSteps: Type.Optional(Type.Array(Short, { maxItems: 8 })),
  artifacts: Type.Optional(Strings), notes: Type.Optional(Type.Array(Short, { maxItems: 8 })), entities: Type.Optional(Type.Array(Id, { maxItems: 20 })),
  provenance: Type.Optional(Choice(['assistant-claim', 'user-confirmation', 'tool-observation'])), evidence: Type.Optional(Strings),
});
const result = (details: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(details, null, 2) }], details });
const reason = (error: unknown) => error instanceof MemoryError ? error.code : 'operation-failed';

// Explicit v2 entry point. Do not load together with index.ts: command/tool names
// are intentionally shared, but this runtime never reads legacy packs or settings.
export default function workingMemory(pi: ExtensionAPI) {
  let generation = 0;
  let briefSession: string | undefined;
  let learningOverride: 'off' | 'on' | undefined;
  let curationOverride: 'off' | 'review' | 'auto' | undefined;
  let scope: { project: ReturnType<typeof resolveV2>; session: string; turn: string; generation: number } | undefined;
  let pendingMessages: any[] | undefined;
  let activeExtraction: AbortController | undefined;
  let attemptedTurn: string | undefined;
  let diagnosticProject: string | undefined;
  let diagnosticEpoch = 0;
  const diagnosticKey = (project: ReturnType<typeof resolveV2>) => JSON.stringify([project.id, project.root, project.memory]);
  let diagnostics: { runs: number; counts: Record<string, number>; reasons: Record<string, number>; usage: Record<string, number> } = { runs: 0, counts: {}, reasons: {}, usage: {} };
  const invalidate = () => { activeExtraction?.abort(); generation++; scope = undefined; pendingMessages = undefined; };
  const projectAt = (ctx: ExtensionContext) => resolveV2(ctx.cwd);
  const learning = (project: ReturnType<typeof resolveV2>) => learningOverride ?? project.learningMode ?? 'on';
  const curation = (project: ReturnType<typeof resolveV2>) => !project.enabled || project.learningMode === 'off' || project.longTermMode === 'off' || learning(project) === 'off'
    ? 'off' : curationOverride ?? project.longTermMode ?? 'review';
  const notify = (ctx: ExtensionContext, message: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, error ? 'warning' : 'info');
    else pi.sendMessage({ customType: 'project-memory-status', content: message, display: true, details: undefined });
  };
  const sameScope = (ctx: ExtensionContext, captured: NonNullable<typeof scope>) => {
    const current = projectAt(ctx);
    return scope === captured && captured.generation === generation && current.enabled && current.id === captured.project.id && current.root === captured.project.root
      && current.memory === captured.project.memory && current.cwd === captured.project.cwd && ctx.sessionManager.getSessionId() === captured.session && learning(current) !== 'off';
  };
  const turnId = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch();
    const user = [...entries].reverse().find(entry => entry.type === 'message' && entry.message.role === 'user');
    return user?.id ?? randomUUID();
  };
  const tally = (projectId: string, output: any) => {
    if (diagnosticProject !== projectId) {
      diagnosticProject = projectId; diagnostics = { runs: 0, counts: {}, reasons: {}, usage: {} };
    }
    const sum = (target: Record<string, number>, values: Record<string, number>) => {
      for (const [key, count] of Object.entries(values)) target[key] = Math.min(Number.MAX_SAFE_INTEGER, (target[key] ?? 0) + count);
    };
    diagnostics.runs = Math.min(Number.MAX_SAFE_INTEGER, diagnostics.runs + 1);
    sum(diagnostics.counts, output.counts ?? {}); sum(diagnostics.reasons, output.reasons ?? {});
    if (Number.isSafeInteger(output.inputChars)) sum(diagnostics.counts, { preparedInputChars: output.inputChars });
    if (Number.isSafeInteger(output.outputChars)) sum(diagnostics.counts, { outputChars: output.outputChars });
    if (output.usage) sum(diagnostics.usage, output.usage);
  };
  const curate = async (ctx: ExtensionContext, captured: NonNullable<typeof scope>, messages: any[], explicit = false) => {
    const key = `${captured.session}:${captured.turn}`;
    if (!explicit && attemptedTurn === key) return;
    if (!sameScope(ctx, captured)) return;
    const project = projectAt(ctx), mode = curation(project), epoch = diagnosticEpoch;
    const canReport = () => {
      try { return epoch === diagnosticEpoch && ctx.sessionManager.getSessionId() === captured.session && diagnosticKey(projectAt(ctx)) === diagnosticKey(project); }
      catch { return false; }
    };
    if (mode === 'off') return;
    if (!explicit) attemptedTurn = key;
    const lastAssistant = [...messages].reverse().find(message => message?.role === 'assistant');
    if (!lastAssistant || lastAssistant.stopReason !== 'stop' || ctx.signal?.aborted) {
      const output = { status: 'skipped', counts: { modelCalls: 0 }, reasons: { 'main-incomplete': 1 } };
      tally(diagnosticKey(project), output); if (explicit) notify(ctx, JSON.stringify(output)); return;
    }
    if (!ctx.model || !ctx.modelRegistry?.streamSimple) {
      const output = { status: 'skipped', counts: { modelCalls: 0 }, reasons: { 'no-model-runtime': 1 } };
      tally(diagnosticKey(project), output); if (explicit) notify(ctx, JSON.stringify(output)); return;
    }
    const controller = new AbortController(); activeExtraction = controller;
    const abort = () => controller.abort();
    ctx.signal?.addEventListener('abort', abort, { once: true });
    if (ctx.signal?.aborted) abort();
    try {
      const working = readWorkingV2(project);
      const state = [...working.events].reverse().find(event => event.payload.kind === 'state')?.payload.value;
      const output = await extractCandidatesV2(project, messages, {
        ...project.extraction, session: captured.session, turn: captured.turn, mode, signal: controller.signal,
        isCurrent: () => sameScope(ctx, captured) && curation(projectAt(ctx)) === mode,
        entityIds: state?.entities ?? [],
        background: [{ label: 'current state (background only)', text: working.state }, { label: 'overview (background only)', text: working.overview }],
        model: async ({ system, prompt, signal, maxOutputTokens }) => {
          const response = await ctx.modelRegistry.streamSimple(ctx.model!, {
            systemPrompt: system, messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: prompt }] }],
          }, { signal, maxTokens: maxOutputTokens, cacheRetention: 'none' }).result();
          const outcome = response.stopReason === 'stop' ? 'completed' : response.stopReason === 'aborted' ? 'cancelled'
            : response.stopReason === 'length' ? 'truncated' : 'failed';
          const usage: Record<string, number> = {};
          if (Number.isSafeInteger(response.usage?.input) && response.usage.input >= 0) usage.inputTokens = response.usage.input;
          if (Number.isSafeInteger(response.usage?.output) && response.usage.output >= 0) usage.outputTokens = response.usage.output;
          return { outcome, text: response.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
            ...(Object.keys(usage).length ? { usage } : {}) };
        },
      });
      if (canReport()) tally(diagnosticKey(project), output);
      if (explicit && sameScope(ctx, captured)) notify(ctx, JSON.stringify(output, null, 2));
    } catch (error) {
      if (canReport()) tally(diagnosticKey(project), { reasons: { [reason(error)]: 1 } });
    } finally {
      ctx.signal?.removeEventListener('abort', abort);
      if (activeExtraction === controller) activeExtraction = undefined;
    }
  };
  pi.on('session_start', (_event, ctx) => {
    invalidate(); briefSession = undefined; learningOverride = undefined; curationOverride = undefined; attemptedTurn = undefined;
    diagnosticEpoch++; diagnosticProject = undefined; diagnostics = { runs: 0, counts: {}, reasons: {}, usage: {} };
    try {
      const project = projectAt(ctx);
      if (ctx.hasUI) ctx.ui.setStatus('project-memory', `memory v2: ${project.name ?? project.reason} · work ${learning(project)}`);
    } catch (error) { notify(ctx, `Memory v2: ${reason(error)}`, true); }
  });
  pi.on('session_before_switch', () => { invalidate(); });
  pi.on('session_before_fork', () => { invalidate(); });
  pi.on('session_shutdown', (_event, ctx) => { invalidate(); if (ctx.hasUI) ctx.ui.setStatus('project-memory', undefined); });
  pi.on('before_agent_start', (event, ctx) => {
    invalidate();
    if (event.messageType === 'custom') return;
    try {
      const project = projectAt(ctx);
      if (!project.enabled) { briefSession = undefined; return; }
      if (learning(project) !== 'off') scope = { project, session: ctx.sessionManager.getSessionId(), turn: turnId(ctx), generation };
      const identity = JSON.stringify([ctx.sessionManager.getSessionId(), project.id, project.root, project.memory, project.cwd]);
      const context = buildWorkingContext(project, event.prompt, { firstTurn: briefSession !== identity });
      if (!context.content) return;
      briefSession = identity;
      return { message: { customType: 'project-memory-context', content: context.content, display: false, details: { project: project.id, paths: context.paths, chars: context.chars } } };
    } catch (error) { notify(ctx, `Memory context skipped: ${reason(error)}`, true); }
  });
  pi.on('agent_end', (event, ctx) => {
    // Pi can run retries/continuations after agent_end without another user
    // prompt. Keep the user scope until replacement; payload identity deduplicates
    // unchanged endings while later complete observations can still be captured.
    const captured = scope;
    if (!captured) return;
    try {
      if (!sameScope(ctx, captured)) return;
      pendingMessages = undefined;
      // Cancellation/error may still leave complete, useful local tool evidence.
      // No model call or detached work is needed to preserve these observations.
      const work = collectWorkTurn(event.messages, { session: captured.session, turn: captured.turn, scope: { path: scopeFor(captured.project).path }, cancelled: ctx.signal?.aborted ?? false });
      if (!work || !sameScope(ctx, captured)) return;
      pendingMessages = event.messages;
      const saved = appendWorkV2(captured.project, work);
      if (saved.projection === 'pending') notify(ctx, `Working memory committed; projection pending: ${saved.reason}`, true);
    } catch (error) { notify(ctx, `Working memory skipped: ${reason(error)}`, true); }
  });
  pi.on('agent_before_settle', async (_event, ctx) => {
    const captured = scope, messages = pendingMessages;
    pendingMessages = undefined;
    if (captured && messages) await curate(ctx, captured, messages);
    // Never add entries or request a continuation: the nested call is bounded,
    // awaited, and cannot create another main agent turn.
  });
  pi.on('session_before_compact', (event, ctx) => {
    try {
      const project = projectAt(ctx);
      if (!project.enabled || learning(project) === 'off' || project.handoffEnabled === false || event.signal.aborted) return;
      // Only canonical projected spans: do not inspect event.branchEntries.
      const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
      const work = collectWorkTurn(messages, { kind: 'handoff', session: ctx.sessionManager.getSessionId(),
        scope: { path: scopeFor(project).path }, turn: `compact:${event.preparation.firstKeptEntryId ?? 'unknown'}`, previousSummary: event.preparation.previousSummary });
      if (!work || event.signal.aborted) return;
      const saved = appendWorkV2(project, work);
      if (saved.projection === 'pending') notify(ctx, `Handoff committed; projection pending: ${saved.reason}`, true);
    } catch (error) { notify(ctx, `Memory handoff skipped: ${reason(error)}`, true); }
    // Never replace or cancel native compaction.
  });
  pi.registerCommand('memory-init', {
    description: 'Initialize v2 project-local working memory: /memory-init [name] [--nested]',
    handler: async (args, ctx) => {
      try {
        const nested = /(?:^|\s)--nested(?:\s|$)/.test(args);
        let name = args.replace(/(?:^|\s)--nested(?=\s|$)/, ' ').trim();
        requireValue(!/(?:^|\s)--/.test(name), 'invalid-arguments');
        if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) name = name.slice(1, -1);
        const project = initializeV2(ctx.cwd, { name: name || undefined, nested });
        invalidate(); notify(ctx, `Working memory ready: ${project.name}\n${project.memory}\nNo source scan or model call. Add the memory directory to your ignore rules if appropriate.`);
      } catch (error) { notify(ctx, `Memory init failed: ${reason(error)}`, true); }
    },
  });
  pi.registerCommand('memory', {
    description: 'V2 memory: status | brief | state | overview | search <query> | get <uuid> | learn on|off | curate off|review|auto | extract | review [uuid [approve|reject]]',
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/), command = match?.[1] ?? 'status', value = match?.[2]?.trim() ?? '';
        const project = projectAt(ctx);
        if (command === 'learn') {
          requireValue(project.enabled && ['on', 'off'].includes(value), 'invalid-arguments');
          invalidate(); learningOverride = value as 'on' | 'off'; notify(ctx, `Working learning: ${learningOverride} (this session only)`);
        } else if (command === 'curate') {
          requireValue(project.enabled && ['off', 'review', 'auto'].includes(value), 'invalid-arguments');
          requireValue(value === 'off' || (project.learningMode !== 'off' && project.longTermMode !== 'off'), 'disabled', 'Project off is a hard boundary; edit project configuration explicitly first');
          invalidate(); curationOverride = value as 'off' | 'review' | 'auto';
          notify(ctx, `Long-term curation: ${curation(project)} (this session only); verification is never upgraded by review or auto`);
        } else if (command === 'extract') {
          requireValue(!value && project.enabled && curation(project) !== 'off', 'disabled');
          invalidate();
          const captured = { project, session: ctx.sessionManager.getSessionId(), turn: turnId(ctx), generation };
          scope = captured;
          const messages = ctx.sessionManager.getBranch().filter(entry => entry.type === 'message').map(entry => entry.message);
          await curate(ctx, captured, messages, true);
        } else if (command === 'status') {
          const work = readWorkingV2(project);
          const candidates = project.enabled ? listCandidatesV2(project).candidates : [];
          const totals = { pending: 0, approved: 0, rejected: 0, publicationPending: 0 };
          for (const item of candidates) { totals[item.status]++; if (item.publication === 'pending') totals.publicationPending++; }
          notify(ctx, JSON.stringify({ ...statusV2(project), workEvents: work.events.length, workRevisions: work.revisions,
            workingLearning: learning(project), defaultContext: project.enabled,
            automaticLearning: !!(project.enabled && learning(project) !== 'off'),
            longTermCurator: !!(project.enabled && curation(project) !== 'off' && ctx.model && ctx.modelRegistry?.streamSimple),
            effectiveLongTermMode: curation(project), candidates: totals, extractionLimits: EXTRACTION_LIMITS,
            diagnostics: diagnosticProject === diagnosticKey(project) ? diagnostics : undefined }, null, 2));
        } else if (command === 'brief') {
          requireValue(!value, 'invalid-arguments', 'Use /memory brief for the current folder');
          notify(ctx, JSON.stringify(readBriefV2(project), null, 2));
        } else if (command === 'state' || command === 'overview') {
          requireValue(!value, 'invalid-arguments', 'Use project_memory_save or the v2 CLI for explicit working updates');
          const current = readWorkingV2(project);
          notify(ctx, JSON.stringify({ revisions: current.revisions, content: current[command] }, null, 2));
        } else if (command === 'search') notify(ctx, JSON.stringify(searchV2(project, value), null, 2));
        else if (command === 'get') notify(ctx, JSON.stringify(getV2(project, value), null, 2));
        else if (command === 'review') {
          const parts = value ? value.split(/\s+/) : [];
          if (parts.length === 2) {
            requireValue(['approve', 'reject'].includes(parts[1]), 'invalid-arguments');
            const reviewed = reviewCandidateV2(project, parts[0], parts[1]);
            const publication = reviewed.publication;
            notify(ctx, JSON.stringify({ status: reviewed.status, duplicate: reviewed.duplicate,
              ...(publication ? { publication: { id: publication.record?.id, revision: publication.record?.revision,
                status: publication.status, projection: publication.projection, reason: publication.reason } } : {}) }, null, 2));
          } else {
            requireValue(parts.length <= 1, 'invalid-arguments');
            const all = listCandidatesV2(project).candidates;
            if (parts.length) {
              const item = all.find(item => item.candidate.requestId === parts[0]); requireValue(!!item, 'not-found');
              const content = item.candidate.entry.content;
              notify(ctx, JSON.stringify({ ...item, candidate: { ...item.candidate, entry: { ...item.candidate.entry, content: content.slice(0, 10000) } },
                contentTruncated: content.length > 10000, fullContent: content.length > 10000 ? 'Use the explicit v2 candidates CLI for complete content before approval' : undefined }, null, 2));
            } else {
              const pending = all.filter(item => item.status === 'pending' || item.publication === 'pending');
              notify(ctx, JSON.stringify({ total: pending.length, truncated: pending.length > 20,
                candidates: pending.slice(0, 20).map(item => ({ id: item.candidate.requestId, title: item.candidate.entry.title,
                  kind: item.candidate.entry.kind, verification: item.candidate.entry.verification, status: item.status, reviewer: item.reviewer,
                  target: item.candidate.target, publication: item.publication })) }, null, 2));
            }
          }
        }
        else throw new MemoryError('invalid-arguments');
      } catch (error) { notify(ctx, `Memory command failed: ${reason(error)}`, true); }
    },
  });
  pi.registerTool({
    name: 'project_memory_search', label: 'Search project working memory',
    description: 'Read-only local v2 project memory. Requires a .pi-root and initialized v2 config. Includes bounded current overview/state plus keyword/BM25 knowledge hits. Defaults to the current folder and inheriting ancestors; siblings require allFolders or an explicit entity reference. Claims and tool observations are unverified unless independently checked; no cross-project or network access.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), includeInactive: Type.Optional(Type.Boolean()), folder: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })), allFolders: Type.Optional(Type.Boolean()), entityId: Type.Optional(Id) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireValue(!signal?.aborted, 'cancelled');
      const project = projectAt(ctx), work = readWorkingV2(project, { folder: params.folder });
      return result({ ...searchV2(project, params.query, { limit: params.limit ?? 8, includeInactive: params.includeInactive ?? false, entityId: params.entityId, folder: params.folder, allFolders: params.allFolders ?? false }),
        working: { revisions: work.revisions, overview: work.overview.slice(0, 2500), state: work.state.slice(0, 5500) } });
    },
  });
  pi.registerTool({
    name: 'project_memory_save', label: 'Save project working memory',
    description: 'Explicit local v2 write only. target knowledge creates a record or revises an explicit id using expectedRevision; target state/overview requires expectedRevision (0 initially). Never runs calculations, changes scientific output or migrates old packs. State nextSteps require actual user-confirmation provenance and evidence. requestId enables safe retries. folder defaults to the current directory for new knowledge/state; inherit defaults true. Existing knowledge revisions retain their folder unless explicitly changed.',
    promptGuidelines: ['Preserve system/method/software/version, charge/spin, units and convergence scope when available. Never turn a plan, assistant claim, normal termination or provenance quote into a verified result. Do not invent evidence. Read revisions before updating. Cards require explicit unknowns, attributed fields and fixed source revisions; normal termination is not convergence. Revise the same result ID explicitly to correct a conflicting value; do not omit an existing card. Save only requested or task-relevant knowledge; working state is not authorization to execute its steps.'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    parameters: Type.Object({ target: Choice(['knowledge', 'state', 'overview']), folder: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })), inherit: Type.Optional(Type.Boolean()), entry: Type.Optional(Entry), state: Type.Optional(State),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })), id: Type.Optional(Id), expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })), requestId: Type.Optional(Id) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireValue(!signal?.aborted, 'cancelled');
      const project = projectAt(ctx), options = params.requestId ? { requestId: params.requestId } : {};
      if (params.target === 'knowledge') {
        requireValue(!params.state && params.content === undefined && params.entry !== undefined, 'invalid-arguments');
        const previous = params.id ? getV2(project, params.id).entry.scope : undefined;
        const entry = { ...params.entry, scope: normalizeScope({
          path: params.folder ?? (params.id ? normalizeScope(previous).path : scopeFor(project).path),
          inherit: params.inherit ?? normalizeScope(previous).inherit,
        }) };
        return result(params.id ? reviseV2(project, params.id, params.expectedRevision, entry, options)
          : (requireValue(params.expectedRevision === undefined, 'invalid-arguments'), saveV2(project, entry, options)));
      }
      requireValue(params.id === undefined && params.entry === undefined && Number.isSafeInteger(params.expectedRevision), 'invalid-arguments');
      requireValue(params.target === 'state' ? params.state !== undefined && params.content === undefined : params.content !== undefined && params.state === undefined, 'invalid-arguments');
      return result(updateWorkingV2(project, params.target, params.expectedRevision, params.target === 'state' ? params.state : { content: params.content }, { ...options,
        scope: normalizeScope({ path: params.folder ?? (params.target === 'overview' ? '.' : scopeFor(project).path), inherit: params.inherit ?? true }),
      }));
    },
  });
}
