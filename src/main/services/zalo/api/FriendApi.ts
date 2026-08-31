import path from "node:path";
import type { AppConfig } from "../config/AppConfig.js";
import { getTempRoot } from "../config/AppConfig.js";
import { ContactRepository } from "../storage/repositories/ContactRepository.js";
import { ZaloGateway } from "../Gateway.js";
import { JsonStore } from "../storage/JsonStore.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("ZALO_SERVICE:FriendApi");

export interface FriendListFile {
    updatedAt: number;
    ownerId: string;
    count: number;
    friends: any[];
}

export class FriendApi {
    constructor(
        private readonly config: AppConfig,
        private readonly gateway: ZaloGateway,
        private readonly contacts: ContactRepository,
    ) {}

    private store(ownerId: string) {
        return new JsonStore<FriendListFile>(
            path.join(getTempRoot(this.config), `FriendList-${ownerId}.json`),
            { updatedAt: 0, ownerId, count: 0, friends: [] },
        );
    }

    async syncAndSaveFriends(api: any, ownerId: string): Promise<any[]> {
        const rawFriends = await this.gateway.syncFriends(api, ownerId);

        let friends = rawFriends;
        const dbFriends = this.contacts.listFriends(ownerId);
        if (dbFriends.length) friends = dbFriends;

        await this.store(ownerId).write({
            updatedAt: Date.now(),
            ownerId,
            count: friends.length,
            friends,
        });

        return friends;
    }

    async readFriends(ownerId: string): Promise<FriendListFile> {
        return this.store(ownerId).read();
    }

    async syncRequests(api: any, ownerId: string): Promise<void> {
        const [incoming, outgoing] = await Promise.all([
            this.getPendingRequests(api, ownerId),
            this.getSentRequests(api, ownerId),
        ]);

        this.contacts.saveFriendRequests(ownerId, "incoming", incoming);
        this.contacts.saveFriendRequests(ownerId, "outgoing", outgoing);

        log.info(
            `friend requests synced: incoming=${incoming.length}, outgoing=${outgoing.length}`,
        );
    }

    async getPendingRequests(api: any, ownerId: string): Promise<any[]> {
        return this.gateway.getPendingFriendRequests(api, ownerId);
    }

    async getSentRequests(api: any, ownerId: string): Promise<any[]> {
        return this.gateway.getSentFriendRequests(api, ownerId);
    }

    async getRecommendations(api: any, ownerId: string): Promise<any[]> {
        return this.gateway.getFriendRecommendations(api, ownerId);
    }

    async sendFriendRequest(
        api: any,
        userId: string,
        message = "Hi, let's be friends!",
    ) {
        if (typeof api.sendFriendRequest !== "function") {
            throw new Error("zca-js does not provide sendFriendRequest.");
        }
        return api.sendFriendRequest(message, userId);
    }

    async acceptFriend(api: any, userId: string) {
        return callRequired(api, ["acceptFriendRequest"], userId);
    }

    async rejectFriend(api: any, userId: string) {
        return callRequired(api, ["rejectFriendRequest", "rejectFriend"], userId);
    }

    async cancelFriendRequest(api: any, userId: string) {
        return callRequired(api, ["undoFriendRequest", "cancelFriendRequest"], userId);
    }

    async removeFriend(api: any, userId: string) {
        return callRequired(api, ["removeFriend"], userId);
    }
}

function callRequired(api: any, methods: string[], ...args: any[]) {
    for (const name of methods) {
        if (typeof api?.[name] === "function") return api[name](...args);
    }
    throw new Error(`zca-js does not provide: ${methods.join(", ")}`);
}
