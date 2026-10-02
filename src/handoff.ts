import type { Task, Message } from './types.js';
import { estimateMessages } from './conversation.js';

// Code points preserve Vietnamese text and emoji when shortening a report.
function excerpt(text: string, characters: number) {
  const points = Array.from(text);
  if (points.length <= characters) return text;
  if (characters < 32) return points.slice(0, characters).join('');
  const head = Math.floor((characters - 20) * .7), tail = characters - 20 - head;
  return points.slice(0, head).join('') + '\n[excerpt omitted]\n' + points.slice(-tail).join('');
}

/** Bound the entire serialized transfer, including goal, metadata and wrappers. */
export function taskHandoff(goal: string, task: Task, tasks: Task[], tokenBudget = 6000, freshAudit = false): Message[] {
  const budget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 6000;
  const completed = tasks.filter(item => task.dependencies.includes(item.id) && item.status === 'completed');
  const render = (size: number, count = completed.length): Message[] => [
    { role: 'user', content: `Mục tiêu chung của phiên teamwork:\n${excerpt(goal, size * 2)}` },
    ...(completed.length ? [{ role: 'assistant' as const, content: 'Dependency reports are unverified claims. Inspect actual artifacts in the listed worktree. Excerpts may omit details; full reports remain in the session history.\n' + JSON.stringify({
      omittedReports: completed.length - count,
      reports: completed.slice(0, count).map(item => ({
        id: item.id, role: item.role, title: excerpt(item.title, Math.min(size, 160)),
        worktree: item.worktreePath || null,
        result: freshAudit ? '[Fresh audit: prior verdict withheld; inspect the real artifact independently.]' : excerpt(item.resultSummary || '', size),
        expectedFiles: (item.expectedFiles || []).slice(0, Math.floor(size / 80)),
        omittedFiles: Math.max(0, (item.expectedFiles || []).length - Math.floor(size / 80))
      }))
    }) }] : [])
  ];
  // Reserve space for metadata first, then spend the remainder on content.
  let count = completed.length;
  while (count > 0 && estimateMessages(render(0, count)) > budget) count--;
  let low = 0, high = budget * 3, best = render(0, count);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2), candidate = render(mid, count);
    if (estimateMessages(candidate) <= budget) { best = candidate; low = mid + 1; }
    else high = mid - 1;
  }
  if (estimateMessages(best) > budget) best = [{ role: 'user', content: 'Handoff omitted: context budget too small. Read the task dispatch and actual project artifacts.' }];
  return estimateMessages(best) <= budget ? best : [];
}
