import Table from 'cli-table3';
import { isColorSupported } from './theme.js';

export interface TableOptions {
  head?: string[];
  colWidths?: Array<number | null>;
  colAligns?: Array<'left' | 'center' | 'right'>;
  wordWrap?: boolean;
  style?: {
    head?: string[];
    border?: string[];
    'padding-left'?: number;
    'padding-right'?: number;
    compact?: boolean;
  };
  chars?: Record<string, string>;
  isTTY?: boolean;
  plain?: boolean;
  truncate?: string;
}

export const ROUNDED_CHARS: Record<string, string> = {
  top: '─',
  'top-mid': '┬',
  'top-left': '╭',
  'top-right': '╮',
  bottom: '─',
  'bottom-mid': '┴',
  'bottom-left': '╰',
  'bottom-right': '╯',
  left: '│',
  'left-mid': '├',
  mid: '─',
  'mid-mid': '┼',
  right: '│',
  'right-mid': '┤',
  middle: '│',
};

export const ASCII_CHARS: Record<string, string> = {
  top: '-',
  'top-mid': '+',
  'top-left': '+',
  'top-right': '+',
  bottom: '-',
  'bottom-mid': '+',
  'bottom-left': '+',
  'bottom-right': '+',
  left: '|',
  'left-mid': '+',
  mid: '-',
  'mid-mid': '+',
  right: '|',
  'right-mid': '+',
  middle: '|',
};

export function createTable(options?: TableOptions): Table.Table {
  const isTty = options?.isTTY ?? true;
  const useColor = isTty && isColorSupported();

  const chars = options?.chars ?? (isTty ? ROUNDED_CHARS : ASCII_CHARS);
  const style = {
    head: useColor ? ['cyan', 'bold'] : [],
    border: useColor ? ['gray'] : [],
    ...options?.style,
  };

  const { isTTY, plain, ...tableOptions } = options || {};

  return new Table({
    chars,
    style,
    ...tableOptions,
  });
}

export function renderPlainTextTable(
  head: string[],
  rows: (string | number | boolean | null | undefined)[][]
): string {
  if (head.length === 0 && rows.length === 0) {
    return '';
  }

  const colCount = Math.max(head.length, ...rows.map(r => r.length), 0);
  if (colCount === 0) return '';

  const colWidths = Array(colCount).fill(0);

  for (let i = 0; i < colCount; i++) {
    const header = head[i] !== undefined && head[i] !== null ? String(head[i]) : '';
    if (header.length > colWidths[i]) {
      colWidths[i] = header.length;
    }
  }

  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
      if (cell.length > colWidths[i]) {
        colWidths[i] = cell.length;
      }
    }
  }

  const lines: string[] = [];

  if (head.length > 0) {
    const headLine = [];
    for (let i = 0; i < colCount; i++) {
      const header = head[i] !== undefined && head[i] !== null ? String(head[i]) : '';
      headLine.push(header.padEnd(colWidths[i]));
    }
    lines.push(headLine.join(' | '));

    const sepLine = colWidths.map(w => '-'.repeat(Math.max(w, 1))).join('-+-');
    lines.push(sepLine);
  }

  for (const row of rows) {
    const rowLine = [];
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] !== undefined && row[i] !== null ? String(row[i]) : '';
      rowLine.push(cell.padEnd(colWidths[i]));
    }
    lines.push(rowLine.join(' | '));
  }

  return lines.join('\n');
}

export function renderTable(
  head: string[],
  rows: (string | number | boolean | null | undefined)[][],
  options?: TableOptions
): string {
  if (head.length === 0 && rows.length === 0) {
    return '';
  }

  if (options?.plain) {
    return renderPlainTextTable(head, rows);
  }

  const table = createTable({
    head,
    ...options,
  });

  for (const row of rows) {
    table.push(row.map(cell => (cell === null || cell === undefined ? '' : cell)));
  }

  return table.toString();
}
