import type { Config } from './config.js';
import type { Message, TokenUsage, ToolCall } from './types.js';
export interface ChatResult { content: string; toolCalls: ToolCall[]; usage?: TokenUsage; model: string }
export interface ChatOptions { maxOutputTokens?: number }

export class ModelClient {
  private usageSupported = true;
  constructor(private c: Config) {}
  get config() { return this.c; }
  async models() {
    const response = await fetch(`${this.c.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.c.apiKey}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Models HTTP ${response.status}`);
    return (await response.json() as { data: { id: string }[] }).data.map(item => item.id);
  }

  async chat(messages: Message[], tools: unknown[], model = this.c.model, signal?: AbortSignal, onToken?: (s: string) => void, options: ChatOptions = {}): Promise<ChatResult> {
    let last: unknown;
    let requestUsage = this.usageSupported;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      let emitted = false;
      try {
        const response = await fetch(`${this.c.baseUrl}/chat/completions`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.c.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: true, ...(requestUsage ? { stream_options: { include_usage: true } } : {}), ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}) }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
        });
        if (response.status === 401 || response.status === 403) throw new Error(`Xác thực API thất bại (HTTP ${response.status}); kiểm tra khóa API`);
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          // Some compatible routers do not implement streaming usage yet.
          if (response.status === 400 && requestUsage && /stream_options|include_usage/i.test(detail)) { requestUsage = false; this.usageSupported = false; continue; }
          if (response.status === 429 || response.status >= 500) { last = new Error(`HTTP ${response.status}: ${detail}`); await this.backoff(attempt, signal); continue; }
          throw new Error(`API HTTP ${response.status}: ${detail}`);
        }
        if (!response.body) throw new Error('Response không có stream');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '', content = '';
        let usage: TokenUsage | undefined;
        const calls = new Map<number, ToolCall>();
        function consume(line: string) {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
          let json: any; try { json = JSON.parse(data); } catch { return; }
          if (json.error) throw new Error('API stream: ' + (json.error.message || 'unknown error'));
          if (json.usage && Number.isFinite(json.usage.prompt_tokens) && Number.isFinite(json.usage.completion_tokens)) {
            usage = { prompt: json.usage.prompt_tokens, completion: json.usage.completion_tokens, total: json.usage.total_tokens ?? json.usage.prompt_tokens + json.usage.completion_tokens, cached: json.usage.prompt_tokens_details?.cached_tokens || 0, estimated: false };
          }
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) { emitted = true; content += delta.content; onToken?.(delta.content); }
          for (const call of delta?.tool_calls || []) {
            emitted = true;
            const previous = calls.get(call.index) || { id: call.id || '', type: 'function' as const, function: { name: '', arguments: '' } };
            previous.id ||= call.id || ''; previous.function.name += call.function?.name || ''; previous.function.arguments += call.function?.arguments || ''; calls.set(call.index, previous);
          }
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
            for (const line of lines) consume(line);
          }
          buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
        } finally { reader.releaseLock(); }
        return { content, toolCalls: [...calls.values()], usage, model };
      } catch (error) {
        last = error; signal?.throwIfAborted();
        // Replaying after visible output could duplicate text or tool actions.
        if (emitted || /Xác thực|API HTTP|API stream/i.test(String(error))) throw error;
        if (attempt < 3) await this.backoff(attempt, signal);
      }
    }
    throw last || new Error('API không chấp nhận cấu hình streaming.');
  }
  private async backoff(attempt: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, Math.min(4000, 250 * 2 ** attempt));
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}
