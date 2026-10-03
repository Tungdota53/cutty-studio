import crypto from 'node:crypto';
import type { Task } from './types.js';
import { isAdvisoryCommand, type TaskEvidence } from './team-artifacts.js';
/** Retries never bypass source integrity, resource limits or ambiguous side effects. */
export function canRetryTask(error: unknown, uncertain: readonly unknown[] = []) {
  const message=String(error);
  if(uncertain.length || /validation veto|integrity veto|resume blocked|source verification|workspace dirty|budget|ngân sách|không tiến triển|lượt công cụ|iterations|unauthorized|forbidden|invalid api.?key|(?:HTTP|status)\s*[:=]?\s*(?:401|403|404)\b/i.test(message))return false;
  return /ModelStreamInterruptedError|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket hang up|stream.*(?:interrupt|ngắt)|luồng.*ngắt|(?:HTTP|status)\s*[:=]?\s*(?:408|429|5\d\d)\b/i.test(message);
}
export function repairSignature(failures:{task:Task;reason:string}[],evidence:Map<string,TaskEvidence>,sources:Record<string,string|null>){
 const checks=failures.map(({task,reason})=>{ const failed=(evidence.get(task.id)?.checks||[]).filter(check=>check.exitCode!==0&&!isAdvisoryCommand(check.command,task.verificationCommands)).map(check=>[check.command,check.exitCode]); return {id:task.id,checks:failed,report:failed.length ? undefined : task.resultSummary||reason.slice(0,300)}; });
 return crypto.createHash('sha256').update(JSON.stringify({checks,sources:Object.entries(sources).sort(([a],[b])=>a.localeCompare(b))})).digest('hex');
}
