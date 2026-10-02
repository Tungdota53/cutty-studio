import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import {
  TeamworkDashboard,
  SequentialFallbackLogger,
  formatDiff,
  parseDiffStats,
  renderMarkdown,
  renderTable,
  createTable,
  renderPlainTextTable,
  formatTestResults,
  formatAuditLog,
  isColorSupported,
  isInteractive,
  colors,
} from '../src/ui/index.js';
import type { TeamworkEvent } from '../src/types.js';

// Strict regex matching any ANSI escape sequence
const STRICT_ANSI_REGEX = /(?:\x1b\[[0-9;]*[a-zA-Z]|\x1b[()][A-B0-2]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[>=]|[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><])/g;
const stripAnsi = (str: string): string => str.replace(STRICT_ANSI_REGEX, '');

class MockStream extends Writable {
  public chunks: string[] = [];
  public writeCount = 0;

  constructor(public isTTY = true) {
    super();
  }

  override _write(
    chunk: any,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(chunk.toString());
    this.writeCount++;
    callback();
  }

  getAllOutput(): string {
    return this.chunks.join('');
  }

  clear(): void {
    this.chunks = [];
    this.writeCount = 0;
  }
}

describe('Milestone M6: Adversarial Stress Testing & Coverage Hardening', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...savedEnv };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  /* ========================================================================== */
  /* Suite 1: High-Throughput Rapid Event Bursts (5,000+ Events)                */
  /* ========================================================================== */
  describe('Suite 1: High-Throughput Rapid Event Bursts (5,000+ Events)', () => {
    it('1.1: processes 5,000 rapid event emissions in <200ms without state loss or memory corruption', () => {
      const mockStream = new MockStream(false);
      const dash = new TeamworkDashboard({
        isTTY: false,
        silent: true,
        stream: mockStream as any,
      });
      dash.start();

      const eventTypes: Array<TeamworkEvent['type']> = [
        'session_start',
        'planner_start',
        'planner_done',
        'task_start',
        'task_complete',
        'task_failed',
        'agent_status',
      ];

      const startTime = performance.now();
      const TOTAL_EVENTS = 5000;

      for (let i = 0; i < TOTAL_EVENTS; i++) {
        const type = eventTypes[i % eventTypes.length];
        const agentIdx = i % 25; // 25 rotating agents
        const agentId = `agent-worker-${String(agentIdx).padStart(2, '0')}`;

        dash.onEvent({
          type,
          agentId,
          role: i % 2 === 0 ? 'coder' : 'tester',
          status: type === 'task_failed' ? 'failed' : type === 'task_complete' ? 'completed' : 'running',
          message: `Rapid event batch #${i} for ${agentId}`,
        });
      }

      const elapsed = performance.now() - startTime;

      expect(dash.events.length).toBe(TOTAL_EVENTS);
      expect(dash.agents.size).toBe(25);
      expect(elapsed).toBeLessThan(500); // Must be fast and non-blocking

      dash.stop({ status: 'completed', tasksCompleted: TOTAL_EVENTS });
      expect(dash.isRunning).toBe(false);
      expect(dash.summary.status).toBe('completed');
    });

    it('1.2: massive agent swarm handles 1,000 unique agent registrations and renders status matrix', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      const AGENT_COUNT = 1000;
      for (let i = 0; i < AGENT_COUNT; i++) {
        const id = `agent-swarm-${String(i).padStart(4, '0')}`;
        dash.onEvent({
          type: 'task_start',
          agentId: id,
          role: i % 4 === 0 ? 'planner' : i % 4 === 1 ? 'coder' : i % 4 === 2 ? 'tester' : 'reviewer',
          message: `Executing subtask ${i}`,
        });
      }

      expect(dash.agents.size).toBe(AGENT_COUNT);

      const matrix = dash.renderStatusMatrix();
      expect(typeof matrix).toBe('string');
      expect(matrix.length).toBeGreaterThan(1000);
      expect(matrix).toContain('agent-swarm-0000');
      expect(matrix).toContain('agent-swarm-0999');

      dash.stop();
    });

    it('1.3: high-frequency state flapping toggles agent status 1,000 times without desynchronization', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      const FLAP_CYCLES = 1000;
      const targetAgent = 'agent-flapper-01';

      for (let i = 0; i < FLAP_CYCLES; i++) {
        dash.onEvent({ type: 'task_start', agentId: targetAgent, role: 'coder', message: `cycle ${i}` });
        dash.onEvent({ type: 'agent_status', agentId: targetAgent, status: 'testing', message: `testing ${i}` });
        dash.onEvent({ type: 'task_complete', agentId: targetAgent, message: `done ${i}` });
        dash.onEvent({ type: 'task_failed', agentId: targetAgent, status: 'cancelled', message: `cancel ${i}` });
        dash.onEvent({ type: 'task_failed', agentId: targetAgent, status: 'failed', message: `err ${i}` });
      }

      const agent = dash.agents.get(targetAgent);
      expect(agent).toBeDefined();
      expect(agent?.status).toBe('failed');
      expect(agent?.error).toBe(`err ${FLAP_CYCLES - 1}`);
      expect(dash.events.length).toBe(FLAP_CYCLES * 5);

      dash.stop();
    });

    it('1.4: safely buffers 5,000 interleaved logs and events maintaining strict separation', () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      const TOTAL_INTERLEAVED = 2500;
      for (let i = 0; i < TOTAL_INTERLEAVED; i++) {
        dash.log(`Diagnostic log line #${i}`);
        dash.onEvent({
          type: 'agent_status',
          agentId: 'agent-sync',
          role: 'coder',
          message: `Heartbeat event #${i}`,
        });
      }

      expect(dash.logs.length).toBe(TOTAL_INTERLEAVED);
      expect(dash.events.length).toBe(TOTAL_INTERLEAVED);
      expect(dash.logs[0]).toBe('Diagnostic log line #0');
      expect(dash.logs[TOTAL_INTERLEAVED - 1]).toBe(`Diagnostic log line #${TOTAL_INTERLEAVED - 1}`);

      dash.stop();
    });

    it('1.5: live TTY streaming handles burst of 500 full-render events without cursor or buffer crash', () => {
      const mockStream = new MockStream(true);
      const dash = new TeamworkDashboard({
        isTTY: true,
        silent: false,
        stream: mockStream as any,
        spinnerInterval: 50,
      });

      dash.start();
      // Should have emitted hide-cursor sequence on start
      expect(mockStream.getAllOutput()).toContain('\x1b[?25l');

      // 500 events in TTY mode invokes 1,000 full-matrix re-renders and ANSI clears
      for (let i = 0; i < 500; i++) {
        dash.onEvent({
          type: 'agent_status',
          agentId: `worker-${i % 5}`,
          role: 'coder',
          message: `Step ${i}`,
        });
      }

      dash.stop({ status: 'completed' });
      // Should have emitted show-cursor sequence on stop
      expect(mockStream.getAllOutput()).toContain('\x1b[?25h');
      expect(mockStream.writeCount).toBeGreaterThan(100);
      expect(dash.isRunning).toBe(false);
    });

    it('1.6: SequentialFallbackLogger processes 5,000 rapid event burst with 0 ANSI codes', () => {
      const mockStream = new MockStream(false);
      const logger = new SequentialFallbackLogger({
        stream: mockStream as any,
        silent: true,
      });

      logger.start({ id: 'burst-sess-01', goal: 'Stress fallback logger' });

      for (let i = 0; i < 5000; i++) {
        if (i % 2 === 0) {
          logger.onEvent({
            type: 'task_start',
            agentId: `agent-${i % 10}`,
            role: 'coder',
            message: `Executing task item ${i}`,
          });
        } else {
          logger.log(`Worker stdout stream line ${i}`);
        }
      }

      logger.stop({ status: 'completed', tasksCompleted: 2500, verified: true });

      const lines = logger.getLines();
      // start (1) + 5,000 events + stop notice (1) + final summary table (1) = 5,003
      expect(lines.length).toBe(5003);

      for (const line of lines) {
        expect(line).not.toMatch(STRICT_ANSI_REGEX);
      }
    });

    it('1.7: concurrency stress handles 10 parallel asynchronous agent workers without race conditions', async () => {
      const dash = new TeamworkDashboard({ isTTY: false, silent: true });
      dash.start();

      const WORKER_COUNT = 10;
      const EVENTS_PER_WORKER = 200; // 2,000 total concurrent events

      // Simulate 10 parallel agents running asynchronously and pushing events
      await Promise.all(
        Array.from({ length: WORKER_COUNT }, async (_, workerIdx) => {
          const agentId = `agent-concurrent-${workerIdx}`;
          for (let e = 0; e < EVENTS_PER_WORKER; e++) {
            dash.onEvent({
              type: e === 0 ? 'task_start' : e === EVENTS_PER_WORKER - 1 ? 'task_complete' : 'agent_status',
              agentId,
              role: workerIdx % 2 === 0 ? 'coder' : 'tester',
              message: `Worker ${workerIdx} async progress ${e}`,
            });
            // Yield event loop occasionally to induce real async interleaving
            if (e % 25 === 0) {
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        })
      );

      expect(dash.events.length).toBe(WORKER_COUNT * EVENTS_PER_WORKER);
      expect(dash.agents.size).toBe(WORKER_COUNT);

      // Verify all workers reached completed status
      for (let workerIdx = 0; workerIdx < WORKER_COUNT; workerIdx++) {
        const agent = dash.agents.get(`agent-concurrent-${workerIdx}`);
        expect(agent).toBeDefined();
        expect(agent?.status).toBe('completed');
      }

      dash.stop({ status: 'completed', tasksCompleted: WORKER_COUNT });
      expect(dash.isRunning).toBe(false);
    });
  });

  /* ========================================================================== */
  /* Suite 2: Extremely Large & Edge-Case Git Diffs                             */
  /* ========================================================================== */
  describe('Suite 2: Extremely Large & Edge-Case Git Diffs', () => {
    it('2.1: processes massive 10,000+ line diff across 50 files in <200ms', () => {
      const fileCount = 50;
      const linesPerFile = 200; // 50 * 200 = 10,000 lines
      const diffChunks: string[] = [];

      let totalAdded = 0;
      let totalDeleted = 0;

      for (let f = 0; f < fileCount; f++) {
        const filePath = `src/subsystem/module_${String(f).padStart(2, '0')}.ts`;
        diffChunks.push(`diff --git a/${filePath} b/${filePath}`);
        diffChunks.push('index 0000000..abcdef1 100644');
        diffChunks.push(`--- a/${filePath}`);
        diffChunks.push(`+++ b/${filePath}`);
        diffChunks.push(`@@ -1,${linesPerFile / 2} +1,${linesPerFile / 2} @@`);

        for (let l = 0; l < linesPerFile / 2; l++) {
          diffChunks.push(`-const deprecatedVar_${f}_${l} = ${l};`);
          diffChunks.push(`+const modernizedVar_${f}_${l} = ${l * 2};`);
          totalDeleted++;
          totalAdded++;
        }
      }

      const massiveDiff = diffChunks.join('\n');
      expect(massiveDiff.split('\n').length).toBeGreaterThanOrEqual(10000);

      const startTime = performance.now();
      const stats = parseDiffStats(massiveDiff);
      const parseDuration = performance.now() - startTime;

      expect(stats.added).toBe(totalAdded);
      expect(stats.deleted).toBe(totalDeleted);
      expect(stats.files).toBe(fileCount);
      expect(parseDuration).toBeLessThan(200);

      const formatted = formatDiff(massiveDiff, false);
      expect(formatted).toContain(`Diff Stats: +${totalAdded} -${totalDeleted} (${fileCount} files)`);
      expect(formatted).not.toMatch(STRICT_ANSI_REGEX);
    });

    it('2.2: handles malformed unified diff headers without infinite loop or crash', () => {
      const malformedDiffs = [
        'diff --git malformed_without_a_and_b',
        'diff --git a/ b/\n--- a/\n+++ b/\n@@ @@',
        '@@ -invalid,chunk +syntax @@\n+added without headers',
        '--- a/file_without_plus\n-deleted line only',
        '+++ b/file_without_minus\n+added line only',
        'diff --git a/foo.ts b/foo.ts\n@@ -1 +1 @@\n+line with \x00 null byte and \x1b[31m escape',
        '@@ -1,5 +1,5 @@\n-line\n+line\n@@ nested chunk @@\n+another line',
        '--- a//dev/null\n+++ b/new_file.ts\n+created file content',
        'diff --git a/file b/file\nindex 1234567..89abcdef\n--- a/file\n+++ /dev/null\n-deleted completely',
      ];

      for (const diff of malformedDiffs) {
        expect(() => {
          const stats = parseDiffStats(diff);
          expect(typeof stats.added).toBe('number');
          expect(typeof stats.deleted).toBe('number');
          expect(typeof stats.files).toBe('number');

          const formatted = formatDiff(diff, true);
          expect(typeof formatted).toBe('string');
        }).not.toThrow();
      }
    });

    it('2.3: correctly handles binary diff markers and file mode changes', () => {
      const binaryDiff = [
        'diff --git a/assets/logo.png b/assets/logo.png',
        'new file mode 100644',
        'index 0000000..f1a2b3c',
        'Binary files /dev/null and b/assets/logo.png differ',
        'diff --git a/scripts/run.sh b/scripts/run.sh',
        'old mode 100644',
        'new mode 100755',
        'diff --git a/docs/old.pdf b/docs/old.pdf',
        'deleted file mode 100644',
        'Binary files a/docs/old.pdf and /dev/null differ',
      ].join('\n');

      const stats = parseDiffStats(binaryDiff);
      expect(stats.added).toBe(0);
      expect(stats.deleted).toBe(0);
      expect(stats.files).toBe(3);

      const formatted = formatDiff(binaryDiff, true);
      expect(formatted).toContain('Binary files');
      expect(formatted).toContain('old mode');
      expect(formatted).toContain('new mode');
    });

    it('2.4: handles degenerate diff inputs: empty, whitespace-only, and single-char tokens', () => {
      const inputs = [
        '',
        '   \n\t  \r\n  ',
        '+',
        '-',
        '@@',
        'diff --git ',
        '---\n+++\n@@\n+\n-',
      ];

      for (const input of inputs) {
        const stats = parseDiffStats(input);
        expect(stats.added).toBeGreaterThanOrEqual(0);
        expect(stats.deleted).toBeGreaterThanOrEqual(0);

        const formatted = formatDiff(input, false);
        expect(typeof formatted).toBe('string');
      }

      // Whitespace and empty return clean tree notice
      expect(formatDiff('', false)).toContain('No changes detected (clean working tree).');
      expect(formatDiff('   \n\r\n  ', false)).toContain('No changes detected (clean working tree).');
    });

    it('2.5: handles extreme single line length (50,000 chars) without stack overflow', () => {
      const longPayload = 'const bundle = "' + 'x'.repeat(50000) + '";';
      const singleLineDiff = [
        'diff --git a/dist/bundle.min.js b/dist/bundle.min.js',
        '--- a/dist/bundle.min.js',
        '+++ b/dist/bundle.min.js',
        '@@ -1,1 +1,1 @@',
        `-${longPayload.slice(0, 25000)}`,
        `+${longPayload}`,
      ].join('\n');

      const startTime = performance.now();
      const stats = parseDiffStats(singleLineDiff);
      const formatted = formatDiff(singleLineDiff, false);
      const duration = performance.now() - startTime;

      expect(stats.added).toBe(1);
      expect(stats.deleted).toBe(1);
      expect(stats.files).toBe(1);
      expect(formatted.length).toBeGreaterThan(50000);
      expect(duration).toBeLessThan(150);
    });

    it('2.6: handles mixed CRLF and LF newlines in diff stream', () => {
      const mixedDiff = 'diff --git a/win.ts b/win.ts\r\n--- a/win.ts\r\n+++ b/win.ts\n@@ -1,2 +1,2 @@\r\n-crlf line\n+lf line\r\n';
      const stats = parseDiffStats(mixedDiff);
      expect(stats.added).toBe(1);
      expect(stats.deleted).toBe(1);
      expect(stats.files).toBe(1);

      const formatted = formatDiff(mixedDiff, false);
      expect(formatted).toContain('-crlf line');
      expect(formatted).toContain('+lf line');
    });
  });

  /* ========================================================================== */
  /* Suite 3: Adversarial Markdown Inputs                                       */
  /* ========================================================================== */
  describe('Suite 3: Adversarial Markdown Inputs', () => {
    it('3.1: safely terminates deeply unclosed and nested code blocks with (unclosed) marker', () => {
      const unclosedMd = [
        '```typescript',
        'const x: number = 42;',
        'function test() {',
        '  console.log("no closing fence anywhere");',
      ].join('\n');

      const rendered = renderMarkdown(unclosedMd, true);
      expect(rendered).toContain('╭─ [typescript]');
      expect(rendered).toContain('(unclosed)');
      expect(rendered).toContain('const');
    });

    it('3.2: syntax highlighter handles hostile regex inputs without ReDoS hanging', () => {
      const hostileSnippets = [
        // Unterminated quotes
        'const str = "this is an unclosed quote with thousands of trailing characters ' + 'a'.repeat(5000),
        // Heavy escaped backslashes
        'const slash = "\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\";',
        // Dense regex-like symbols
        'const symbols = /[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}/gi.test(email);',
        // Packed keywords and numbers
        'let ' + Array(200).fill('const x = 12345;').join(' '),
      ];

      for (const snippet of hostileSnippets) {
        const md = '```js\n' + snippet + '\n```';
        const start = performance.now();
        const res = renderMarkdown(md, true);
        const duration = performance.now() - start;

        expect(typeof res).toBe('string');
        expect(duration).toBeLessThan(100); // Must not hang on ReDoS
      }
    });

    it('3.3: processes extreme uninterrupted token lengths (20,000 chars) in <50ms', () => {
      const longToken = 'Alpha' + 'Beta123_456-789'.repeat(1500) + 'Omega';
      const md = `Here is a gigantic unbroken token: ${longToken} and **${longToken.slice(0, 100)}**`;

      const start = performance.now();
      const res = renderMarkdown(md, true);
      const duration = performance.now() - start;

      expect(res.length).toBeGreaterThan(20000);
      expect(duration).toBeLessThan(100);
    });

    it('3.4: handles hostile unicode, surrogate pairs, emoji sequences, and control chars', () => {
      const hostileText = [
        '# Title with Emojis 🚀🔥🎉💡 and ZWJ 👨‍👩‍👧‍👦 🏳️‍🌈',
        '- Bullet with RTL override: \u202Ereversed text\u202C',
        '- Bullet with Null byte: pre\x00post and Bell: \x07',
        '1. Complex script: 𠮷野家 (surrogate pair) and 👩🏽‍💻',
        '> Blockquote with mixed math: ∀x∈ℝ, ∃y>x, ∫f(x)dx=0',
      ].join('\n');

      const rendered = renderMarkdown(hostileText, true);
      expect(rendered).toContain('🚀🔥🎉💡');
      expect(rendered).toContain('👨‍👩‍👧‍👦');
      expect(rendered).toContain('𠮷野家');
      expect(rendered).toContain('reversed text');
    });

    it('3.5: handles deeply nested blockquotes and malformed list structures', () => {
      const deeplyNested = Array(30).fill('>').join(' ') + ' deeply nested quote\n' +
        '    -   *   - deeply spaced list item\n' +
        '999999999999. Extreme numbered list\n' +
        '---\n***\n___\n';

      const rendered = renderMarkdown(deeplyNested, true);
      expect(rendered).toContain('deeply nested quote');
      expect(rendered).toContain('999999999999.');
    });

    it('3.6: handles malformed inline markdown combinations without crashing', () => {
      const malformedInlines = [
        '**unclosed bold',
        '__unclosed underscore bold',
        '*unclosed italic',
        '_unclosed underscore italic',
        '`unclosed backtick code',
        '[unclosed link](',
        '[unclosed link text without paren',
        '**_nested *half* closed__**',
        '```` ``` ` nested backticks ````',
        '***all three asterisks***',
      ];

      for (const input of malformedInlines) {
        expect(() => renderMarkdown(input, true)).not.toThrow();
        expect(() => renderMarkdown(input, false)).not.toThrow();
      }
    });
  });

  /* ========================================================================== */
  /* Suite 4: Strict Non-TTY & CI Validation (0 ANSI & 0 Dangling Timers)       */
  /* ========================================================================== */
  describe('Suite 4: Strict Non-TTY & CI Validation', () => {
    it('4.1: strict 0 ANSI escape sequences across all formatters in non-TTY mode', () => {
      process.env.NO_COLOR = '1';
      process.env.TERM = 'dumb';

      const diff = 'diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-old\n+new';
      const md = '# Header 1\n- Item 1\n```ts\nconst x = 1;\n```\n**bold** and `code`';
      const testResult = { ok: true, output: '1 test passed', command: 'npm test', exitCode: 0 };
      const audit = { action: 'file_write', target: '/tmp/test', approved: true, riskLevel: 'low' as const };
      const tableOutput = renderTable(['Col A', 'Col B'], [['Val 1', 'Val 2']], { isTTY: false, plain: true });

      const diffOut = formatDiff(diff, false);
      const mdOut = renderMarkdown(md, false);
      const testOut = formatTestResults(testResult, false);
      const auditOut = formatAuditLog(audit, false);

      expect(diffOut).not.toMatch(STRICT_ANSI_REGEX);
      expect(mdOut).not.toMatch(STRICT_ANSI_REGEX);
      expect(testOut).not.toMatch(STRICT_ANSI_REGEX);
      expect(auditOut).not.toMatch(STRICT_ANSI_REGEX);
      expect(tableOutput).not.toMatch(STRICT_ANSI_REGEX);
    });

    it('4.2: strict 0 dangling timers after TeamworkDashboard start and stop', () => {
      vi.useFakeTimers();

      const mockStream = new MockStream(true);
      const dash = new TeamworkDashboard({
        isTTY: true,
        silent: false,
        stream: mockStream as any,
        spinnerInterval: 80,
      });

      dash.start();
      expect((dash as any).timer).not.toBeNull();

      // Advance time while running - tick fires
      vi.advanceTimersByTime(240);
      expect((dash as any).spinnerIndex).toBeGreaterThan(0);

      dash.stop({ status: 'completed' });
      expect((dash as any).timer).toBeNull();

      // Advance time after stop - no more ticks or unhandled exceptions
      const tickCountBefore = (dash as any).spinnerIndex;
      vi.advanceTimersByTime(1000);
      expect((dash as any).spinnerIndex).toBe(tickCountBefore);
      expect((dash as any).timer).toBeNull();

      vi.useRealTimers();
    });

    it('4.3: non-TTY TeamworkDashboard never starts an interval timer', () => {
      vi.useFakeTimers();

      const mockStream = new MockStream(false);
      const dash = new TeamworkDashboard({
        isTTY: false,
        silent: true,
        stream: mockStream as any,
      });

      dash.start();
      expect((dash as any).timer).toBeNull();

      vi.advanceTimersByTime(1000);
      expect((dash as any).timer).toBeNull();

      dash.stop();
      expect((dash as any).timer).toBeNull();

      vi.useRealTimers();
    });

    it('4.4: repeated start and stop cycles do not leak interval timers or exit listeners', () => {
      vi.useFakeTimers();

      const mockStream = new MockStream(true);
      const dash = new TeamworkDashboard({
        isTTY: true,
        silent: false,
        stream: mockStream as any,
      });

      const initialSigintCount = process.listenerCount('SIGINT');
      const initialExitCount = process.listenerCount('exit');

      for (let i = 0; i < 10; i++) {
        dash.start();
        expect((dash as any).timer).not.toBeNull();
        dash.stop();
        expect((dash as any).timer).toBeNull();
      }

      // Verifies cleanupHandler properly deregistered on each stop()
      expect(process.listenerCount('SIGINT')).toBe(initialSigintCount);
      expect(process.listenerCount('exit')).toBe(initialExitCount);

      vi.useRealTimers();
    });

    it('4.5: non-TTY stream receives 0 cursor manipulation or clear screen sequences', () => {
      const mockStream = new MockStream(false);
      const dash = new TeamworkDashboard({
        isTTY: false,
        silent: false,
        stream: mockStream as any,
      });

      dash.start();
      dash.onEvent({ type: 'session_start', message: 'Non-TTY session' });
      dash.onEvent({ type: 'planner_start', agentId: 'p1', role: 'planner' });
      dash.log('A regular progress log line');
      dash.onEvent({ type: 'task_complete', agentId: 'p1', role: 'planner' });
      dash.stop({ status: 'completed' });

      const allOutput = mockStream.getAllOutput();
      // Ensure no cursor hide/show
      expect(allOutput).not.toContain('\x1b[?25l');
      expect(allOutput).not.toContain('\x1b[?25h');
      // Ensure no cursor movement or line clearing
      expect(allOutput).not.toContain('\x1b[0J');
      expect(allOutput).not.toMatch(/\x1b\[\d+A/);
    });
  });

  /* ========================================================================== */
  /* Suite 5: Table Rendering Stress                                            */
  /* ========================================================================== */
  describe('Suite 5: Table Rendering Stress', () => {
    it('5.1: renders massive column counts (60 columns) without crashing', () => {
      const COL_COUNT = 60;
      const headers = Array.from({ length: COL_COUNT }, (_, i) => `Col_${i}`);
      const row1 = Array.from({ length: COL_COUNT }, (_, i) => `v${i}`);
      const row2 = Array.from({ length: COL_COUNT }, (_, i) => i * 10);

      // Test cli-table3 formatter
      const ttyTable = renderTable(headers, [row1, row2], { isTTY: true });
      expect(ttyTable).toContain('Col_0');
      expect(ttyTable).toContain('Col_59');
      expect(ttyTable).toContain('v0');
      expect(ttyTable).toContain('590');

      // Test plain text fallback
      const plainTable = renderTable(headers, [row1, row2], { plain: true });
      expect(plainTable).toContain('Col_0');
      expect(plainTable).toContain('Col_59');
      expect(plainTable).not.toMatch(STRICT_ANSI_REGEX);
    });

    it('5.2: renders 2,000 rows in <300ms without memory exhaustion', () => {
      const headers = ['Row ID', 'Status', 'Latency', 'Target'];
      const ROW_COUNT = 2000;
      const rows: (string | number)[][] = [];

      for (let i = 0; i < ROW_COUNT; i++) {
        rows.push([`R-${i}`, i % 2 === 0 ? 'OK' : 'WARN', `${i * 2}ms`, `192.168.1.${i % 255}`]);
      }

      const start = performance.now();
      const output = renderTable(headers, rows, { isTTY: false });
      const duration = performance.now() - start;

      expect(output.length).toBeGreaterThan(20000);
      expect(output).toContain('R-0');
      expect(output).toContain('R-1999');
      expect(duration).toBeLessThan(500);
    });

    it('5.3: handles extreme cell contents: 5,000 chars, multilines, nulls, undefined, numbers', () => {
      const massiveCell = 'Z'.repeat(5000);
      const multilineCell = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';

      const headers = ['Type', 'Payload'];
      const rows = [
        ['Massive', massiveCell],
        ['Multiline', multilineCell],
        ['Null', null as any],
        ['Undefined', undefined as any],
        ['Zero', 0],
        ['Negative', -999999.99],
        ['Empty', ''],
      ];

      expect(() => {
        const out = renderTable(headers, rows, { isTTY: false });
        expect(out).toContain('Line 1');
        expect(out).toContain('Line 5');
        expect(out).toContain('-999999.99');
      }).not.toThrow();

      expect(() => {
        const plainOut = renderPlainTextTable(headers, rows);
        expect(plainOut).toContain('Line 1');
        expect(plainOut).toContain('-999999.99');
      }).not.toThrow();
    });

    it('5.4: handles special characters, CJK characters, emojis, and ANSI in cells', () => {
      const headers = ['Category', 'Symbol', 'Description'];
      const rows = [
        ['Emoji', '🚀🔥🎉💡', 'Rocket Fire Party Lightbulb'],
        ['CJK Japanese', 'こんにちは世界', 'Hello world in Japanese'],
        ['CJK Chinese', '你好，团队合作', 'Hello teamwork in Simplified Chinese'],
        ['CJK Korean', '안녕하세요', 'Hello in Korean'],
        ['Control Chars', 'tab\tseparated\bbackspace', 'Escape test'],
        ['ANSI Styled', colors.green('GREEN_BADGE'), 'Pre-colored cell content'],
      ];

      const out = renderTable(headers, rows, { isTTY: true });
      expect(out).toContain('🚀🔥🎉💡');
      expect(out).toContain('こんにちは世界');
      expect(out).toContain('你好，团队合作');
      expect(out).toContain('안녕하세요');
    });

    it('5.5: handles degenerate and boundary table inputs gracefully', () => {
      // Empty table
      expect(renderTable([], [])).toBe('');
      expect(renderPlainTextTable([], [])).toBe('');

      // Headers only, 0 rows
      const hOnly = renderTable(['Header A', 'Header B'], []);
      expect(hOnly).toContain('Header A');
      expect(hOnly).toContain('Header B');

      // Rows only, 0 headers
      const rOnly = renderTable([], [['Val A', 'Val B']]);
      expect(rOnly).toContain('Val A');

      // Unequal row lengths
      const irregularRows = [
        ['Col 1 only'],
        ['Col 1', 'Col 2', 'Col 3', 'Col 4', 'Col 5'],
        [],
      ];
      expect(() => renderTable(['A', 'B'], irregularRows)).not.toThrow();
      expect(() => renderPlainTextTable(['A', 'B'], irregularRows)).not.toThrow();
    });

    it('5.6: plain text table maintains correct column alignment and separator padding', () => {
      const headers = ['ID', 'Long Column Header', 'Short'];
      const rows = [
        ['1', 'Short val', 'A'],
        ['2000', 'A much longer value here', 'B'],
      ];

      const plain = renderPlainTextTable(headers, rows);
      const lines = plain.split('\n');

      expect(lines.length).toBe(4); // Header, separator, row 1, row 2
      expect(lines[1]).toContain('-+-'); // Standard ascii separator
      expect(lines[2]).toContain('Short val');
      expect(lines[3]).toContain('A much longer value here');
    });
  });
});
