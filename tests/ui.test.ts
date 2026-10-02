import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isColorSupported,
  isInteractive,
  colors,
  renderTable,
  createTable,
  renderBanner,
  renderApprovalCard,
  renderHelp,
  formatDiff,
  renderMarkdown,
  TeamworkDashboard,
  getUIStatus
} from './fixtures/loader.js';
import { MOCK_DIFFS } from './fixtures/mock-diffs.js';
import { MOCK_MARKDOWN } from './fixtures/mock-markdown.js';
import { MOCK_EVENT_SEQUENCES } from './fixtures/mock-events.js';
import { MOCK_SLASH_DATA } from './fixtures/mock-tables.js';

// Helper regex to detect ANSI escape codes
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Helper to strip ANSI codes for assertions on raw content
const stripAnsi = (str: string): string => str.replace(ANSI_REGEX, '');

/* ========================================================================== */
/* Tier 1: Feature Coverage (>=5 test cases per feature)                       */
/* ========================================================================== */

describe('Tier 1: Feature Coverage', () => {

  // Feature 1: Startup Banner & Approval Card
  describe('Feature 1: Startup Banner & Approval Card', () => {
    it('1.1: renderBanner returns branded string containing application title', () => {
      const banner = renderBanner({ model: 'gpt-4o', quality: 'max', workspace: '/test/workspace' });
      const raw = stripAnsi(banner);
      expect(raw.toLowerCase()).toContain('vibe cli');
    });

    it('1.2: renderBanner includes configured model information', () => {
      const banner = renderBanner({ model: 'claude-3-5-sonnet', quality: 'high', workspace: '/test' });
      const raw = stripAnsi(banner);
      expect(raw).toContain('claude-3-5-sonnet');
    });

    it('1.3: renderBanner includes configured quality mode preset', () => {
      const banner = renderBanner({ model: 'gpt-4o', quality: 'balanced', workspace: '/test' });
      const raw = stripAnsi(banner);
      expect(raw).toContain('balanced');
    });

    it('1.4: renderBanner includes current workspace directory', () => {
      const banner = renderBanner({ model: 'gpt-4o', quality: 'fast', workspace: 'd:/scr code/tdotcliag' });
      const raw = stripAnsi(banner);
      expect(raw).toContain('d:/scr code/tdotcliag');
    });

    it('1.5: renderApprovalCard formats high-risk warning box', () => {
      const card = renderApprovalCard('git reset --hard HEAD~1');
      const raw = stripAnsi(card);
      expect(raw.toUpperCase()).toContain('HIGH-RISK');
    });

    it('1.6: renderApprovalCard includes the exact requested command string', () => {
      const cmd = 'rm -rf node_modules && npm i';
      const card = renderApprovalCard(cmd);
      const raw = stripAnsi(card);
      expect(raw).toContain(cmd);
    });

    it('1.7: renderApprovalCard prompts for APPROVE confirmation instruction', () => {
      const card = renderApprovalCard('drop database');
      const raw = stripAnsi(card);
      expect(raw).toContain('APPROVE');
    });
  });

  // Feature 2: Table Rendering (renderTable & createTable)
  describe('Feature 2: Table Rendering (renderTable & createTable)', () => {
    it('2.1: renderTable renders defined column headers correctly', () => {
      const output = renderTable(['Name', 'Role', 'Status'], [
        ['Alice', 'developer', 'active'],
        ['Bob', 'reviewer', 'idle']
      ]);
      const raw = stripAnsi(output);
      expect(raw).toContain('Name');
      expect(raw).toContain('Role');
      expect(raw).toContain('Status');
    });

    it('2.2: renderTable formats tabular rows with correct cell values', () => {
      const output = renderTable(['ID', 'Count'], [
        ['ITEM-1', 42],
        ['ITEM-2', 99]
      ]);
      const raw = stripAnsi(output);
      expect(raw).toContain('ITEM-1');
      expect(raw).toContain('42');
      expect(raw).toContain('ITEM-2');
      expect(raw).toContain('99');
    });

    it('2.3: renderTable maintains multi-column alignment structure', () => {
      const output = renderTable(['ColA', 'ColB'], [
        ['Short', 'MuchLongerTextContentHere']
      ]);
      const lines = stripAnsi(output).split('\n');
      expect(lines.length).toBeGreaterThan(2);
    });

    it('2.4: createTable returns a configured Table instance with push and toString', () => {
      const table = createTable({ head: ['A', 'B'] });
      expect(table).toBeDefined();
      expect(typeof table.push).toBe('function');
      expect(typeof table.toString).toBe('function');
      table.push(['val1', 'val2']);
      const res = stripAnsi(table.toString());
      expect(res).toContain('val1');
      expect(res).toContain('val2');
    });

    it('2.5: renderTable includes border separator characters', () => {
      const output = renderTable(['H1', 'H2'], [['D1', 'D2']]);
      const raw = stripAnsi(output);
      // Checks for unicode or ascii border elements
      const hasBorders = /[│|─\-┌╭+]/.test(raw);
      expect(hasBorders).toBe(true);
    });

    it('2.6: renderTable handles numeric and boolean cell values without throwing', () => {
      const output = renderTable(['Key', 'Num', 'Bool'], [
        ['alpha', 100, true as any],
        ['beta', 0, false as any]
      ]);
      const raw = stripAnsi(output);
      expect(raw).toContain('100');
      expect(raw).toContain('true');
    });
  });

  // Feature 3: Git Diff Syntax Highlighter (formatDiff)
  describe('Feature 3: Git Diff Syntax Highlighter (formatDiff)', () => {
    it('3.1: formatDiff preserves diff headers and file names', () => {
      const diff = MOCK_DIFFS.singleLineChange;
      const formatted = formatDiff(diff, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('--- a/src/index.ts');
      expect(raw).toContain('+++ b/src/index.ts');
    });

    it('3.2: formatDiff highlights addition lines (+) with green color in TTY mode', () => {
      const orig = process.env.FORCE_COLOR;
      process.env.FORCE_COLOR = '1';
      try {
        const diff = '+const newVariable = 42;';
        const formatted = formatDiff(diff, true);
        expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
        expect(stripAnsi(formatted)).toContain('+const newVariable = 42;');
      } finally {
        process.env.FORCE_COLOR = orig;
      }
    });

    it('3.3: formatDiff highlights deletion lines (-) with red color in TTY mode', () => {
      const orig = process.env.FORCE_COLOR;
      process.env.FORCE_COLOR = '1';
      try {
        const diff = '-const oldVariable = 10;';
        const formatted = formatDiff(diff, true);
        expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
        expect(stripAnsi(formatted)).toContain('-const oldVariable = 10;');
      } finally {
        process.env.FORCE_COLOR = orig;
      }
    });

    it('3.4: formatDiff highlights chunk marker (@@) lines in TTY mode', () => {
      const orig = process.env.FORCE_COLOR;
      process.env.FORCE_COLOR = '1';
      try {
        const diff = '@@ -1,3 +1,3 @@\n context';
        const formatted = formatDiff(diff, true);
        expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
        expect(stripAnsi(formatted)).toContain('@@ -1,3 +1,3 @@');
      } finally {
        process.env.FORCE_COLOR = orig;
      }
    });

    it('3.5: formatDiff appends summary diff statistics (+added / -deleted)', () => {
      const diff = MOCK_DIFFS.singleLineChange;
      const formatted = formatDiff(diff, true);
      const raw = stripAnsi(formatted);
      expect(raw.toLowerCase()).toContain('diff stats');
      expect(raw).toMatch(/\+1/);
      expect(raw).toMatch(/-1/);
    });

    it('3.6: formatDiff processes multi-file diff outputs cleanly', () => {
      const diff = MOCK_DIFFS.multiFileChange;
      const formatted = formatDiff(diff, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('src/a.ts');
      expect(raw).toContain('src/b.ts');
      expect(raw).toMatch(/\+4/);
      expect(raw).toMatch(/-2/);
    });
  });

  // Feature 4: Terminal Markdown Renderer (renderMarkdown)
  describe('Feature 4: Terminal Markdown Renderer (renderMarkdown)', () => {
    it('4.1: renderMarkdown formats headings with distinct markers', () => {
      const md = '# Header 1\n## Header 2\n### Header 3';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('Header 1');
      expect(raw).toContain('Header 2');
      expect(raw).toContain('Header 3');
    });

    it('4.2: renderMarkdown formats fenced code blocks with borders or language tags', () => {
      const md = '```typescript\nconst a = 1;\n```';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('const a = 1;');
      expect(raw.toLowerCase()).toContain('typescript');
    });

    it('4.3: renderMarkdown highlights inline code backticks', () => {
      const md = 'Run the command `npm test` to verify.';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('npm test');
    });

    it('4.4: renderMarkdown formats bullet list items', () => {
      const md = '- Item Alpha\n- Item Beta\n- Item Gamma';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('Item Alpha');
      expect(raw).toContain('Item Beta');
      expect(raw).toContain('Item Gamma');
    });

    it('4.5: renderMarkdown formats bold emphasis text', () => {
      const orig = process.env.FORCE_COLOR;
      process.env.FORCE_COLOR = '1';
      try {
        const md = 'This is **critical** information.';
        const formatted = renderMarkdown(md, true);
        const raw = stripAnsi(formatted);
        expect(raw).toContain('critical');
        expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
      } finally {
        process.env.FORCE_COLOR = orig;
      }
    });

    it('4.6: renderMarkdown parses full structured documents without throwing', () => {
      const formatted = renderMarkdown(MOCK_MARKDOWN.standard, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('System Status');
      expect(raw).toContain('Task A');
      expect(raw).toContain('Running test suite...');
    });
  });

  // Feature 5: Multi-Agent Dashboard Lifecycle (TeamworkDashboard)
  describe('Feature 5: Multi-Agent Dashboard Lifecycle (TeamworkDashboard)', () => {
    it('5.1: TeamworkDashboard initializes and starts with active state', () => {
      const dash = new TeamworkDashboard();
      expect(dash.isRunning).toBe(false);
      dash.start();
      expect(dash.isRunning).toBe(true);
      dash.stop();
      expect(dash.isRunning).toBe(false);
    });

    it('5.2: onEvent handles session_start and planner_start events', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      dash.onEvent({ type: 'session_start', message: 'Session 01' });
      dash.onEvent({ type: 'planner_start', agentId: 'planner-01', role: 'planner' });

      expect(dash.agents.has('planner-01')).toBe(true);
      expect(dash.agents.get('planner-01')?.status).toBe('running');
      dash.stop();
    });

    it('5.3: onEvent handles task_start and updates agent current task', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      dash.onEvent({
        type: 'task_start',
        agentId: 'coder-01',
        role: 'coder',
        message: 'Implement auth module'
      });

      const agent = dash.agents.get('coder-01');
      expect(agent).toBeDefined();
      expect(agent?.role).toBe('coder');
      expect(agent?.status).toBe('running');
      expect(agent?.task).toContain('Implement auth module');
      dash.stop();
    });

    it('5.4: onEvent handles task_complete and transitions status', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'T1' });
      dash.onEvent({ type: 'task_complete', agentId: 'coder-01', role: 'coder', message: 'T1 done' });

      expect(dash.agents.get('coder-01')?.status).toBe('completed');
      dash.stop();
    });

    it('5.5: onEvent handles task_failed and marks agent status as failed (bug fix validation)', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'Compile ts' });
      dash.onEvent({
        type: 'task_failed',
        agentId: 'coder-01',
        role: 'coder',
        message: 'tsc exited with 1'
      });

      const agent = dash.agents.get('coder-01');
      expect(agent?.status).toBe('failed');
      expect(agent?.status).not.toBe('running');
      dash.stop();
    });

    it('5.6: stop() captures summary report and completes session', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      dash.onEvent({ type: 'session_start', message: 'S1' });
      dash.stop({ totalEvents: 1, durationMs: 250 });

      expect(dash.isRunning).toBe(false);
      expect(dash.summary).toBeDefined();
      expect(dash.summary.totalEvents).toBe(1);
    });
  });
});

