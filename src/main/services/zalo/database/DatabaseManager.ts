import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config/AppConfig.js";
import {
    getConversationDbPath,
    getIndexDbPath,
    getOwnerDataRoot,
} from "../config/AppConfig.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("ZALO_SERVICE:DatabaseManager");

export class DatabaseManager {
    private indexDb: DatabaseSync | null = null;
    private readonly conversationDbs = new Map<string, DatabaseSync>();

    constructor(private readonly config: AppConfig) {}

    get enabled(): boolean {
        return this.config.database.enabled;
    }

    /**
     * Backwards-compatible accessor. New code should use getIndexDatabase()
     * or getConversationDatabase(ownerId, threadId).
     */
    get database(): DatabaseSync | null {
        return this.getIndexDatabase("");
    }

    ensureOpen(ownerId = ""): DatabaseSync | null {
        return this.getIndexDatabase(ownerId);
    }

    getIndexDatabase(ownerId: string): DatabaseSync | null {
        if (!this.enabled) return null;
        if (!this.indexDb) {
            const owner = ownerId || "default";
            const file = getIndexDbPath(this.config, owner);
            this.indexDb = this.openDatabase(file);
            this.migrateIndex(this.indexDb);
            log.info(`index database opened: ${file}`);
        }
        return this.indexDb;
    }

    getConversationDatabase(
        ownerId: string,
        threadId: string,
        threadType = 0,
    ): DatabaseSync | null {
        if (!this.enabled) return null;

        if (!this.config.database.splitPerConversation) {
            return this.getIndexDatabase(ownerId);
        }

        const key = `${ownerId}:${threadId}`;
        const existing = this.conversationDbs.get(key);
        if (existing) return existing;

        const file = getConversationDbPath(
            this.config,
            ownerId,
            threadId,
        );

        const db = this.openDatabase(file);
        this.migrateConversation(db, ownerId, threadId, threadType);
        this.conversationDbs.set(key, db);

        return db;
    }

    private openDatabase(file: string): DatabaseSync {
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const db = new DatabaseSync(file);

        db.exec(
            `PRAGMA busy_timeout=${Math.max(
                0,
                Math.floor(this.config.database.busyTimeoutMs),
            )}`,
        );
        db.exec(`PRAGMA journal_mode=${this.config.database.journalMode}`);
        db.exec("PRAGMA foreign_keys=ON");
        db.exec("PRAGMA synchronous=NORMAL");

        return db;
    }

    private migrateIndex(db: DatabaseSync): void {
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS users (
                owner_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT,
                avatar TEXT,
                raw_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS friends (
                owner_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'friend',
                raw_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS friend_requests (
                owner_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                direction TEXT NOT NULL,
                name TEXT,
                avatar TEXT,
                message TEXT,
                raw_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, user_id, direction)
            );

            CREATE TABLE IF NOT EXISTS groups (
                owner_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                name TEXT,
                avatar TEXT,
                raw_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, group_id)
            );

            CREATE TABLE IF NOT EXISTS group_members (
                owner_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT,
                raw_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, group_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS conversations (
                owner_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                title TEXT,
                avatar TEXT,
                unread_count INTEGER NOT NULL DEFAULT 0,
                last_message_id TEXT,
                last_message_at INTEGER,
                raw_json TEXT,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, thread_id)
            );

            CREATE TABLE IF NOT EXISTS message_index (
                owner_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                sender_id TEXT,
                receiver_id TEXT,
                content_text TEXT,
                message_type TEXT,
                timestamp INTEGER,
                direction TEXT NOT NULL,
                is_recalled INTEGER NOT NULL DEFAULT 0,
                source_db TEXT NOT NULL,
                PRIMARY KEY (owner_id, message_id)
            );

            CREATE INDEX IF NOT EXISTS idx_message_index_time
                ON message_index(owner_id, timestamp DESC);

            CREATE INDEX IF NOT EXISTS idx_message_index_thread
                ON message_index(owner_id, thread_id, timestamp DESC);

            -- Used only when splitPerConversation=false.
            CREATE TABLE IF NOT EXISTS messages (
                owner_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                sender_id TEXT,
                receiver_id TEXT,
                content_json TEXT,
                content_text TEXT,
                message_type TEXT,
                timestamp INTEGER,
                direction TEXT NOT NULL,
                is_recalled INTEGER NOT NULL DEFAULT 0,
                recalled_at INTEGER,
                raw_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, message_id)
            );

            CREATE INDEX IF NOT EXISTS idx_messages_thread_time
                ON messages(owner_id, thread_id, timestamp DESC);

            CREATE TABLE IF NOT EXISTS raw_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'processed',
                created_at INTEGER NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
                owner_id UNINDEXED,
                message_id UNINDEXED,
                thread_id UNINDEXED,
                content,
                tokenize='unicode61'
            );
        `);
    }

    private migrateConversation(
        db: DatabaseSync,
        ownerId: string,
        threadId: string,
        threadType: number,
    ): void {
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS conversation (
                owner_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, thread_id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                owner_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                thread_type INTEGER NOT NULL DEFAULT 0,
                sender_id TEXT,
                receiver_id TEXT,
                content_json TEXT,
                content_text TEXT,
                message_type TEXT,
                timestamp INTEGER,
                direction TEXT NOT NULL,
                is_recalled INTEGER NOT NULL DEFAULT 0,
                recalled_at INTEGER,
                raw_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (owner_id, message_id)
            );

            CREATE INDEX IF NOT EXISTS idx_messages_time
                ON messages(timestamp DESC);

            CREATE INDEX IF NOT EXISTS idx_messages_sender
                ON messages(sender_id, timestamp DESC);

            CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                user_id TEXT,
                reaction TEXT,
                raw_json TEXT,
                created_at INTEGER NOT NULL
            );
        `);

        const now = Date.now();
        db.prepare(`
            INSERT INTO conversation(owner_id,thread_id,thread_type,created_at,updated_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(owner_id,thread_id)
            DO UPDATE SET updated_at=excluded.updated_at
        `).run(ownerId, threadId, threadType, now, now);
    }

    close(): void {
        for (const db of this.conversationDbs.values()) {
            try { db.close(); } catch {}
        }
        this.conversationDbs.clear();

        try { this.indexDb?.close(); } catch {}
        this.indexDb = null;
    }

    getDataRoot(ownerId: string): string {
        return getOwnerDataRoot(this.config, ownerId);
    }
}
