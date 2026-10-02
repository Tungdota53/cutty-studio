import { ZodError } from 'zod';

/** Find complete JSON objects while respecting quoted braces and escapes. */
export function planObject(raw: string): unknown {
  if (raw.length > 1_000_000) throw new Error('Kế hoạch vượt giới hạn 1 MB. Hãy rút gọn mô tả.');
  let start = -1, depth = 0, quoted = false, escaped = false;
  const plans: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (start < 0) { if (char === '{') { start = i; depth = 1; } continue; }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        const value = JSON.parse(raw.slice(start, i + 1));
        if (value && Object.hasOwn(value, 'tasks')) plans.push(value);
      } catch { /* Do not execute incomplete or invalid JSON. */ }
      start = -1;
    }
  }
  if (plans.length > 1) throw new Error('Planner trả nhiều kế hoạch. Chỉ trả một JSON chứa tasks.');
  if (!plans.length) throw new Error('Planner chưa trả JSON hợp lệ chứa tasks; đầu ra có thể bị cắt ngắn.');
  return plans[0];
}

export function planError(error: unknown): string {
  if (error instanceof ZodError) return error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || 'plan'}: ${issue.message}`).join('\n');
  return (error instanceof Error ? error.message : String(error)).slice(0, 3000);
}

/** Retry validation only; transport/auth/tool failures retain their own policy. */
export async function validatedPlan<T>(generate: (attempt: number, feedback: string) => Promise<string>, validate: (raw: string) => T, signal?: AbortSignal, onRetry?: (attempt: number, reason: string) => void) {
  let feedback = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const raw = await generate(attempt, feedback);
    signal?.throwIfAborted();
    try { return { raw, value: validate(raw) }; }
    catch (error) {
      const reason = planError(error);
      if (attempt === 2) throw new Error(`Không thể tạo kế hoạch hợp lệ sau 3 lần.\n${reason}`);
      feedback = `Repair the previous plan. Validation errors:\n${reason}\nReturn exactly one complete JSON object with tasks. Preserve the user's goal. Use arrays for acceptanceCriteria, verificationCommands, dependencies, expectedFiles and skills. Fix missing/cyclic dependencies, role/phase conflicts and agent assignments. Do not execute implementation work.`;
      onRetry?.(attempt + 1, reason);
    }
  }
  throw new Error('Không thể tạo kế hoạch');
}
