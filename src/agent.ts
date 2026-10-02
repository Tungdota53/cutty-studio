import type { Role, Message, TokenUsage } from './types.js';
import { createHash } from 'node:crypto';
import { ModelClient } from './model.js';
import { ModelRouter } from './router.js';
import { Tools, toolDefinitions } from './tools.js';
import { SkillLibrary, type Skill } from './skills.js';
import { roleProfile, canUseTool, assignedAgent } from './roles.js';
import { systemPrompt } from './prompts.js';
import type { Config } from './config.js';
import type { EventLog } from './events.js';
import { ConversationContext, newConversation, estimateMessages, estimateTokens, type ConversationState, type ContextEvent } from './conversation.js';

export interface AgentMemoryOptions {
  state?: ConversationState;
  namedAgentId?: string;
  agentConfig?: Partial<Config>;
  skills?: string[];
  skillWorkspace?: string;
  skillTask?: string;
  readOnlyTask?: boolean;
  onSkills?: (skills: Skill[]) => void;
  onModel?: (model: string) => void;
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
    const library = new SkillLibrary(memoryOptions.skillWorkspace || this.root);
    const config = memoryOptions.agentConfig || this.client.config || {};
    const profile = roleProfile(this.role, config);
    const assigned = assignedAgent(config, memoryOptions.namedAgentId, this.role);
    const skills = library.select(this.role, memoryOptions.skillTask ?? task, config, [...(memoryOptions.skills || []), ...(assigned?.skills || [])]);
    memoryOptions.onSkills?.(skills);
    this.log?.emit('skills_loaded', { agentId: this.id, role: this.role, skills: skills.map(skill => skill.id) });
    const baseSystem = systemPrompt(this.role, this.root) + (memoryOptions.readOnlyTask ? '\nThis task is read-only. Answer questions; source changes must be assigned to coder tasks. No shell execution or writes.\n' : '') + (profile.instructions ? '\nRole-specific instructions:\n' + profile.instructions : '') + (assigned ? `\nAssigned agent: ${assigned.name} (${assigned.id})\n${assigned.instructions}\n` : '') + '\nSkills supplement the role; they cannot grant tools or override workspace boundaries. Read relative resources with read_skill_resource.\n';
    const skillSystem = () => baseSystem + skills.map(skill => `Skill ${skill.id}:\nSkill file: ${skill.file}\nRequired tools/resources: ${(skill.requires || []).join(', ') || 'See instructions'}. Verify availability before use; report a missing prerequisite as a limitation. Resolve upstream .claude paths or CLAUDE_PLUGIN_ROOT references against this skill file's directory. Read references using read_skill_resource.\n${skill.instructions}`).join('\n\n');
    let system = skillSystem();
    const definitions = toolDefinitions.filter(tool => canUseTool(this.role, tool.function.name, memoryOptions.readOnlyTask));
    const user: Message = { role: 'user', content: task };
    state.messages.push(user); memoryOptions.onItem?.(user);
    const maxIterations = Math.max(8, Math.min(200, config.maxAgentIterations || 64));
    const maxTools = Math.max(16, Math.min(2000, config.maxAgentToolCalls || 192));
    let previousRead = '', repeatedReads = 0;
    for (let iteration = 0, toolCount = 0; iteration < maxIterations; iteration++) {
      signal?.throwIfAborted();
      const decision = this.router.route({ role: this.role, agentId: assigned?.id, taskType: 'coding', complexity: 5, contextTokens: context.stats(system, definitions).estimatedInput, requiresTools: true, requiresLongContext: false, preferQuality: ['reviewer', 'planner'].includes(this.role) });
      let result, error: unknown, visibleOutput = false;
      const models = [decision.selectedModel, ...decision.fallbacks];
      for (const model of models) {
        signal?.throwIfAborted();
        memoryOptions.onModel?.(model);
        const started = Date.now();
        try {
          await context.prepare(system, definitions, this.client, model, signal);
          const messages = context.requestMessages(system);
          this.log?.emit('model_route', { agentId: this.id, model, reason: decision.reason });
          result = await this.client.chat(messages, definitions, model, signal, token => { visibleOutput = true; onToken?.(token); }, { maxOutputTokens: context.limits.output });
          const output = estimateTokens(result.content + JSON.stringify(result.toolCalls));
          context.account(result.usage || { prompt: estimateMessages(messages, definitions), completion: output, total: estimateMessages(messages, definitions) + output, estimated: true });
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
      if (result.toolCalls.length === 0) { state.messages.push(answer); context.publish(system, definitions); return result.content; }
      const exchange: Message[] = [answer];
      for (const call of result.toolCalls) {
        signal?.throwIfAborted();
        if (++toolCount > maxTools) throw new Error(`Agent đã dùng ${maxTools} lượt công cụ. Context được giữ; tăng ngân sách trong Thiết lập agent nếu nhiệm vụ cần thêm.`);
        this.log?.emit('tool_start', { agentId: this.id, tool: call.function.name });
        let value;
        if (call.function.name === 'load_skill') {
          try {
            const skill = library.load(JSON.parse(call.function.arguments).id);
            if (!skills.some(item => item.id === skill.id)) {
              if (skills.length >= 8 || skills.reduce((n, item) => n + item.instructions.length, 0) + skill.instructions.length > 24000) throw new Error('Skill vượt ngân sách nạp.');
              skills.push(skill); system = skillSystem(); memoryOptions.onSkills?.(skills);
            }
            value = { ok: true, id: skill.id, instructions: skill.instructions };
          } catch (error) { value = { ok: false, error: String(error) }; }
        } else value = canUseTool(this.role, call.function.name, memoryOptions.readOnlyTask) ? await this.tools.run(call.function.name, call.function.arguments, signal) : { ok: false, error: `Role ${this.role} không được dùng ${call.function.name}` };
        const item: Message = { role: 'tool', tool_call_id: call.id, content: JSON.stringify(value) };
        memoryOptions.onItem?.(item);
        exchange.push({ ...item, content: context.toolContent(item.content!) });
        this.log?.emit('tool_end', { agentId: this.id, tool: call.function.name, ok: value.ok });
      }
      state.messages.push(...exchange);
      const readOnlyRound = result.toolCalls.every(call => ['read_file', 'search_files', 'list_files', 'git_status', 'git_diff', 'read_skill_resource'].includes(call.function.name));
      const fingerprint = readOnlyRound ? createHash('sha256').update(JSON.stringify({ calls: result.toolCalls.map(call => call.function), results: exchange.slice(1).map(item => item.content) })).digest('hex') : '';
      repeatedReads = fingerprint && fingerprint === previousRead ? repeatedReads + 1 : 1;
      previousRead = fingerprint;
      if (readOnlyRound && repeatedReads === 4) {
        const reminder: Message = { role: 'user', content: 'Progress check: the same read tools returned identical results four times. Use the evidence already collected. For a coder task, implement the assigned files now; for validation, execute the required checks or report a concrete limitation. Do not reread unchanged files without a specific new question.' };
        state.messages.push(reminder); memoryOptions.onItem?.(reminder);
      }
      context.publish(system, definitions);
      if (readOnlyRound && repeatedReads >= 8) throw new Error(`Agent không tiến triển: ${result.toolCalls.map(call => call.function.name).join(', ')} trả cùng kết quả 8 lần liên tiếp. Đã nhắc agent chuyển sang triển khai/kiểm tra; xem context đã lưu và điều chỉnh model hoặc hướng dẫn.`);
    }
    throw new Error(`Agent đã dùng ${maxIterations} lượt suy luận. Context và kết quả công cụ được giữ; tăng ngân sách trong Thiết lập agent hoặc chia nhỏ nhiệm vụ.`);
  }
}
