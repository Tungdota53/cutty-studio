import { z } from 'zod';
import type { TokenUsage } from './types.js';

export const runBudgetSchema = z.object({ maxTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), maxCostUSD: z.number().finite().min(0).optional() });
export const modelRatesSchema = z.record(z.string().min(1), z.object({ inputPerMillion: z.number().finite().nonnegative(), outputPerMillion: z.number().finite().nonnegative(), cachedInputPerMillion: z.number().finite().nonnegative().optional() }));
export type RunBudget = z.infer<typeof runBudgetSchema>;
export type ModelRates = z.infer<typeof modelRatesSchema>;
export class BudgetExceededError extends Error { constructor(message: string) { super(message); this.name = 'BudgetExceededError'; } }
export class BudgetTracker {
  private started = Date.now();
  private entries = new Map<string, { prompt: number; completion: number; cached: number; actualTokens: number; estimatedTokens: number; knownCostUSD: number; costEstimated: boolean; unpricedTokens: number; modelCalls: number; usageReports: number }>();
  private modelCalls = 0;
  private toolCalls = 0;
  readonly budget: RunBudget;
  readonly rates: ModelRates;
  constructor(options: { budget?: RunBudget; rates?: ModelRates; agentId?: string; taskId?: string } = {}) {
    this.budget = runBudgetSchema.parse(options.budget || {}); this.rates = modelRatesSchema.parse(options.rates || {}); this.identity = { agentId: options.agentId, taskId: options.taskId };
  }
  private identity: { agentId?: string; taskId?: string };
  private entry(model: string) {
    let value = this.entries.get(model);
    if (!value) { value = { prompt: 0, completion: 0, cached: 0, actualTokens: 0, estimatedTokens: 0, knownCostUSD: 0, costEstimated: false, unpricedTokens: 0, modelCalls: 0, usageReports: 0 }; this.entries.set(model, value); }
    return value;
  }
  beforeModelCall() {
    const stats = this.snapshot();
    if (this.budget.maxTokens && stats.tokens >= this.budget.maxTokens) throw new BudgetExceededError('Đã hết ngân sách token; dừng trước lượt gọi model tiếp theo.');
    if (this.budget.maxCostUSD && stats.knownCostUSD >= this.budget.maxCostUSD) throw new BudgetExceededError('Đã hết ngân sách chi phí cấu hình; dừng trước lượt gọi model tiếp theo.');
  }
  modelCall(model: string) { this.beforeModelCall(); this.modelCalls++; this.entry(model).modelCalls++; }
  toolCall() { this.toolCalls++; }
  recordUsage(model: string, usage: TokenUsage) {
    const finite = (value: number | undefined) => Number.isFinite(value) && value! > 0 ? value! : 0;
    const prompt = finite(usage.prompt), completion = finite(usage.completion), cached = Math.min(prompt, finite(usage.cached));
    const tokens = Math.max(finite(usage.total), prompt + completion), entry = this.entry(model), rate = this.rates[model];
    entry.usageReports++;
    entry.prompt += prompt; entry.completion += completion; entry.cached += cached;
    if (usage.estimated) entry.estimatedTokens += tokens; else entry.actualTokens += tokens;
    if (rate) {
      entry.knownCostUSD += ((prompt - cached) * rate.inputPerMillion + cached * (rate.cachedInputPerMillion ?? rate.inputPerMillion) + completion * rate.outputPerMillion) / 1_000_000;
      entry.costEstimated ||= !!usage.estimated;
    } else entry.unpricedTokens += tokens;
  }
  snapshot() {
    const models = Object.fromEntries([...this.entries].map(([model, value]) => [model, { ...value }]));
    const sum = (key: 'actualTokens' | 'estimatedTokens' | 'knownCostUSD' | 'unpricedTokens') => [...this.entries.values()].reduce((value, entry) => value + entry[key], 0);
    const actualTokens = sum('actualTokens'), estimatedTokens = sum('estimatedTokens'), tokens = actualTokens + estimatedTokens, knownCostUSD = sum('knownCostUSD'), unpricedTokens = sum('unpricedTokens');
    const unreportedModelCalls = [...this.entries.values()].reduce((sum, entry) => sum + Math.max(0, entry.modelCalls - entry.usageReports), 0);
    const costKnown = (this.entries.size > 0 || Object.keys(this.rates).length > 0) && unpricedTokens === 0 && unreportedModelCalls === 0 && [...this.entries.keys()].every(model => !!this.rates[model]);
    const warnings: string[] = [];
    if (this.budget.maxTokens && tokens >= this.budget.maxTokens * .8) warnings.push('Token budget ≥80%');
    if (this.budget.maxCostUSD && knownCostUSD >= this.budget.maxCostUSD * .8) warnings.push('Cost budget ≥80%');
    if (this.budget.maxCostUSD && !costKnown) warnings.push('Cost unknown: configure model rates and inspect unreported API usage.');
    return { ...this.identity, tokens, actualTokens, estimatedTokens, costUSD: costKnown ? knownCostUSD : null, knownCostUSD, costKnown, costEstimated: estimatedTokens > 0, pricingSource: 'configured' as const, unpricedTokens, unreportedModelCalls, modelCalls: this.modelCalls, toolCalls: this.toolCalls, durationMs: Math.max(0, Date.now() - this.started), warnings, budget: { ...this.budget }, remainingTokens: this.budget.maxTokens ? Math.max(0, this.budget.maxTokens - tokens) : null, remainingCostUSD: this.budget.maxCostUSD && costKnown ? Math.max(0, this.budget.maxCostUSD - knownCostUSD) : null, models };
  }
}
