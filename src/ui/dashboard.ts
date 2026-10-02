import type { TeamworkEvent, Role, TaskStatus } from '../types.js';
import { colors, symbols, isInteractive } from './theme.js';
import { renderTable } from './table.js';

export type { TeamworkEvent };

export interface AgentDashboardState {
  role: string;
  status: string;
  task?: string;
  error?: string;
  model?: string;
}

export interface DashboardOptions {
  isTTY?: boolean;
  stream?: NodeJS.WriteStream;
  spinnerInterval?: number;
  silent?: boolean;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * TeamworkDashboard
 *
 * Implements a Dual-Zone Terminal Viewport:
 * - Upper Zone: Scrolling event and activity logs.
 * - Lower Zone: Pinned live multi-agent status matrix with live spinners and badges.
 *
 * Provides safe logging without clobbering pinned lines,
 * clean cursor visibility handling, and execution summary table rendering upon teardown.
 */
export class TeamworkDashboard {
  public agents: Map<string, AgentDashboardState> = new Map();
  public events: TeamworkEvent[] = [];
  public logs: string[] = [];
  public isRunning = false;
  public summary: any = null;

  public isTTY: boolean;
  private stream: NodeJS.WriteStream;
  private spinnerInterval: number;
  private silent: boolean;

  private timer: NodeJS.Timeout | null = null;
  private spinnerIndex = 0;
  private renderedZoneBLines = 0;
  private cleanupHandler: (() => void) | null = null;

  constructor(public options: DashboardOptions = {}) {
    this.isTTY = options.isTTY ?? (Boolean(process.stdout?.isTTY) && isInteractive());
    this.stream = options.stream ?? process.stdout;
    this.spinnerInterval = options.spinnerInterval ?? 80;
    this.silent = Boolean(options.silent);
  }

  /**
   * Starts the dashboard and live spinner interval (if TTY interactive).
   */
  start(): void {
    this.isRunning = true;

    if (this.isTTY && !this.silent) {
      // Hide cursor in terminal
      this.stream.write('\x1b[?25l');

      // Hook cleanup handlers to restore cursor on abort
      this.cleanupHandler = () => {
        this.restoreCursor();
      };
      process.once('SIGINT', this.cleanupHandler);
      process.once('exit', this.cleanupHandler);

      // Start live spinner tick
      this.timer = setInterval(() => {
        this.tick();
      }, this.spinnerInterval);

      this.renderZoneB();
    }
  }

  /**
   * Single spinner animation frame tick.
   */
  tick(): void {
    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
    if (this.isRunning && this.isTTY && !this.silent) {
      this.clearZoneB();
      this.renderZoneB();
    }
  }

  /**
   * Restores terminal cursor visibility.
   */
  private restoreCursor(): void {
    if (this.isTTY && !this.silent) {
      this.stream.write('\x1b[?25h');
    }
  }

  /**
   * Clears the pinned lower zone lines so upper log lines can scroll cleanly.
   */
  private clearZoneB(): void {
    if (this.renderedZoneBLines > 0 && this.isTTY && !this.silent) {
      // Move up by renderedZoneBLines and clear from cursor to end of screen
      this.stream.write(`\x1b[${this.renderedZoneBLines}A\x1b[0J`);
      this.renderedZoneBLines = 0;
    }
  }

  /**
   * Renders the pinned lower zone status matrix.
   */
  private renderZoneB(): void {
    if (!this.isRunning || !this.isTTY || this.silent) return;

    const matrix = this.renderStatusMatrix();
    const lines = matrix.split('\n');
    this.stream.write(matrix + '\n');
    this.renderedZoneBLines = lines.length;
  }

  /**
   * Writes an event line to the upper scrolling zone safely without polluting this.logs.
   */
  private writeEventLine(line: string): void {
    if (this.isRunning && this.isTTY && !this.silent) {
      this.clearZoneB();
      this.stream.write(line + '\n');
      this.renderZoneB();
    } else if (!this.silent && this.isTTY) {
      this.stream.write(line + '\n');
    }
  }

