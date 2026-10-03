import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addContextPin, attachContextFile, ConversationContext, inspectContext, newConversation, removeContextPin, removeContextAttachment } from '../src/conversation.js';
import type { ModelClient } from '../src/model.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const config = { contextWindow: 8192, maxOutputTokens: 1024 };
describe('User-authored context pins and file evidence', () => {
  it('retains user pins and attached snapshots across repeated compaction and tracks summary sources', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pins-')); roots.push(root);
    fs.writeFileSync(path.join(root, 'requirements.md'), 'Keep the public API stable.');
    const state = newConversation([{ role: 'user', content: 'Original requirement' }, ...Array.from({ length: 25 }, () => ({ role: 'assistant' as const, content: 'Historical details '.repeat(150) })), { role: 'user', content: 'Continue' }]);
    const pin = addContextPin(state, 'Never change auth behavior.', 'Auth constraint');
    const attachment = attachContextFile(state, root, 'requirements.md');
    const client = { chat: vi.fn(async () => ({ content: 'A concise memory', toolCalls: [], model: 'test' })) } as unknown as ModelClient;
    const manager = new ConversationContext(config, state);
    await manager.prepare('System', [], client, 'test');
    state.messages.splice(state.messages.length - 1, 0, ...Array.from({ length: 20 }, () => ({ role: 'assistant' as const, content: 'More historical details '.repeat(150) })));
    await manager.prepare('System', [], client, 'test');
    expect(state.pins?.[0]).toEqual(pin); expect(state.attachments?.[0]).toEqual(attachment);
    expect(manager.requestMessages('System').some(item => item.content?.includes('Never change auth behavior.'))).toBe(true);
    expect(manager.requestMessages('System').some(item => item.content?.includes('Keep the public API stable.'))).toBe(true);
    expect(state.summarySources).toHaveLength(2);
    const report = inspectContext(config, state, 'System');
    expect(report.pins[0].id).toBe(pin.id); expect(report.attachments[0]).toMatchObject({ sha256: attachment.sha256, bytes: attachment.bytes });
    expect(report.groups.every(group => group.tokens > 0)).toBe(true);
    removeContextPin(state, pin.id); removeContextAttachment(state, attachment.id);
    expect(state.pins).toEqual([]); expect(state.attachments).toEqual([]);
  });
  it('errors explicitly when protected context cannot fit, retaining all user data', async () => {
    const state = newConversation([{ role: 'user', content: 'Small request' }]);
    const pin = addContextPin(state, 'Important constraint. '.repeat(500));
    const client = { chat: vi.fn() } as unknown as ModelClient;
    await expect(new ConversationContext({ contextWindow: 4096, maxOutputTokens: 512 }, state).prepare('System', [], client, 'test')).rejects.toThrow('vượt ngân sách');
    expect(state.pins).toEqual([pin]); expect(client.chat).not.toHaveBeenCalled();
  });
  it('blocks sensitive files, outside paths, binary data and oversized files, and redacts secrets in ordinary text', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-attachments-')); roots.push(root); const state = newConversation();
    for (const file of ['.env.local', 'credentials.json', 'private.pem']) { fs.writeFileSync(path.join(root, file), 'secret'); expect(() => attachContextFile(state, root, file)).toThrow('bí mật'); }
    expect(() => attachContextFile(state, root, '../outside.txt')).toThrow('ngoài workspace');
    fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2])); expect(() => attachContextFile(state, root, 'binary.bin')).toThrow('nhị phân');
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(1048577)); expect(() => attachContextFile(state, root, 'large.txt')).toThrow('1 MiB');
    fs.writeFileSync(path.join(root, 'notes.md'), 'api_key=hidden-value\nPublic instructions');
    const attachment = attachContextFile(state, root, 'notes.md');
    expect(attachment.redacted).toBe(true); expect(attachment.content).not.toContain('hidden-value');
  });
});
