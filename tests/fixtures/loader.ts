import * as mockUI from './mock-ui.js';
import type { TeamworkEvent } from './mock-events.js';
import fs from 'node:fs';
import path from 'node:path';

export interface UIModuleStatus {
  theme: 'real' | 'fixture';
  table: 'real' | 'fixture';
  banner: 'real' | 'fixture';
  help: 'real' | 'fixture';
  diff: 'real' | 'fixture';
  markdown: 'real' | 'fixture';
  dashboard: 'real' | 'fixture';
}

const status: UIModuleStatus = {
  theme: 'fixture',
  table: 'fixture',
  banner: 'fixture',
  help: 'fixture',
  diff: 'fixture',
  markdown: 'fixture',
  dashboard: 'fixture'
};

function hasSourceFile(filename: string): boolean {
  const p = path.resolve(process.cwd(), 'src/ui', filename);
  return fs.existsSync(p);
}

// Dynamic imports using variables so TypeScript does not statically reject uncreated files
let realTheme: any = null;
let realTable: any = null;
let realBanner: any = null;
let realHelp: any = null;
let realDiff: any = null;
let realMarkdown: any = null;
let realDashboard: any = null;

if (hasSourceFile('theme.ts')) {
  try {
    const p = '../../src/ui/theme.js';
    realTheme = await import(p);
    status.theme = 'real';
  } catch { /* fallback */ }
}

if (hasSourceFile('table.ts')) {
  try {
    const p = '../../src/ui/table.js';
    realTable = await import(p);
    status.table = 'real';
  } catch { /* fallback */ }
}

if (hasSourceFile('banner.ts')) {
  try {
    const p = '../../src/ui/banner.js';
    realBanner = await import(p);
    status.banner = 'real';
  } catch { /* fallback */ }
}

if (hasSourceFile('help.ts')) {
  try {
    const p = '../../src/ui/help.js';
    realHelp = await import(p);
    status.help = 'real';
  } catch { /* fallback */ }
}

if (hasSourceFile('diff.ts')) {
  try {
    const p = '../../src/ui/diff.js';
    realDiff = await import(p);
    status.diff = 'real';
  } catch { /* fallback */ }
}

if (hasSourceFile('markdown.ts')) {
  try {
    const p = '../../src/ui/markdown.js';
    realMarkdown = await import(p);
    status.markdown = 'real';
  } catch { /* fallback */ }
}

if (hasSourceFile('dashboard.ts')) {
  try {
    const p = '../../src/ui/dashboard.js';
    realDashboard = await import(p);
    status.dashboard = 'real';
  } catch { /* fallback */ }
}

export const getUIStatus = (): UIModuleStatus => ({ ...status });

export const isColorSupported = realTheme?.isColorSupported || mockUI.isColorSupported;
export const isInteractive = realTheme?.isInteractive || mockUI.isInteractive;
export const colors = realTheme?.colors || mockUI.colors;

export const createTable = realTable?.createTable || mockUI.createTable;
export const renderTable = realTable?.renderTable || mockUI.renderTable;

export const renderBanner = realBanner?.renderBanner || mockUI.renderBanner;
export const renderApprovalCard = realBanner?.renderApprovalCard || mockUI.renderApprovalCard;

export const renderHelp = realHelp?.renderHelp || mockUI.renderHelp;

export const formatDiff = realDiff?.formatDiff || mockUI.formatDiff;

export const renderMarkdown = realMarkdown?.renderMarkdown || mockUI.renderMarkdown;

export const TeamworkDashboard = realDashboard?.TeamworkDashboard || mockUI.TeamworkDashboard;
export type { TeamworkEvent };
