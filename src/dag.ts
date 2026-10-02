import type { Task } from './types.js';

export function assertDag(tasks: Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error('Task ID bị trùng');
  const seen = new Set<string>(), stack = new Set<string>();
  const visit = (id: string) => {
    if (stack.has(id)) throw new Error(`Task DAG có cycle: ${[...stack, id].join(' → ')}`);
    if (seen.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`Dependency không tồn tại: ${id}`);
    stack.add(id);
    for (const dependency of task.dependencies) visit(dependency);
    stack.delete(id); seen.add(id);
  };
  tasks.forEach(task => visit(task.id));
}

export function updateReady(tasks: Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visited = new Set<string>();
  const update = (task: Task) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    if (task.status !== 'pending') return;
    const dependencies = task.dependencies.map(id => byId.get(id));
    dependencies.forEach(dependency => { if (dependency) update(dependency); });
    if (dependencies.some(dependency => !dependency || ['failed', 'blocked', 'cancelled'].includes(dependency.status))) task.status = 'blocked';
    else if (dependencies.every(dependency => dependency?.status === 'completed')) task.status = 'ready';
  };
  tasks.forEach(update);
  return tasks;
}
