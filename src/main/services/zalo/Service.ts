import type { AppConfig } from "./config/AppConfig.js";
import { DatabaseManager } from "./database/DatabaseManager.js";
import { ContactRepository } from "./storage/repositories/ContactRepository.js";
import { ChatRepository } from "./storage/repositories/ChatRepository.js";
import { ZaloGateway } from "./Gateway.js";
import { ZaloEventProcessor } from "./EventProcessor.js";
import { FriendApi } from "./api/FriendApi.js";
import { ChatApi } from "./api/ChatApi.js";
import { GroupApi } from "./api/GroupApi.js";
import { CallApi } from "./api/CallApi.js";

/**
 * Thin dependency container kept for callers that do not use ZaloRuntime.
 * Runtime is the preferred entry point for the full application.
 */
export class ZaloService {
    readonly contacts: ContactRepository;
    readonly chats: ChatRepository;
    readonly gateway: ZaloGateway;
    readonly events: ZaloEventProcessor;
    readonly friends: FriendApi;
    readonly chat: ChatApi;
    readonly groups: GroupApi;
    readonly calls: CallApi;

    constructor(
        readonly config: AppConfig,
        readonly db: DatabaseManager,
    ) {
        this.contacts = new ContactRepository(
            () => db.getIndexDatabase("default"),
        );
        this.chats = new ChatRepository(
            () => db.getIndexDatabase("default"),
            (ownerId, threadId, threadType) =>
                db.getConversationDatabase(ownerId, threadId, threadType),
            config,
        );
        this.gateway = new ZaloGateway(config, this.contacts, this.chats);
        this.events = new ZaloEventProcessor(config, this.chats);
        this.friends = new FriendApi(config, this.gateway, this.contacts);
        this.chat = new ChatApi(config, this.gateway, this.chats, this.events);
        this.groups = new GroupApi(config, this.gateway, this.contacts);
        this.calls = new CallApi(config);
    }
}
