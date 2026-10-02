import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const workspace = path.resolve('.vibe/exe-smoke'); fs.mkdirSync(workspace, { recursive: true });
const exe = path.resolve(process.argv[2] || 'release/win-unpacked/Vibe Studio.exe');
assert(fs.existsSync(path.join(path.dirname(exe), 'resources/runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node')), 'SQLite native binary is missing from the executable distribution');
const child = spawn(exe, ['--remote-debugging-port=19473', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(workspace, 'profile')}`], { windowsHide: true, stdio: 'ignore', env: { ...process.env, VIBE_SMOKE_TEST: '1', VIBE_WORKSPACE: workspace, VIBE_API_KEY: '' } });
let socket;
try {
  let target;
  for (let i = 0; i < 150; i++) {
    try { const pages = await (await fetch('http://127.0.0.1:19473/json')).json(); target = pages.find(page => page.url.includes('?token=')); if (target) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(target, 'Packaged executable did not load its desktop page');
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  async function evaluate(expression) {
    const id = ++sequence;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('CDP timeout')); }, 5000);
      function listener(data) { const msg = JSON.parse(String(data)); if (msg.id === id) { clearTimeout(timer); socket.off('message', listener); resolve(msg.result?.result?.value); } }
      socket.on('message', listener);
    });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    return answer;
  }
  let state;
  for (let i = 0; i < 100; i++) {
    state = await evaluate(`({desktop:typeof window.desktop,node:typeof window.require,connection:document.getElementById('connection-text')?.textContent,workspace:document.getElementById('workspace-path')?.textContent})`);
    if (state?.connection === 'Đã kết nối' && state.workspace === workspace) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.desktop, 'object'); assert.equal(state.node, 'undefined'); assert.equal(state.workspace, workspace); assert.equal(state.connection, 'Đã kết nối');
  const token = new URL(target.url).searchParams.get('token');
  const response = await (await fetch(new URL('/api/status?token=' + token, target.url))).json(); assert(response.ok);
  fs.writeFileSync('release/exe-result.json', JSON.stringify({ ok: true, exe, checks: ['Windows executable startup', 'bundled backend connected', 'isolated preload bridge', 'correct workspace', 'authenticated API'] }, null, 2));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: "window.desktop.control('close')" } }));
  await new Promise(resolve => { const timer = setTimeout(resolve, 7000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  console.log('Windows executable checks passed.');
} finally { socket?.close(); if (child.exitCode === null) child.kill(); }
