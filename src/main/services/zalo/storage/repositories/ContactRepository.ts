import type { DatabaseSync } from "node:sqlite";

export class ContactRepository {
    constructor(private readonly getDb: () => DatabaseSync | null) {}

    getDatabase(): DatabaseSync | null {
        return this.getDb();
    }

    upsertUsers(ownerId: string, profiles: any[]): void {
        const db = this.getDb();
        if (!db || !Array.isArray(profiles) || !profiles.length) return;

        const stmt = db.prepare(`
            INSERT INTO users(owner_id,user_id,display_name,avatar,raw_json,updated_at)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(owner_id,user_id) DO UPDATE SET
                display_name=excluded.display_name,
                avatar=excluded.avatar,
                raw_json=excluded.raw_json,
                updated_at=excluded.updated_at
        `);

        const now = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const p of profiles) {
                const userId = String(p?.userId ?? p?.uid ?? p?.id ?? "");
                if (!userId) continue;
                stmt.run(
                    ownerId,
                    userId,
                    p?.displayName ?? p?.name ?? p?.zaloName ?? "",
                    p?.avatar ?? p?.avt ?? p?.fullAvt ?? p?.picture ?? "",
                    safeJson(p),
                    now,
                );
            }
            db.exec("COMMIT");
        } catch (error) {
            try { db.exec("ROLLBACK"); } catch {}
            throw error;
        }
    }

    replaceFriends(ownerId: string, friends: any[]): void {
        const db = this.getDb();
        if (!db) return;

        const stmt = db.prepare(`
            INSERT INTO friends(owner_id,user_id,status,raw_json,updated_at)
            VALUES(?,?,?,?,?)
            ON CONFLICT(owner_id,user_id) DO UPDATE SET
                status=excluded.status,
                raw_json=excluded.raw_json,
                updated_at=excluded.updated_at
        `);

        const now = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const friend of friends ?? []) {
                const userId = String(friend?.userId ?? friend?.uid ?? friend?.id ?? "");
                if (!userId) continue;
                stmt.run(ownerId, userId, "friend", safeJson(friend), now);
            }
            db.exec("COMMIT");
        } catch (error) {
            try { db.exec("ROLLBACK"); } catch {}
            throw error;
        }
    }

    saveFriendRequests(
        ownerId: string,
        direction: "incoming" | "outgoing",
        requests: any[],
    ): void {
        const db = this.getDb();
        if (!db) return;

        const stmt = db.prepare(`
            INSERT INTO friend_requests(
                owner_id,user_id,direction,name,avatar,message,raw_json,updated_at
            ) VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(owner_id,user_id,direction) DO UPDATE SET
                name=excluded.name,
                avatar=excluded.avatar,
                message=excluded.message,
                raw_json=excluded.raw_json,
                updated_at=excluded.updated_at
        `);

        const now = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const item of requests ?? []) {
                const userId = String(
                    item?.userId ??
                    item?.uid ??
                    item?.senderId ??
                    item?.fromUid ??
                    item?.id ??
                    "",
                );
                if (!userId) continue;

                stmt.run(
                    ownerId,
                    userId,
                    direction,
                    item?.displayName ?? item?.name ?? item?.zaloName ?? "",
                    item?.avatar ?? item?.avt ?? item?.fullAvt ?? "",
                    item?.message ?? item?.msg ?? "",
                    safeJson(item),
                    now,
                );
            }
            db.exec("COMMIT");
        } catch (error) {
            try { db.exec("ROLLBACK"); } catch {}
            throw error;
        }
    }

    listFriends(ownerId: string): any[] {
        const db = this.getDb();
        if (!db) return [];

        return db.prepare(`
            SELECT
                f.owner_id AS ownerId,
                f.user_id AS userId,
                f.status,
                COALESCE(u.display_name,'') AS displayName,
                COALESCE(u.avatar,'') AS avatar,
                f.raw_json AS rawJson
            FROM friends f
            LEFT JOIN users u
                ON u.owner_id=f.owner_id AND u.user_id=f.user_id
            WHERE f.owner_id=?
            ORDER BY COALESCE(u.display_name,f.user_id) COLLATE NOCASE
        `).all(ownerId) as any[];
    }

    listFriendRequests(
        ownerId: string,
        direction: "incoming" | "outgoing",
    ): any[] {
        const db = this.getDb();
        if (!db) return [];

        return db.prepare(`
            SELECT * FROM friend_requests
            WHERE owner_id=? AND direction=?
            ORDER BY updated_at DESC
        `).all(ownerId, direction) as any[];
    }
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
        );
    } catch {
        return JSON.stringify({ value: String(value) });
    }
}
