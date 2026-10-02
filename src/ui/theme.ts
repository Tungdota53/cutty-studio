import { Chalk } from 'chalk';
import pc from 'picocolors';
import ora, { type Ora, type Options as OraOptions } from 'ora';

export const isTTY = Boolean(process.stdout && process.stdout.isTTY);
export const isCI = Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION);

export function isColorSupported(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  if (process.env.FORCE_COLOR === '1') {
    return true;
  }
  if (process.env.FORCE_COLOR === '0' || process.env.TERM === 'dumb') {
    return false;
  }
  return Boolean(process.stdout?.isTTY || pc.isColorSupported);
}

export function isInteractive(): boolean {
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION || process.env.TERM === 'dumb') {
    return false;
  }
  return Boolean(process.stdout?.isTTY);
}

export const symbols = {
  tick: '✔',
  cross: '✖',
  info: 'ℹ',
  warning: '⚠',
  arrow: '→',
  bullet: '•',
  star: '★',
  pointer: '❯',
  radioOn: '◉',
  radioOff: '◯',
};

const chalkInstance = new Chalk({ level: 3 });

const wrapColor = (formatter: (val: string | number) => string) => {
  return (value: string | number): string => {
    return isColorSupported() ? formatter(value) : String(value);
  };
};

export const colors = {
  cyan: wrapColor(val => chalkInstance.cyan(val)),
  green: wrapColor(val => chalkInstance.green(val)),
  red: wrapColor(val => chalkInstance.red(val)),
  yellow: wrapColor(val => chalkInstance.yellow(val)),
  magenta: wrapColor(val => chalkInstance.magenta(val)),
  blue: wrapColor(val => chalkInstance.blue(val)),
  gray: wrapColor(val => chalkInstance.gray(val)),
  white: wrapColor(val => chalkInstance.white(val)),
  bold: wrapColor(val => chalkInstance.bold(val)),
  dim: wrapColor(val => chalkInstance.dim(val)),
  underline: wrapColor(val => chalkInstance.underline(val)),
  bgRed: wrapColor(val => chalkInstance.bgRed(val)),
  bgGreen: wrapColor(val => chalkInstance.bgGreen(val)),
  bgYellow: wrapColor(val => chalkInstance.bgYellow(val)),
  bgCyan: wrapColor(val => chalkInstance.bgCyan(val)),
};

export function createSpinner(options?: string | OraOptions): Ora {
  return ora(options);
}
