import Table from 'cli-table3';
import pc from 'picocolors';
import type { TeamworkEvent } from './mock-events.js';

export function isColorSupported(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout?.isTTY || pc.isColorSupported);
}

export function isInteractive(): boolean {
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout?.isTTY);
}

const colorPass = (s: string) => String(s);

export const colors = {
  get cyan() { return isColorSupported() ? pc.cyan : colorPass; },
  get green() { return isColorSupported() ? pc.green : colorPass; },
  get red() { return isColorSupported() ? pc.red : colorPass; },
  get yellow() { return isColorSupported() ? pc.yellow : colorPass; },
  get magenta() { return isColorSupported() ? pc.magenta : colorPass; },
  get gray() { return isColorSupported() ? pc.gray : colorPass; },
  get bold() { return isColorSupported() ? pc.bold : colorPass; },
  get dim() { return isColorSupported() ? pc.dim : colorPass; }
};

export function createTable(options: { head: string[]; colWidths?: number[] }): Table.Table {
  const chars = isInteractive() ? {
    'top': '─', 'top-mid': '┬', 'top-left': '╭', 'top-right': '╮',
    'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '╰', 'bottom-right': '╯',
    'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
    'right': '│', 'right-mid': '┤', 'middle': '│'
  } : {
    'top': '-', 'top-mid': '+', 'top-left': '+', 'top-right': '+',
    'bottom': '-', 'bottom-mid': '+', 'bottom-left': '+', 'bottom-right': '+',
    'left': '|', 'left-mid': '+', 'mid': '-', 'mid-mid': '+',
    'right': '|', 'right-mid': '+', 'middle': '|'
  };

  const tableConfig: any = {
    head: (options.head || []).map(h => isColorSupported() ? pc.bold(pc.cyan(h)) : h),
    chars,
    style: { 'padding-left': 1, 'padding-right': 1, head: [], border: [] }
  };

  if (options.colWidths && options.colWidths.length > 0) {
    tableConfig.colWidths = options.colWidths;
  }

  return new Table(tableConfig);
}

export function renderTable(head: string[], rows: (string | number)[][], options?: { colWidths?: number[]; plain?: boolean }): string {
  if (!head || head.length === 0) {
    if (!rows || rows.length === 0) return '';
  }

  if (options?.plain) {
    const colCount = Math.max(head?.length || 0, ...((rows || []).map(r => r.length)), 0);
    if (colCount === 0) return '';
    const lines: string[] = [];
    if (head && head.length > 0) {
      lines.push(head.join(' | '));
      lines.push(head.map(h => '-'.repeat(h.length)).join('-+-'));
    }
    for (const r of rows || []) {
      lines.push(r.map(c => String(c ?? '')).join(' | '));
    }
    return lines.join('\n');
  }

  const table = createTable({ head: head || [], colWidths: options?.colWidths });
  for (const row of rows || []) {
    table.push(row.map(cell => cell === null || cell === undefined ? '' : String(cell)));
  }
  return table.toString();
}

export function renderBanner(
  config?: { model?: string; quality?: string; workspace?: string; version?: string },
  options?: { isTTY?: boolean; plain?: boolean }
): string {
  const model = config?.model || 'default-model';
  const quality = config?.quality || 'balanced';
  const workspace = config?.workspace || process.cwd();
  const version = config?.version || '0.1.0';

  if (options?.plain) {
    return [
      '=== VIBE CLI ===',
      `Version:   ${version}`,
      `Model:     ${model}`,
      `Quality:   ${quality}`,
      `Workspace: ${workspace}`
    ].join('\n');
  }

  const useColor = isColorSupported() && (options?.isTTY ?? true);
  const title = useColor ? pc.bold(pc.cyan(`Vibe CLI v${version}`)) : `Vibe CLI v${version}`;
  const borderTop = '╭──────────────────────────────────────────────────╮';
  const borderBottom = '╰──────────────────────────────────────────────────╯';

  return [
    borderTop,
    `│  ${title.padEnd(58)}│`,
    `│  Model:     ${model.padEnd(46)}│`,
    `│  Quality:   ${quality.padEnd(46)}│`,
    `│  Workspace: ${workspace.padEnd(46)}│`,
    borderBottom
  ].join('\n');
}

export function renderApprovalCard(cmd: string, options?: { plain?: boolean; isTTY?: boolean }): string {
  if (options?.plain) {
    return [
      '==============================================================',
      'HIGH-RISK COMMAND APPROVAL REQUIRED',
      `Command: ${cmd}`,
      'Type APPROVE to confirm execution.',
      '=============================================================='
    ].join('\n');
  }

  const useColor = isColorSupported() && (options?.isTTY ?? true);
  const warn = useColor ? pc.bold(pc.red('⚠ HIGH-RISK COMMAND DETECTED ⚠')) : '⚠ HIGH-RISK COMMAND DETECTED ⚠';
  const boxTop = '┌──────────────────────────────────────────────────┐';
  const boxBottom = '└──────────────────────────────────────────────────┘';

  return [
    boxTop,
    `│  ${warn}`,
    '│  Agent requested to run:',
    `│    ${cmd}`,
    '│',
    '│  Type APPROVE to confirm execution.',
    boxBottom
  ].join('\n');
}

