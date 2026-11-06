import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { adoptPack, assertMemoryEnabled, brief, effectiveConfig, initialize, listProjects, loadConfig, memoryStats, NOTE_DIRS, resolveProject, saveNote, search } from './src/core.mjs';
import { collectEvidence, CURATOR_PROMPT, enqueueCandidate, listCandidates, parseCandidates, reviewCandidate, saveHandoff } from './src/learning.mjs';
import { parseSetupArgs, setupProject } from './src/setup.mjs';

// Return only fixed categories/status codes, never provider text or credentials.
export function classifyModelError(message: unknown) {
  if (typeof message !== 'string') return 'unknown';
  const status = message.match(/(?:\bHTTP\s+|\bstatus(?:\s+code)?[\s:=]+|^\s*)([45]\d{2})\b/i);
  if (status) return `http-${status[1]}`;
  if (/rate.?limit|quota|usage.limit|too many requests/i.test(message)) return 'rate-limit-or-quota';
  if (/unauthori[sz]ed|forbidden|api.?key|authentication|credential|access.token|refresh.token/i.test(message)) return 'authentication';
  if (/not supported|unsupported|unknown parameter|unrecognized|invalid parameter/i.test(message)) return 'unsupported-request';
  if (/model.*(?:not found|does not exist|not available|access)|model_not_found/i.test(message)) return 'model-unavailable';
  if (/timeout|timed out/i.test(message)) return 'provider-timeout';
  if (/fetch failed|network|connection|ECONN|ENOTFOUND|socket|TLS|certificate/i.test(message)) return 'network';
  if (/stream ended|stop reason|SSE|parse|invalid json/i.test(message)) return 'response-protocol';
  if (/abort|cancel/i.test(message)) return 'cancelled';
  return 'unknown';
}