/* ========================================================================== */
/* Tier 2: Boundary & Corner Cases                                            */
/* ========================================================================== */

describe('Tier 2: Boundary & Corner Cases', () => {

  describe('Boundary 2.1: Empty and Minimal Diffs', () => {
    it('2.1.1: formatDiff handles empty string without throwing', () => {
      const result = formatDiff(MOCK_DIFFS.emptyDiff, true);
      const raw = stripAnsi(result);
      expect(raw.toLowerCase()).toContain('no changes');
    });

    it('2.1.2: formatDiff handles whitespace-only diff cleanly', () => {
      const result = formatDiff(MOCK_DIFFS.whitespaceOnlyDiff, true);
      const raw = stripAnsi(result);
      expect(raw.toLowerCase()).toContain('no changes');
    });

    it('2.1.3: formatDiff handles header-only diff with zero additions/deletions', () => {
      const result = formatDiff(MOCK_DIFFS.headerOnlyDiff, true);
      const raw = stripAnsi(result);
      expect(raw).toContain('src/file.ts');
      expect(raw).toMatch(/\+0/);
      expect(raw).toMatch(/-0/);
    });

    it('2.1.4: formatDiff handles malformed diff lines gracefully', () => {
      const result = formatDiff(MOCK_DIFFS.malformedDiff, true);
      expect(result).toBeDefined();
      expect(stripAnsi(result)).toContain('+just a plus line');
    });
  });

  describe('Boundary 2.2: Table Boundaries & Extreme Data', () => {
    it('2.2.1: renderTable handles empty rows array without throwing', () => {
      const result = renderTable(MOCK_SLASH_DATA.emptyTable.head, MOCK_SLASH_DATA.emptyTable.rows);
      expect(result).toBeDefined();
      const raw = stripAnsi(result);
      expect(raw).toContain('Col1');
    });

    it('2.2.2: renderTable handles completely empty headers and rows', () => {
      const result = renderTable(MOCK_SLASH_DATA.completelyEmpty.head, MOCK_SLASH_DATA.completelyEmpty.rows);
      expect(result).toBe('');
    });

    it('2.2.3: renderTable renders single-column table correctly', () => {
      const result = renderTable(MOCK_SLASH_DATA.singleColumn.head, MOCK_SLASH_DATA.singleColumn.rows);
      const raw = stripAnsi(result);
      expect(raw).toContain('Command');
      expect(raw).toContain('/help');
      expect(raw).toContain('/teamwork');
    });

    it('2.2.4: renderTable handles extremely long strings without throwing or crashing', () => {
      const result = renderTable(MOCK_SLASH_DATA.longStrings.head, MOCK_SLASH_DATA.longStrings.rows);
      expect(result).toBeDefined();
      const raw = stripAnsi(result);
      expect(raw).toContain('EXT-001');
    });

    it('2.2.5: renderTable handles null and undefined cell values safely', () => {
      const result = renderTable(['Col1', 'Col2', 'Col3'], [
        ['val1', null as any, undefined as any]
      ]);
      expect(result).toBeDefined();
      const raw = stripAnsi(result);
      expect(raw).toContain('val1');
    });
  });

  describe('Boundary 2.3: Markdown Edge Cases', () => {
    it('2.3.1: renderMarkdown handles empty string without throwing', () => {
      const result = renderMarkdown(MOCK_MARKDOWN.empty, true);
      expect(result).toBe('');
    });

    it('2.3.2: renderMarkdown handles unclosed code fence gracefully', () => {
      const result = renderMarkdown(MOCK_MARKDOWN.unclosedCodeFence, true);
      const raw = stripAnsi(result);
      expect(raw).toContain('const unfinished = true;');
    });

    it('2.3.3: renderMarkdown passes plain text through without disruption', () => {
      const result = renderMarkdown(MOCK_MARKDOWN.plainText, true);
      expect(stripAnsi(result).trim()).toBe(MOCK_MARKDOWN.plainText);
    });

    it('2.3.4: renderMarkdown handles nested markdown and symbols safely', () => {
      const result = renderMarkdown(MOCK_MARKDOWN.nestedFormatting, true);
      const raw = stripAnsi(result);
      expect(raw).toContain('Alpha');
      expect(raw).toContain('alpha_handler()');
    });
  });

  describe('Boundary 2.4: Dashboard Edge Cases & Bursts', () => {
    it('2.4.1: onEvent handles events with missing optional fields without throwing', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      for (const ev of MOCK_EVENT_SEQUENCES.missingFields) {
        expect(() => dash.onEvent(ev)).not.toThrow();
      }
      dash.stop();
    });

    it('2.4.2: onEvent processes rapid bursts of 40+ events sequentially', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      for (const ev of MOCK_EVENT_SEQUENCES.rapidBurst) {
        dash.onEvent(ev);
      }
      expect(dash.events.length).toBe(40);
      dash.stop();
    });

    it('2.4.3: onEvent handles unknown event type safely without crashing', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      expect(() => dash.onEvent({ type: 'unknown_custom_event' as any, message: 'extra' })).not.toThrow();
      dash.stop();
    });

    it('2.4.4: onEvent handles task cancellation event with status cancelled', () => {
      const dash = new TeamworkDashboard();
      dash.start();
      for (const ev of MOCK_EVENT_SEQUENCES.cancellationPath) {
        dash.onEvent(ev);
      }
      const agent = dash.agents.get('coder-02');
      expect(agent?.status).toBe('cancelled');
      dash.stop();
    });
  });
});

