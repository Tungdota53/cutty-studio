import { colors, symbols, isColorSupported, isInteractive } from './theme.js';

export interface DiffStats {
  added: number;
  deleted: number;
  files: number;
}

export interface TestRunResult {
  ok?: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  duration?: number;
}

export interface AuditLogEntry {
  timestamp?: string;
  action: string;
  command?: string;
  target?: string;
  approved?: boolean;
  user?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  details?: string;
}

export function parseDiffStats(rawDiff: string): DiffStats {
  if (!rawDiff || rawDiff.trim() === '') {
    return { added: 0, deleted: 0, files: 0 };
  }

  const lines = rawDiff.split(/\r?\n/);
  let added = 0;
  let deleted = 0;
  const files = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/diff --git a\/(.+?)\s+b\/(.+?)$/);
      if (match) {
        files.add(match[2]);
      }
    } else if (line.startsWith('+++ b/')) {
      const f = line.slice(6).trim();
      if (f && f !== '/dev/null') files.add(f);
    } else if (line.startsWith('--- a/')) {
      const f = line.slice(6).trim();
      if (f && f !== '/dev/null' && files.size === 0) files.add(f);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deleted++;
    }
  }

  return { added, deleted, files: files.size };
}

export function formatDiff(rawDiff: string, isTTY = isInteractive()): string {
  const useColor = Boolean(isTTY) && isColorSupported();

  if (!rawDiff || rawDiff.trim() === '') {
    return useColor
      ? colors.dim('No changes detected (clean working tree).')
      : 'No changes detected (clean working tree).';
  }

  const lines = rawDiff.split(/\r?\n/);
  let added = 0;
  let deleted = 0;
  const files = new Set<string>();
  const formattedLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/diff --git a\/(.+?)\s+b\/(.+?)$/);
      if (match) {
        files.add(match[2]);
      }
      formattedLines.push(useColor ? colors.bold(colors.cyan(line)) : line);
    } else if (line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ')) {
      formattedLines.push(useColor ? colors.cyan(line) : line);
    } else if (line.startsWith('--- ')) {
      if (line.startsWith('--- a/')) {
        const f = line.slice(6).trim();
        if (f && f !== '/dev/null' && files.size === 0) files.add(f);
      }
      formattedLines.push(useColor ? colors.bold(colors.cyan(line)) : line);
    } else if (line.startsWith('+++ ')) {
      if (line.startsWith('+++ b/')) {
        const f = line.slice(6).trim();
        if (f && f !== '/dev/null') files.add(f);
      }
      formattedLines.push(useColor ? colors.bold(colors.cyan(line)) : line);
    } else if (line.startsWith('@@')) {
      formattedLines.push(useColor ? colors.magenta(line) : line);
    } else if (line.startsWith('+')) {
      added++;
      formattedLines.push(useColor ? colors.green(line) : line);
    } else if (line.startsWith('-')) {
      deleted++;
      formattedLines.push(useColor ? colors.red(line) : line);
    } else if (line.startsWith('new file mode ') || line.startsWith('deleted file mode ')) {
      formattedLines.push(useColor ? colors.dim(line) : line);
    } else {
      formattedLines.push(useColor ? colors.gray(line) : line);
    }
  }

  const fileCount = files.size;
  const fileText = fileCount > 0 ? ` (${fileCount} ${fileCount === 1 ? 'file' : 'files'})` : '';
  const stats = useColor
    ? `\n${colors.bold('Diff Stats:')} ${colors.green(`+${added}`)} ${colors.red(`-${deleted}`)}${fileText ? colors.gray(fileText) : ''}`
    : `\nDiff Stats: +${added} -${deleted}${fileText}`;

  return formattedLines.join('\n') + stats;
}

