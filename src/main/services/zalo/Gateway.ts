import type { AppConfig } from "./config/AppConfig.js";
import { ContactRepository } from "./storage/repositories/ContactRepository.js";
import { ChatRepository } from "./storage/repositories/ChatRepository.js";
import { CircuitBreaker, TTLCache, withRetry } from "./Resilience.js";

export class ZaloGateway {
    private readonly breakers = new Map<string, CircuitBreaker>();
    private readonly userCaches = new Map<string, TTLCache<any>>();
    private readonly groupCaches = new Map<string, TTLCache<any>>();

    constructor(
        private readonly config: AppConfig,
        private readonly contacts: ContactRepository,
        private readonly chats: ChatRepository,
    ) {}

    private breaker(accountId: string): CircuitBreaker {
        let breaker = this.breakers.get(accountId);
        if (!breaker) {
            breaker = new CircuitBreaker(
                this.config.resilience.circuitFailureThreshold,
                this.config.resilience.circuitCooldownMs,
            );
            this.breakers.set(accountId, breaker);
        }
        return breaker;
    }

    private cache(
        map: Map<string, TTLCache<any>>,
        accountId: string,
        ttl: number,
    ): TTLCache<any> {
        let cache = map.get(accountId);
        if (!cache) {
            cache = new TTLCache<any>(ttl);
            map.set(accountId, cache);
        }
        return cache;
    }

    private userCache(accountId: string) {
        return this.cache(
            this.userCaches,
            accountId,
            this.config.cache.userTtlMs,
        );
    }

    private groupCache(accountId: string) {
        return this.cache(
            this.groupCaches,
            accountId,
            this.config.cache.groupTtlMs,
        );
    }

    private async call<T>(
        accountId: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        return this.breaker(accountId).execute(() =>
            withRetry(
                async () => {
                    let timer: NodeJS.Timeout | undefined;
                    try {
                        const timeout = new Promise<never>((_, reject) => {
                            timer = setTimeout(
                                () => reject(new Error("Zalo request timeout")),
                                this.config.resilience.timeoutMs,
                            );
                        });

                        return await Promise.race([operation(), timeout]);
                    } finally {
                        if (timer) clearTimeout(timer);
                    }
                },
                this.config.resilience.retries,
                this.config.resilience.retryDelayMs,
            ),
        );
    }

    async getUserInfo(api: any, ownerId: string, userIds: string | string[]): Promise<any> {
        const ids = Array.isArray(userIds) ? userIds : [userIds];

        if (!this.config.cache.enabled) {
            const response = await this.call(ownerId, () => api.getUserInfo(ids));
            const profiles = Object.values(response?.changed_profiles ?? {}) as any[];
            this.contacts.upsertUsers(ownerId, profiles);
            return Array.isArray(userIds) ? profiles : profiles[0] ?? null;
        }

        const cache = this.userCache(ownerId);
        const missing = ids.filter((id) => !cache.get(id));

        if (missing.length) {
            const response = await this.call(ownerId, () => api.getUserInfo(missing));
            const profiles = Object.values(response?.changed_profiles ?? {}) as any[];

            for (const profile of profiles) {
                const id = String(profile?.userId ?? "");
                if (id) cache.set(id, profile);
            }

            this.contacts.upsertUsers(ownerId, profiles);
        }

        const result = ids.map((id) => cache.get(id)).filter(Boolean);
        return Array.isArray(userIds) ? result : result[0] ?? null;
    }

    async syncFriends(api: any, ownerId: string): Promise<any[]> {
        if (!this.config.sync.enabled || !this.config.sync.friendsOnLogin) return [];
        if (typeof api.getAllFriends !== "function") return [];

        const result = await this.call(ownerId, () => api.getAllFriends());
        const friends = Array.isArray(result)
            ? result
            : Object.values(result?.friends ?? result?.data ?? {});

        this.contacts.upsertUsers(ownerId, friends as any[]);
        this.contacts.replaceFriends(ownerId, friends as any[]);

        return friends as any[];
    }

    async getPendingFriendRequests(api: any, ownerId: string): Promise<any[]> {
        const fn = firstMethod(api, [
            "getPendingFriendRequests",
            "getReceivedFriendRequests",
            "getFriendRequests",
        ]);
        if (!fn) return [];

        const result = await this.call(ownerId, () => fn());
        return normalizeArray(result);
    }

    async getSentFriendRequests(api: any, ownerId: string): Promise<any[]> {
        const fn = firstMethod(api, [
            "getSentFriendRequests",
            "getSentFriendRequest",
        ]);
        if (!fn) return [];

        const result = await this.call(ownerId, () => fn());
        return normalizeArray(result);
    }