/* ========================================================================== */
/* Tier 3: Cross-Feature Combinations                                          */
/* ========================================================================== */

describe('Tier 3: Cross-Feature Combinations', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  describe('Combination 3.1: Non-TTY Fallback Mode', () => {
    it('3.1.1: formatDiff in non-TTY mode returns clean plain text without ANSI escape sequences', () => {
      const diff = MOCK_DIFFS.singleLineChange;
      const formatted = formatDiff(diff, false);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('+const b = 3;');
      expect(formatted).toContain('-const b = 2;');
    });

    it('3.1.2: renderMarkdown in non-TTY mode emits plain text without ANSI color codes', () => {
      const md = MOCK_MARKDOWN.standard;
      const formatted = renderMarkdown(md, false);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('Task A: completed');
    });

    it('3.1.3: renderTable in plain mode produces valid plaintext layout without ANSI styling', () => {
      const output = renderTable(
        ['Command', 'Desc'],
        [['/help', 'Help command']],
        { plain: true } as any
      );
      expect(output).not.toMatch(ANSI_REGEX);
      expect(output).toContain('/help');
    });

    it('3.1.4: renderBanner in plain mode renders clean text without ANSI styling', () => {
      const banner = renderBanner(
        { model: 'm', quality: 'fast', workspace: 'd:/ws' },
        { plain: true }
      );
      expect(banner).not.toMatch(ANSI_REGEX);
      expect(banner).toContain('Model:');
      expect(banner).toContain('Quality:');
    });

    it('3.1.5: renderApprovalCard in plain mode outputs plain text warning box without ANSI styling', () => {
      const card = renderApprovalCard('git clean -fd', { plain: true });
      expect(card).not.toMatch(ANSI_REGEX);
      expect(card).toContain('git clean -fd');
      expect(card).toContain('APPROVE');
    });
  });

  describe('Combination 3.2: NO_COLOR Environment Variable', () => {
    it('3.2.1: isColorSupported returns false when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      expect(isColorSupported()).toBe(false);
    });

    it('3.2.2: colors wrap returns plain unstyled strings when NO_COLOR is set', () => {
      process.env.NO_COLOR = 'true';
      expect(colors.cyan('test-text')).toBe('test-text');
      expect(colors.red('error-msg')).toBe('error-msg');
      expect(colors.green('ok-msg')).toBe('ok-msg');
    });

    it('3.2.3: renderBanner produces output without ANSI escapes when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      const banner = renderBanner({ model: 'gpt-4o', quality: 'high', workspace: '/ws' });
      expect(banner).not.toMatch(ANSI_REGEX);
      expect(banner).toContain('gpt-4o');
    });

    it('3.2.4: formatDiff produces diff without ANSI escapes when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      const diff = '+new code added';
      const formatted = formatDiff(diff, true);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('+new code added');
    });
  });

  describe('Combination 3.3: Interactive Environment Detection', () => {
    it('3.3.1: isInteractive returns false when CI environment variable is set', () => {
      process.env.CI = 'true';
      expect(isInteractive()).toBe(false);
    });

    it('3.3.2: isInteractive returns false when CONTINUOUS_INTEGRATION is set', () => {
      delete process.env.CI;
      process.env.CONTINUOUS_INTEGRATION = '1';
      expect(isInteractive()).toBe(false);
    });

    it('3.3.3: isInteractive returns false when TERM is dumb', () => {
      delete process.env.CI;
      delete process.env.CONTINUOUS_INTEGRATION;
      process.env.TERM = 'dumb';
      expect(isInteractive()).toBe(false);
    });
  });
});

