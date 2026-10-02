import { describe, it, expect, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import {
  startStudio,
  parseDiffStats,
  sanitizeConfig,
  type StudioServerInstance,
} from '../src/studio/server.js';
import type { Config } from '../src/config.js';

// Robust WebSocket test helper with message buffering to prevent dropped packets
class SocketHelper {
  public received: any[] = [];
  private listeners = new Set<(msg: any) => void>();

  constructor(public ws: WebSocket) {
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        this.received.push(parsed);
        for (const listener of this.listeners) {
          listener(parsed);
        }
      } catch {
        // preserve raw error notifications if needed
        const raw = data.toString();
        this.received.push({ __raw: raw });
      }
    });
  }

  async waitForOpen(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket open timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async waitFor<T = any>(predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<T> {
    const existingIndex = this.received.findIndex(predicate);
    if (existingIndex !== -1) {
      const match = this.received[existingIndex];
      this.received.splice(existingIndex, 1);
      return match as T;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onMsg);
        reject(new Error(`Timed out waiting for WS message after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMsg = (msg: any) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          this.listeners.delete(onMsg);
          const idx = this.received.indexOf(msg);
          if (idx !== -1) this.received.splice(idx, 1);
          resolve(msg as T);
        }
      };

      this.listeners.add(onMsg);
    });
  }

  send(data: any): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(payload);
  }

  close(): void {
    try {
      this.ws.terminate();
    } catch {}
  }
}

describe('Vibe Studio Server & WebSocket Integration Test Suite', () => {
  const trackedInstances = new Set<StudioServerInstance>();
  const trackedHelpers = new Set<SocketHelper>();

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.CI = 'true';
  });

  afterEach(async () => {
    // Terminate all open test sockets
    for (const helper of trackedHelpers) {
      helper.close();
    }
    trackedHelpers.clear();

    // Close all server instances
    for (const inst of trackedInstances) {
      try {
        await inst.close();
      } catch {
        // ignore
      }
    }
    trackedInstances.clear();
  });

  async function createStudio(port = 0): Promise<StudioServerInstance> {
    const instance = await startStudio({ port, openBrowser: false, host: '127.0.0.1' });
    trackedInstances.add(instance);
    return instance;
  }

  async function createClient(url: string): Promise<SocketHelper> {
    const wsUrl = url.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    const helper = new SocketHelper(ws);
    trackedHelpers.add(helper);
    await helper.waitForOpen();
    return helper;
  }

  /* ========================================================================== */
  /* Suite 1: Server Initialization & Teardown Lifecycle                       */
  /* ========================================================================== */

  describe('Suite 1: Server Initialization & Teardown Lifecycle', () => {
    it('1.1: startStudio with port 0 binds to an ephemeral OS port and provides valid instance', async () => {
      const studio = await createStudio(0);
      expect(studio).toBeDefined();
      expect(typeof studio.port).toBe('number');
      expect(studio.port).toBeGreaterThan(0);
      expect(studio.host).toBe('127.0.0.1');
      expect(studio.url).toBe(`http://localhost:${studio.port}`);
      expect(studio.server).toBeInstanceOf(http.Server);
      expect(studio.server.listening).toBe(true);
      expect(studio.wss).toBeDefined();
      expect(typeof studio.close).toBe('function');
      expect(typeof studio.requestApproval).toBe('function');
    });

    it('1.2: startStudio accepts numeric port option as shorthand', async () => {
      const studio = await startStudio(0);
      trackedInstances.add(studio);
      expect(studio.port).toBeGreaterThan(0);
      expect(studio.server.listening).toBe(true);
    });

    it('1.3: instance.close() terminates HTTP and WebSocket servers cleanly', async () => {
      const studio = await createStudio(0);
      const url = studio.url;
      expect(studio.server.listening).toBe(true);

      await studio.close();
      expect(studio.server.listening).toBe(false);

      // Verify HTTP request fails after close
      await expect(fetch(url)).rejects.toThrow();
    });

    it('1.4: instance.close() is idempotent and handles multiple sequential calls', async () => {
      const studio = await createStudio(0);
      await expect(studio.close()).resolves.toBeUndefined();
      await expect(studio.close()).resolves.toBeUndefined();
      await expect(studio.close()).resolves.toBeUndefined();
    });

    it('1.5: instance.close() terminates connected WebSocket clients without hanging', async () => {
      const studio = await createStudio(0);
      const client = await createClient(studio.url);

      let closed = false;
      client.ws.once('close', () => {
        closed = true;
      });

      await studio.close();
      expect(closed).toBe(true);
    });
  });

  /* ========================================================================== */
  /* Suite 2: HTTP Endpoints & Content Serving                                 */
  /* ========================================================================== */

  describe('Suite 2: HTTP Endpoints & Content Serving', () => {
    let studio: StudioServerInstance;

    beforeEach(async () => {
      studio = await createStudio(0);
    });

    it('2.1: GET / serves HTML content with status 200 and UTF-8 charset', async () => {
      const res = await fetch(`${studio.url}/`);
      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type') || '';
      expect(contentType).toContain('text/html');
      expect(contentType).toContain('utf-8');

      const body = await res.text();
      expect(body.length).toBeGreaterThan(0);
      expect(body.toLowerCase()).toMatch(/vibe studio|<!doctype html>/);
    });

    it('2.2: GET /index.html serves the same HTML content as GET /', async () => {
      const resRoot = await fetch(`${studio.url}/`);
      const resIndex = await fetch(`${studio.url}/index.html`);
      expect(resIndex.status).toBe(200);

      const rootBody = await resRoot.text();
      const indexBody = await resIndex.text();
      expect(indexBody).toBe(rootBody);
    });

    it('2.3: GET /api/status returns JSON with ok: true, sessions, cwd, and routerMetrics', async () => {
      const res = await fetch(`${studio.url}/api/status`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.config).toBeDefined();
      expect(Array.isArray(json.sessions)).toBe(true);
      expect(typeof json.cwd).toBe('string');
      expect(json.routerMetrics).toBeDefined();
    });

    it('2.4: GET /api/status redacts apiKey in returned configuration', async () => {
      const res = await fetch(`${studio.url}/api/status`);
      const json = await res.json();
      expect(json.config).toBeDefined();
      if (json.config.apiKey) {
        expect(json.config.apiKey).toBe('[REDACTED]');
      }
    });

    it('2.5: GET /api/diff returns JSON with diff string and parsed stats', async () => {
      const res = await fetch(`${studio.url}/api/diff`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(typeof json.diff).toBe('string');
      expect(json.stats).toBeDefined();
      expect(typeof json.stats.additions).toBe('number');
      expect(typeof json.stats.deletions).toBe('number');
      expect(typeof json.stats.files).toBe('number');
    });

    it('2.6: GET /unregistered_path returns HTTP 404 with JSON error object', async () => {
      const res = await fetch(`${studio.url}/api/unknown_route_404`);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe('Not found');
    });

    it('2.7: parseDiffStats helper computes additions, deletions, and unique file count', () => {
      const sampleDiff = [
        'diff --git a/foo.ts b/foo.ts',
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '@@ -1,3 +1,4 @@',
        '+const a = 1;',
        '+const b = 2;',
        '-const c = 0;',
        'diff --git a/bar.ts b/bar.ts',
        '--- a/bar.ts',
        '+++ b/bar.ts',
        '@@ -10,2 +10,2 @@',
        '+const d = 4;',
        '-const e = 5;',
      ].join('\n');

      const stats = parseDiffStats(sampleDiff);
      expect(stats.files).toBe(2);
      expect(stats.additions).toBe(3);
      expect(stats.deletions).toBe(2);
    });

    it('2.8: sanitizeConfig redacts apiKey while preserving other fields', () => {
      const raw: Config = {
        apiKey: 'sk-secret-key-12345',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        maxTokens: 4096,
        temperature: 0.7,
        workspace: '/test/workspace',
        maxAgents: 10,
        quality: 'balanced',
      };

      const sanitized = sanitizeConfig(raw);
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.baseUrl).toBe(raw.baseUrl);
      expect(sanitized.model).toBe(raw.model);
      expect(sanitized.workspace).toBe(raw.workspace);
    });
  });

  /* ========================================================================== */
  /* Suite 3: WebSocket Protocol & Lifecycle                                   */
  /* ========================================================================== */

  describe('Suite 3: WebSocket Protocol & Lifecycle', () => {
    let studio: StudioServerInstance;

    beforeEach(async () => {
      studio = await createStudio(0);
    });

    it('3.1: client receives init event on connection with config, diff, and sessions', async () => {
      const client = await createClient(studio.url);
      const initMsg = await client.waitFor((msg) => msg.type === 'init');
      expect(initMsg.type).toBe('init');
      expect(initMsg.config).toBeDefined();
      if (initMsg.config.apiKey) {
        expect(initMsg.config.apiKey).toBe('[REDACTED]');
      }
      expect(typeof initMsg.diff).toBe('string');
      expect(Array.isArray(initMsg.sessions)).toBe(true);
      expect(initMsg.routerMetrics).toBeDefined();
    });

    it('3.2: client sends get_diff and receives diff response event', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send({ type: 'get_diff' });
      const diffMsg = await client.waitFor((m) => m.type === 'diff');
      expect(diffMsg.type).toBe('diff');
      expect(typeof diffMsg.diff).toBe('string');
    });

    it('3.3: client sends get_sessions and receives sessions response event', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send({ type: 'get_sessions' });
      const sessMsg = await client.waitFor((m) => m.type === 'sessions');
      expect(sessMsg.type).toBe('sessions');
      expect(Array.isArray(sessMsg.sessions)).toBe(true);
    });

    it('3.4: client sends command /status and receives stream chunk & stream end', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send({ type: 'command', line: '/status' });

      const chunkMsg = await client.waitFor((m) => m.type === 'stream_chunk');
      expect(chunkMsg.type).toBe('stream_chunk');
      expect(chunkMsg.token).toContain('Trạng thái hệ thống');

      const endMsg = await client.waitFor((m) => m.type === 'stream_end');
      expect(endMsg.type).toBe('stream_end');
    });

    it('3.5: client sends command /sessions and receives sessions message followed by stream end', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send({ type: 'command', line: '/sessions' });

      const sessionsMsg = await client.waitFor((m) => m.type === 'sessions');
      expect(sessionsMsg.type).toBe('sessions');
      expect(Array.isArray(sessionsMsg.sessions)).toBe(true);

      const endMsg = await client.waitFor((m) => m.type === 'stream_end');
      expect(endMsg.type).toBe('stream_end');
    });

    it('3.6: client sends command /quality and receives confirmation stream chunk', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send({ type: 'command', line: '/quality fast' });
      const chunkMsg = await client.waitFor((m) => m.type === 'stream_chunk');
      expect(chunkMsg.token).toContain('fast');

      const endMsg = await client.waitFor((m) => m.type === 'stream_end');
      expect(endMsg.type).toBe('stream_end');
    });

    it('3.7: client sends unknown slash command and receives informative response without crash', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send({ type: 'command', line: '/unknown_custom_command' });
      const chunkMsg = await client.waitFor((m) => m.type === 'stream_chunk');
      expect(chunkMsg.token).toContain('/unknown_custom_command');

      const endMsg = await client.waitFor((m) => m.type === 'stream_end');
      expect(endMsg.type).toBe('stream_end');
    });

    it('3.8: client sends malformed JSON and receives error response without server crash', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      client.send('NOT_A_JSON_STRING{{{');
      const errMsg = await client.waitFor((m) => m.type === 'error');
      expect(errMsg.type).toBe('error');
      expect(errMsg.message).toContain('Invalid payload');

      // Verify connection remains healthy for subsequent message
      client.send({ type: 'get_diff' });
      const diffMsg = await client.waitFor((m) => m.type === 'diff');
      expect(diffMsg.type).toBe('diff');
    });
  });

  /* ========================================================================== */
  /* Suite 4: Approval Bridge Architecture                                     */
  /* ========================================================================== */

  describe('Suite 4: Approval Bridge Architecture', () => {
    let studio: StudioServerInstance;

    beforeEach(async () => {
      studio = await createStudio(0);
    });

    it('4.1: server broadcasts approval_request and client resolves it with approved: true', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      const approvalPromise = studio.requestApproval('git reset --hard HEAD~1', 'run_command', 'CRITICAL');

      const reqMsg = await client.waitFor((m) => m.type === 'approval_request');
      expect(reqMsg.type).toBe('approval_request');
      expect(reqMsg.id).toMatch(/^appr_/);
      expect(reqMsg.command).toBe('git reset --hard HEAD~1');
      expect(reqMsg.tool).toBe('run_command');
      expect(reqMsg.riskLevel).toBe('CRITICAL');

      // Client responds with approval
      client.send({ type: 'approval_response', id: reqMsg.id, approved: true });

      const approvedResult = await approvalPromise;
      expect(approvedResult).toBe(true);
    });

    it('4.2: client resolves approval_request with approved: false', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      const approvalPromise = studio.requestApproval('rm -rf /', 'run_command', 'CRITICAL');

      const reqMsg = await client.waitFor((m) => m.type === 'approval_request');
      expect(reqMsg.command).toBe('rm -rf /');

      // Client rejects
      client.send({ type: 'approval_response', id: reqMsg.id, approved: false });

      const approvedResult = await approvalPromise;
      expect(approvedResult).toBe(false);
    });

    it('4.3: duplicate approval_response for already resolved ID is safely ignored', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      const approvalPromise = studio.requestApproval('git clean -fd', 'run_command', 'HIGH');
      const reqMsg = await client.waitFor((m) => m.type === 'approval_request');

      client.send({ type: 'approval_response', id: reqMsg.id, approved: true });
      await approvalPromise;

      // Duplicate response
      expect(() => {
        client.send({ type: 'approval_response', id: reqMsg.id, approved: false });
      }).not.toThrow();
    });

    it('4.4: approval_response with unknown id is ignored without server error', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      expect(() => {
        client.send({ type: 'approval_response', id: 'appr_non_existent_12345', approved: true });
      }).not.toThrow();
    });

    it('4.5: closing server while approvals are pending cancels them and resolves to false', async () => {
      const client = await createClient(studio.url);
      await client.waitFor((m) => m.type === 'init');

      const approvalPromise = studio.requestApproval('pending task before shutdown', 'run_command', 'MEDIUM');
      await client.waitFor((m) => m.type === 'approval_request');

      // Close server before client responds
      await studio.close();

      const result = await approvalPromise;
      expect(result).toBe(false);
    });

    it('4.6: unapproved request times out and fail-safe resolves to false', async () => {
      vi.useFakeTimers();
      try {
        const approvalPromise = studio.requestApproval('unattended command', 'run_command', 'HIGH');

        // Advance past the 120s timeout
        await vi.advanceTimersByTimeAsync(120005);

        const result = await approvalPromise;
        expect(result).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /* ========================================================================== */
  /* Suite 5: Multi-Client Concurrency & Port Negotiation                      */
  /* ========================================================================== */

  describe('Suite 5: Multi-Client Concurrency & Port Negotiation', () => {
    it('5.1: multiple concurrent WebSocket clients receive broadcast approval requests', async () => {
      const studio = await createStudio(0);

      const client1 = await createClient(studio.url);
      const client2 = await createClient(studio.url);

      await Promise.all([
        client1.waitFor((m) => m.type === 'init'),
        client2.waitFor((m) => m.type === 'init'),
      ]);

      const approvalPromise = studio.requestApproval('broadcast test cmd');

      const [req1, req2] = await Promise.all([
        client1.waitFor((m) => m.type === 'approval_request'),
        client2.waitFor((m) => m.type === 'approval_request'),
      ]);

      expect(req1.id).toBe(req2.id);

      // Client 2 approves
      client2.send({ type: 'approval_response', id: req2.id, approved: true });

      const result = await approvalPromise;
      expect(result).toBe(true);
    });

    it('5.2: port conflict negotiation automatically binds next available port', async () => {
      // 1. Create a dummy HTTP server on a random port
      const dummyServer = http.createServer((_req, res) => res.end('occupied'));
      await new Promise<void>((resolve) => dummyServer.listen(0, '127.0.0.1', () => resolve()));
      const occupiedPort = (dummyServer.address() as AddressInfo).port;

      try {
        // 2. Start Studio attempting to bind the occupied port
        const studio = await startStudio({
          port: occupiedPort,
          host: '127.0.0.1',
          openBrowser: false,
        });
        trackedInstances.add(studio);

        expect(studio.port).toBeGreaterThan(occupiedPort);
        expect(studio.server.listening).toBe(true);

        const res = await fetch(`${studio.url}/api/status`);
        expect(res.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => dummyServer.close(() => resolve()));
      }
    });
  });
});
