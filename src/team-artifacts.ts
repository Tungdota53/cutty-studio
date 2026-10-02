import fs from 'node:fs';
import path from 'node:path';
import type { Message, Task } from './types.js';

export interface TaskEvidence { inspected: boolean; successfulChecks: number; failedChecks: number; toolErrors: number }
export function recordEvidence(evidence: TaskEvidence, item: Message, calls: Map<string, string>) {
  for (const call of item.tool_calls || []) calls.set(call.id, call.function.name);
  if (item.role !== 'tool') return;
  let result: { ok?: boolean; output?: string };
  try { result = JSON.parse(item.content || '{}'); } catch { evidence.toolErrors++; return; }
  if (!result.ok) { evidence.toolErrors++; return; }
  const tool = calls.get(item.tool_call_id || '');
  if (['read_file', 'git_diff', 'search_files'].includes(tool || '')) evidence.inspected = true;
  if (!['run_tests', 'run_command'].includes(tool || '')) return;
  const exit = result.output?.match(/(?:^|\n)exit=(\d+)(?:\n|$)/);
  if (!exit) return;
  if (exit[1] === '0') evidence.successfulChecks++; else evidence.failedChecks++;
}

export function reviewVerdict(task: Task): 'PASS' | 'FAIL' | 'UNVERIFIED' {
  try {
    const report = JSON.parse((task.resultSummary || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (report.verdict === 'PASS' && Array.isArray(report.findings) && report.findings.length === 0) return 'PASS';
    if (report.verdict === 'FAIL' || report.findings?.length) return 'FAIL';
  } catch { /* Free-form claims are not a structured review verdict. */ }
  return 'UNVERIFIED';
}

export function qualityGate(tasks: Task[], evidence: Map<string, TaskEvidence>) {
  const implementation = tasks.filter(task => task.role === 'coder');
  if (!implementation.length) return { verdict: tasks.every(t => t.status === 'completed') ? 'PASS' : 'FAIL', reasons: ['Không có thay đổi mã nguồn trong kế hoạch.'] };
  const reasons: string[] = [];
  const dependsOn = (task: Task, id: string, visited = new Set<string>()): boolean => {
    if (visited.has(task.id)) return false; visited.add(task.id);
    return task.dependencies.includes(id) || task.dependencies.some(dep => {
      const parent = tasks.find(candidate => candidate.id === dep); return Boolean(parent && dependsOn(parent, id, visited));
    });
  };
  for (const coder of implementation) {
    const testers = tasks.filter(t => t.role === 'tester' && dependsOn(t, coder.id));
    const reviews = tasks.filter(t => t.role === 'reviewer' && dependsOn(t, coder.id));
    if (!testers.some(t => t.status === 'completed' && (evidence.get(t.id)?.successfulChecks || 0) > 0)) reasons.push(`${coder.id}: chưa có kiểm tra thực thi thành công từ tester phụ thuộc.`);
    if (!reviews.some(t => t.status === 'completed' && evidence.get(t.id)?.inspected && reviewVerdict(t) === 'PASS')) reasons.push(`${coder.id}: chưa có review độc lập đọc mã và trả PASS không có finding.`);
  }
  const failed = tasks.some(t => t.status !== 'completed' || (evidence.get(t.id)?.failedChecks || 0) > 0 || (t.role === 'reviewer' && reviewVerdict(t) === 'FAIL'));
  return { verdict: failed ? 'FAIL' : reasons.length ? 'UNVERIFIED' : 'PASS', reasons };
}

export function writeAgentArtifact(root: string, aid: string, file: string, content: string) {
  const folder = path.join(root, 'agents', aid);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, file), content);
}
