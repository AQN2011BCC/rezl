import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../../config/AppConfig.js";
import { getConversationDbPath } from "../../config/AppConfig.js";

export interface StoredMessage {
    ownerId: string;
    messageId: string;
    threadId: string;
    threadType: number;
    senderId?: string;
    receiverId?: string;
    content?: unknown;
    messageType?: string;
    timestamp?: number;
    direction: "incoming" | "outgoing";
    raw?: unknown;
}

export class ChatRepository {
    constructor(
        private readonly getIndexDb: () => DatabaseSync | null,
        private readonly getConversationDb: (
            ownerId: string,
            threadId: string,
            threadType: number,
        ) => DatabaseSync | null,
        private readonly config: AppConfig,
    ) {}

    saveMessage(m: StoredMessage): void {
        if (!m.ownerId || !m.messageId || !m.threadId) return;

        const db = this.getConversationDb(
            m.ownerId,
            m.threadId,
            m.threadType,
        );
        const index = this.getIndexDb();
        if (!db || !index) return;

        const now = Date.now();
        const contentJson = safeJson(m.content);
        const contentText = extractSearchText(m.content);

        db.prepare(`
            INSERT INTO messages(
                owner_id,message_id,thread_id,thread_type,sender_id,receiver_id,
                content_json,content_text,message_type,timestamp,direction,
                is_recalled,recalled_at,raw_json,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(owner_id,message_id) DO UPDATE SET
                thread_id=excluded.thread_id,
                thread_type=excluded.thread_type,
                sender_id=excluded.sender_id,
                receiver_id=excluded.receiver_id,
                content_json=COALESCE(messages.content_json,excluded.content_json),
                content_text=COALESCE(messages.content_text,excluded.content_text),
                message_type=excluded.message_type,
                timestamp=COALESCE(messages.timestamp,excluded.timestamp),
                direction=excluded.direction,
                raw_json=COALESCE(messages.raw_json,excluded.raw_json),
                updated_at=excluded.updated_at
        `).run(
            m.ownerId,
            m.messageId,
            m.threadId,
            m.threadType,
            m.senderId ?? null,
            m.receiverId ?? null,
            contentJson,
            contentText,
            m.messageType ?? "text",
            m.timestamp ?? now,
            m.direction,
            0,
            null,
            safeJson(m.raw),
            now,
            now,
        );

        const sourceDb = this.config.database.splitPerConversation
            ? getConversationDbPath(this.config, m.ownerId, m.threadId)
            : this.config.database.indexDatabaseName;

        index.prepare(`
            INSERT INTO message_index(
                owner_id,message_id,thread_id,thread_type,sender_id,receiver_id,
                content_text,message_type,timestamp,direction,is_recalled,source_db
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(owner_id,message_id) DO UPDATE SET
                thread_id=excluded.thread_id,
                thread_type=excluded.thread_type,
                sender_id=excluded.sender_id,
                receiver_id=excluded.receiver_id,
                content_text=COALESCE(message_index.content_text,excluded.content_text),
                message_type=excluded.message_type,
                timestamp=COALESCE(message_index.timestamp,excluded.timestamp),
                direction=excluded.direction,
                source_db=excluded.source_db
        `).run(
            m.ownerId,
            m.messageId,
            m.threadId,
            m.threadType,
            m.senderId ?? null,
            m.receiverId ?? null,
            contentText,
            m.messageType ?? "text",
            m.timestamp ?? now,
            m.direction,
            0,
            sourceDb,
        );

        if (this.config.history.searchIndex && contentText) {
            try {
                index.prepare(`
                    DELETE FROM message_fts
                    WHERE owner_id=? AND message_id=?
                `).run(m.ownerId, m.messageId);

                index.prepare(`
                    INSERT INTO message_fts(owner_id,message_id,thread_id,content)
                    VALUES(?,?,?,?)
                `).run(m.ownerId, m.messageId, m.threadId, contentText);
            } catch {
                // FTS is an optimization; normal message persistence must survive
                // if an older SQLite build has no FTS5.
            }
        }

        index.prepare(`
            INSERT INTO conversations(
                owner_id,thread_id,thread_type,last_message_id,last_message_at,updated_at
            ) VALUES(?,?,?,?,?,?)
            ON CONFLICT(owner_id,thread_id) DO UPDATE SET
                thread_type=excluded.thread_type,
                last_message_id=excluded.last_message_id,
                last_message_at=excluded.last_message_at,
                updated_at=excluded.updated_at
        `).run(
            m.ownerId,
            m.threadId,
            m.threadType,
            m.messageId,
            m.timestamp ?? now,
            now,
        );
    }

