import type { Role, Message, TokenUsage } from './types.js';
import { ModelClient } from './model.js';
import { ModelRouter } from './router.js';
import { Tools, toolDefinitions } from './tools.js';
import { systemPrompt } from './prompts.js';
import type { EventLog } from './events.js';
import { ConversationContext, newConversation, estimateMessages, estimateTokens, type ConversationState, type ContextEvent } from './conversation.js';

export interface AgentMemoryOptions {
  state?: ConversationState;
  onContext?: (event: ContextEvent) => void;
  checkpoint?: (state: ConversationState) => void;
  onItem?: (message: Message) => void;
}

export class Agent {
  usage: TokenUsage = { prompt: 0, completion: 0, total: 0 };
  constructor(public id: string, public role: Role, private root: string, private client: ModelClient, private router: ModelRouter, private tools: Tools, private log?: EventLog) {}

  async run(task: string, signal?: AbortSignal, onToken?: (s: string) => void, history: Message[] = [], memoryOptions: AgentMemoryOptions = {}) {
    const state = memoryOptions.state || newConversation(history.filter(message => message.role === 'user' || message.role === 'assistant'));
    const context = new ConversationContext(this.client.config || {}, state, memoryOptions.onContext, memoryOptions.checkpoint);
    const system = systemPrompt(this.role, this.root);
    const user: Message = { role: 'user', content: task };
    state.messages.push(user); memoryOptions.onItem?.(user);
    for (let iteration = 0, toolCount = 0; iteration < 20; iteration++) {
      signal?.throwIfAborted();
      const decision = this.router.route({ role: this.role, taskType: 'coding', complexity: 5, contextTokens: context.stats(system, toolDefinitions).estimatedInput, requiresTools: true, requiresLongContext: false, preferQuality: ['reviewer', 'planner'].includes(this.role) });
      let result, error: unknown, visibleOutput = false;
      const models = [decision.selectedModel, ...decision.fallbacks];
      for (const model of models) {
        signal?.throwIfAborted();
        const started = Date.now();
        try {
          await context.prepare(system, toolDefinitions, this.client, model, signal);
          const messages = context.requestMessages(system);
          this.log?.emit('model_route', { agentId: this.id, model, reason: decision.reason });
          result = await this.client.chat(messages, toolDefinitions, model, signal, token => { visibleOutput = true; onToken?.(token); }, { maxOutputTokens: context.limits.output });
          const output = estimateTokens(result.content + JSON.stringify(result.toolCalls));
          context.account(result.usage || { prompt: estimateMessages(messages, toolDefinitions), completion: output, total: estimateMessages(messages, toolDefinitions) + output, estimated: true });
          this.usage = { ...state.usage };
          this.router.record(model, true, Date.now() - started);
          break;
        } catch (e) {
          signal?.throwIfAborted();
          error = e;
          this.router.record(model, false, Date.now() - started);
          this.log?.emit('model_failure', { agentId: this.id, model, error: String(e) });
          if (visibleOutput) throw e;
        }
      }
      if (!result) throw error;
      const answer: Message = { role: 'assistant', content: result.content, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) };
      memoryOptions.onItem?.(answer);
      if (result.toolCalls.length === 0) { state.messages.push(answer); context.publish(system, toolDefinitions); return result.content; }
      const exchange: Message[] = [answer];
      for (const call of result.toolCalls) {
        signal?.throwIfAborted();
        if (++toolCount > 50) throw new Error('Agent vượt max tool calls');
        this.log?.emit('tool_start', { agentId: this.id, tool: call.function.name });
        const value = await this.tools.run(call.function.name, call.function.arguments, signal);
        const item: Message = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) };
        memoryOptions.onItem?.(item);
        exchange.push({ ...item, content: context.toolContent(item.content!) });
        this.log?.emit('tool_end', { agentId: this.id, tool: call.function.name, ok: value.ok });
      }
      state.messages.push(...exchange);
      context.publish(system, toolDefinitions);
    }
    throw new Error('Agent vượt max iterations');
  }
}