  /**
   * Writes a log message to the upper scrolling zone safely without clobbering the lower zone.
   */
  log(message: string): void {
    this.logs.push(message);

    if (this.isRunning && this.isTTY && !this.silent) {
      this.clearZoneB();
      this.stream.write(message + '\n');
      this.renderZoneB();
    } else if (!this.silent) {
      this.stream.write(message + '\n');
    }
  }

  /**
   * Handles incoming structured lifecycle events from TeamworkEngine.
   */
  onEvent(event: TeamworkEvent | string): void {
    if (typeof event === 'string') {
      this.log(event);
      return;
    }

    this.events.push(event);

    const aid = event.agentId || (event.role ? `agent-${event.role}` : 'system');
    const existing: AgentDashboardState = this.agents.get(aid) || {
      role: event.role || 'general',
      status: 'idle',
    };

    switch (event.type) {
      case 'session_start': {
        const msg = event.message || 'Teamwork session initialized';
        this.writeEventLine(`${colors.cyan(symbols.pointer)} ${colors.bold(msg)}`);
        break;
      }

      case 'planner_start': {
        this.agents.set(aid, {
          ...existing,
          role: 'planner',
          status: 'running',
          task: event.message || 'Analyzing requirements and repository',
        });
        const msg = event.message || 'Planner analyzing requirements...';
        this.writeEventLine(`${colors.magenta('▶ [planner]')} ${msg}`);
        break;
      }

      case 'planner_done': {
        this.agents.set(aid, {
          ...existing,
          role: 'planner',
          status: 'idle',
          task: event.message || 'Plan generated',
        });
        const msg = event.message || 'Planner created execution DAG';
        this.writeEventLine(`${colors.green(symbols.tick)} ${colors.bold('[planner]')} ${msg}`);
        break;
      }

      case 'task_start': {
        const role = event.role || existing.role;
        this.agents.set(aid, {
          ...existing,
          role,
          status: 'running',
          task: event.message,
        });
        const msg = event.message ? ` ${event.message}` : '';
        this.writeEventLine(`${colors.cyan('⚡ [task_start]')} [${role}] ${aid}${msg}`);
        break;
      }

      case 'task_complete': {
        this.agents.set(aid, {
          ...existing,
          status: 'completed',
          task: event.message || existing.task,
        });
        const msg = event.message ? ` - ${event.message}` : '';
        this.writeEventLine(`${colors.green(symbols.tick)} ${colors.green('[task_complete]')} [${aid}]${msg}`);
        break;
      }

      case 'task_failed': {
        const isCancelled = event.status === 'cancelled';
        const st = isCancelled ? 'cancelled' : 'failed';
        this.agents.set(aid, {
          ...existing,
          status: st,
          error: event.message,
        });
        const icon = isCancelled ? colors.yellow('⚠') : colors.red(symbols.cross);
        const tag = isCancelled ? colors.yellow('[cancelled]') : colors.red('[task_failed]');
        this.writeEventLine(`${icon} ${tag} [${aid}] ${event.message || 'Task failed'}`);
        break;
      }

      case 'agent_status': {
        const updatedRole = event.role || existing.role;
        const updatedStatus = event.status || existing.status;
        this.agents.set(aid, {
          ...existing,
          role: updatedRole,
          status: updatedStatus,
          task: event.message || existing.task,
        });
        if (event.message) {
          this.writeEventLine(`${colors.gray('•')} [${updatedRole}] ${event.message}`);
        }
        break;
      }
    }

    if (this.isRunning && this.isTTY && !this.silent) {
      this.clearZoneB();
      this.renderZoneB();
    }
  }

