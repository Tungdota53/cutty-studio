import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db.js';
import { estimateTokens } from '../src/conversation.js';
const stores: Store[] = [], roots: string[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function store() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-archive-')); roots.push(root); const db = new Store(root); stores.push(db); return db; }
describe('Original context retrieval', () => {
  it('retrieves original tool evidence with stable IDs and pages only within the bound task', () => {
    const db = store();
    db.archiveItem('other-task', { role: 'user', content: 'private unrelated evidence' });
    for (let i = 0; i < 6; i++) db.archiveItem('task', { role: 'tool', tool_call_id: `call-${i}`, content: JSON.stringify({ ok: true, output: `exit=0\nevidence ${i}` }) });
    const first = db.recall('task', 'evidence', 2);
    expect(first.records).toHaveLength(2); expect(first.nextBeforeId).toBeTruthy();
    const second = db.recall('task', 'evidence', 2, first.nextBeforeId!);
    expect(new Set([...first.records, ...second.records].map(row => row.archiveId)).size).toBe(4);
    expect(JSON.stringify(first)).not.toContain('unrelated'); expect(first.untrusted).toBe(true);
  });
  it('uses literal search and rejects unbounded retrieval arguments', () => {
    const db = store(); db.archiveItem('task', { role: 'user', content: "Keep 100% local Việt Nam 日本語" });
    expect(db.recall('task', '%', 4).records).toHaveLength(1);
    expect(db.recall('task', 'Việt Nam', 4).records).toHaveLength(1);
    expect(db.recall('task', "' OR 1=1 --", 4).records).toHaveLength(0);
    expect(() => db.recall('task', '', 100)).toThrow(); expect(() => db.recall('task', '', 2, -1)).toThrow();
  });
  it('returns bounded Unicode excerpts and explicitly marks incomplete source', () => {
    const db = store(); db.archiveItem('task', { role: 'assistant', content: 'Việt Nam 😀 日本語 '.repeat(5000) });
    const result = db.recall('task', '', 8);
    expect(result.records[0].incomplete).toBe(true);
    expect(estimateTokens(result.records[0].excerpt)).toBeLessThanOrEqual(300);
    expect(result.records[0].excerpt).not.toContain('\uFFFD');
  });
});