    async getFriendRecommendations(api: any, ownerId: string): Promise<any[]> {
        const fn = firstMethod(api, ["getFriendRecommendations"]);
        if (!fn) return [];

        const result = await this.call(ownerId, () => fn());
        return (
            result?.recommItems ??
            result?.data?.recomItems ??
            normalizeArray(result)
        );
    }

    async getAllGroups(api: any, ownerId: string): Promise<any[]> {
        if (typeof api.getAllGroups !== "function") return [];

        const result = await this.call(ownerId, () => api.getAllGroups());
        const groups = normalizeGroups(result);

        if (this.config.cache.enabled) {
            const cache = this.groupCache(ownerId);
            for (const group of groups) {
                const id = String(group?.groupId ?? group?.groupID ?? "");
                if (id) cache.set(id, group);
            }
        }

        return groups;
    }

    async getGroupInfo(api: any, ownerId: string, groupId: string): Promise<any> {
        if (this.config.cache.enabled) {
            const hit = this.groupCache(ownerId).get(groupId);
            if (hit) return hit;
        }

        if (typeof api.getGroupInfo !== "function") {
            throw new Error("zca-js does not provide getGroupInfo.");
        }

        const result = await this.call(ownerId, () => api.getGroupInfo(groupId));
        if (this.config.cache.enabled) this.groupCache(ownerId).set(groupId, result);
        this.saveGroups(ownerId, [result]);
        return result;
    }

    saveGroups(ownerId: string, groups: any[]): void {
        // Group persistence is intentionally kept in the index database through
        // the ContactRepository's DB connection. Avoids another DB manager layer.
        const db = this.contacts.getDatabase();
        if (!db) return;

        const upsert = db.prepare(`
            INSERT INTO groups(owner_id,group_id,name,avatar,raw_json,updated_at)
            VALUES(?,?,?,?,?,?)
            ON CONFLICT(owner_id,group_id) DO UPDATE SET
                name=excluded.name,
                avatar=excluded.avatar,
                raw_json=excluded.raw_json,
                updated_at=excluded.updated_at
        `);

        const memberUpsert = db.prepare(`
            INSERT INTO group_members(
                owner_id,group_id,user_id,role,raw_json,updated_at
            ) VALUES(?,?,?,?,?,?)
            ON CONFLICT(owner_id,group_id,user_id) DO UPDATE SET
                role=excluded.role,
                raw_json=excluded.raw_json,
                updated_at=excluded.updated_at
        `);

        const now = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const group of groups ?? []) {
                const info = unwrapGroup(group);
                const groupId = String(
                    info?.groupId ??
                    info?.groupID ??
                    info?.id ??
                    "",
                );
                if (!groupId) continue;

                upsert.run(
                    ownerId,
                    groupId,
                    info?.name ?? "",
                    info?.avt ?? info?.avatar ?? info?.fullAvt ?? "",
                    safeJson(group),
                    now,
                );

                const members = [
                    ...(info?.members ?? []),
                    ...(info?.participants ?? []),
                    ...(info?.currentMems ?? []),
                ];

                for (const member of members) {
                    const userId = String(
                        member?.userId ??
                        member?.uid ??
                        member?.id ??
                        member,
                    );
                    if (!userId) continue;

                    const role =
                        member?.isAdmin ? "admin" :
                        member?.isOwner ? "owner" :
                        member?.role ?? null;

                    memberUpsert.run(
                        ownerId,
                        groupId,
                        userId,
                        role,
                        safeJson(member),
                        now,
                    );
                }
            }
            db.exec("COMMIT");
        } catch (error) {
            try { db.exec("ROLLBACK"); } catch {}
            throw error;
        }
    }
}

function firstMethod(api: any, names: string[]): (() => Promise<any>) | null {
    for (const name of names) {
        if (typeof api?.[name] === "function") {
            return () => api[name]();
        }
    }
    return null;
}

function normalizeArray(result: any): any[] {
    if (Array.isArray(result)) return result;
    return Object.values(
        result?.data ??
        result?.requests ??
        result?.items ??
        result?.friends ??
        {},
    );
}

function normalizeGroups(result: any): any[] {
    if (Array.isArray(result)) return result;
    return Object.values(
        result?.gridInfoMap ??
        result?.groups ??
        result?.data ??
        {},
    );
}

function unwrapGroup(group: any): any {
    if (group?.gridInfoMap && typeof group.gridInfoMap === "object") {
        const first = Object.values(group.gridInfoMap)[0];
        return first ?? group;
    }
    return group;
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
