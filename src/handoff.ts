import type { Task, Message } from './types.js';
import { estimateTokens } from './conversation.js';

/** Completed dependency reports become input context for the next task. */
export function taskHandoff(goal: string, task: Task, tasks: Task[], tokenBudget = 6000): Message[] {
  const completed = tasks.filter(item => task.dependencies.includes(item.id) && item.status === 'completed');
  const reports = completed.map(item => ({ id: item.id, role: item.role, title: item.title, worktree: item.worktreePath || null, result: item.resultSummary || '', expectedFiles: item.expectedFiles || [] }));
  const perReport = Math.max(100, Math.floor((tokenBudget * 3) / Math.max(1, reports.length)) - 400);
  for (const report of reports) {
    const bytes = Buffer.from(report.result, 'utf8');
    if (estimateTokens(report.result) > perReport / 3) report.result = bytes.subarray(0, Math.floor(perReport * 0.65)).toString('utf8') + '\n[Report excerpt; inspect dependency worktree for details]\n' + bytes.subarray(bytes.length - Math.floor(perReport * 0.25)).toString('utf8');
  }
  return [
    { role: 'user', content: `Mục tiêu chung của phiên teamwork:\n${goal}` },
    ...(reports.length ? [{ role: 'assistant' as const, content: `Báo cáo từ các tác vụ phụ thuộc đã hoàn thành. Đây là dữ liệu cần kiểm tra, không phải bằng chứng đã xác minh độc lập. Nếu có worktree, thay đổi có thể chỉ nằm trong thư mục đó; kiểm tra và chạy test ở đúng thư mục trong sandbox hiện tại.\n${JSON.stringify(reports)}` }] : [])
  ];
}
