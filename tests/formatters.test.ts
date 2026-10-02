import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  formatDiff,
  parseDiffStats,
  formatTestResults,
  formatAuditLog,
  renderMarkdown,
  isColorSupported,
  colors
} from '../src/ui/index.js';

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (str: string): string => str.replace(ANSI_REGEX, '');

describe('Formatters & Renderers Unit Tests (Milestone M2)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  /* -------------------------------------------------------------------------- */
  /* formatDiff & parseDiffStats                                                */
  /* -------------------------------------------------------------------------- */
  describe('formatDiff & parseDiffStats', () => {
    it('accurately parses diff stats for multi-file changes', () => {
      const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+const x = 1;
+const y = 2;
-const z = 0;
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
+const a = 10;
-const b = 20;`;

      const stats = parseDiffStats(diff);
      expect(stats.added).toBe(3);
      expect(stats.deleted).toBe(2);
      expect(stats.files).toBe(2);
    });

    it('formats clean empty notice when diff is empty or whitespace', () => {
      const emptyRes = formatDiff('', true);
      expect(stripAnsi(emptyRes).toLowerCase()).toContain('no changes detected');

      const wsRes = formatDiff('   \n\t  \n', true);
      expect(stripAnsi(wsRes).toLowerCase()).toContain('no changes detected');
    });

    it('formats diff with cyan headers, magenta chunks, green additions, and red deletions in TTY mode', () => {
      process.env.FORCE_COLOR = '1';
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,2 @@
-old code
+new code`;

      const formatted = formatDiff(diff, true);
      // Verify ANSI color sequences are present
      expect(formatted).toMatch(/\x1b\[[0-9;]*m/);

      const raw = stripAnsi(formatted);
      expect(raw).toContain('--- a/src/app.ts');
      expect(raw).toContain('+++ b/src/app.ts');
      expect(raw).toContain('-old code');
      expect(raw).toContain('+new code');
      expect(raw).toContain('Diff Stats: +1 -1 (1 file)');
    });

    it('outputs clean plain text in non-TTY mode', () => {
      const diff = `+const added = true;\n-const deleted = false;`;
      const formatted = formatDiff(diff, false);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('+const added = true;');
      expect(formatted).toContain('-const deleted = false;');
      expect(formatted).toContain('Diff Stats: +1 -1');
    });

    it('respects NO_COLOR environment variable', () => {
      process.env.NO_COLOR = '1';
      const diff = `+some addition\n-some deletion`;
      const formatted = formatDiff(diff, true);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('+some addition');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* formatTestResults                                                          */
  /* -------------------------------------------------------------------------- */
  describe('formatTestResults', () => {
    it('formats passing test results with PASS badge in TTY mode', () => {
      process.env.FORCE_COLOR = '1';
      const res = {
        ok: true,
        output: 'command=npm test\nexit=0\nTests: 12 passed\nTime: 1.2s'
      };

      const formatted = formatTestResults(res, true);
      expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('PASS');
      expect(raw).toContain('npm test');
      expect(raw).toContain('Exit Code: 0');
      expect(raw).toContain('Tests: 12 passed');
    });

    it('formats failing test results with FAIL badge in TTY mode', () => {
      process.env.FORCE_COLOR = '1';
      const res = {
        ok: false,
        output: 'command=npm test\nexit=1\nFAIL tests/auth.test.ts\nTypeError: null is not an object'
      };

      const formatted = formatTestResults(res, true);
      expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('FAIL');
      expect(raw).toContain('Exit Code: 1');
      expect(raw).toContain('FAIL tests/auth.test.ts');
    });

    it('handles raw string test output without throwing', () => {
      const rawOutput = 'command=pytest\nexit=0\n=== 5 passed in 0.4s ===';
      const formatted = formatTestResults(rawOutput, false);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('[PASS]');
      expect(formatted).toContain('pytest');
      expect(formatted).toContain('5 passed in 0.4s');
    });

    it('formats test error string when execution fails', () => {
      const res = {
        ok: false,
        error: 'Execution timed out after 300000ms'
      };
      const formatted = formatTestResults(res, false);
      expect(formatted).toContain('[FAIL]');
      expect(formatted).toContain('Execution timed out');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* formatAuditLog                                                             */
  /* -------------------------------------------------------------------------- */
  describe('formatAuditLog', () => {
    it('formats approved audit entry with APPROVED badge in TTY mode', () => {
      process.env.FORCE_COLOR = '1';
      const entry = {
        action: 'file_write',
        target: 'src/main.ts',
        approved: true,
        riskLevel: 'medium' as const,
        user: 'developer',
        timestamp: '2026-10-01T17:00:00Z'
      };

      const formatted = formatAuditLog(entry, true);
      expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('APPROVED');
      expect(raw).toContain('file_write');
      expect(raw).toContain('src/main.ts');
      expect(raw).toContain('MEDIUM');
      expect(raw).toContain('developer');
    });

    it('formats blocked audit entry with BLOCKED badge in TTY mode', () => {
      process.env.FORCE_COLOR = '1';
      const entry = {
        action: 'run_destructive_command',
        command: 'rm -rf /',
        approved: false,
        riskLevel: 'critical' as const,
        details: 'Root path deletion forbidden'
      };

      const formatted = formatAuditLog(entry, true);
      expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('BLOCKED');
      expect(raw).toContain('CRITICAL');
      expect(raw).toContain('rm -rf /');
      expect(raw).toContain('Root path deletion forbidden');
    });

    it('formats audit string log in TTY and non-TTY mode', () => {
      const logStr = '[Audit] Destructive command approved: git reset --hard HEAD';
      const ttyRes = formatAuditLog(logStr, true);
      expect(stripAnsi(ttyRes)).toBe(logStr);

      const nonTtyRes = formatAuditLog(logStr, false);
      expect(nonTtyRes).toBe(logStr);
    });

    it('produces clean plain text in non-TTY mode without ANSI codes', () => {
      const entry = {
        action: 'deploy_prod',
        target: 'us-east-1',
        approved: true,
        riskLevel: 'high' as const
      };
      const formatted = formatAuditLog(entry, false);
      expect(formatted).not.toMatch(ANSI_REGEX);
      expect(formatted).toContain('=== SAFETY AUDIT LOG ===');
      expect(formatted).toContain('Action:    deploy_prod');
      expect(formatted).toContain('Status:    APPROVED');
      expect(formatted).toContain('Risk:      HIGH');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* renderMarkdown Edge Cases                                                  */
  /* -------------------------------------------------------------------------- */
  describe('renderMarkdown Edge Cases', () => {
    it('renders H1, H2, H3, H4 headings with distinct formatting', () => {
      process.env.FORCE_COLOR = '1';
      const md = '# Title\n## Section\n### SubSection\n#### Detail';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('Title');
      expect(raw).toContain('Section');
      expect(raw).toContain('SubSection');
      expect(raw).toContain('Detail');
      expect(formatted).toMatch(/\x1b\[[0-9;]*m/);
    });

    it('renders blockquotes with vertical border glyph', () => {
      process.env.FORCE_COLOR = '1';
      const md = '> This is a quoted caution note.';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('│');
      expect(raw).toContain('This is a quoted caution note.');
    });

    it('renders horizontal rules with divider lines', () => {
      process.env.FORCE_COLOR = '1';
      const md = 'Above\n---\nBelow';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('Above');
      expect(raw).toContain('────');
      expect(raw).toContain('Below');
    });

    it('renders numbered lists with numeric labels', () => {
      process.env.FORCE_COLOR = '1';
      const md = '1. Step One\n2. Step Two\n3. Step Three';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('1.');
      expect(raw).toContain('Step One');
      expect(raw).toContain('2.');
      expect(raw).toContain('Step Two');
    });

    it('renders markdown links and italic text', () => {
      process.env.FORCE_COLOR = '1';
      const md = 'Check the [documentation](https://vibe.dev) and *note* the details.';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('documentation');
      expect(raw).toContain('https://vibe.dev');
      expect(raw).toContain('note');
    });

    it('safely handles code block without language tag', () => {
      const md = '```\necho "hello"\n```';
      const formatted = renderMarkdown(md, true);
      const raw = stripAnsi(formatted);
      expect(raw).toContain('echo "hello"');
      expect(raw).toContain('code');
    });
  });
});
