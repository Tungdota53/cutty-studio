import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, Task, Message } from './types.js';
import { newConversation, type ConversationState } from './conversation.js';

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
    `);
  }
  session(id: string, status: string, model: string, task = '') {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,model=excluded.model,updated_at=excluded.updated_at').run(id, status, model, task, now, now);
  }
  task(session: string, task: Task) { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES(?,?,?)').run(task.id, session, JSON.stringify(task)); }
  agent(session: string, agent: AgentState) { this.db.prepare('INSERT OR REPLACE INTO agents VALUES(?,?,?)').run(agent.id, session, JSON.stringify(agent)); }
  tasks(session: string) { return (this.db.prepare('SELECT data FROM tasks WHERE session_id=?').all(session) as { data: string }[]).map(item => JSON.parse(item.data) as Task); }
  sessions() { return this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 20').all(); }
  conversation(session: string): ConversationState {
    const saved = this.db.prepare('SELECT data FROM conversation_state WHERE session_id=?').get(session) as { data: string } | undefined;
    if (saved) return JSON.parse(saved.data) as ConversationState;
    // Upgrade old chats without losing turns beyond the previous 24-message cap.
    const rows = this.db.prepare('SELECT agent_id,content FROM messages WHERE session_id=? ORDER BY id').all(session) as { agent_id: string; content: string }[];
    return newConversation(rows.map(row => ({ role: row.agent_id === 'user' ? 'user' : 'assistant', content: row.content })));
  }
  saveConversation(session: string, state: ConversationState) { this.db.prepare('INSERT INTO conversation_state VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data').run(session, JSON.stringify(state)); }
  archiveItem(session: string, item: Message) { this.db.prepare('INSERT INTO conversation_items(session_id,ts,data) VALUES(?,?,?)').run(session, new Date().toISOString(), JSON.stringify(item)); }
  items(session: string) { return (this.db.prepare('SELECT data FROM conversation_items WHERE session_id=? ORDER BY id').all(session) as { data: string }[]).map(item => JSON.parse(item.data) as Message); }
  close() { this.db.close(); }
}
