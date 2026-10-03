import { describe, expect, it } from 'vitest';
import { BudgetExceededError, BudgetTracker, modelRatesSchema, runBudgetSchema } from '../src/budgets.js';
describe('Run budgets and honest task telemetry', () => {
  it('separates provider usage from estimates and prices cached input from configured rates', () => {
    const tracker = new BudgetTracker({ budget: { maxTokens: 1000 }, rates: { model: { inputPerMillion: 2, outputPerMillion: 4, cachedInputPerMillion: 1 } }, agentId: 'backend', taskId: 'T2' });
    tracker.modelCall('model'); tracker.toolCall(); tracker.recordUsage('model', { prompt: 100, completion: 50, cached: 40, total: 150 });
    tracker.modelCall('model'); tracker.recordUsage('model', { prompt: 20, completion: 10, total: 30, estimated: true });
    const stats = tracker.snapshot();
    expect(stats).toMatchObject({ agentId: 'backend', taskId: 'T2', tokens: 180, actualTokens: 150, estimatedTokens: 30, modelCalls: 2, toolCalls: 1, costKnown: true, costEstimated: true });
    expect(stats.costUSD).toBeCloseTo((60 * 2 + 40 + 50 * 4 + 20 * 2 + 10 * 4) / 1e6);
    expect(stats.remainingTokens).toBe(820); expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('warns at 80% and stops before the next model call once token or known cost cap is reached', () => {
    const tokens = new BudgetTracker({ budget: { maxTokens: 100 } });
    tokens.recordUsage('model', { prompt: 80, completion: 0, total: 80 }); expect(tokens.snapshot().warnings).toContain('Token budget ≥80%');
    tokens.modelCall('model'); tokens.recordUsage('model', { prompt: 20, completion: 0, total: 20 });
    expect(() => tokens.modelCall('model')).toThrow(BudgetExceededError); expect(tokens.snapshot().modelCalls).toBe(1);
    const cost = new BudgetTracker({ budget: { maxCostUSD: .001 }, rates: { model: { inputPerMillion: 1, outputPerMillion: 1 } } });
    cost.recordUsage('model', { prompt: 1000, completion: 0, total: 1000 }); expect(() => cost.beforeModelCall()).toThrow('chi phí');
  });
  it('leaves unknown model cost unknown and does not invent a rate or claim an enforceable dollar cap', () => {
    const tracker = new BudgetTracker({ budget: { maxCostUSD: 1 } });
    tracker.modelCall('unpriced'); tracker.recordUsage('unpriced', { prompt: 1000000, completion: 100, total: 1000100 });
    expect(tracker.snapshot()).toMatchObject({ costUSD: null, costKnown: false, remainingCostUSD: null, knownCostUSD: 0 });
    expect(tracker.snapshot().warnings.join(' ')).toContain('Cost unknown'); expect(() => tracker.beforeModelCall()).not.toThrow();
    expect(() => runBudgetSchema.parse({ maxTokens: -1 })).toThrow(); expect(() => modelRatesSchema.parse({ model: { inputPerMillion: -1, outputPerMillion: 1 } })).toThrow();
  });
});
