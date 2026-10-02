import type { Task } from './types.js';
import { taskPhase } from './team-protocol.js';

export interface RepairFinding { task: Task; reason: string }

/** Collect every concurrent failure before resetting any task or discarding evidence. */
export function scheduleRepairs(tasks: Task[], failures: RepairFinding[], round: number): Task | undefined {
  if (round > 2 || round < 1 || tasks.length >= 48 || tasks.some(task => task.status === 'running') || !failures.length) return;
  if (failures.some(({task}) => !['verification', 'review', 'challenge', 'audit'].includes(taskPhase(task)))) return;
  const ancestors = new Set<string>();
  const visit = (task: Task) => { for (const id of task.dependencies) if (!ancestors.has(id)) { ancestors.add(id); const parent = tasks.find(t => t.id === id); if (parent) visit(parent); } };
  for (const {task} of failures) visit(task);
  const workers = tasks.filter(task => ancestors.has(task.id) && task.role === 'coder' && !task.id.startsWith('repair-'));
  if (!workers.length || workers.some(task => !task.expectedFiles?.length || task.status !== 'completed')) return;
  const id = `repair-${round}`;
  if (tasks.some(task => task.id === id)) return;
  const repair: Task = {
    id, title: `Repair validation findings (round ${round})`, role: 'coder', phase: 'implementation', agentId: workers.length === 1 ? workers[0].agentId : undefined,
    description: `[REPAIR] Fix ALL collected findings within assigned files. Do not weaken tests, skip assertions, fabricate results or change the acceptance criteria.\n${failures.map(({task,reason}) => `Failure task: ${task.id}\n${reason}\nPrevious report:\n${(task.resultSummary || '').slice(0, 10000)}`).join('\n\n')}`,
    dependencies: workers.map(task => task.id), expectedFiles: [...new Set(workers.flatMap(task => task.expectedFiles || []))],
    acceptanceCriteria: workers.flatMap(task => task.acceptanceCriteria || []), skills: [], status: 'pending', retries: 0, createdAt: new Date().toISOString()
  };
  const affected = new Set(workers.map(task => task.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const task of tasks) if (!affected.has(task.id) && task.dependencies.some(id => affected.has(id))) { affected.add(task.id); changed = true; }
  }
  const sources = new Set(workers.map(task => task.id));
  const gates = new Set(['verification', 'review', 'challenge', 'audit', 'acceptance']);
  for (const task of tasks) if (affected.has(task.id) && !sources.has(task.id) && gates.has(taskPhase(task))) {
    task.status = 'pending'; task.dependencies = [...new Set([...task.dependencies, repair.id])]; task.retries = (task.retries || 0) + 1;
    delete task.startedAt; delete task.completedAt; delete task.resultSummary; delete task.error; delete task.loadedSkills;
  }
  tasks.push(repair);
  return repair;
}

/** Compatibility entry point for a single failed gate. */
export function scheduleRepair(tasks: Task[], failure: Task, reason: string, round: number) {
  return scheduleRepairs(tasks, [{task: failure, reason}], round);
}
