import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, Task, Message } from './types.js';
import { newConversation, type ConversationState, type ContextStats } from './conversation.js';
import { contextExcerpt } from './conversation.js';
import { recallArguments } from './context-archive.js';

export class Store {
  db: Database.Database;
  constructor(root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.db = new Database(path.join(root, 'vibe.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version(version INTEGER);
      INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,status TEXT,model TEXT,task TEXT,created_at TEXT,updated_at TEXT);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT,session_id TEXT,data TEXT,PRIMARY KEY(id,session_id));
      CREATE TABLE IF NOT EXISTS agents(id TEXT,session_id TEXT,data TEXT,PRIMARY KEY(id,session_id));
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,agent_id TEXT,ts TEXT,content TEXT);
      CREATE TABLE IF NOT EXISTS conversation_state(session_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_items(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,ts TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_items_session ON conversation_items(session_id,id);
      CREATE TABLE IF NOT EXISTS run_progress(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,ts TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS run_progress_session ON run_progress(session_id,id);
      CREATE TABLE IF NOT EXISTS session_context(session_id TEXT PRIMARY KEY,data TEXT NOT NULL);
    `);
  }
  session(id: string, status: string, model: string, task = '') {
    // Millisecond timestamp collisions must not reorder a resumed older chat.
    const latest = this.db.prepare('SELECT MAX(updated_at) AS ts FROM sessions').get() as { ts?: string };
    const now = new Date(Math.max(Date.now(), (latest.ts ? Date.parse(latest.ts) : 0) + 1)).toISOString();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,model=excluded.model,task=CASE WHEN sessions.task=\'\' THEN excluded.task ELSE sessions.task END,updated_at=excluded.updated_at').run(id, status, model, task, now, now);
  }
  task(session: string, task: Task) { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES(?,?,?)').run(task.id, session, JSON.stringify(task)); }
  agent(session: string, agent: AgentState) { this.db.prepare('INSERT OR REPLACE INTO agents VALUES(?,?,?)').run(agent.id, session, JSON.stringify(agent)); }
  tasks(session: string) { return (this.db.prepare('SELECT data FROM tasks WHERE session_id=?').all(session) as { data: string }[]).map(item => JSON.parse(item.data) as Task); }
  sessions() { return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC,rowid DESC LIMIT 100').all(); }
  sessionInfo(session: string) { return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(session) as { id: string; model: string; task: string; status: string } | undefined; }
  message(session: string, role: 'user' | 'assistant', content: string) { this.db.prepare('INSERT INTO messages(session_id,agent_id,ts,content) VALUES(?,?,?,?)').run(session, role, new Date().toISOString(), content); }
  transcript(session: string): Message[] {
    const rows = this.db.prepare('SELECT agent_id,content FROM messages WHERE session_id=? ORDER BY id').all(session) as { agent_id: string; content: string }[];
    const visibleRows = rows.filter(row => !['tool', 'system'].includes(row.agent_id));
    if (visibleRows.length) return visibleRows.map(row => ({ role: row.agent_id === 'user' ? 'user' : 'assistant', content: row.content }));
    // Archived original turns survive compaction. Tool calls/results are never
    // rendered as ordinary assistant answers in the chat history.
    const archived = this.items(session).filter(item => item.role === 'user' || item.role === 'assistant' && !item.tool_calls?.length && !!item.content?.trim());
    if (archived.length) return archived;
    const saved = this.db.prepare('SELECT data FROM conversation_state WHERE session_id=?').get(session) as { data: string } | undefined;
    if (saved) { try { const visible = (JSON.parse(saved.data) as ConversationState).messages.filter(item => item.role === 'user' || item.role === 'assistant' && !item.tool_calls?.length && !!item.content?.trim()); if (visible.length) return visible; } catch {} }
    const info = this.sessionInfo(session), tasks = this.tasks(session);
    if (!info?.task && !tasks.length) return [];
    return [...(info?.task ? [{ role: 'user' as const, content: info.task }] : []), ...(tasks.length ? [{ role: 'assistant' as const, content: tasks.map(task => `${task.title}: ${task.status}\n${task.resultSummary || task.error || ''}`).join('\n\n') }] : [])];
  }
  progress(session: string, event: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const safe = { ...event, sessionId: session, timestamp };
    const result = this.db.prepare('INSERT INTO run_progress(session_id,ts,data) VALUES(?,?,?)').run(session, timestamp, JSON.stringify(safe));
    return { ...safe, id: Number(result.lastInsertRowid) };
  }
  progressHistory(session: string) { return (this.db.prepare('SELECT id,data FROM run_progress WHERE session_id=? ORDER BY id DESC LIMIT 500').all(session) as { id: number; data: string }[]).reverse().map(row => ({ ...JSON.parse(row.data), id: row.id })); }
  saveContext(session: string, stats: ContextStats, model?: string) { this.db.prepare('INSERT INTO session_context VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(session, JSON.stringify({ ...stats, ...(model ? { model } : {}) })); }
  context(session: string): (ContextStats & { model?: string }) | undefined { const row = this.db.prepare('SELECT data FROM session_context WHERE session_id=?').get(session) as { data: string } | undefined; if (row) { try { return JSON.parse(row.data); } catch {} } }
  conversation(session: string): ConversationState {
    const saved = this.db.prepare('SELECT data FROM conversation_state WHERE session_id=?').get(session) as { data: string } | undefined;
    if (saved) { try { const state = JSON.parse(saved.data) as ConversationState; if (Array.isArray(state.messages)) return state; } catch { /* Recover visible original turns from archives when a legacy snapshot is corrupt. */ } }
    // Upgrade old chats without losing turns beyond the previous 24-message cap.
    return newConversation(this.transcript(session));
  }
  saveConversation(session: string, state: ConversationState) { this.db.prepare('INSERT INTO conversation_state VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(session, JSON.stringify(state)); }
  archiveItem(session: string, item: Message) { this.db.prepare('INSERT INTO conversation_items(session_id,ts,data) VALUES(?,?,?)').run(session, new Date().toISOString(), JSON.stringify(item)); }
  items(session: string) { return (this.db.prepare('SELECT data FROM conversation_items WHERE session_id=? ORDER BY id').all(session) as { data: string }[]).map(item => JSON.parse(item.data) as Message); }
  recall(session: string, query = '', limit = 4, beforeId?: number) {
    const args = recallArguments.parse({ query, limit, beforeId });
    // instr is a literal search, so %, quotes and Unicode are never SQL patterns.
    const rows = this.db.prepare('SELECT id,data FROM conversation_items WHERE session_id=? AND (? IS NULL OR id<?) AND (?=\'\' OR instr(lower(data),lower(?))>0) ORDER BY id DESC LIMIT ?').all(session, args.beforeId ?? null, args.beforeId ?? null, args.query, args.query, args.limit + 1) as { id: number; data: string }[];
    const selected = rows.slice(0, args.limit);
    return {
      source: 'original task archive', untrusted: true,
      records: selected.map(row => ({ archiveId: row.id, excerpt: contextExcerpt(row.data, Math.floor(2400 / args.limit)), incomplete: Buffer.byteLength(row.data) > Math.floor(2400 / args.limit) * 3 })),
      nextBeforeId: rows.length > args.limit ? selected.at(-1)?.id : null,
    };
  }
  close() { this.db.close(); }
}