export function formatTestResults(
  result: TestRunResult | string,
  isTTY = isInteractive()
): string {
  const useColor = Boolean(isTTY) && isColorSupported();

  let ok = true;
  let rawOutput = '';
  let command = '';
  let exitCode: number | undefined;

  if (typeof result === 'string') {
    rawOutput = result;
    const exitMatch = result.match(/exit=(\d+)/);
    if (exitMatch) {
      exitCode = parseInt(exitMatch[1], 10);
      ok = exitCode === 0;
    }
    const cmdMatch = result.match(/command=([^\r\n]+)/);
    if (cmdMatch) {
      command = cmdMatch[1];
    }
  } else {
    rawOutput = result.output || '';
    if (result.ok !== undefined) {
      ok = result.ok;
    } else if (result.exitCode !== undefined) {
      ok = result.exitCode === 0;
    }
    exitCode = result.exitCode;
    if (result.error) {
      ok = false;
    }
    const cmdMatch = rawOutput.match(/command=([^\r\n]+)/);
    if (cmdMatch) {
      command = cmdMatch[1];
    }
    const exitMatch = rawOutput.match(/exit=(\d+)/);
    if (exitMatch && exitCode === undefined) {
      exitCode = parseInt(exitMatch[1], 10);
      if (result.ok === undefined) {
        ok = exitCode === 0;
      }
    }
  }

  let displayBody = rawOutput
    .replace(/^command=[^\r\n]*\r?\n/, '')
    .replace(/^exit=\d+\r?\n/, '')
    .trim();

  if (typeof result !== 'string' && result.error && !displayBody) {
    displayBody = result.error;
  }

  if (useColor) {
    const badge = ok
      ? `${colors.bold(colors.bgGreen(colors.white(' PASS ')))} ${colors.green(symbols.tick)} ${colors.bold('Test Suite Completed Successfully')}`
      : `${colors.bold(colors.bgRed(colors.white(' FAIL ')))} ${colors.red(symbols.cross)} ${colors.bold('Test Suite Execution Failed')}`;

    const lines: string[] = [];
    lines.push('╭─────────────────────────────────────────────────────────────╮');
    lines.push(`│  ${badge}`);
    if (command) {
      lines.push(`│  ${colors.dim('Command:')} ${colors.cyan(command)}`);
    }
    if (exitCode !== undefined) {
      lines.push(`│  ${colors.dim('Exit Code:')} ${ok ? colors.green(String(exitCode)) : colors.red(String(exitCode))}`);
    }
    lines.push('╰─────────────────────────────────────────────────────────────╯');

    if (displayBody) {
      lines.push('');
      const bodyLines = displayBody.split(/\r?\n/).map(l => {
        if (/✓|passed|PASS/i.test(l)) return colors.green(l);
        if (/✖|failed|FAIL|error/i.test(l)) return colors.red(l);
        return colors.dim(l);
      });
      lines.push(bodyLines.join('\n'));
    }

    return lines.join('\n');
  }

  const badge = ok ? '[PASS] Test Suite Passed' : '[FAIL] Test Suite Failed';
  const lines: string[] = [];
  lines.push('=============================================================');
  lines.push(badge);
  if (command) lines.push(`Command:   ${command}`);
  if (exitCode !== undefined) lines.push(`Exit Code: ${exitCode}`);
  lines.push('=============================================================');
  if (displayBody) {
    lines.push(displayBody);
  }
  return lines.join('\n');
}

export function formatAuditLog(
  entry: AuditLogEntry | string,
  isTTY = isInteractive()
): string {
  const useColor = Boolean(isTTY) && isColorSupported();

  if (typeof entry === 'string') {
    if (!useColor) return entry;
    let formatted = entry;
    if (formatted.includes('[Audit]')) {
      formatted = formatted.replace('[Audit]', colors.bold(colors.cyan('[Audit]')));
    }
    if (/approved/i.test(formatted)) {
      formatted = formatted.replace(/approved/gi, colors.green('approved'));
    }
    if (/rejected|blocked|denied/i.test(formatted)) {
      formatted = formatted.replace(/(rejected|blocked|denied)/gi, colors.red('$1'));
    }
    return formatted;
  }

  const timestamp = entry.timestamp || new Date().toISOString();
  const isApproved = entry.approved ?? true;
  const risk = entry.riskLevel || 'medium';

  if (useColor) {
    const statusText = isApproved
      ? `${colors.bold(colors.green(`${symbols.tick} APPROVED`))}`
      : `${colors.bold(colors.red(`${symbols.cross} BLOCKED`))}`;

    const riskBadge =
      risk === 'critical' ? colors.bold(colors.bgRed(colors.white(' CRITICAL ')))
      : risk === 'high' ? colors.bold(colors.red('HIGH'))
      : risk === 'medium' ? colors.yellow('MEDIUM')
      : colors.green('LOW');

    const lines: string[] = [
      colors.gray('╭─ [SAFETY AUDIT LOG] ───────────────────────────────────────'),
      `│  ${colors.bold('Action:')}    ${colors.cyan(entry.action)}`,
      `│  ${colors.bold('Status:')}    ${statusText}`,
      `│  ${colors.bold('Risk:')}      ${riskBadge}`,
      `│  ${colors.bold('Target:')}    ${colors.yellow(entry.target || entry.command || '-')}`,
      `│  ${colors.bold('Time:')}      ${colors.dim(timestamp)}`,
    ];
    if (entry.user) {
      lines.push(`│  ${colors.bold('User:')}      ${colors.white(entry.user)}`);
    }
    if (entry.details) {
      lines.push(`│  ${colors.bold('Details:')}   ${colors.dim(entry.details)}`);
    }
    lines.push(colors.gray('╰────────────────────────────────────────────────────────────'));
    return lines.join('\n');
  }

  const lines: string[] = [
    '=== SAFETY AUDIT LOG ===',
    `Action:    ${entry.action}`,
    `Status:    ${isApproved ? 'APPROVED' : 'BLOCKED'}`,
    `Risk:      ${risk.toUpperCase()}`,
    `Target:    ${entry.target || entry.command || '-'}`,
    `Time:      ${timestamp}`
  ];
  if (entry.user) lines.push(`User:      ${entry.user}`);
  if (entry.details) lines.push(`Details:   ${entry.details}`);
  lines.push('========================');
  return lines.join('\n');
}
