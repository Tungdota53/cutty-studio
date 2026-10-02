import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
const runtime = path.resolve(process.argv[2] || 'release/win-unpacked/resources/runtime');
const manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'dependencies-manifest.json'), 'utf8'));
for (const file of ['better-sqlite3/package.json', 'better-sqlite3/lib/index.js', 'better-sqlite3/build/Release/better_sqlite3.node', 'bindings/bindings.js', 'file-uri-to-path/index.js']) assert(manifest[file], `Missing runtime dependency: ${file}`);
for (const [file, expected] of Object.entries(manifest)) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(runtime, 'node_modules', file))).digest('hex');
  assert.equal(actual, expected, `Runtime dependency mismatch: ${file}`);
}
const workspace = path.resolve('.vibe/runtime-smoke'); fs.mkdirSync(workspace, { recursive: true });
const child = fork(path.join(runtime, 'desktop-host.mjs'), [], { execPath: path.join(runtime, 'node.exe'), cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, VIBE_WORKSPACE: workspace, VIBE_DESKTOP_TOKEN: 'runtime-smoke-token', VIBE_API_KEY: '' } });
let errors = ''; child.stderr.on('data', data => errors += data);
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime timeout: ' + errors)), 15000);
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Runtime exit ${code}: ${errors}`)); });
    child.on('message', msg => { if (msg.type === 'ready') { clearTimeout(timer); resolve(msg.url); } });
  });
  assert.equal((await fetch(url + '/api/status')).status, 401);
  const status = await (await fetch(url + '/api/status?token=runtime-smoke-token')).json(); assert.equal(status.ok, true); assert.equal(status.config.workspace, workspace);
  for (const route of ['/', '/app.css', '/app.js']) assert.equal((await fetch(url + route + '?token=runtime-smoke-token')).status, 200);
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/?token=runtime-smoke-token');
  const initial = await new Promise((resolve, reject) => { socket.once('message', data => resolve(JSON.parse(String(data)))); socket.once('error', reject); });
  assert.equal(initial.type, 'init');
  const teamReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Skill catalog timeout')), 5000);
    socket.once('message', data => { clearTimeout(timer); resolve(JSON.parse(String(data))); });
  });
  socket.send(JSON.stringify({ type: 'get_team' }));
  const team = await teamReady;
  assert.equal(team.type, 'team_config'); assert.equal(team.roles.length, 7);
  for (const id of ['repository-planning', 'scoped-implementation', 'code-review', 'evidence-testing']) assert(team.skills.some(skill => skill.id === 'builtin:' + id), `Missing bundled skill: ${id}`);
  const githubSkills = team.skills.filter(skill => skill.source === 'github');
  assert.equal(githubSkills.length, 5); assert(githubSkills.every(skill => skill.provenance?.integrity && skill.provenance.license === 'Apache-2.0'));
  socket.close();
  child.send({ type: 'shutdown' });
  await new Promise(resolve => child.once('exit', resolve));
  fs.writeFileSync('release/runtime-result.json', JSON.stringify({ ok: true, runtime, checks: ['dependency files and SHA-256 manifest', 'bundled Node executable', 'bundled SQLite native module', 'authenticated HTTP assets', 'authenticated websocket', 'clean shutdown'] }, null, 2));
  console.log('Packaged runtime checks passed.');
} finally { if (child.exitCode === null) child.kill(); }
