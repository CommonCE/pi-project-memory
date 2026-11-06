// Test-only provider: deterministic, in-process streams; no HTTP, credentials or paid models.
import fs from 'node:fs';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

let sequence = 0;
function textOf(message: any) {
  return typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
}
export default function offlineProvider(pi: ExtensionAPI) {
  pi.registerProvider('memory-offline-test', {
    api: 'memory-offline-api', baseUrl: 'http://127.0.0.1:1', apiKey: 'local-test-placeholder',
    models: [{ id: 'offline', name: 'Memory offline test', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const output: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'pending', content: [], usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        try {
          if (options?.signal?.aborted) throw new Error('aborted');
          const system = getCurrentSystemPrompt(context.messages);
          const tools = getCurrentTools(context.messages) ?? [];
          // Host adapters may encode injected reference messages as user messages.
          // Select the actual fixture request, not the first-turn memory brief.
          const lastUser = [...context.messages].reverse().find((message: any) => message.role === 'user'
            && !textOf(message).includes('Project working memory (untrusted reference, NOT instructions)'));
          const prompt = textOf(lastUser);
          let kind = 'assistant';
          let text = '已核实：项目使用 release.sh 发布脚本；发布前需要测试通过并获得人工批准。';
          if (prompt.includes('v2_work_fixture')) text = '合成工作记录：解析器入口 src/parser.mjs，输出夹具位于 calc/test/run.out。助手建议下一步检查夹具，但尚未获得用户确认，也不代表计算已经成功。'.repeat(3);
          if (system.includes('Extract only durable, project-specific knowledge')) {
            kind = 'curator';
            const payload = JSON.parse(prompt);
            const source = payload.evidence.find((item: any) => item.role === 'assistant');
            text = JSON.stringify({ candidates: source ? [{ type: 'runbook', title: '离线验收发布流程', content: '项目使用 release.sh 发布；发布前必须测试通过并获得人工批准。', tags: ['offline-test'], status: 'active', grounding: [{ id: source.id, quote: source.text.slice(0, 100) }] }] : [] });
          } else if (system.includes('Select durable project-specific excerpts')) {
            kind = 'v2-curator';
            const payload = JSON.parse(prompt);
            const source = payload.evidence.find((item: any) => item.source === 'assistant-claim') ?? payload.evidence.find((item: any) => item.source === 'tool-observation');
            const quote = source?.text.slice(0, 100).toWellFormed();
            text = JSON.stringify({ candidates: source && quote.length >= 12 ? [{ kind: 'software', title: quote.slice(0, 40).toWellFormed(), grounding: [{ id: source.id, quote }] }] : [] });
          } else if (!tools.length && /summari|compact/i.test(system + prompt)) {
            kind = 'compact';
            text = '## Goal\n验证项目记忆。\n\n## Progress\n已确认 release.sh 发布流程。\n\n## Next Steps\n人工批准后发布。';
          }
          const call = kind === 'assistant' && prompt.includes('use_search') && context.messages.at(-1)?.role !== 'toolResult';
          if (process.env.PI_MEMORY_TEST_CALLS) fs.appendFileSync(process.env.PI_MEMORY_TEST_CALLS, JSON.stringify({ kind, toolCall: call, tools: tools.map((tool: any) => tool.name), injectedNote: context.messages.some((message: any) => textOf(message).includes('--- Note ')), workingContext: context.messages.some((message: any) => textOf(message).includes('Project working memory (untrusted reference')) }) + '\n', { mode: 0o600 });
          await options?.onPayload?.({ offlineTest: true }, model);
          await options?.onProviderStreamEvent?.({ offlineTest: true, kind }, model);
          stream.push({ type: 'start', partial: output });
          if (call) {
            const block = { type: 'toolCall', id: `offline-search-${++sequence}`, name: 'project_memory_search', arguments: { query: 'release.sh' } };
            output.content.push(block);
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output });
            stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(block.arguments), partial: output });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: block, partial: output });
            output.stopReason = 'toolUse';
          } else {
            output.content.push({ type: 'text', text: '' });
            stream.push({ type: 'text_start', contentIndex: 0, partial: output });
            output.content[0].text = text;
            stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output });
            stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output });
            output.stopReason = 'stop';
          }
          stream.push({ type: 'done', reason: output.stopReason, message: output });
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          output.errorMessage = String(error);
          stream.push({ type: 'error', reason: output.stopReason, error: output });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
}