  /**
   * Generates the status badge/icon for a given agent state.
   */
  private formatStatusBadge(status: string): string {
    const spinnerChar = SPINNER_FRAMES[this.spinnerIndex];

    switch (status) {
      case 'running':
        return this.isTTY
          ? `${colors.cyan(spinnerChar)} ${colors.cyan('running')}`
          : 'running';
      case 'testing':
        return this.isTTY
          ? `🧪 ${colors.yellow('testing')}`
          : 'testing';
      case 'completed':
        return this.isTTY
          ? `${colors.green(symbols.tick)} ${colors.green('completed')}`
          : 'completed';
      case 'failed':
        return this.isTTY
          ? `${colors.red(symbols.cross)} ${colors.red('failed')}`
          : 'failed';
      case 'cancelled':
        return this.isTTY
          ? `⚠ ${colors.yellow('cancelled')}`
          : 'cancelled';
      case 'idle':
      default:
        return this.isTTY
          ? `⏸ ${colors.gray('idle')}`
          : 'idle';
    }
  }

  /**
   * Renders the pinned agent status matrix.
   */
  renderStatusMatrix(): string {
    const head = ['Agent ID', 'Role', 'Status', 'Current Action'];
    const rows: (string | number)[][] = [];

    for (const [id, a] of this.agents.entries()) {
      const statusBadge = this.formatStatusBadge(a.status);
      const action = a.error
        ? (this.isTTY ? colors.red(a.error) : a.error)
        : (a.task || '-');
      rows.push([id, a.role, statusBadge, action]);
    }

    if (rows.length === 0) {
      rows.push(['-', 'orchestrator', this.formatStatusBadge('idle'), 'Initializing multi-agent graph...']);
    }

    return renderTable(head, rows, { isTTY: this.isTTY });
  }

  /**
   * Renders the execution summary table after teardown.
   */
  renderExecutionSummary(summary: any): string {
    const head = ['Metric', 'Execution Summary'];
    const isSuccess = summary?.status === 'completed' || summary?.success === true;
    const statusText = summary?.status
      ? summary.status.toUpperCase()
      : (isSuccess ? 'COMPLETED' : 'FAILED');

    const formattedStatus = this.isTTY
      ? (isSuccess ? colors.green(colors.bold(statusText)) : colors.red(colors.bold(statusText)))
      : statusText;

    const rows: (string | number)[][] = [
      ['Session Status', formattedStatus],
      ['Total Events Emitted', this.events.length],
      ['Agents Engaged', this.agents.size],
    ];

    if (summary?.id) {
      rows.unshift(['Session ID', summary.id]);
    }

    if (summary?.tasksCompleted !== undefined) {
      rows.push(['Tasks Completed', summary.tasksCompleted]);
    } else if (Array.isArray(summary?.tasks)) {
      const completed = summary.tasks.filter((t: any) => t.status === 'completed').length;
      rows.push(['Tasks Completed', `${completed} / ${summary.tasks.length}`]);
    }

    if (summary?.verified !== undefined) {
      rows.push(['Verified', summary.verified ? (this.isTTY ? colors.green('✔ PASS') : 'PASS') : (this.isTTY ? colors.red('✖ FAIL') : 'FAIL')]);
    }

    if (summary?.failedTask) {
      rows.push(['Failed Task', summary.failedTask]);
    }

    if (Array.isArray(summary?.failures) && summary.failures.length > 0) {
      rows.push(['Failures', summary.failures.filter(Boolean).join('; ') || 'Unknown error']);
    }

    return renderTable(head, rows, { isTTY: this.isTTY });
  }

  /**
   * Stops the live dashboard, halts intervals, restores cursor, and prints final summary table.
   */
  stop(summary?: any): void {
    this.isRunning = false;

    // Clear live timer
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Remove process exit listeners
    if (this.cleanupHandler) {
      process.removeListener('SIGINT', this.cleanupHandler);
      process.removeListener('exit', this.cleanupHandler);
      this.cleanupHandler = null;
    }

    // Clear lower zone from terminal
    this.clearZoneB();

    // Restore terminal cursor
    this.restoreCursor();

    // Store summary object
    this.summary = summary || {
      totalEvents: this.events.length,
      activeAgents: this.agents.size,
      status: [...this.agents.values()].some(a => a.status === 'failed') ? 'failed' : 'completed',
    };

    // Render final summary table
    if (!this.silent) {
      const summaryTable = this.renderExecutionSummary(this.summary);
      this.stream.write('\n' + summaryTable + '\n');
    }
  }
}
