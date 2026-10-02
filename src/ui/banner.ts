import { colors, symbols, isColorSupported } from './theme.js';

export interface BannerConfig {
  version?: string;
  model?: string;
  quality?: string;
  workspace?: string;
  [key: string]: any;
}

export function renderBanner(
  config?: BannerConfig,
  options?: { isTTY?: boolean; plain?: boolean }
): string {
  const version = config?.version || '0.1.0';
  const model = config?.model || 'unknown';
  const quality = config?.quality || 'balanced';
  const workspace = config?.workspace || process.cwd();

  const isTty = options?.isTTY ?? true;
  const useColor = isTty && !options?.plain && isColorSupported();

  if (options?.plain) {
    return [
      '=== VIBE CLI TEAMWORK ===',
      `Version:   ${version}`,
      `Model:     ${model}`,
      `Quality:   ${quality}`,
      `Workspace: ${workspace}`,
      'Type /help for slash commands or enter your prompt below.',
    ].join('\n');
  }

  const border = (s: string) => (useColor ? colors.gray(s) : s);
  const title = useColor
    ? colors.cyan(colors.bold('⚡ VIBE CLI TEAMWORK'))
    : '⚡ VIBE CLI TEAMWORK';
  const subtitle = useColor
    ? colors.dim('Multi-Agent Collaborative System')
    : 'Multi-Agent Collaborative System';

  const lblVer = useColor ? colors.bold('Version:  ') : 'Version:  ';
  const valVer = useColor ? colors.green(version) : version;

  const lblMod = useColor ? colors.bold('Model:    ') : 'Model:    ';
  const valMod = useColor ? colors.cyan(model) : model;

  const lblQ = useColor ? colors.bold('Quality:  ') : 'Quality:  ';
  const valQ = useColor ? colors.yellow(quality) : quality;

  const lblWs = useColor ? colors.bold('Workspace:') : 'Workspace:';
  const valWs = useColor ? colors.dim(workspace) : workspace;

  const hint = useColor
    ? colors.dim('Type /help for slash commands or enter your prompt below')
    : 'Type /help for slash commands or enter your prompt below';

  const rawLines = [
    `  Version:   ${version}`,
    `  Model:     ${model}`,
    `  Quality:   ${quality}`,
    `  Workspace: ${workspace}`,
  ];
  const maxLineLen = Math.max(...rawLines.map(l => l.length), 58);
  const innerWidth = maxLineLen + 4;

  const padContent = (content: string, visibleLen: number) => {
    const space = Math.max(0, innerWidth - visibleLen);
    return ' ' + content + ' '.repeat(space) + ' ';
  };

  const centerContent = (content: string, visibleLen: number) => {
    const totalSpaces = Math.max(0, innerWidth - visibleLen);
    const left = Math.floor(totalSpaces / 2);
    const right = totalSpaces - left;
    return ' ' + ' '.repeat(left) + content + ' '.repeat(right) + ' ';
  };

  const b = border('│');
  const top = border('╭' + '─'.repeat(innerWidth + 2) + '╮');
  const mid = border('├' + '─'.repeat(innerWidth + 2) + '┤');
  const bot = border('╰' + '─'.repeat(innerWidth + 2) + '╯');

  return [
    top,
    `${b}${centerContent(title, 19)}${b}`,
    `${b}${centerContent(subtitle, 32)}${b}`,
    mid,
    `${b}${padContent(`  ${lblVer} ${valVer}`, 13 + version.length)}${b}`,
    `${b}${padContent(`  ${lblMod} ${valMod}`, 13 + model.length)}${b}`,
    `${b}${padContent(`  ${lblQ} ${valQ}`, 13 + quality.length)}${b}`,
    `${b}${padContent(`  ${lblWs} ${valWs}`, 13 + workspace.length)}${b}`,
    mid,
    `${b}${centerContent(hint, 56)}${b}`,
    bot,
  ].join('\n');
}

export function renderApprovalCard(
  cmd: string,
  options?: { isTTY?: boolean; plain?: boolean }
): string {
  const isTty = options?.isTTY ?? true;
  const useColor = isTty && !options?.plain && isColorSupported();

  if (options?.plain) {
    return [
      '==============================================================',
      `[HIGH-RISK COMMAND APPROVAL REQUIRED]`,
      `Command: ${cmd}`,
      'Type APPROVE to execute once, or any other input to abort.',
      '==============================================================',
    ].join('\n');
  }

  const border = (s: string) => (useColor ? colors.red(s) : s);
  const warnTitle = useColor
    ? colors.red(colors.bold(`${symbols.warning} HIGH-RISK COMMAND APPROVAL REQUIRED`))
    : `${symbols.warning} HIGH-RISK COMMAND APPROVAL REQUIRED`;

  const cmdText = useColor ? colors.yellow(cmd) : cmd;
  const promptText = useColor
    ? `${colors.bold('Type')} ${colors.green(colors.bold('APPROVE'))} ${colors.bold('to permit execution once, or abort with Enter.')}`
    : 'Type APPROVE to permit execution once, or abort with Enter.';

  const width = Math.max(64, cmd.length + 8);
  const pad = (str: string, visualLen: number) => {
    const space = Math.max(0, width - visualLen - 2);
    return ' ' + str + ' '.repeat(space) + ' ';
  };

  const b = border('│');
  const top = border('╭' + '─'.repeat(width) + '╮');
  const mid = border('├' + '─'.repeat(width) + '┤');
  const bot = border('╰' + '─'.repeat(width) + '╯');

  return [
    top,
    `${b}${pad(warnTitle, 37)}${b}`,
    mid,
    `${b}${pad('Command to execute:', 19)}${b}`,
    `${b}${pad(`  ${cmdText}`, 2 + cmd.length)}${b}`,
    mid,
    `${b}${pad(promptText, 62)}${b}`,
    bot,
  ].join('\n');
}
