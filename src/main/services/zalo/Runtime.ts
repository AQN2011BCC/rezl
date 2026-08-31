import type { AppConfig } from "./config/AppConfig.js";
import type { DatabaseManager } from "./database/DatabaseManager.js";
import { ContactRepository } from "./storage/repositories/ContactRepository.js";
import { ChatRepository } from "./storage/repositories/ChatRepository.js";
import { FriendApi } from "./api/FriendApi.js";
import { ChatApi } from "./api/ChatApi.js";
import { GroupApi } from "./api/GroupApi.js";
import { CallApi } from "./api/CallApi.js";
import { ZaloEventProcessor } from "./EventProcessor.js";
import { ZaloGateway } from "./Gateway.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ZALO_SERVICE:Runtime");

export class ZaloRuntime {
    public readonly contacts: ContactRepository;
    public readonly chats: ChatRepository;
    public readonly gateway: ZaloGateway;
    public readonly events: ZaloEventProcessor;
    public readonly friends: FriendApi;
    public readonly chat: ChatApi;
    public readonly groups: GroupApi;
    public readonly calls: CallApi;

    private started = false;

    constructor(
        private readonly config: AppConfig,
        private readonly db: DatabaseManager,
    ) {
        this.contacts = new ContactRepository(
            () => this.db.getIndexDatabase("default"),
        );

        this.chats = new ChatRepository(
            () => this.db.getIndexDatabase("default"),
            (ownerId, threadId, threadType) =>
                this.db.getConversationDatabase(ownerId, threadId, threadType),
            this.config,
        );

        this.gateway = new ZaloGateway(
            this.config,
            this.contacts,
            this.chats,
        );

        this.events = new ZaloEventProcessor(this.config, this.chats);

        this.friends = new FriendApi(
            this.config,
            this.gateway,
            this.contacts,
        );

        this.chat = new ChatApi(
            this.config,
            this.gateway,
            this.chats,
            this.events,
        );

        this.groups = new GroupApi(
            this.config,
            this.gateway,
            this.contacts,
        );

        this.calls = new CallApi(this.config);
    }

    async start(api: any, ownerId: string): Promise<void> {
        if (this.started) return;
        if (!api?.listener) throw new Error("api.listener does not exist.");

        log.info(`starting post-login runtime for owner=${ownerId}`);

        if (this.config.database.enabled) {
            this.db.ensureOpen(ownerId);
        }

        this.attachSilentListeners(api, ownerId);

        if (this.config.call.enabled && this.calls.health().supported) {
            try {
                this.calls.startEventPolling(this.config.call.eventPollIntervalMs);
            } catch (error) {
                log.error("native call engine unavailable", error);
            }
        }
        this.started = true;

        setTimeout(() => {
            void this.runBackgroundSync(api, ownerId);
        }, 1000);
    }

    private attachSilentListeners(api: any, ownerId: string): void {
        const listener = api.listener;
        const marker = "__REZL_ZALO_SERVICE_ATTACHED_V2__";

        if ((listener as any)[marker]) return;

        Object.defineProperty(listener, marker, {
            value: true,
            enumerable: false,
            configurable: false,
        });

        listener.on("message", (event: any) => {
            try { this.events.onMessage(ownerId, event); }
            catch (error) { log.error("message pipeline failed", error); }
        });

        listener.on("old_messages", (events: any) => {
            try {
                if (!Array.isArray(events)) return;
                for (const event of events) this.events.onMessage(ownerId, event);
            } catch (error) {
                log.error("history pipeline failed", error);
            }
        });

        listener.on("undo", (event: any) => {
            try { this.events.onUndo(ownerId, event); }
            catch (error) { log.error("undo pipeline failed", error); }
        });

        listener.on("reaction", (event: any) => {
            try { this.events.onReaction(ownerId, event); }
            catch (error) { log.error("reaction pipeline failed", error); }
        });

        if (this.config.database.enabled && this.config.history.saveRawEvents) {
            for (const type of ["group_event", "friend_event", "typing"]) {
                listener.on(type, (event: any) =>
                    this.events.onRawEvent(ownerId, type, event),
                );
            }
        }

        listener.on("connected", () => log.info("socket connected"));
        listener.on("reconnecting", () => log.info("socket reconnecting"));
        listener.on("closed", () => log.info("socket closed"));
        listener.on("error", (error: any) => log.error("socket error", error));

        const readyState = listener?.ws?.readyState ?? 3;
        if (readyState !== 0 && readyState !== 1) {
            if (typeof listener.start === "function") {
                listener.start({ retryOnClose: true });
            }
        }
    }

    private async runBackgroundSync(api: any, ownerId: string): Promise<void> {
        if (!this.config.sync.enabled) return;

        if (this.config.sync.friendsOnLogin) {
            try {
                const friends = await this.friends.syncAndSaveFriends(api, ownerId);
                log.info(`friend sync completed (${friends.length})`);
            } catch (error) {
                log.error("friend sync failed", error);
            }
        }

        if (this.config.sync.friendRequestsOnLogin) {
            try {
                await this.friends.syncRequests(api, ownerId);
            } catch (error) {
                log.error("friend request sync failed", error);
            }
        }

        if (this.config.sync.groupsOnLogin) {
            try {
                await this.groups.syncGroups(api, ownerId);
            } catch (error) {
                log.error("group sync failed", error);
            }
        }
    }
}