    markRecalled(
        ownerId: string,
        messageId: string,
        event: unknown,
    ): boolean {
        if (!ownerId || !messageId) return false;

        const index = this.getIndexDb();
        if (!index) return false;

        const row = index.prepare(`
            SELECT thread_id, thread_type, source_db
            FROM message_index
            WHERE owner_id=? AND message_id=?
        `).get(ownerId, messageId) as any;

        if (!row) return false;

        const db = this.getConversationDb(
            ownerId,
            String(row.thread_id),
            Number(row.thread_type ?? 0),
        );
        if (!db) return false;

        const now = Date.now();

        db.prepare(`
            UPDATE messages
            SET is_recalled=1,
                recalled_at=COALESCE(recalled_at,?),
                raw_json=COALESCE(raw_json,?),
                updated_at=?
            WHERE owner_id=? AND message_id=?
        `).run(now, safeJson(event), now, ownerId, messageId);

        index.prepare(`
            UPDATE message_index
            SET is_recalled=1
            WHERE owner_id=? AND message_id=?
        `).run(ownerId, messageId);

        return true;
    }

    listMessages(
        ownerId: string,
        threadId: string,
        limit = 100,
        before?: number,
    ): any[] {
        const db = this.getConversationDb(ownerId, threadId, 0);
        if (!db) return [];

        const n = clampLimit(limit);

        const sql = before
            ? `SELECT * FROM messages
               WHERE owner_id=? AND timestamp < ?
               ORDER BY timestamp DESC LIMIT ?`
            : `SELECT * FROM messages
               WHERE owner_id=?
               ORDER BY timestamp DESC LIMIT ?`;

        const rows = before
            ? db.prepare(sql).all(ownerId, before, n)
            : db.prepare(sql).all(ownerId, n);

        return rows as any[];
    }

    searchMessages(
        ownerId: string,
        query: string,
        limit = 50,
        threadId?: string,
    ): any[] {
        const index = this.getIndexDb();
        if (!index || !query.trim()) return [];

        const n = clampLimit(limit);
        const q = query.trim();

        try {
            const rows = index.prepare(`
                SELECT
                    mi.*,
                    snippet(message_fts,3,'','', '…', 12) AS snippet
                FROM message_fts
                JOIN message_index mi
                  ON mi.owner_id=message_fts.owner_id
                 AND mi.message_id=message_fts.message_id
                WHERE message_fts.owner_id=?
                  AND message_fts MATCH ?
                  ${threadId ? "AND mi.thread_id=?" : ""}
                ORDER BY mi.timestamp DESC
                LIMIT ?
            `).all(
                ...(threadId
                    ? [ownerId, q, threadId, n]
                    : [ownerId, q, n]),
            );

            return rows as any[];
        } catch {
            const like = `%${q}%`;
            return (threadId
                ? index.prepare(`
                    SELECT * FROM message_index
                    WHERE owner_id=? AND thread_id=? AND content_text LIKE ?
                    ORDER BY timestamp DESC LIMIT ?
                `).all(ownerId, threadId, like, n)
                : index.prepare(`
                    SELECT * FROM message_index
                    WHERE owner_id=? AND content_text LIKE ?
                    ORDER BY timestamp DESC LIMIT ?
                `).all(ownerId, like, n)) as any[];
        }
    }

    saveRawEvent(ownerId: string, eventType: string, payload: unknown): void {
        const db = this.getIndexDb();
        if (!db) return;

        db.prepare(`
            INSERT INTO raw_events(owner_id,event_type,payload,status,created_at)
            VALUES(?,?,?,?,?)
        `).run(
            ownerId,
            eventType,
            safeJson(payload) ?? "null",
            "processed",
            Date.now(),
        );
    }
}

function clampLimit(value: number): number {
    const n = Number.isFinite(value) ? Math.floor(value) : 100;
    return Math.max(1, Math.min(1000, n));
}

function safeJson(value: unknown): string | null {
    if (value === undefined) return null;
    try {
        return JSON.stringify(value, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
        );
    } catch {
        return JSON.stringify({ value: String(value) });
    }
}

function extractSearchText(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value;

    if (typeof value === "object") {
        const obj = value as Record<string, unknown>;
        for (const key of ["text", "content", "msg", "title", "description"]) {
            if (typeof obj[key] === "string") return obj[key] as string;
        }
    }

    try {
        return JSON.stringify(value, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
        );
    } catch {
        return String(value);
    }
}
