import type { TeamworkEvent } from '../types.js';
import { renderTable } from './table.js';

/**
 * Checks whether the environment is interactive (TTY-supported, not CI, not dumb terminal).
 */
export function isInteractiveEnvironment(stream?: NodeJS.WriteStream): boolean {
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.TERM === 'dumb') {
    return false;
  }
  const s = stream ?? process.stdout;
  return Boolean(s && s.isTTY);
}

/**
 * Returns true if current environment is non-interactive (CI, pipe, or dumb terminal).
 */
export function isNonInteractive(stream?: NodeJS.WriteStream): boolean {
  return !isInteractiveEnvironment(stream);
}

export interface FallbackLoggerOptions {
  stream?: NodeJS.WritableStream;
  silent?: boolean;
}

/**
 * SequentialFallbackLogger provides deterministic, sequential plain-text logging
 * for non-TTY, CI, and piped environments.
 *
 * Guarantees:
 * - 0 ANSI escape sequences or cursor positioning
 * - 0 background interval timers
 * - Strict chronological timestamped output
 */
export class SequentialFallbackLogger {
  private stream: NodeJS.WritableStream;
  private silent: boolean;
  public lines: string[] = [];
  public isRunning = false;
  public summary: any = null;

  constructor(options: FallbackLoggerOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.silent = Boolean(options.silent);
  }

  private formatTimestamp(date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
  }

  private writeLine(text: string): void {
    this.lines.push(text);
    if (!this.silent) {
      this.stream.write(text + '\n');
    }
  }

  start(sessionInfo?: { id?: string; goal?: string }): void {
    this.isRunning = true;
    const ts = this.formatTimestamp();
    const info = sessionInfo?.id ? ` (Session: ${sessionInfo.id})` : '';
    const goal = sessionInfo?.goal ? ` - Goal: ${sessionInfo.goal}` : '';
    this.writeLine(`[${ts}] [SESSION_START] Multi-agent execution started${info}${goal}`);
  }

  onEvent(event: TeamworkEvent | string): void {
    const ts = this.formatTimestamp();

    if (typeof event === 'string') {
      this.writeLine(`[${ts}] [INFO] ${event}`);
      return;
    }

    const type = (event.type || 'EVENT').toUpperCase();
    const agent = event.agentId || (event.role ? `agent-${event.role}` : 'system');
    const roleTag = event.role ? `[${event.role}] ` : '';
    const statusTag = event.status ? ` [status: ${event.status}]` : '';
    const message = event.message || '';

    let details = '';
    if (message) {
      details = ` ${message}`;
    }

    this.writeLine(`[${ts}] [${type}] ${roleTag}${agent}${statusTag}${details}`.trim());
  }

  log(message: string): void {
    const ts = this.formatTimestamp();
    this.writeLine(`[${ts}] [LOG] ${message}`);
  }

  stop(summary?: any): void {
    this.isRunning = false;
    this.summary = summary;
    const ts = this.formatTimestamp();
    const status = summary?.status || (summary?.success === false ? 'failed' : 'completed');
    this.writeLine(`[${ts}] [SESSION_COMPLETE] Execution finished with status: ${status}`);

    if (summary && typeof summary === 'object') {
      const rows: [string, string][] = [
        ['Status', String(summary.status ?? (summary.success ? 'completed' : 'finished'))],
      ];
      if (summary.id) rows.push(['Session ID', String(summary.id)]);
      if (summary.tasksCompleted !== undefined) rows.push(['Tasks Completed', String(summary.tasksCompleted)]);
      if (Array.isArray(summary.tasks)) rows.push(['Total Tasks', String(summary.tasks.length)]);
      if (summary.verified !== undefined) rows.push(['Verified', String(summary.verified)]);

      const table = renderTable(['Metric', 'Value'], rows, { plain: true, isTTY: false });
      if (table) {
        this.writeLine('\n' + table);
      }
    }
  }

  getLines(): string[] {
    return [...this.lines];
  }
}