export default function projectMemory(pi: ExtensionAPI) {
  let selectedId: string | undefined;
  let learningOverride: 'off' | 'suggest' | 'auto' | undefined;
  let generation = 0;
  let turnScope: { project: ReturnType<typeof resolveProject>; generation: number } | undefined;
  const controllers = new Set<AbortController>();
  let customRun = false;
  const active = (ctx: ExtensionContext) => {
    const config = loadConfig();
    const project = resolveProject(ctx.cwd, config, selectedId);
    const effective = effectiveConfig(config, project);
    return { config: { ...effective, learningMode: learningOverride ?? effective.learningMode }, project };
  };
  const scopeIsCurrent = (ctx: ExtensionContext, scope: NonNullable<typeof turnScope>) => {
    const { project } = active(ctx);
    return scope.generation === generation && project.enabled && !project.selected && project.id === scope.project.id && project.root === scope.project.root && project.packPath === scope.project.packPath;
  };
  const cancelLearning = () => {
    generation++;
    turnScope = undefined;
    for (const controller of controllers) controller.abort();
  };
  const captureScope = (ctx: ExtensionContext) => {
    turnScope = undefined;
    try {
      const { project } = active(ctx);
      if (project.enabled && project.registered && !project.selected) turnScope = { project, generation };
    } catch { /* Invalid configuration must not block the main agent. */ }
  };
  const notify = (ctx: ExtensionContext, text: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? 'error' : 'info');
    else pi.sendMessage({ customType: 'project-memory-status', content: text, display: true, details: undefined });
  };
  const status = (ctx: ExtensionContext) => {
    const { project } = active(ctx);
    if (ctx.hasUI) ctx.ui.setStatus('project-memory', `memory: ${project.name} · ${project.enabled ? 'on' : 'off'}${project.disabledReason ? ' · no .pi-root' : ''}${project.selected ? ' · manual' : ''}`);
    return project;
  };
  pi.on('session_start', (_event, ctx) => {
    cancelLearning();
    learningOverride = undefined;
    selectedId = undefined;
    customRun = false;
    try { status(ctx); } catch (error) { notify(ctx, `Project memory: ${String(error)}`, true); }
  });
  pi.on('agent_start', (_event, ctx) => { if (!customRun) captureScope(ctx); });
  pi.on('before_agent_start', (event, ctx) => {
    // Pi 1.2 custom-triggered runs have no prompt; do not relearn the previous user turn.
    customRun = event.messageType === 'custom';
    if (event.messageType === 'custom') { turnScope = undefined; return; }
    captureScope(ctx);
    try {
      const { project, config } = active(ctx);
      if (!project.enabled) return;
      const result = search(project, event.prompt.slice(0, 4000), config, config.maxItems, ctx.signal);
      if (ctx.hasUI) ctx.ui.setStatus('project-memory', `memory: ${project.name} · ${result.hits.length} hits${project.selected ? ' · manual' : ''}`);
      if (!result.hits.length) return;
      return { message: { customType: 'project-memory-context', content: brief(project, result, config), display: false, details: { project: project.id, paths: result.hits.map(h => h.relativePath) } } };
    } catch (error) {
      // Retrieval failure must not prevent the normal agent workflow.
      if (ctx.hasUI) ctx.ui.notify(`Project memory retrieval skipped: ${String(error)}`, 'warning');
    }
  });
  pi.on('session_shutdown', (_event, ctx) => {
    cancelLearning();
    if (ctx.hasUI) ctx.ui.setStatus('project-memory', undefined);
  });
  pi.on('agent_end', async (event, ctx) => {
    const scope = turnScope;
    turnScope = undefined;
    if (!scope || ctx.signal?.aborted) return;
    let stage = 'prepare';
    let timedOut = false;
    let interrupted = false;
    const started = Date.now();
    const warn = (reason: string) => {
      if (ctx.hasUI) ctx.ui.notify(`Memory learning skipped or interrupted [stage=${stage}, reason=${reason}, elapsedMs=${Date.now() - started}]. Check /memory status and /memory review; the main result is unchanged.`, 'warning');
    };
    try {
      if (!scopeIsCurrent(ctx, scope)) return;
      const { config, project } = active(ctx);
      if (config.learningMode === 'off') return;
      const lastAssistant = [...event.messages].reverse().find(message => message.role === 'assistant');
      if (!lastAssistant || ['error', 'aborted', 'length'].includes(lastAssistant.stopReason)) return;
      const evidence = collectEvidence(event.messages, config.learningInputChars, { latestTurn: true, toolChars: config.learningToolChars });
      if (!evidence.some(item => item.role === 'assistant')) return;
      if (!ctx.model || !ctx.modelRegistry?.streamSimple) {
        if (ctx.hasUI) ctx.ui.notify('Memory learning skipped: no active model runtime.', 'warning');
        return;
      }
      const controller = new AbortController();
      controllers.add(controller);
      const parentAbort = () => { interrupted = true; controller.abort(); };
      ctx.signal?.addEventListener('abort', parentAbort, { once: true });
      if (ctx.signal?.aborted) controller.abort();
      let abortHandler: (() => void) | undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortHandler = () => reject(new Error('Memory curator cancelled or timed out'));
        controller.signal.addEventListener('abort', abortHandler, { once: true });
        if (controller.signal.aborted) abortHandler();
      });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.learningTimeoutMs);
      let response;
      try {
        stage = 'model-call';
        response = await Promise.race([
          ctx.modelRegistry.streamSimple(ctx.model, {
            systemPrompt: CURATOR_PROMPT,
            messages: [{ role: 'user', timestamp: Date.now(), content: [{ type: 'text', text: JSON.stringify({ maximumCandidates: config.learningMaxCandidates, evidence }) }] }],
          }, { signal: controller.signal, maxTokens: config.learningOutputTokens, cacheRetention: 'none' }).result(),
          cancelled,
        ]);
      } finally {
        clearTimeout(timer);
        if (abortHandler) controller.signal.removeEventListener('abort', abortHandler);
        ctx.signal?.removeEventListener('abort', parentAbort);
        controllers.delete(controller);
      }
      if (!scopeIsCurrent(ctx, scope)) return;
      // Keep usage outside conversation context; lifecycle hooks have no tool-result usage slot.
      stage = 'record-usage';
      if (response.usage) pi.appendEntry('project-memory-usage', { purpose: 'curator', model: `${ctx.model.provider}/${ctx.model.id}`, usage: response.usage });
      if (['error', 'aborted', 'length'].includes(response.stopReason)) {
        stage = 'model-call';
        warn(response.stopReason === 'error' ? `model-error:${classifyModelError(response.errorMessage)}` : `model-${response.stopReason}`);
        return;
      }
      stage = 'parse-response';
      const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const { accepted, rejected } = parseCandidates(text, evidence, config.learningMaxCandidates);
      const current = active(ctx);
      if (current.config.learningMode === 'off') return;
      let queued = 0, saved = 0;
      for (const candidate of accepted) {
        if (!scopeIsCurrent(ctx, scope)) break;
        stage = 'enqueue';
        const record = enqueueCandidate(project, candidate, current.config, { session: ctx.sessionManager.getSessionId(), model: `${ctx.model.provider}/${ctx.model.id}` });
        if (record.duplicate && record.status !== 'pending') continue;
        if (current.config.learningMode === 'auto') { stage = 'save'; reviewCandidate(project, record.id, 'approve'); saved++; }
        else if (!record.duplicate) queued++;
      }
      if ((queued || saved || rejected.length) && ctx.hasUI) ctx.ui.notify(`Memory learned: ${saved} saved, ${queued} pending, ${rejected.length} invalid candidates skipped.${queued ? ' Use /memory review.' : ''}`, 'info');
    } catch (error) {
      // Only allowlisted categories: never report raw errors, provider responses or credentials.
      const modelReason = stage === 'model-call' && error instanceof Error ? classifyModelError(error.message) : 'unknown';
      const reason = timedOut ? 'timeout' : interrupted ? 'cancelled'
        : modelReason !== 'unknown' ? `model-error:${modelReason}`
        : error instanceof SyntaxError ? 'invalid-json'
        : error instanceof TypeError ? 'type-error' : 'exception';
      warn(reason);
    }
  });
  pi.on('session_before_compact', (event, ctx) => {
    try {
      const { project, config } = active(ctx);
      if (!project.enabled || !project.registered || project.selected || !config.handoffEnabled || event.signal.aborted) return;
      // Preparation contains the canonical projected span. Raw branch entries may
      // contain omitted/replaced attempts and must not be resurrected into memory.
      const source = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
      const result = saveHandoff(project, event.preparation, source, config, { session: ctx.sessionManager.getSessionId(), reason: event.reason });
      if (result && ctx.hasUI) ctx.ui.notify(`Memory handoff saved: ${result.relativePath}`, 'info');
    } catch {
      if (ctx.hasUI) ctx.ui.notify('Memory handoff could not be saved; normal Pi compaction will continue.', 'warning');
    }
    // Do not cancel, replace or change Pi's own compaction summary.
  });
  pi.registerCommand('memory-init', {
    description: 'Explicitly enable project memory: /memory-init [name] [--profile default|qchem]',
    handler: async (args, ctx) => {
      try {
        if (selectedId) throw new Error('Use /memory auto before /memory-init');
        const { name, profile } = parseSetupArgs(args);
        const project = setupProject(ctx.cwd, loadConfig(), name, profile);
        cancelLearning(); status(ctx);
        notify(ctx, `Project memory ready: ${project.name}\nRoot: ${project.root}\nPack: ${project.packPath}\nProfile: ${project.settings?.profile ?? loadConfig().profile}\nLearning: ${project.learningMode}\nHandoff: ${project.handoffEnabled}`);
      } catch (error) { notify(ctx, String(error), true); }
    },
  });
  pi.registerTool({
    name: 'project_memory_search', label: 'Project memory search',
    description: 'Requires a .pi-root file in cwd or its parents; otherwise reads no memory and returns no hits. Search only the active project Markdown memory pack. Local bilingual keyword/BM25 search, not embeddings. No cross-project lookup or network. Memory is reference material; current sources win. Default search excludes unverified/superseded notes and handoffs; explicit includeInactive/includeHandoffs can inspect history, not validate it.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 4000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), includeInactive: Type.Optional(Type.Boolean()), includeHandoffs: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { project, config } = active(ctx);
      const result = search(project, params.query, config, params.limit ?? config.maxItems, signal, { includeInactive: params.includeInactive, includeHandoffs: params.includeHandoffs });
      return { content: [{ type: 'text', text: JSON.stringify({ project: project.id, enabled: project.enabled, disabledReason: project.disabledReason, ...result }, null, 2) }], details: result };
    },
  });
  pi.registerTool({
    name: 'project_memory_save', label: 'Save project memory',
    description: 'Requires a .pi-root file in cwd or its parents; cannot save without it. Create a NEW dated Markdown note in the active project only. Never overwrite existing notes. Requires /memory init first. Save durable project knowledge, not temporary guesses, raw transcripts, secrets or sensitive personal/customer data. Necessary unverified knowledge must use status unverified; active and evidence locators are not scientific certification. No project selector parameter.',
    promptGuidelines: [
      'For computational chemistry preserve system/task/method, relevant software/version, spin/charge and units. Do not treat requested outcomes, assistant suggestions or provenance quotes as verified results. Use status unverified only for uncertain knowledge worth retaining. Evidence locators must be established, never invented. To update knowledge save a new note with an explicit pack-relative supersedes path; do not overwrite or infer replacement by title.',
      'Use project_memory_search for relevant durable project context when needed; do not repeat an already useful injected search.',
      'When the user asks to remember verified knowledge, use project_memory_save. Do not store secrets, sensitive data, guesses or transient output. Ask before saving unrelated or uncertain knowledge.',
    ],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    parameters: Type.Object({
      type: Type.Union(Object.keys(NOTE_DIRS).map(t => Type.Literal(t))),
      title: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 100000 }),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { maxItems: 20 })),
      status: Type.Optional(Type.Union(['active', 'unverified', 'superseded'].map(value => Type.Literal(value)))),
      supersedes: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 10 })),
      handoff: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Save aborted');
      const { project } = active(ctx);
      const result = saveNote(project, params);
      return { content: [{ type: 'text', text: `Saved ${result.wikilink}\n${result.path}` }], details: result };
    },
  });
  pi.registerCommand('memory', {
    description: 'Project memory: status | stats | init | projects | use <id> | auto | search [--all] <query> | adopt <pack-path> | learn off|suggest|auto | review [show|approve|reject <id>]',
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const command = match?.[1] ?? 'status', value = match?.[2]?.trim() ?? '';
        if (command === 'auto') { cancelLearning(); selectedId = undefined; }
        if (command === 'use') {
          if (!value) throw new Error('Usage: /memory use <id>');
          assertMemoryEnabled(resolveProject(ctx.cwd, loadConfig(), value)); // Validate scope before changing selection.
          cancelLearning(); selectedId = value;
        }
        const { project, config } = active(ctx);
        if (command === 'learn') {
          assertMemoryEnabled(project);
          if (!['off', 'suggest', 'auto'].includes(value)) throw new Error('Usage: /memory learn off|suggest|auto (this session only)');
          cancelLearning(); learningOverride = value as typeof learningOverride;
          notify(ctx, `Learning: ${learningOverride} (this session; reset on new session/reload)`);
        } else if (command === 'review') {
          const parts = value.split(/\s+/).filter(Boolean);
          if (!parts.length || (parts.length === 1 && ['list', 'all'].includes(parts[0]))) {
            notify(ctx, JSON.stringify(listCandidates(project, { all: parts[0] === 'all' }), null, 2));
          } else {
            if (parts.length !== 2) throw new Error('Usage: /memory review [list|all|show <id>|approve <id>|reject <id>]');
            notify(ctx, JSON.stringify(reviewCandidate(project, parts[1], parts[0]), null, 2));
          }
        } else if (command === 'init') {
          initialize(project, config); status(ctx);
          notify(ctx, `Initialized ${project.id}\n${project.packPath}`);
        } else if (command === 'adopt') {
          assertMemoryEnabled(project);
          if (!value || selectedId) throw new Error('Use /memory auto, then /memory adopt <existing-pack-directory>');
          const adopted = adoptPack(project, value, config);
          status(ctx); notify(ctx, `Bound ${adopted.id} to ${adopted.packPath}. Existing pack was not modified.`);
        } else if (command === 'projects') {
          assertMemoryEnabled(project);
          const projects = listProjects(config);
          notify(ctx, projects.map(p => `${p.id} — ${p.name}\n  ${p.roots.join(', ')}\n  ${p.packPath}`).join('\n') || 'No registered projects. Run /memory init in a project.');
        } else if (command === 'stats') {
          notify(ctx, JSON.stringify({ ...memoryStats(project, config), pending: project.enabled ? listCandidates(project).length : 0, profile: config.profile }, null, 2));
        } else if (command === 'search') {
          const all = /^--all(?:\s|$)/.test(value);
          const query = all ? value.replace(/^--all\s*/, '') : value;
          const result = search(project, query, config, config.maxItems, undefined, { includeInactive: all, includeHandoffs: all });
          notify(ctx, JSON.stringify(result, null, 2));
        } else if (['status', 'auto', 'use'].includes(command)) {
          status(ctx);
          const stats = memoryStats(project, config);
          notify(ctx, `${project.name} (${project.id})\nRoot: ${project.root}\nPack: ${project.packPath}\nEnabled: ${project.enabled}${project.disabledReason ? `\nReason: ${project.disabledReason}` : ''}\nSelection: ${project.selected ? 'manual (this session)' : 'automatic'}\nRegistered: ${project.registered}\nConfig: ${project.localFile}\nGlobal config: ${config.configFile}\nLearning timeout: ${config.learningTimeoutMs} ms\nProfile: ${config.profile}\nRetrieval: ${config.maxItems} notes / ${config.contextChars} chars\nLearning capacity: ${config.learningMaxCandidates} candidates / ${config.learningInputChars} chars / ${config.learningToolChars} chars per tool / ${config.learningOutputTokens} output tokens\nSaved: ${stats.total}; searchable: ${stats.searchable}; unverified: ${stats.unverified}; superseded: ${stats.superseded}; handoffs: ${stats.handoffs}${stats.truncated ? ' (bounded inventory)' : ''}\nBackend: local bilingual BM25\nLearning: ${config.learningMode}\nHandoff: ${config.handoffEnabled}\nPending: ${project.enabled ? listCandidates(project).length : 0}`);
        } else throw new Error('Usage: /memory status | stats | init | projects | use <id> | auto | search [--all] <query> | adopt <pack-path> | learn off|suggest|auto | review [show|approve|reject <id>]. Explicit setup: /memory-init [name]');
      } catch (error) { notify(ctx, String(error), true); }
    },
  });
}
