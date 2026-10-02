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

const validationRoles = new Set(['tester', 'reviewer', 'judge']);
const ownedFiles = (task: Task) => (task.expectedFiles || []).map(file => path.posix.normalize(file.replace(/\\/g, '/')).toLowerCase());
/** Fill available slots across phases; running tasks retain reservations until they finish. */
export function executionBatch(tasks: Task[], limit: number): Task[] {
  const ready = tasks.filter(task => task.status === 'ready').sort((a, b) => phases.indexOf(taskPhase(a)) - phases.indexOf(taskPhase(b)));
  const running = tasks.filter(task => task.status === 'running'), batch: Task[] = [];
  for (const task of ready) {
    if (running.length + batch.length >= limit) break;
    const active = [...running, ...batch];
    if (task.role === 'coder' && active.some(item => validationRoles.has(item.role))) continue;
    if (validationRoles.has(task.role) && active.some(item => item.role === 'coder')) continue;
    if (task.role === 'coder' && active.some(item => item.role === 'coder' && (!ownedFiles(task).length || !ownedFiles(item).length || ownedFiles(task).some(file => ownedFiles(item).includes(file))))) continue;
    batch.push(task);
  }
  return batch;
}

export function waitingReason(task: Task, tasks: Task[], limit: number): string | undefined {
  if (!['pending', 'ready'].includes(task.status)) return;
  const unmet = task.dependencies.filter(id => tasks.find(item => item.id === id)?.status !== 'completed');
  if (unmet.length) return `Chờ kết quả: ${unmet.join(', ')}`;
  const active = tasks.filter(item => item.status === 'running');
  if (task.role === 'coder' && active.some(item => validationRoles.has(item.role))) return 'Chờ các kiểm tra kết thúc trước khi sửa nguồn';
  if (validationRoles.has(task.role) && active.some(item => item.role === 'coder')) return 'Chờ nguồn ổn định để kiểm tra';
  if (task.role === 'coder' && active.some(item => item.role === 'coder' && (!ownedFiles(task).length || !ownedFiles(item).length || ownedFiles(task).some(file => ownedFiles(item).includes(file))))) return 'Chờ quyền ghi tệp đang được agent khác sử dụng';
  return active.length >= limit ? `Chờ slot · giới hạn ${limit} agent đồng thời` : 'Sẵn sàng nhận slot';
}

export function handoffContract(task: Task) {
  const phase = taskPhase(task);
  const verdict = ['review', 'challenge', 'audit', 'acceptance'].includes(phase)
    ? '\nFor this gate task, return JSON {"verdict":"PASS|FAIL|UNVERIFIED","findings":[],"observation":"...","logicChain":"...","caveats":[],"conclusion":"...","verificationMethod":[],"invalidationConditions":[]}. PASS requires actual inspection, required checks and no unresolved finding.' : '';
  return 'Report five handoff components: Observation, Logic Chain (decision rationale, not private reasoning), Caveats, Conclusion, Verification Method. Include file paths, commands, exit codes, remaining requirements and invalidation conditions. Claims are unverified until independently checked.' + verdict;
}
