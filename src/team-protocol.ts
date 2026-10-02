import path from 'node:path';
import type { Task } from './types.js';
import { z } from 'zod';

export const phases = ['survey', 'specification', 'test_design', 'implementation', 'verification', 'review', 'challenge', 'audit', 'acceptance'] as const;
export const phaseSchema = z.enum(phases);
export type Phase = z.infer<typeof phaseSchema>;
export const phaseAgents: Partial<Record<Phase, string[]>> = {
  survey: ['explorer', 'planner'], specification: ['spec-backend', 'spec-ui'], test_design: ['test-writer'],
  verification: ['web-tester'], challenge: ['challenger'], audit: ['auditor', 'victory-auditor'], acceptance: ['acceptance']
};
export function taskPhase(task: Task): Phase {
  if (task.phase) return task.phase;
  if (task.agentId === 'challenger') return 'challenge';
  if (task.agentId === 'auditor' || task.agentId === 'victory-auditor') return 'audit';
  if (['spec-backend', 'spec-ui'].includes(task.agentId || '')) return 'specification';
  return ({ planner: 'survey', orchestrator: 'survey', coder: 'implementation', tester: 'verification', reviewer: 'review', judge: 'acceptance', general: 'implementation' } as const)[task.role];
}

export function validateProtocol(tasks: Task[]) {
  const allowed: Record<Phase, Task['role'][]> = {
    survey: ['planner', 'orchestrator'], specification: ['planner'], test_design: ['coder'], implementation: ['coder', 'general'],
    verification: ['tester'], review: ['reviewer'], challenge: ['tester'], audit: ['tester'], acceptance: ['judge']
  };
  for (const task of tasks) {
    if (!allowed[taskPhase(task)].includes(task.role)) throw new Error(`Task ${task.id}: phase không phù hợp role ${task.role}`);
    if (task.role === 'general' && task.expectedFiles?.length) throw new Error(`Task ${task.id}: general chỉ trả lời; giao thay đổi source cho coder`);
    for (const file of task.expectedFiles || []) {
      if (!file || path.win32.isAbsolute(file) || path.posix.isAbsolute(file) || file.split(/[\\/]/).includes('..') || /[*?:\0]/.test(file)) throw new Error(`Task ${task.id}: expectedFiles phải là đường dẫn tệp tương đối chính xác`);
    }
  }
}

/** Parallel reads are safe; shared implementation writes require disjoint declared file ownership. */
export function executionBatch(tasks: Task[], limit: number): Task[] {
  const ready = tasks.filter(task => task.status === 'ready').sort((a, b) => phases.indexOf(taskPhase(a)) - phases.indexOf(taskPhase(b)));
  if (!ready.length) return [];
  const phase = taskPhase(ready[0]), batch: Task[] = [], owned = new Set<string>();
  for (const task of ready.filter(item => taskPhase(item) === phase)) {
    if (batch.length >= limit) break;
    // Gate tasks run serially so a repair cannot race another validator's stale verdict.
    if (['tester', 'reviewer', 'judge', 'general'].includes(task.role)) return [task];
    if (task.role === 'coder') {
      const files = (task.expectedFiles || []).map(file => path.posix.normalize(file.replace(/\\/g, '/')).toLowerCase());
      if (!files.length) return batch.length ? batch : [task];
      if (files.some(file => owned.has(file))) continue;
      files.forEach(file => owned.add(file));
    }
    batch.push(task);
  }
  return batch;
}

export function handoffContract(task: Task) {
  const phase = taskPhase(task);
  const verdict = ['review', 'challenge', 'audit', 'acceptance'].includes(phase)
    ? '\nFor this gate task, return JSON {"verdict":"PASS|FAIL|UNVERIFIED","findings":[],"observation":"...","logicChain":"...","caveats":[],"conclusion":"...","verificationMethod":[],"invalidationConditions":[]}. PASS requires actual inspection, required checks and no unresolved finding.' : '';
  return 'Report five handoff components: Observation, Logic Chain (decision rationale, not private reasoning), Caveats, Conclusion, Verification Method. Include file paths, commands, exit codes, remaining requirements and invalidation conditions. Claims are unverified until independently checked.' + verdict;
}
