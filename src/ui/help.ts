import { renderTable } from './table.js';
import { colors } from './theme.js';

export interface CommandDef {
  command: string;
  description: string;
  category: 'Core' | 'Models' | 'Teamwork' | 'Dev Tools';
}

export const COMMAND_DEFINITIONS: CommandDef[] = [
  // Core
  { command: '/help', description: 'Show this slash commands help directory', category: 'Core' },
  { command: '/status', description: 'Show current model, quality preset, and workspace', category: 'Core' },
  { command: '/clear', description: 'Start a new chat and clear the terminal screen', category: 'Core' },
  { command: '/compact', description: 'Summarize older context while retaining conversation state', category: 'Core' },
  { command: '/sessions', description: 'List persisted sessions from database', category: 'Core' },
  { command: '/resume <chat-id>', description: 'Resume a persisted chat and its context', category: 'Core' },
  { command: '/logs', description: 'Show sessions log directory path', category: 'Core' },
  { command: '/exit', description: 'Exit Vibe CLI session', category: 'Core' },

  // Models
  { command: '/model [id]', description: 'View or switch the active default model', category: 'Models' },
  { command: '/models', description: 'List available models from provider router', category: 'Models' },
  { command: '/model-role <role> <id>', description: 'Assign specific model to an agent role', category: 'Models' },
  { command: '/model-pool', description: 'View model pool candidates and priority tags', category: 'Models' },
  { command: '/router-status', description: 'View router metrics, latency, and fallback states', category: 'Models' },
  { command: '/quality <fast|balanced|high|max>', description: 'View or set execution quality preset', category: 'Models' },

  // Teamwork
  { command: '/teamwork <task>', description: 'Launch multi-agent cooperative workflow (DAG scheduler)', category: 'Teamwork' },
  { command: '/agents', description: 'View active agents status and assigned roles', category: 'Teamwork' },
  { command: '/tasks', description: 'View tasks in current teamwork plan', category: 'Teamwork' },
  { command: '/plan', description: 'View execution DAG and task dependencies', category: 'Teamwork' },
  { command: '/stop', description: 'Send cancellation signal to active teamwork workflow', category: 'Teamwork' },

  // Dev Tools
  { command: '/studio', description: 'Launch Vibe Studio web interface (Antigravity & Codex style)', category: 'Dev Tools' },
  { command: '/diff', description: 'View git diff of workspace changes', category: 'Dev Tools' },
  { command: '/test', description: 'Run workspace test suite', category: 'Dev Tools' },
  { command: '/review', description: 'Launch autonomous reviewer agent on git diff', category: 'Dev Tools' },
  { command: '/ssh list|exec <host> <cmd>', description: 'Manage SSH connections and execute remote commands', category: 'Dev Tools' },
];

export const SLASH_COMMANDS: string[] = COMMAND_DEFINITIONS.map(d => d.command.split(' ')[0]);

export function completer(line: string): [string[], string] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('/quality ')) {
    const sub = trimmed.slice('/quality '.length);
    const qualities = ['fast', 'balanced', 'high', 'max'];
    const hits = qualities.filter(q => q.startsWith(sub)).map(q => `/quality ${q}`);
    return [hits.length ? hits : qualities.map(q => `/quality ${q}`), line];
  }
  if (trimmed.startsWith('/ssh ')) {
    const sub = trimmed.slice('/ssh '.length);
    const sshCmds = ['list', 'exec'];
    const hits = sshCmds.filter(s => s.startsWith(sub)).map(s => `/ssh ${s}`);
    return [hits.length ? hits : sshCmds.map(s => `/ssh ${s}`), line];
  }
  if (trimmed.startsWith('/')) {
    const hits = SLASH_COMMANDS.filter(c => c.startsWith(trimmed));
    return [hits, line];
  }
  return [[], line];
}

export function renderHelp(options?: { isTTY?: boolean; plain?: boolean }): string {
  const categories: Array<'Core' | 'Models' | 'Teamwork' | 'Dev Tools'> = [
    'Core',
    'Models',
    'Teamwork',
    'Dev Tools',
  ];

  const sections: string[] = [];

  for (const cat of categories) {
    const items = COMMAND_DEFINITIONS.filter(d => d.category === cat);
    const rows = items.map(d => [d.command, d.description]);
    const headerTitle = options?.plain || options?.isTTY === false
      ? `=== ${cat} Commands ===`
      : colors.cyan(colors.bold(`=== ${cat} Commands ===`));

    const tableStr = renderTable(['Command', 'Description'], rows, {
      ...options,
      wordWrap: true,
    });

    sections.push(`${headerTitle}\n${tableStr}`);
  }

  return sections.join('\n\n');
}