export function renderHelp(options?: { plain?: boolean; isTTY?: boolean }): string {
  const useColor = isColorSupported() && !options?.plain && (options?.isTTY ?? true);
  const title = useColor ? pc.bold(pc.cyan('Vibe CLI - Slash Commands Directory')) : 'Vibe CLI - Slash Commands Directory';
  const categories = [
    { name: 'Core Commands', cmds: ['/help', '/status', '/exit', '/clear'] },
    { name: 'Model Router', cmds: ['/models', '/model [id]', '/model-pool', '/router-status', '/quality <mode>'] },
    { name: 'Teamwork & Multi-Agent', cmds: ['/teamwork <task>', '/agents', '/tasks', '/plan', '/resume', '/stop'] },
    { name: 'Dev Tools & Inspection', cmds: ['/diff', '/test', '/review', '/logs', '/sessions', '/ssh'] }
  ];

  const lines = [title, ''];
  for (const cat of categories) {
    lines.push(useColor ? pc.bold(pc.yellow(`[${cat.name}]`)) : `[${cat.name}]`);
    lines.push(`  ${cat.cmds.join('  ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function formatDiff(rawDiff: string, isTTY = isInteractive()): string {
  if (!rawDiff || rawDiff.trim() === '') {
    return isColorSupported() && isTTY
      ? pc.dim('No changes detected (clean working tree).')
      : 'No changes detected (clean working tree).';
  }

  const lines = rawDiff.split('\n');
  let added = 0;
  let deleted = 0;
  const useColor = isTTY && isColorSupported();

  const formattedLines = lines.map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      return useColor ? pc.bold(line) : line;
    }
    if (line.startsWith('+')) {
      added++;
      return useColor ? pc.green(line) : line;
    }
    if (line.startsWith('-')) {
      deleted++;
      return useColor ? pc.red(line) : line;
    }
    if (line.startsWith('@@')) {
      return useColor ? pc.cyan(line) : line;
    }
    return useColor ? pc.gray(line) : line;
  });

  const stats = useColor
    ? `\n${pc.bold('Diff Stats:')} ${pc.green(`+${added}`)} ${pc.red(`-${deleted}`)}`
    : `\nDiff Stats: +${added} -${deleted}`;

  return formattedLines.join('\n') + stats;
}

export function renderMarkdown(markdown: string, isTTY = isInteractive()): string {
  if (!markdown) return '';
  const useColor = isTTY && isColorSupported();

  if (!useColor) {
    return markdown;
  }

  const lines = markdown.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        result.push(pc.gray(`┌─ [${codeBlockLang || 'code'}] ───────────────────────────────────`));
      } else {
        inCodeBlock = false;
        result.push(pc.gray('└──────────────────────────────────────────────────'));
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(pc.cyan(`│ ${line}`));
      continue;
    }

    if (line.startsWith('### ')) {
      result.push(pc.bold(pc.yellow(line.replace('### ', '▶▶▶ '))));
    } else if (line.startsWith('## ')) {
      result.push(pc.bold(pc.magenta(line.replace('## ', '▶▶ '))));
    } else if (line.startsWith('# ')) {
      result.push(pc.bold(pc.cyan(line.replace('# ', '▶ '))));
    } else if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      result.push(line.replace(/^[ \t]*[-*]/, pc.cyan('  •')));
    } else {
      let formatted = line;
      formatted = formatted.replace(/\*\*(.*?)\*\*/g, (_, p1) => pc.bold(p1));
      formatted = formatted.replace(/`([^`]+)`/g, (_, p1) => pc.yellow(`[${p1}]`));
      result.push(formatted);
    }
  }

  if (inCodeBlock) {
    result.push(pc.gray('└────────────────────────────────────────────────── (unclosed)'));
  }

  return result.join('\n');
}

export class TeamworkDashboard {
  public agents: Map<string, { role: string; status: string; task?: string; error?: string }> = new Map();
  public events: TeamworkEvent[] = [];
  public logs: string[] = [];
  public isRunning = false;
  public summary: any = null;

  constructor(public options: { isTTY?: boolean } = {}) {}

  start(): void {
    this.isRunning = true;
  }

  stop(summary?: any): void {
    this.isRunning = false;
    this.summary = summary || { totalEvents: this.events.length, activeAgents: this.agents.size };
  }

  onEvent(event: TeamworkEvent): void {
    this.events.push(event);

    const aid = event.agentId || (event.role ? `agent-${event.role}` : 'system');
    const existing = this.agents.get(aid) || { role: event.role || 'general', status: 'idle' };

    switch (event.type) {
      case 'session_start':
        break;
      case 'planner_start':
        this.agents.set(aid, { ...existing, role: 'planner', status: 'running' });
        break;
      case 'planner_done':
        this.agents.set(aid, { ...existing, role: 'planner', status: 'idle' });
        break;
      case 'task_start':
        this.agents.set(aid, { ...existing, role: event.role || existing.role, status: 'running', task: event.message });
        break;
      case 'task_complete':
        this.agents.set(aid, { ...existing, status: 'completed' });
        break;
      case 'task_failed':
        this.agents.set(aid, {
          ...existing,
          status: event.status === 'cancelled' ? 'cancelled' : 'failed',
          error: event.message
        });
        break;
      case 'agent_status':
        this.agents.set(aid, {
          ...existing,
          role: event.role || existing.role,
          status: event.status || existing.status
        });
        break;
    }
  }

  log(message: string): void {
    this.logs.push(message);
  }

  renderStatusMatrix(): string {
    const head = ['Agent ID', 'Role', 'Status', 'Current Action'];
    const rows: (string | number)[][] = [];
    for (const [id, a] of this.agents.entries()) {
      rows.push([id, a.role, a.status, a.task || a.error || '-']);
    }
    return renderTable(head, rows);
  }
}
