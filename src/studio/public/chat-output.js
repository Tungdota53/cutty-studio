'use strict';
window.ChatOutput = (() => {
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Đã sao chép ✓'; setTimeout(() => button.textContent = 'Sao chép', 1800); }
    catch { button.textContent = 'Không thể sao chép'; }
  }
  function inline(parent, text) {
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g)) {
      if (part.startsWith('**') && part.endsWith('**')) parent.append(node('strong', part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`')) parent.append(node('code', part.slice(1, -1)));
      else {
        const match = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        if (match) { const a = node('a', match[1]); a.href = match[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
        else parent.append(document.createTextNode(part));
      }
    }
  }
  function highlight(code, text) {
    const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\b(?:const|let|var|function|async|await|return|if|else|for|while|class|import|export|from|new|try|catch|throw|true|false|null|def|self|None|SELECT|FROM|WHERE)\b|\b\d+(?:\.\d+)?\b)/g;
    let end = 0;
    for (const match of text.matchAll(tokens)) {
      code.append(document.createTextNode(text.slice(end, match.index)));
      code.append(node('span', match[0], /^['"]/.test(match[0]) ? 'syntax-string' : match[0].startsWith('//') ? 'syntax-comment' : /^\d/.test(match[0]) ? 'syntax-number' : 'syntax-keyword'));
      end = match.index + match[0].length;
    }
    code.append(document.createTextNode(text.slice(end)));
  }
  function render(target, text) {
    target.dataset.raw = text; target.replaceChildren();
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('```')) {
        const language = lines[i].slice(3).trim(), content = [];
        while (++i < lines.length && !lines[i].startsWith('```')) content.push(lines[i]);
        const raw = content.join('\n'), block = node('section', undefined, 'code-block');
        const toolbar = node('div', undefined, 'code-toolbar'), button = node('button', 'Sao chép'); button.type = 'button'; button.onclick = () => copy(raw, button);
        toolbar.append(node('span', language || 'code'), button);
        const pre = node('pre'), code = node('code'); highlight(code, raw); pre.append(code); block.append(toolbar, pre); target.append(block); continue;
      }
      const heading = lines[i].match(/^(#{1,4})\s+(.+)/);
      if (heading) { const h = node('h' + Math.min(heading[1].length + 1, 5)); inline(h, heading[2]); target.append(h); continue; }
      if (/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        const ordered = /^\s*\d/.test(lines[i]), list = node(ordered ? 'ol' : 'ul');
        do { const li = node('li'); inline(li, lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')); list.append(li); i++; }
        while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i]));
        i--; target.append(list); continue;
      }
      if (lines[i].includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {
        const table = node('table'), wrap = node('div', undefined, 'table-wrap');
        const cells = line => line.replace(/^\s*\||\|\s*$/g, '').split('|');
        const tr = node('tr'); for (const cell of cells(lines[i])) { const th = node('th'); inline(th, cell.trim()); tr.append(th); } table.append(tr); i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { const row = node('tr'); for (const cell of cells(lines[i])) { const td = node('td'); inline(td, cell.trim()); row.append(td); } table.append(row); i++; }
        i--; wrap.append(table); target.append(wrap); continue;
      }
      if (!lines[i].trim()) continue;
      const p = node(lines[i].startsWith('> ') ? 'blockquote' : 'p'); inline(p, lines[i].replace(/^> /, '')); target.append(p);
    }
  }
  return { render, copy };
})();
