const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(process.env.VIBE_SMOKE_WORKSPACE || '.vibe/desktop-smoke');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', root);
process.env.VIBE_WORKSPACE = root;
process.env.VIBE_SMOKE_TEST = '1';
process.env.VIBE_API_KEY = '';
const requests = [];
const model = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'smoke-model' }, { id: 'agent-specific-model' }] })); return; }
  let body = ''; req.on('data', data => body += data); req.on('end', () => {
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const request = requests.at(-1), user = request.messages.findLast(message => message.role === 'user')?.content || '';
    if (user.includes('smoke-teamwork-page') && request.messages[0].content.includes('You are Vibe planner')) {
      const content = JSON.stringify({ tasks: [{ id: 'T1', title: 'Create smoke page', role: 'coder', description: 'smoke-create-page', dependencies: [] }, { id: 'T2', title: 'Test smoke page', role: 'tester', description: 'smoke-check-page', dependencies: ['T1'] }, { id: 'T3', title: 'Review smoke page', role: 'reviewer', description: 'smoke-review-page', dependencies: ['T2'] }] });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    if (user.startsWith('smoke-') && user.endsWith('-page')) {
      const tools = request.messages.filter(message => message.role === 'tool');
      if (!tools.length) {
        const write = user === 'smoke-create-page';
        const call = { index: 0, id: 'smoke-page-tool', type: 'function', function: { name: write ? 'write_file' : 'read_file', arguments: JSON.stringify(write ? { path: 'smoke-teamwork.html', content: '<h1>alo alo</h1>' } : { path: 'smoke-teamwork.html' }) } };
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      assert(tools.every(tool => JSON.parse(tool.content).ok));
      if (user !== 'smoke-create-page') assert(tools.at(-1).content.includes('alo alo'));
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Verified smoke page' } }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    const text = requests.at(-1).tools ? 'Đã kiểm tra giao diện desktop.\n\n**Sẵn sàng làm việc.**\n\n```typescript\nconst studio = "Vibe";\n```' : 'Mục tiêu: kiểm tra desktop. Giữ kết quả đã xác nhận và tiếp tục từ lượt trước.';
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 351, completion_tokens: 24, total_tokens: 375, prompt_tokens_details: { cached_tokens: 123 } } }) + '\n\ndata: [DONE]\n\n');
  });
});
const timer = setTimeout(() => { fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: false, error: 'timeout' })); app.exit(1); }, 35000);
async function wait(win, expression) {
  for (let i = 0; i < 150; i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('UI timeout: ' + expression);
}
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, _level, message) => { if (String(message).includes('Error')) console.log(message); });
  win.webContents.once('did-finish-load', async () => {
    try {
      await wait(win, `document.getElementById('connection-text').textContent === 'Đã kết nối' && document.getElementById('workspace-name').textContent !== 'Dự án' && typeof window.desktop === 'object'`);
      fs.mkdirSync('release', { recursive: true });
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync('release/preview.png', (await win.webContents.capturePage()).toPNG());
      const port = model.address().port;
      await win.webContents.executeJavaScript(`document.getElementById('team-button').click();`);
      await wait(win, `document.querySelectorAll('.role-card').length===7`);
      await win.webContents.executeJavaScript(`document.querySelector('[data-role=reviewer] [data-field=instructions]').value='Review authentication with evidence';document.getElementById('team-form').requestSubmit();`);
      await wait(win, `document.getElementById('team-status').textContent.includes('Đã lưu')`);
      const profiles = JSON.parse(fs.readFileSync(path.join(root, '.vibe/config.json'), 'utf8'));
      assert.equal(profiles.agentProfiles.reviewer.instructions, 'Review authentication with evidence');
      assert(profiles.agentProfiles.coder.skills.includes('builtin:scoped-implementation'));
      await win.webContents.executeJavaScript(`document.querySelector('[data-agent=assistant] [data-field=model]').value='agent-specific-model';document.getElementById('team-form').requestSubmit();`);
      await wait(win, `document.querySelector('[data-agent=assistant] summary').textContent.includes('agent-specific-model')`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.vibe/config.json'), 'utf8')).namedAgents.find(agent=>agent.id==='assistant').model, 'agent-specific-model');
      await win.webContents.executeJavaScript(`document.getElementById('skill-search').value='review';document.getElementById('skill-search').dispatchEvent(new Event('input'));`);
      await wait(win, `document.getElementById('skill-results').textContent.includes('code-review') && !document.getElementById('skill-results').textContent.includes('imagegen')`);
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync('release/preview-team.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('team-dialog').close();`);
      await win.webContents.executeJavaScript(`document.getElementById('settings-button').click();document.getElementById('base-url').value='http://127.0.0.1:${port}/v1';document.getElementById('model-input').value='smoke-model';document.getElementById('api-key').value='smoke-private-key';document.getElementById('context-window').value=16384;document.getElementById('output-tokens').value=2048;document.getElementById('settings-form').requestSubmit();`);
      await wait(win, `!document.getElementById('settings-dialog').open && document.getElementById('model-name').textContent === 'smoke-model'`);
      const saved = fs.readFileSync(path.join(root, 'settings.json'), 'utf8'); assert(!saved.includes('smoke-private-key')); assert(saved.includes('encryptedKey'));
      await win.webContents.executeJavaScript(`document.getElementById('fetch-models').click();`);
      await wait(win, `document.querySelectorAll('#available-models option').length===2`);
      await win.webContents.executeJavaScript(`document.getElementById('prompt').value='Kiểm tra desktop';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.querySelector('.message.assistant .message-content strong') && !document.getElementById('stop-button').hidden === false`);
      assert.equal(requests.at(-1).model, 'smoke-model');
      assert.equal(requests.at(-1).max_tokens, 2048);
      assert(requests.at(-1).messages[0].content.includes('builtin:workspace-assistant'));
      await wait(win, `document.getElementById('usage-output').textContent==='24'`);
      await win.webContents.executeJavaScript(`document.getElementById('chat-agent').value='assistant';`);
      await win.webContents.executeJavaScript(`document.getElementById('prompt').value='Tiếp tục từ kết quả trên';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.querySelectorAll('.message.assistant').length===2 && document.getElementById('stop-button').hidden`);
      assert.equal(requests.at(-1).model, 'agent-specific-model');
      assert(requests.at(-1).messages.some(item => item.role==='assistant' && item.content.includes('Sẵn sàng làm việc')));
      await win.webContents.executeJavaScript(`document.getElementById('context-button').click();document.getElementById('compact-context').click();`);
      await wait(win, `Number(document.getElementById('context-compactions').textContent)>=1 && document.getElementById('stop-button').hidden`);
      await win.webContents.executeJavaScript(`document.getElementById('toast').hidden=true`);
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync('release/preview-chat.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('new-chat').click();document.querySelector('#history button').click();`);
      await wait(win, `document.querySelectorAll('.message').length >= 2`);
      await win.webContents.executeJavaScript(`document.getElementById('mode').value='teamwork';document.getElementById('prompt').value='smoke-teamwork-page';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.getElementById('stop-button').hidden && document.getElementById('messages').textContent.includes('Kết quả Teamwork')`);
      assert.equal(fs.readFileSync(path.join(root, 'smoke-teamwork.html'), 'utf8'), '<h1>alo alo</h1>');
      const report = await win.webContents.executeJavaScript(`document.getElementById('messages').textContent`);
      assert(!report.includes(': failed')); assert(!report.includes(': blocked')); assert(!fs.existsSync(path.join(root, '.git')));
      const bounds = await win.webContents.executeJavaScript(`({width:innerWidth, scroll:document.body.scrollWidth, node:typeof window.require, sidebar:!!document.getElementById('history').children.length})`);
      assert.equal(bounds.node, 'undefined'); assert(bounds.scroll <= bounds.width); assert(bounds.sidebar);
      fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: true, checks: ['desktop preload', 'encrypted settings', 'seven role profiles', 'saved role instructions and selected skills', 'skill search', 'skill instructions in model input', 'configurable token limits', 'chat streaming', 'previous output reused as input', 'actual input/output/cache usage', 'manual compaction', 'history restore', 'inspector', 'renderer isolation', 'layout'], bounds }, null, 2));
      clearTimeout(timer); model.close(); app.quit();
    } catch (error) { fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: false, error: String(error) })); clearTimeout(timer); model.close(); app.quit(); }
  });
});
model.listen(0, '127.0.0.1', () => require('../desktop/main.cjs'));
