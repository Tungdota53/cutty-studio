import { colors, symbols, isColorSupported, isInteractive } from './theme.js';

function highlightSyntax(code: string): string {
  if (/^\s*(\/\/|#|\/\*)/.test(code)) {
    return colors.dim(colors.gray(code));
  }

  const stringTokens: string[] = [];
  let tokenized = code.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, match => {
    stringTokens.push(colors.green(match));
    return `___STR_${stringTokens.length - 1}___`;
  });

  tokenized = tokenized.replace(
    /\b(const|let|var|function|return|if|else|for|while|import|export|from|class|extends|interface|type|async|await|try|catch|finally|throw|new|typeof|instanceof|switch|case|default|break|continue|yield)\b/g,
    match => colors.magenta(match)
  );

  tokenized = tokenized.replace(
    /\b(true|false|null|undefined)\b/g,
    match => colors.yellow(match)
  );

  tokenized = tokenized.replace(
    /\b(\d+(\.\d+)?)\b/g,
    match => colors.cyan(match)
  );

  tokenized = tokenized.replace(/___STR_(\d+)___/g, (_, idx) => {
    return stringTokens[Number(idx)];
  });

  return tokenized;
}

function formatInline(text: string): string {
  let result = text;

  const codeTokens: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    codeTokens.push(colors.yellow(`\`${code}\``));
    return `___CODE_${codeTokens.length - 1}___`;
  });

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    return `${colors.cyan(linkText)} ${colors.dim(`(${url})`)}`;
  });

  result = result.replace(/\*\*([^*]+)\*\*/g, (_, p1) => colors.bold(p1));
  result = result.replace(/__([^_]+)__/g, (_, p1) => colors.bold(p1));

  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, p1) => colors.dim(p1));
  result = result.replace(/(?<!_)_([^_]+)_(?!_)/g, (_, p1) => colors.dim(p1));

  result = result.replace(/___CODE_(\d+)___/g, (_, idx) => {
    return codeTokens[Number(idx)];
  });

  return result;
}

export function renderMarkdown(markdown: string, isTTY = isInteractive()): string {
  if (!markdown) return '';

  const useColor = Boolean(isTTY) && isColorSupported();

  if (!useColor) {
    return markdown;
  }

  const lines = markdown.split(/\r?\n/);
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        const tag = codeBlockLang ? `╭─ [${codeBlockLang}] ` : '╭─ [code] ';
        const border = '─'.repeat(Math.max(2, 50 - tag.length));
        result.push(colors.gray(`${tag}${border}`));
      } else {
        inCodeBlock = false;
        result.push(colors.gray('╰──────────────────────────────────────────────────'));
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(`${colors.gray('│ ')}${highlightSyntax(line)}`);
      continue;
    }

    // Headings
    if (line.startsWith('# ')) {
      result.push(colors.bold(colors.cyan(`▶ ${line.slice(2).trim()}`)));
    } else if (line.startsWith('## ')) {
      result.push(colors.bold(colors.magenta(`▶▶ ${line.slice(3).trim()}`)));
    } else if (line.startsWith('### ')) {
      result.push(colors.bold(colors.yellow(`▶▶▶ ${line.slice(4).trim()}`)));
    } else if (line.startsWith('#### ')) {
      result.push(colors.bold(colors.blue(`▶▶▶▶ ${line.slice(5).trim()}`)));
    }
    // Bullet lists
    else if (/^[ \t]*[-*]\s+(.*)$/.test(line)) {
      const match = line.match(/^([ \t]*)[-*]\s+(.*)$/);
      if (match) {
        const indent = match[1];
        const content = match[2];
        result.push(`${indent}  ${colors.cyan(symbols.bullet)} ${formatInline(content)}`);
      }
    }
    // Numbered lists
    else if (/^[ \t]*(\d+)\.\s+(.*)$/.test(line)) {
      const match = line.match(/^([ \t]*)(\d+)\.\s+(.*)$/);
      if (match) {
        const indent = match[1];
        const num = match[2];
        const content = match[3];
        result.push(`${indent}  ${colors.yellow(`${num}.`)} ${formatInline(content)}`);
      }
    }
    // Blockquote
    else if (/^[ \t]*>\s*(.*)$/.test(line)) {
      const match = line.match(/^([ \t]*)>\s*(.*)$/);
      if (match) {
        const indent = match[1];
        const content = match[2];
        result.push(`${indent}${colors.gray('│ ')}${colors.dim(formatInline(content))}`);
      }
    }
    // Horizontal rule
    else if (/^[ \t]*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      result.push(colors.gray('──────────────────────────────────────────────────'));
    }
    // Regular text line
    else {
      result.push(formatInline(line));
    }
  }

  if (inCodeBlock) {
    result.push(colors.gray('╰────────────────────────────────────────────────── (unclosed)'));
  }

  return result.join('\n');
}
