import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { StoredMessage } from './assistant/types.ts';

type Row = Record<string, unknown>;

export type Conversation = {
  id: number;
  /** tg:123456 или web:<id сессии> */
  clientKey: string;
  clientName: string;
  kbHash: string;
  startedAt: number;
  lastAt: number;
  handedOff: boolean;
};

export type Lead = {
  id: number;
  clientKey: string;
  name: string;
  phone: string;
  request: string;
  createdAt: number;
};

export type Database = ReturnType<typeof openDatabase>;

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY,
      client_key  TEXT    NOT NULL,
      client_name TEXT    NOT NULL DEFAULT '',
      kb_hash     TEXT    NOT NULL,
      started_at  INTEGER NOT NULL,
      last_at     INTEGER NOT NULL,
      handed_off  INTEGER NOT NULL DEFAULT 0,
      closed      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS conversations_client ON conversations (client_key, closed);

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      role            TEXT    NOT NULL,
      content         TEXT    NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, id);

    CREATE TABLE IF NOT EXISTS leads (
      id         INTEGER PRIMARY KEY,
      client_key TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      phone      TEXT    NOT NULL,
      request    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    -- Какое сообщение в чате менеджера относится к какому клиенту: чтобы ответ «реплаем» дошёл адресату
    CREATE TABLE IF NOT EXISTS manager_threads (
      admin_chat_id INTEGER NOT NULL,
      message_id    INTEGER NOT NULL,
      client_key    TEXT    NOT NULL,
      PRIMARY KEY (admin_chat_id, message_id)
    );
  `);

  const toConversation = (r: Row): Conversation => ({
    id: Number(r.id),
    clientKey: String(r.client_key),
    clientName: String(r.client_name),
    kbHash: String(r.kb_hash),
    startedAt: Number(r.started_at),
    lastAt: Number(r.last_at),
    handedOff: Boolean(r.handed_off)
  });

  const toLead = (r: Row): Lead => ({
    id: Number(r.id),
    clientKey: String(r.client_key),
    name: String(r.name),
    phone: String(r.phone),
    request: String(r.request),
    createdAt: Number(r.created_at)
  });

  return {
    openConversation: (clientKey: string) => {
      const row = db
        .prepare('SELECT * FROM conversations WHERE client_key = ? AND closed = 0 ORDER BY id DESC LIMIT 1')
        .get(clientKey) as Row | undefined;
      return row ? toConversation(row) : undefined;
    },

    createConversation: (clientKey: string, clientName: string, kbHash: string, now: number) => {
      const result = db
        .prepare('INSERT INTO conversations (client_key, client_name, kb_hash, started_at, last_at) VALUES (?, ?, ?, ?, ?)')
        .run(clientKey, clientName, kbHash, now, now);
      return Number(result.lastInsertRowid);
    },

    closeConversation: (id: number) => {
      db.prepare('UPDATE conversations SET closed = 1 WHERE id = ?').run(id);
    },

    touchConversation: (id: number, now: number) => {
      db.prepare('UPDATE conversations SET last_at = ? WHERE id = ?').run(now, id);
    },

    setHandedOff: (id: number, handedOff: boolean) => {
      db.prepare('UPDATE conversations SET handed_off = ? WHERE id = ?').run(Number(handedOff), id);
    },

    history: (conversationId: number): StoredMessage[] =>
      (db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId) as Row[]).map(
        (r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: JSON.parse(String(r.content)) })
      ),

    countMessages: (conversationId: number) =>
      Number((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as Row).n),

    appendMessages: (conversationId: number, messages: StoredMessage[], now: number) => {
      const insert = db.prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)');
      for (const m of messages) insert.run(conversationId, m.role, JSON.stringify(m.content), now);
    },

    /**
     * Сколько сообщений клиент написал за период — для лимита расходов на ИИ.
     * Считаем только текст клиента (JSON-строка начинается с кавычки), а не служебные результаты инструментов.
     */
    countClientMessagesSince: (clientKey: string, since: number) =>
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
               WHERE c.client_key = ? AND m.role = 'user' AND m.created_at >= ? AND m.content LIKE '"%'`
            )
            .get(clientKey, since) as Row
        ).n
      ),

    saveLead: (lead: Omit<Lead, 'id'>) => {
      db.prepare('INSERT INTO leads (client_key, name, phone, request, created_at) VALUES (?, ?, ?, ?, ?)').run(
        lead.clientKey,
        lead.name,
        lead.phone,
        lead.request,
        lead.createdAt
      );
    },

    recentLeads: (limit = 10) =>
      (db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toLead),

    rememberThread: (adminChatId: number, messageId: number, clientKey: string) => {
      db.prepare('INSERT OR REPLACE INTO manager_threads (admin_chat_id, message_id, client_key) VALUES (?, ?, ?)').run(
        adminChatId,
        messageId,
        clientKey
      );
    },

    threadClient: (adminChatId: number, messageId: number) => {
      const row = db
        .prepare('SELECT client_key FROM manager_threads WHERE admin_chat_id = ? AND message_id = ?')
        .get(adminChatId, messageId) as Row | undefined;
      return row ? String(row.client_key) : undefined;
    },

    close: () => db.close()
  };
}
