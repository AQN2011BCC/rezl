import type { AppConfig } from "../config/AppConfig.js";
import { ChatRepository } from "../storage/repositories/ChatRepository.js";
import { ZaloEventProcessor } from "../EventProcessor.js";
import { ZaloGateway } from "../Gateway.js";

export class ChatApi {
    constructor(
        private readonly config: AppConfig,
        private readonly gateway: ZaloGateway,
        private readonly chats: ChatRepository,
        private readonly events: ZaloEventProcessor,
    ) {}

    history(ownerId: string, threadId: string, limit = 100, before?: number) {
        if (!this.config.database.enabled || !this.config.history.enabled) return [];
        return this.chats.listMessages(ownerId, threadId, limit, before);
    }

    search(
        ownerId: string,
        query: string,
        limit = 50,
        threadId?: string,
    ) {
        if (
            !this.config.database.enabled ||
            !this.config.history.enabled ||
            !this.config.history.searchIndex
        ) return [];

        return this.chats.searchMessages(ownerId, query, limit, threadId);
    }

    async sendText(
        api: any,
        ownerId: string,
        threadId: string,
        text: string,
        threadType = 0,
    ) {
        const content = String(text ?? "").trim();
        if (!content) throw new Error("Message text cannot be empty.");
        if (!threadId) throw new Error("threadId is required.");
        if (typeof api?.sendMessage !== "function") {
            throw new Error("zca-js does not provide sendMessage.");
        }

        // zca-js v2 expects a message object, not a bare string.
        const result = await api.sendMessage(
            { msg: content },
            String(threadId),
            threadType,
        );

        this.events.onOutgoing(
            ownerId,
            {
                msgId: result?.msgId ?? result?.messageId,
                content,
                timestamp: Date.now(),
                uidTo: threadId,
            },
            threadId,
            threadType,
        );

        return result;
    }

    async send(
        api: any,
        ownerId: string,
        threadId: string,
        message: Record<string, unknown>,
        threadType = 0,
    ) {
        if (typeof api?.sendMessage !== "function") {
            throw new Error("zca-js does not provide sendMessage.");
        }

        const result = await api.sendMessage(
            message,
            String(threadId),
            threadType,
        );

        this.events.onOutgoing(
            ownerId,
            {
                ...message,
                msgId: result?.msgId ?? result?.messageId,
                timestamp: Date.now(),
                uidTo: threadId,
            },
            threadId,
            threadType,
        );

        return result;
    }
}
