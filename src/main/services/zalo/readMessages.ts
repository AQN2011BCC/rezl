import { createDatabaseManager } from "./database/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ZALO_READ_MESSAGES");

export async function readMessages(
    ownerId: string,
    threadId: string,
    limit = 100,
    before?: number,
) {
    const { config, db } = await createDatabaseManager();

    if (!config.database.enabled || !config.history.enabled) {
        throw new Error("Database/history is disabled in config.");
    }

    const repository = db.getConversationDatabase(ownerId, threadId, 0);
    if (!repository) return [];

    const n = Math.max(1, Math.min(1000, Math.floor(limit)));

    const rows = before
        ? repository.prepare(`
            SELECT * FROM messages
            WHERE owner_id=? AND timestamp < ?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(ownerId, before, n)
        : repository.prepare(`
            SELECT * FROM messages
            WHERE owner_id=?
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(ownerId, n);

    return rows as any[];
}

export async function searchMessages(
    ownerId: string,
    query: string,
    limit = 50,
    threadId?: string,
) {
    const { config, db } = await createDatabaseManager();

    if (!config.database.enabled || !config.history.searchIndex) return [];

    const index = db.getIndexDatabase(ownerId);
    if (!index) return [];

    const n = Math.max(1, Math.min(1000, Math.floor(limit)));

    try {
        return (threadId
            ? index.prepare(`
                SELECT mi.*,
                       snippet(message_fts,3,'','', '…', 12) AS snippet
                FROM message_fts
                JOIN message_index mi
                  ON mi.owner_id=message_fts.owner_id
                 AND mi.message_id=message_fts.message_id
                WHERE message_fts.owner_id=?
                  AND message_fts MATCH ?
                  AND mi.thread_id=?
                ORDER BY mi.timestamp DESC
                LIMIT ?
            `).all(ownerId, query, threadId, n)
            : index.prepare(`
                SELECT mi.*,
                       snippet(message_fts,3,'','', '…', 12) AS snippet
                FROM message_fts
                JOIN message_index mi
                  ON mi.owner_id=message_fts.owner_id
                 AND mi.message_id=message_fts.message_id
                WHERE message_fts.owner_id=?
                  AND message_fts MATCH ?
                ORDER BY mi.timestamp DESC
                LIMIT ?
            `).all(ownerId, query, n)) as any[];
    } catch (error) {
        log.warn(`FTS search failed: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}

export function showMessages(messages: any[]): void {
    for (const message of messages) {
        let content = message.content_json;
        try { content = JSON.parse(content); } catch {}

        console.log({
            messageId: message.message_id,
            threadId: message.thread_id,
            senderId: message.sender_id,
            receiverId: message.receiver_id,
            messageType: message.message_type,
            timestamp: message.timestamp,
            direction: message.direction,
            isRecalled: Boolean(message.is_recalled),
            content,
        });
    }
}

async function cli() {
    const [, , command = "read", ownerId, threadIdOrQuery, limitArg] = process.argv;

    if (!ownerId || !threadIdOrQuery) {
        log.info("Usage:");
        log.info("  npx tsx src/main/services/zalo/readMessages.ts read <ownerId> <threadId> [limit]");
        log.info("  npx tsx src/main/services/zalo/readMessages.ts search <ownerId> <query> [limit]");
        return;
    }

    if (command === "search") {
        const rows = await searchMessages(
            ownerId,
            threadIdOrQuery,
            Number(limitArg ?? 50),
        );
        showMessages(rows);
        return;
    }

    const rows = await readMessages(
        ownerId,
        threadIdOrQuery,
        Number(limitArg ?? 100),
    );

    showMessages(rows);
    log.info(`read ${rows.length} messages`);
}

const invokedFile = process.argv[1] ?? "";
if (invokedFile.includes("readMessages")) {
    cli().catch((error) => {
        log.error("failed", error);
        process.exitCode = 1;
    });
}
