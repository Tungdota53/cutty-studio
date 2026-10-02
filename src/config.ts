import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Quality, Role } from './types.js';
import { roleSchema, profileSchema, namedAgentSchema, defaultAgents, type NamedAgent, type RoleProfile } from './roles.js';
const Pool = z.object({ id: z.string(), tags: z.array(z.string()).default([]), priority: z.number().default(50), maxContext: z.number().optional(), estimatedLatencyClass: z.enum(['fast', 'medium', 'slow']).optional(), estimatedCostClass: z.enum(['low', 'medium', 'high']).optional() });
const FileConfig = z.object({
  agentProfiles: z.partialRecord(roleSchema, profileSchema.partial()).optional(),
  namedAgents: z.array(namedAgentSchema).max(32).optional(),
  model: z.string().optional(), maxAgents: z.number().int().positive().max(16).optional(), quality: z.enum(['fast', 'balanced', 'high', 'max']).optional(),
  contextWindow: z.number().int().min(4096).max(2097152).optional(), maxOutputTokens: z.number().int().min(128).max(65536).optional(),
  autoRunTests: z.boolean().optional(), reviewBeforeFinish: z.boolean().optional(), useWorktrees: z.boolean().optional(),
  models: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), modelPool: z.array(Pool).optional(),
  sshHosts: z.record(z.string(), z.object({ host: z.string(), port: z.number().default(22), username: z.string(), identityFile: z.string().optional(), remoteWorkspace: z.string(), jumpHost: z.string().optional() })).optional()
}).passthrough();
export type ModelCandidate = z.infer<typeof Pool>;
export interface Config {
  baseUrl: string; apiKey: string; model: string; maxAgents: number; workspace: string; debug: boolean; quality: Quality;
  autoRunTests: boolean; reviewBeforeFinish: boolean; useWorktrees: boolean; models: Record<string, string | string[]>; modelPool: ModelCandidate[];
  contextWindow?: number; maxOutputTokens?: number;
  agentProfiles?: Partial<Record<Role, Partial<RoleProfile>>>;
  namedAgents?: NamedAgent[];
  sshHosts: Record<string, { host: string; port: number; username: string; identityFile?: string; remoteWorkspace: string; jumpHost?: string }>;
}
function read(file: string) { try { return FileConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return {}; } }
export function loadConfig(workspace = process.env.VIBE_WORKSPACE || process.cwd()): Config {
  const user = read(path.join(os.homedir(), '.vibe', 'config.json'));
  const project = read(path.join(workspace, '.vibe', 'config.json'));
  const merged = { ...user, ...project };
  const model = process.env.VIBE_MODEL || merged.model || 'cx/gpt-5.6-sol';
  const roleEnv: Partial<Record<Role, string>> = { orchestrator: process.env.VIBE_ORCHESTRATOR_MODEL, planner: process.env.VIBE_PLANNER_MODEL, coder: process.env.VIBE_CODER_MODEL, tester: process.env.VIBE_TESTER_MODEL, reviewer: process.env.VIBE_REVIEWER_MODEL, judge: process.env.VIBE_JUDGE_MODEL };
  const models = { ...(merged.models || {}) };
  for (const [role, value] of Object.entries(roleEnv)) if (value) models[role] = value;
  return {
    baseUrl: (process.env.VIBE_BASE_URL || 'https://9router.tungdota.io.vn/v1').replace(/\/$/, ''), apiKey: process.env.VIBE_API_KEY || '',
    model, maxAgents: Number(process.env.VIBE_MAX_AGENTS || merged.maxAgents || 4), workspace: path.resolve(workspace), debug: process.env.VIBE_DEBUG === '1',
    quality: (process.env.VIBE_QUALITY || merged.quality || 'balanced') as Quality, autoRunTests: merged.autoRunTests ?? true,
    reviewBeforeFinish: merged.reviewBeforeFinish ?? true, useWorktrees: merged.useWorktrees ?? true, models,
    agentProfiles: merged.agentProfiles || {},
    namedAgents: merged.namedAgents ?? structuredClone(defaultAgents),
    modelPool: merged.modelPool || [{ id: model, tags: ['coding', 'reasoning', 'review', 'tools'], priority: 100 }], sshHosts: merged.sshHosts || {},
    contextWindow: Number(process.env.VIBE_CONTEXT_WINDOW || merged.contextWindow || 32768), maxOutputTokens: Number(process.env.VIBE_OUTPUT_TOKENS || merged.maxOutputTokens || 4096)
  };
}
export function assertConfigured(c: Config) { if (!c.apiKey) throw new Error('Thiếu khóa API. Nhập khóa trong Cài đặt hoặc đặt VIBE_API_KEY.'); }
