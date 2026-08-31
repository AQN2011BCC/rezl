import type { AppConfig } from "./config/AppConfig.js";
import { ChatRepository } from "./storage/repositories/ChatRepository.js";

export class ZaloEventProcessor {
    private readonly recentIds = new Set<string>();
    private readonly recentQueue: string[] = [];

    constructor(
        private readonly config: AppConfig,
        private readonly chats: ChatRepository,
    ) {}

    onMessage(ownerId: string, event: any): void {
        if (!this.config.database.enabled || !this.config.history.enabled) return;

        const isOutgoing = Boolean(event?.isSelf);
        if (!this.config.history.saveIncoming && !isOutgoing) return;
        if (!this.config.history.saveOutgoing && isOutgoing) return;

        const normalized = normalizeMessage(event, ownerId);
        if (!normalized) return;

        const key = `${ownerId}:${normalized.messageId}`;
        if (this.recentIds.has(key)) return;
        this.remember(key);

        this.chats.saveMessage(normalized);
    }

    onOutgoing(
        ownerId: string,
        event: any,
        threadId: string,
        threadType = 0,
    ): void {
        if (
            !this.config.database.enabled ||
            !this.config.history.enabled ||
            !this.config.history.saveOutgoing
        ) return;

        const messageId = String(
            event?.msgId ??
            event?.messageId ??
            event?.id ??
            `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );

        this.chats.saveMessage({
            ownerId,
            messageId,
            threadId: String(threadId),
            threadType,
            senderId: ownerId,
            receiverId: String(event?.uidTo ?? event?.toUid ?? ""),
            content: event?.content ?? event?.msg ?? null,
            messageType: String(event?.msgType ?? event?.type ?? "text"),
            timestamp: Number(event?.ts ?? event?.timestamp ?? Date.now()),
            direction: "outgoing",
            raw: event,
        });
    }

    /**
     * Zalo may emit an `undo` event after the original message has already
     * been persisted. We intentionally keep the original content and only
     * change the recalled flag in our local copy.
     */
    onUndo(ownerId: string, event: any): void {
        if (
            !this.config.database.enabled ||
            !this.config.history.enabled ||
            !this.config.history.preserveRecalledMessages
        ) return;

        const messageIds = extractMessageIds(event);
        for (const id of messageIds) {
            this.chats.markRecalled(ownerId, id, event);
        }

        if (this.config.history.saveRawEvents) {
            this.chats.saveRawEvent(ownerId, "undo", event);
        }
    }

    onReaction(ownerId: string, event: any): void {
        if (!this.config.database.enabled || !this.config.history.enabled) return;
        if (this.config.history.saveRawEvents) {
            this.chats.saveRawEvent(ownerId, "reaction", event);
        }
    }

    onRawEvent(ownerId: string, eventType: string, event: any): void {
        if (
            !this.config.database.enabled ||
            !this.config.history.enabled ||
            !this.config.history.saveRawEvents
        ) return;

        this.chats.saveRawEvent(ownerId, eventType, event);
    }

    private remember(key: string): void {
        this.recentIds.add(key);
        this.recentQueue.push(key);

        if (this.recentQueue.length > 2000) {
            const old = this.recentQueue.shift();
            if (old) this.recentIds.delete(old);
        }
    }
}

function normalizeMessage(event: any, ownerId: string) {
    const data = event?.data ?? event ?? {};

    const messageId = firstString(
        data?.msgId,
        data?.messageId,
        event?.msgId,
        event?.messageId,
        event?.id,
    );

    const threadId = firstString(
        event?.threadId,
        data?.threadId,
        data?.groupId,
        data?.idTo,
        data?.uidFrom,
        data?.fromUid,
        event?.groupId,
    );

    if (!messageId || !threadId) return null;

    const senderId = firstString(
        data?.uidFrom,
        data?.fromUid,
        data?.senderId,
        event?.uidFrom,
    );

    const receiverId = firstString(
        data?.uidTo,
        data?.toUid,
        data?.receiverId,
        event?.uidTo,
    );

    const timestamp = Number(
        data?.ts ??
        data?.timestamp ??
        event?.timestamp ??
        Date.now(),
    );

    const content =
        data?.msg ??
        data?.content ??
        data?.text ??
        event?.content ??
        event?.msg ??
        null;

    return {
        ownerId,
        messageId,
        threadId,
        threadType: Number(
            event?.threadType ??
            data?.threadType ??
            event?.type ??
            0,
        ),
        senderId,
        receiverId,
        content,
        messageType: String(
            data?.msgType ??
            data?.messageType ??
            event?.msgType ??
            "text",
        ),
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        direction: event?.isSelf || senderId === ownerId
            ? "outgoing"
            : "incoming",
        raw: event,
    } as const;
}

function extractMessageIds(event: any): string[] {
    const candidates = [
        event?.msgId,
        event?.messageId,
        event?.id,
        event?.data?.msgId,
        event?.data?.messageId,
        event?.data?.id,
        event?.data?.cliMsgId,
        event?.cliMsgId,
    ];

    const ids = candidates
        .flatMap((value) => Array.isArray(value) ? value : [value])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean);

    return [...new Set(ids)];
}

function firstString(...values: unknown[]): string {
    for (const value of values) {
        if (value === undefined || value === null) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return "";
}