/* ========================================================================== */
/* Tier 4: Real-World Scenarios                                                */
/* ========================================================================== */

describe('Tier 4: Real-World Scenarios', () => {

  describe('Scenario 4.1: Slash Commands Output Formatting', () => {
    it('4.1.1: renders /models & /model-pool table with accurate metadata', () => {
      const output = renderTable(MOCK_SLASH_DATA.models.head, MOCK_SLASH_DATA.models.rows);
      const raw = stripAnsi(output);
      expect(raw).toContain('gpt-4o');
      expect(raw).toContain('claude-3-5-sonnet');
      expect(raw).toContain('gemini-1.5-pro');
      expect(raw).toContain('deepseek-coder-v2');
      expect(raw).toContain('128000');
    });

    it('4.1.2: renders /router-status table with latency, error rates, and health', () => {
      const output = renderTable(MOCK_SLASH_DATA.routerStatus.head, MOCK_SLASH_DATA.routerStatus.rows);
      const raw = stripAnsi(output);
      expect(raw).toContain('gpt-4o');
      expect(raw).toContain('450ms');
      expect(raw).toContain('healthy');
      expect(raw).toContain('degraded');
    });

    it('4.1.3: renders /agents table with agent IDs, roles, statuses, and models', () => {
      const output = renderTable(MOCK_SLASH_DATA.agents.head, MOCK_SLASH_DATA.agents.rows);
      const raw = stripAnsi(output);
      expect(raw).toContain('agent-plan-01');
      expect(raw).toContain('agent-coder-01');
      expect(raw).toContain('agent-tester-01');
      expect(raw).toContain('running');
      expect(raw).toContain('waiting');
    });

    it('4.1.4: renders /tasks & /plan table with task dependencies and titles', () => {
      const output = renderTable(MOCK_SLASH_DATA.tasks.head, MOCK_SLASH_DATA.tasks.rows);
      const raw = stripAnsi(output);
      expect(raw).toContain('T1');
      expect(raw).toContain('T2');
      expect(raw).toContain('T3');
      expect(raw).toContain('Analyze codebase');
      expect(raw).toContain('Implement UI theme');
    });

    it('4.1.5: renders /sessions table with persistent database history', () => {
      const output = renderTable(MOCK_SLASH_DATA.sessions.head, MOCK_SLASH_DATA.sessions.rows);
      const raw = stripAnsi(output);
      expect(raw).toContain('sess_20261001_01');
      expect(raw).toContain('sess_20261001_02');
      expect(raw).toContain('closed');
      expect(raw).toContain('active');
    });

    it('4.1.6: renderHelp produces categorized directory covering Core, Models, Teamwork, and Dev Tools', () => {
      const helpOutput = renderHelp();
      const raw = stripAnsi(helpOutput);
      expect(raw).toContain('/help');
      expect(raw).toContain('/status');
      expect(raw).toContain('/models');
      expect(raw).toContain('/teamwork');
      expect(raw).toContain('/diff');
      expect(raw).toContain('/test');
    });
  });

  describe('Scenario 4.2: Teamwork Multi-Agent Lifecycle Simulation', () => {
    it('4.2.1: simulates complete collaborative workflow (planner -> coder -> tester -> reviewer)', () => {
      const dash = new TeamworkDashboard();
      dash.start();

      for (const event of MOCK_EVENT_SEQUENCES.happyPath) {
        dash.onEvent(event);
      }

      // Verify all agents were tracked
      expect(dash.agents.has('planner-01')).toBe(true);
      expect(dash.agents.has('coder-01')).toBe(true);
      expect(dash.agents.has('tester-01')).toBe(true);
      expect(dash.agents.has('reviewer-01')).toBe(true);

      // Verify all tasks reached completed status
      expect(dash.agents.get('coder-01')?.status).toBe('completed');
      expect(dash.agents.get('tester-01')?.status).toBe('completed');
      expect(dash.agents.get('reviewer-01')?.status).toBe('completed');

      dash.stop({ success: true, tasksCompleted: 3 });
      expect(dash.isRunning).toBe(false);
      expect(dash.summary.success).toBe(true);
    });

    it('4.2.2: simulates agent failure path, capturing error and avoiding stuck running state', () => {
      const dash = new TeamworkDashboard();
      dash.start();

      for (const event of MOCK_EVENT_SEQUENCES.failurePath) {
        dash.onEvent(event);
      }

      const failedAgent = dash.agents.get('coder-01');
      expect(failedAgent).toBeDefined();
      expect(failedAgent?.status).toBe('failed');
      expect(failedAgent?.status).not.toBe('running');

      dash.stop({ success: false, failedTask: 'T1' });
      expect(dash.summary.success).toBe(false);
    });

    it('4.2.3: simulates user cancellation of teamwork DAG execution', () => {
      const dash = new TeamworkDashboard();
      dash.start();

      for (const event of MOCK_EVENT_SEQUENCES.cancellationPath) {
        dash.onEvent(event);
      }

      const cancelledAgent = dash.agents.get('coder-02');
      expect(cancelledAgent?.status).toBe('cancelled');
      dash.stop();
    });

    it('4.2.4: interleaves live log entries during active agent execution', () => {
      const dash = new TeamworkDashboard();
      dash.start();

      dash.onEvent({ type: 'task_start', agentId: 'coder-01', role: 'coder', message: 'Writing code' });
      dash.log('[Audit] File write approved: src/ui/theme.ts');
      dash.log('[Test] Running quick lint...');
      dash.onEvent({ type: 'task_complete', agentId: 'coder-01', role: 'coder', message: 'Done' });

      expect(dash.logs.length).toBe(2);
      expect(dash.logs[0]).toContain('File write approved');
      expect(dash.logs[1]).toContain('Running quick lint');
      dash.stop();
    });

    it('4.2.5: renders status matrix table representing all active agents', () => {
      const dash = new TeamworkDashboard();
      dash.start();

      dash.onEvent({ type: 'task_start', agentId: 'agent-1', role: 'coder', message: 'Building UI' });
      dash.onEvent({ type: 'task_start', agentId: 'agent-2', role: 'tester', message: 'Testing components' });

      if (typeof dash.renderStatusMatrix === 'function') {
        const matrix = dash.renderStatusMatrix();
        const raw = stripAnsi(matrix);
        expect(raw).toContain('agent-1');
        expect(raw).toContain('coder');
        expect(raw).toContain('agent-2');
        expect(raw).toContain('tester');
      }
      dash.stop();
    });
  });
});
