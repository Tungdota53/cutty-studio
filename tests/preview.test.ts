import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WebPreview } from '../src/studio/preview.js';
import { startStudio, type StudioServerInstance } from '../src/studio/server.js';
const roots: string[] = [], previews: WebPreview[] = [], studios: StudioServerInstance[] = [];
afterEach(async () => { await Promise.all(previews.splice(0).map(preview => preview.close())); await Promise.all(studios.splice(0).map(studio => studio.close())); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function workspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-preview-')); roots.push(root); fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><title>Demo</title></head><body>Hello</body></html>'); return root; }
async function preview(root = workspace(), entry = 'index.html') { const server = new WebPreview(); previews.push(server); return { server, root, ...await server.start(root, entry) }; }
describe('Isolated web preview and JavaScript console bridge', () => {
  it('serves real HTML/CSS/JS/assets with a nonce-scoped base and isolation headers', async () => {
    const root = workspace(); fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'style.css'), 'body { color: blue; }'); fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("App loaded");');
    fs.writeFileSync(path.join(root, 'index.html'), '<html><head><base href="https://outside.test/"><link href="/assets/style.css" rel="stylesheet"></head><body><script src="/assets/app.js"></script></body></html>');
    const instance = await preview(root), html = await fetch(instance.url), text = await html.text(), prefix = new URL('.', instance.url).pathname;
    expect(text).toContain(`<base href="${prefix}">`); expect(text).not.toContain('https://outside.test/');
    expect(text).toContain(`href="${prefix}assets/style.css"`); expect(text).toContain(`src="${prefix}assets/app.js"`);
    expect(html.headers.get('content-security-policy')).toContain("connect-src 'none'"); expect(html.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(html.headers.get('x-content-type-options')).toBe('nosniff'); expect(html.headers.get('cache-control')).toBe('no-store');
    const css = await fetch(new URL('assets/style.css', instance.url)); expect(css.status).toBe(200); expect(await css.text()).toBe('body { color: blue; }');
    const js = await fetch(new URL('assets/app.js', instance.url)); expect(js.headers.get('content-type')).toContain('text/javascript'); expect(await js.text()).toBe('console.log("App loaded");');
  });
  it('executes the injected bridge and captures console, errors, rejected promises and readiness', async () => {
    const instance = await preview(), text = await (await fetch(instance.url)).text();
    const source = text.match(/<script>([\s\S]*?)<\/script>/)?.[1]; expect(source).toBeTruthy();
    const events: Record<string, (event?: any) => void> = {}, messages: any[] = [], printed: unknown[][] = [];
    const sandbox = { parent: { postMessage: (data: unknown, origin: string) => messages.push({ data, origin }) }, document: { title: 'Demo page' }, console: { log: (...args: unknown[]) => printed.push(args), warn: (...args: unknown[]) => printed.push(args), error: (...args: unknown[]) => printed.push(args) }, addEventListener: (event: string, callback: (event?: any) => void) => { events[event] = callback; } };
    vm.runInNewContext(source!, sandbox);
    sandbox.console.log('Hello', { count: 2 }); sandbox.console.warn('x'.repeat(10000));
    events.error({ message: 'Broken JavaScript', filename: 'app.js', lineno: 5 }); events.unhandledrejection({ reason: new Error('Rejected') }); events.DOMContentLoaded();
    expect(printed[0]).toEqual(['Hello', { count: 2 }]);
    expect(messages.map(item => item.data.kind)).toEqual(['log', 'warn', 'error', 'error', 'ready']);
    expect(messages[0]).toMatchObject({ origin: '*', data: { vibePreview: true, text: 'Hello {"count":2}' } });
    expect(messages[1].data.text).toHaveLength(8000); expect(messages[2].data.text).toContain('app.js 5'); expect(messages[4].data.text).toBe('Demo page');
  });
  it('rejects backend routes, nonce-less requests, traversal, unsupported files and malformed escapes', async () => {
    const instance = await preview(), prefix = new URL('.', instance.url), origin = new URL(instance.url).origin;
    fs.writeFileSync(path.join(instance.root, 'code.ts'), 'private implementation');
    fs.mkdirSync(path.join(instance.root, '.git')); fs.writeFileSync(path.join(instance.root, '.git', 'config.json'), '{}');
    for (const input of [origin + '/api/status', origin + '/index.html', new URL('code.ts', prefix).href, new URL('.git/config.json', prefix).href, prefix.href + '%2e%2e%2foutside.json', prefix.href + '%5c..%5coutside.json', prefix.href + '%ZZ']) expect((await fetch(input)).status, input).toBe(404);
    await expect(new WebPreview().start(instance.root, '../outside.html')).rejects.toThrow('ngoài workspace');
  });
  it('does not serve credential assets or allow an internal-state entry point', async () => {
    const instance = await preview(), prefix = new URL('.', instance.url);
    for (const file of ['credentials.json', 'secrets.json', '.env.production.json']) {
      fs.writeFileSync(path.join(instance.root, file), '{"password":"do-not-expose"}');
      expect((await fetch(new URL(file, prefix))).status, file).toBe(404);
    }
    fs.mkdirSync(path.join(instance.root, '.vibe')); fs.writeFileSync(path.join(instance.root, '.vibe', 'private.html'), '<html>Internal data</html>');
    const server = new WebPreview(); previews.push(server);
    await expect(server.start(instance.root, '.vibe/private.html')).rejects.toThrow();
  });
  it('retires the previous nonce/server when switching entry files', async () => {
    const instance = await preview(); fs.writeFileSync(path.join(instance.root, 'other.html'), '<html><head></head><body>Other page</body></html>');
    const next = await instance.server.start(instance.root, 'other.html'); expect(next.url).not.toBe(instance.url); expect(await (await fetch(next.url)).text()).toContain('Other page');
    const stale = await fetch(instance.url).then(response => response.status).catch(() => 0); expect(stale).not.toBe(200);
  });
  it('blocks asset aliases that resolve into internal state', async () => {
    const instance = await preview(), privateDirectory = path.join(instance.root, '.vibe');
    fs.mkdirSync(privateDirectory); fs.writeFileSync(path.join(privateDirectory, 'data.json'), '{"internal":"private"}');
    fs.symlinkSync(privateDirectory, path.join(instance.root, 'assets-alias'), 'junction');
    expect((await fetch(new URL('assets-alias/data.json', instance.url))).status).toBe(404);
  });
  it('loads the workbench static assets through authenticated Studio routes', async () => {
    const studio = await startStudio({ port: 0, workspace: workspace(), token: 'preview-static-test', openBrowser: false }); studios.push(studio);
    for (const asset of ['/workbench.js', '/workbench.css', '/chat-output.js', '/chat.css']) {
      expect((await fetch(studio.url + asset)).status).toBe(401);
      const response = await fetch(studio.url + asset + '?token=preview-static-test'); expect(response.status, asset).toBe(200); expect((await response.text()).length).toBeGreaterThan(50);
    }
  });
});
