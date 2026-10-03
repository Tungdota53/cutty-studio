import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { contextLimits } from '../src/conversation.js';
import { teamSchema } from '../src/roles.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function project(value: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-limits-')); roots.push(root);
  fs.mkdirSync(path.join(root, '.vibe'));
  fs.writeFileSync(path.join(root, '.vibe', 'config.json'), JSON.stringify(value));
  return root;
}
describe('Provider-sized context and optional run budgets', () => {
  it('loads windows larger than the old app cap without discarding project settings', () => {
    const c = loadConfig(project({ contextMode: 'manual', contextWindow: 4_194_304, maxOutputTokens: 131_072, model: 'large-window', maxAgentIterations: 0, maxAgentToolCalls: 0 }));
    expect(c.model).toBe('large-window');
    expect(c.contextMode).toBe('manual');
    expect(contextLimits(c)).toMatchObject({ window: 4_194_304, output: 131_072 });
    expect(c.maxAgentIterations).toBe(0);
    expect(c.maxAgentToolCalls).toBe(0);
  });
  it('migrates the old automatic fallback without changing explicit manual or larger windows', () => {
    const c = loadConfig(project({ contextMode: 'auto', contextWindow: 128_000 }));
    expect(c.contextMode).toBe('auto');
    expect(c.contextWindow).toBe(1_000_000);
    expect(loadConfig(project({ contextMode: 'manual', contextWindow: 128_000 })).contextWindow).toBe(128_000);
    expect(loadConfig(project({ contextMode: 'auto', contextWindow: 2_000_000 })).contextWindow).toBe(2_000_000);
  });
  it('accepts unlimited and high finite budgets but rejects unsafe or negative values', () => {
    expect(teamSchema.parse({ maxAgentIterations: 0, maxAgentToolCalls: 0 })).toMatchObject({ maxAgentIterations: 0, maxAgentToolCalls: 0 });
    expect(teamSchema.parse({ maxAgentIterations: 1000, maxAgentToolCalls: 10000 })).toMatchObject({ maxAgentIterations: 1000, maxAgentToolCalls: 10000 });
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(teamSchema.safeParse({ maxAgentIterations: value }).success).toBe(false);
  });
  it('retains output reserves and rejects windows with imprecise integer arithmetic', () => {
    expect(() => contextLimits({ contextWindow: Number.MAX_SAFE_INTEGER + 1, maxOutputTokens: 4096 })).toThrow();
    expect(() => contextLimits({ contextWindow: 4096, maxOutputTokens: 4096 })).toThrow('một nửa');
    const limits = contextLimits({ contextWindow: 4_194_304, maxOutputTokens: 131_072 });
    expect(limits.inputBudget + limits.output).toBeLessThan(limits.window);
  });
});
