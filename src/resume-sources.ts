import path from 'node:path';
import type { Task } from './types.js';
import { staleEvidence } from './team-artifacts.js';

/** Preserve historical repair snapshots. A later completed repair can supersede
 * an earlier snapshot only for its owned files and the same original workers. */
export function verifyCompletedSource(task: Task, tasks: Task[], fingerprints: Record<string, Record<string, string | null>>, workspace: string) {
  const recorded = fingerprints[task.id];
  if (!recorded || !Object.keys(recorded).length) throw new Error(`Không thể tiếp tục: ${task.id} thiếu dấu vết nguồn để xác minh. Checkpoint được giữ; cần kiểm tra nguồn.`);
  const originalWorkers = /^repair-\d+$/.test(task.id) ? task.dependencies : [task.id];
  const completed = Date.parse(task.completedAt || '');
  const repairs = tasks.filter(candidate => candidate.role === 'coder' && candidate.status === 'completed' && /^repair-\d+$/.test(candidate.id)
    && Date.parse(candidate.completedAt || '') > completed && originalWorkers.length > 0 && originalWorkers.every(id => candidate.dependencies.includes(id)))
    .sort((a,b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!));
  const current = { ...recorded };
  for (const file of Object.keys(current)) {
    const latest = repairs.find(candidate => candidate.expectedFiles?.some(owned => path.resolve(candidate.worktreePath || workspace, owned) === path.resolve(file)));
    if (latest) {
      const replacement = fingerprints[latest.id]?.[file];
      if (replacement === undefined) throw new Error(`Không thể tiếp tục: vòng sửa ${latest.id} thiếu dấu vết cho ${file}.`);
      current[file] = replacement;
    }
  }
  if (staleEvidence({inspected:false,successfulChecks:0,failedChecks:0,toolErrors:0,files:current})) throw new Error(`Không thể tiếp tục: nguồn của ${task.id} đã thay đổi ngoài các vòng sửa hoàn tất của phiên. Checkpoint được giữ; cần xác minh thay đổi trước khi ghi tệp.`);
}
