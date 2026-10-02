'use strict';
const $ = id => document.getElementById(id);
const credential = new URLSearchParams(location.search).get('token');
let ws, config, busy = false, currentSession = null, assistant = null, response = '', reconnectTimer, toastTimer;
let pendingSettings = null;
let currentContext = null;
const approvalQueue = [];
let approvalsTimer;
function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('Mất kết nối. Đang thử kết nối lại…'); return false; }
  ws.send(JSON.stringify(payload)); return true;
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function setBusy(value) {
  busy = value;
  $('send-button').hidden = value; $('stop-button').hidden = !value; $('run-status').hidden = !value;
  $('new-chat').disabled = value; $('workspace-button').disabled = value; $('mode').disabled = value;
  $('settings-form').querySelector('[type=submit]').disabled = value;
  $('compact-context').disabled = value || !currentSession;
  $('run-text').textContent = 'Đang xử lý…';
}
function configure(next) {
  config = next;
  const parts = next.workspace.split(/[\\/]/).filter(Boolean);
  $('workspace-name').textContent = parts.at(-1) || next.workspace;
  $('workspace-path').textContent = next.workspace; $('workspace-button').title = next.workspace;
  $('model-name').textContent = next.model;
  $('base-url').value = next.baseUrl; $('model-input').value = next.model;
  $('context-window').value = next.contextWindow || 32768; $('output-tokens').value = next.maxOutputTokens || 4096;
  if (!currentContext) showContext(null);
  $('api-key').placeholder = next.apiKey ? 'Đã có khóa · để trống để giữ nguyên' : 'Nhập khóa API';
  $('key-note').textContent = window.desktop ? 'Khóa được mã hóa bằng Windows và lưu trên máy của bạn.' : 'Khóa chỉ được giữ trong phiên backend hiện tại.';
}
const formatTokens = number => new Intl.NumberFormat('vi-VN').format(number || 0);
function showContext(stats, summary) {
  currentContext = stats;
  const windowSize = stats?.window || config?.contextWindow || 32768;
  $('context-button').textContent = stats ? `Ngữ cảnh ~${stats.percent}%` : `Ngữ cảnh ${formatTokens(windowSize)}`;
  $('context-window-value').textContent = formatTokens(windowSize);
  $('context-input-value').textContent = stats ? '~' + formatTokens(stats.estimatedInput) : 'Chưa gửi';
  $('context-output-value').textContent = formatTokens(stats?.outputReserve || config?.maxOutputTokens || 4096);
  $('context-compactions').textContent = formatTokens(stats?.compactions);
  $('context-progress').value = stats?.percent || 0;
  const usage = stats?.usage;
  $('usage-input').textContent = (usage?.estimated ? '~' : '') + formatTokens(usage?.prompt);
  $('usage-output').textContent = (usage?.estimated ? '~' : '') + formatTokens(usage?.completion);
  $('usage-cache').textContent = formatTokens(usage?.cached);
  $('usage-note').textContent = usage?.estimated ? 'Nhà cung cấp chưa trả đủ usage. Số có dấu ~ là ước tính, không dùng để tính tiền.' : 'Vào/ra là tổng usage nhà cung cấp trả về trong phiên, bao gồm các lượt nén.';
  if (summary !== undefined) $('context-summary').textContent = summary || 'Chưa cần nén. Các lượt trò chuyện và kết quả công cụ được giữ trong ngữ cảnh.';
  $('compact-context').disabled = busy || !currentSession;
}
function selectTab(name) {
  document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node.dataset.tab === name));
  for (const tab of ['diff', 'activity', 'context']) $(tab + '-panel').hidden = tab !== name;
}
function addMessage(role, content = '') {
  $('welcome').hidden = true;
  const article = document.createElement('article'); article.className = `message ${role}`;
  const header = document.createElement('div'); header.className = 'message-header';
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? 'B' : 'v';
  const name = document.createElement('span'); name.textContent = role === 'user' ? 'Bạn' : 'Vibe';
  header.append(avatar, name);
  const body = document.createElement('div'); body.className = 'message-content'; body.textContent = content;
  article.append(header, body); $('messages').append(article); scrollEnd(); return body;
}
function scrollEnd() { $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; }
// Markdown is constructed as DOM nodes; model output never becomes HTML.
function renderText(target, text) {
  target.replaceChildren();
  const chunks = text.split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const chunk of chunks) {
    if (chunk.startsWith('```') && chunk.endsWith('```')) {
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = chunk.slice(chunk.indexOf('\n') + 1, -3).replace(/\n$/, ''); pre.append(code); target.append(pre);
    } else {
      for (const part of chunk.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g)) {
        const element = part.startsWith('**') && part.endsWith('**') ? 'strong' : part.startsWith('`') && part.endsWith('`') ? 'code' : null;
        if (element) { const node = document.createElement(element); node.textContent = part.slice(element === 'strong' ? 2 : 1, element === 'strong' ? -2 : -1); target.append(node); }
        else target.append(document.createTextNode(part));
      }
    }
  }
}
function showHistory(sessions) {
  $('history').replaceChildren();
  if (!sessions.length) { const p = document.createElement('p'); p.className = 'sidebar-empty'; p.textContent = 'Ý tưởng tiếp theo bắt đầu ở đây.'; $('history').append(p); }
  for (const session of sessions) {
    const button = document.createElement('button'); button.className = session.id === currentSession ? 'active' : '';
    const icon = document.createElement('span'); icon.textContent = session.id.startsWith('chat-') ? '◌' : '◈';
    const label = document.createElement('span'); label.textContent = session.task || session.id;
    button.append(icon, label); button.title = `${session.task || session.id}\n${session.status}`;
    button.onclick = () => {
      if (busy) return toast('Hãy dừng tác vụ trước khi chuyển cuộc trò chuyện.');
      currentSession = session.id; $('chat-title').textContent = session.task || 'Cuộc trò chuyện';
      assistant = null; response = ''; $('messages').replaceChildren(); $('welcome').hidden = true;
      send({ type: 'get_conversation', sessionId: session.id }); showHistory(sessions);
    };
    $('history').append(button);
  }
}
function showDiff(diff) {
  $('diff-output').replaceChildren();
  let added = 0, removed = 0, files = 0;
  if (!diff) { $('diff-output').textContent = 'Chưa có thay đổi Git trong thư mục này.'; }
  else for (const line of diff.split('\n')) {
    const span = document.createElement('span'); span.textContent = line + '\n';
    if (line.startsWith('diff --git')) { files++; span.className = 'diff-header'; }
    else if (line.startsWith('+') && !line.startsWith('+++')) { added++; span.className = 'diff-add'; }
    else if (line.startsWith('-') && !line.startsWith('---')) { removed++; span.className = 'diff-remove'; }
    $('diff-output').append(span);
  }
  $('change-count').textContent = files; $('diff-stats').textContent = files ? `${files} tệp · +${added} / −${removed}` : 'Chưa có thay đổi';
}
function log(text) {
  const output = $('activity-output');
  if (!output.querySelector('.activity-entry')) output.replaceChildren();
  const entry = document.createElement('div'); entry.className = 'activity-entry'; entry.textContent = text;
  output.append(entry); while (output.children.length > 300) output.firstChild.remove(); output.scrollTop = output.scrollHeight;
}
function nextApproval() {
  if (!approvalQueue.length) { $('approval-dialog').close(); return; }
  const item = approvalQueue[0];
  $('approval-command').textContent = item.command;
  $('approval-risk').textContent = `${item.tool} · ${item.riskLevel}`;
  if (!$('approval-dialog').open) $('approval-dialog').showModal();
  clearTimeout(approvalsTimer);
  approvalsTimer = setTimeout(() => { approvalQueue.shift(); nextApproval(); }, Math.max(1, item.deadline - Date.now()));
}
function answerApproval(approved) {
  const item = approvalQueue.shift(); clearTimeout(approvalsTimer);
  if (item) send({ type: 'approval_response', id: item.id, approved }); nextApproval();
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/${credential ? '?token=' + encodeURIComponent(credential) : ''}`);
  ws.onopen = () => { $('connection-dot').classList.add('online'); $('connection-text').textContent = 'Đã kết nối'; $('send-button').disabled = false; };
  ws.onclose = () => {
    $('connection-dot').classList.remove('online'); $('connection-text').textContent = 'Đang kết nối lại'; $('send-button').disabled = true;
    setBusy(false); approvalQueue.length = 0; nextApproval();
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = async ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'init': configure(msg.config); showHistory(msg.sessions || []); showDiff(msg.diff || ''); setBusy(Boolean(msg.busy)); break;
      case 'configured':
        configure(msg.config);
        if (pendingSettings && window.desktop) {
          try { const result = await window.desktop.saveSettings(pendingSettings); if (!result.keySaved) toast('Windows không hỗ trợ mã hóa. Khóa chỉ được giữ trong phiên này.'); }
          catch (error) { toast(`Đã áp dụng, nhưng không lưu được: ${error.message}`); }
        }
        pendingSettings = null; $('api-key').value = ''; $('settings-dialog').close(); toast('Đã cập nhật kết nối.'); if (currentSession) send({ type: 'get_conversation', sessionId: currentSession }); break;
      case 'sessions': showHistory(msg.sessions || []); break;
      case 'conversation':
        if (msg.sessionId !== currentSession) break;
        $('messages').replaceChildren();
        for (const item of msg.messages || []) renderText(addMessage(item.role, item.content), item.content);
        if (!msg.messages?.length) addMessage('assistant', msg.summary || 'Phiên teamwork này chưa có nội dung trò chuyện.');
        showContext(msg.context, msg.memorySummary);
        scrollEnd(); break;
      case 'context_stats': if (msg.sessionId === currentSession) showContext(msg.stats); break;
      case 'memory_summary': if (msg.sessionId === currentSession) $('context-summary').textContent = msg.summary || 'Chưa cần nén ngữ cảnh.'; break;
      case 'compaction_start': if (msg.sessionId === currentSession) { $('run-text').textContent = 'Đang tóm tắt ngữ cảnh cũ…'; log('Đang nén ngữ cảnh để tiếp tục cuộc trò chuyện.'); } break;
      case 'compaction_end': if (msg.sessionId === currentSession) { $('run-text').textContent = 'Đang tiếp tục với ngữ cảnh đã nén…'; log(`Đã nén ngữ cảnh · lần ${msg.compactions}.`); } break;
      case 'run_start': setBusy(true); break;
      case 'run_end': setBusy(false); approvalQueue.length = 0; clearTimeout(approvalsTimer); nextApproval(); send({ type: 'get_sessions' }); send({ type: 'get_diff' }); break;
      case 'stream_chunk':
        if (!assistant) assistant = addMessage('assistant'); response += msg.token || ''; assistant.textContent = response; scrollEnd(); break;
      case 'stream_end': if (assistant) renderText(assistant, response); scrollEnd(); break;
      case 'thinking': $('run-text').textContent = 'Đang phân tích yêu cầu…'; break;
      case 'terminal_log': log(msg.text || ''); break;
      case 'teamwork_event': log(msg.event.message || `${msg.event.role || 'Agent'} · ${msg.event.type}`); $('run-text').textContent = msg.event.message || 'Nhóm đang thực hiện tác vụ…'; break;
      case 'diff': showDiff(msg.diff || ''); break;
      case 'approval_request': approvalQueue.push({ ...msg, deadline: Date.now() + msg.timeoutMs }); nextApproval(); break;
      case 'error': toast(msg.message); if (pendingSettings) { $('settings-status').textContent = msg.message; pendingSettings = null; } break;
    }
  };
}
function newChat() {
  if (busy) return;
  currentSession = null; assistant = null; response = ''; $('messages').replaceChildren(); $('welcome').hidden = false; $('chat-title').textContent = 'Cuộc trò chuyện mới'; $('prompt').value = ''; $('prompt').focus();
  showContext(null, '');
  send({ type: 'get_sessions' });
}
$('composer').onsubmit = event => {
  event.preventDefault(); const prompt = $('prompt').value.trim(); if (!prompt || busy) return;
  if (!config?.apiKey) { $('settings-status').textContent = 'Nhập khóa API để bắt đầu.'; $('settings-dialog').showModal(); return; }
  const teamwork = $('mode').value === 'teamwork';
  if (!currentSession || !currentSession.startsWith('chat-')) currentSession = `chat-${crypto.randomUUID()}`;
  if (!send({ type: 'chat', prompt: teamwork ? `/teamwork ${prompt}` : prompt, sessionId: currentSession })) return;
  setBusy(true); assistant = null; response = ''; addMessage('user', prompt); $('chat-title').textContent = prompt.slice(0, 80); $('prompt').value = ''; $('prompt').style.height = '';
};
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('prompt').oninput = () => { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min(180, $('prompt').scrollHeight)}px`; };
$('stop-button').onclick = () => { send({ type: 'stop' }); $('run-text').textContent = 'Đang dừng…'; };
$('new-chat').onclick = newChat;
$('toggle-sidebar').onclick = () => { $('sidebar').hidden = !$('sidebar').hidden; };
$('toggle-inspector').onclick = () => { $('inspector').hidden = !$('inspector').hidden; if (!$('inspector').hidden) send({ type: 'get_diff' }); };
$('close-inspector').onclick = () => $('inspector').hidden = true;
$('refresh-diff').onclick = () => send({ type: 'get_diff' });
$('refresh-sessions').onclick = () => send({ type: 'get_sessions' });
$('clear-log').onclick = () => $('activity-output').replaceChildren();
$('workspace-button').onclick = async () => { if (busy) return; if (!window.desktop) return toast('Chọn thư mục có sẵn trong bản desktop .exe.'); try { await window.desktop.chooseWorkspace(); } catch (error) { toast(error.message); } };
function openSettings() { $('settings-status').textContent = ''; $('settings-dialog').showModal(); }
$('settings-button').onclick = openSettings; $('model-button').onclick = openSettings;
$('settings-form').onsubmit = event => {
  event.preventDefault(); if (busy) { $('settings-status').textContent = 'Hãy dừng tác vụ trước khi đổi kết nối.'; return; }
  pendingSettings = { baseUrl: $('base-url').value.trim(), model: $('model-input').value.trim(), apiKey: $('api-key').value.trim(), contextWindow: Number($('context-window').value), maxOutputTokens: Number($('output-tokens').value) };
  if (!send({ type: 'configure', ...pendingSettings })) pendingSettings = null;
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); };
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => {
  selectTab(button.dataset.tab);
};
$('context-button').onclick = () => { $('inspector').hidden = false; selectTab('context'); };
$('compact-context').onclick = () => {
  if (busy || !currentSession) return;
  assistant = null; response = '';
  if (send({ type: 'command', line: '/compact', sessionId: currentSession })) setBusy(true);
};
$('accept-approval').onclick = () => answerApproval(true); $('reject-approval').onclick = () => answerApproval(false);
$('approval-dialog').oncancel = event => { event.preventDefault(); answerApproval(false); };
if (window.desktop) { $('window-actions').hidden = false; for (const button of document.querySelectorAll('[data-window]')) button.onclick = () => window.desktop.control(button.dataset.window); }
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); } if (event.ctrlKey && event.key === ',') { event.preventDefault(); openSettings(); } });
connect();
