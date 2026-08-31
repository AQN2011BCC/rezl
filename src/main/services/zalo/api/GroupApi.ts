import type { AppConfig } from "../config/AppConfig.js";
import { ZaloGateway } from "../Gateway.js";
import { ContactRepository } from "../storage/repositories/ContactRepository.js";

export interface GroupSummary {
    groupId: string;
    name: string;
    avatar?: string;
    raw: unknown;
}

export class GroupApi {
    constructor(
        private readonly config: AppConfig,
        private readonly gateway: ZaloGateway,
        private readonly contacts: ContactRepository,
    ) {}

    async list(api: any, ownerId: string): Promise<any[]> {
        return this.gateway.getAllGroups(api, ownerId);
    }

    async syncGroups(api: any, ownerId: string): Promise<any[]> {
        const groups = await this.list(api, ownerId);
        this.gateway.saveGroups(ownerId, groups);
        return groups;
    }

    async getInfo(api: any, ownerId: string, groupId: string): Promise<any> {
        return this.gateway.getGroupInfo(api, ownerId, groupId);
    }

    async create(
        api: any,
        ownerId: string,
        name: string,
        memberIds: string[] = [],
    ): Promise<any> {
        const result = await callFirst(
            api,
            ["createGroup"],
            name,
            memberIds,
        );
        await this.refreshOne(api, ownerId, result);
        return result;
    }

    async addMembers(
        api: any,
        ownerId: string,
        groupId: string,
        userIds: string[],
    ): Promise<any> {
        const result = await callFirst(
            api,
            ["addUserToGroup", "inviteUserToGroups"],
            groupId,
            userIds,
        );
        await this.refreshOne(api, ownerId, groupId);
        return result;
    }

    async removeMembers(
        api: any,
        ownerId: string,
        groupId: string,
        userIds: string[],
    ): Promise<any> {
        const result = await callFirst(
            api,
            ["removeUserFromGroup", "kickUserFromGroup"],
            groupId,
            userIds,
        );
        await this.refreshOne(api, ownerId, groupId);
        return result;
    }

    async promoteAdmins(api: any, groupId: string, userIds: string[]): Promise<any> {
        return callFirst(api, ["addGroupAdmin", "promoteAdmin"], groupId, userIds);
    }

    async demoteAdmins(api: any, groupId: string, userIds: string[]): Promise<any> {
        return callFirst(api, ["removeGroupAdmin", "demoteAdmin"], groupId, userIds);
    }

    async changeName(
        api: any,
        ownerId: string,
        groupId: string,
        name: string,
    ): Promise<any> {
        const result = await callFirst(
            api,
            ["changeGroupName", "changeGroupSubject"],
            groupId,
            name,
        );
        await this.refreshOne(api, ownerId, groupId);
        return result;
    }

    async changeOwner(
        api: any,
        ownerId: string,
        groupId: string,
        newOwnerId: string,
    ): Promise<any> {
        const result = await callFirst(
            api,
            ["changeGroupOwner", "changeOwner"],
            groupId,
            newOwnerId,
        );
        await this.refreshOne(api, ownerId, groupId);
        return result;
    }

    async leave(api: any, groupId: string): Promise<any> {
        return callFirst(api, ["leaveGroup"], groupId);
    }

    async getAdmins(api: any, groupId: string): Promise<any> {
        return callFirst(api, ["getGroupAdmins"], groupId);
    }

    async getInviteLink(api: any, groupId: string): Promise<any> {
        return callFirst(api, ["getGroupInviteLink"], groupId);
    }

    async revokeInviteLink(api: any, groupId: string): Promise<any> {
        return callFirst(api, ["revokeGroupInviteLink", "groupRevokeInvite"], groupId);
    }

    async acceptInvite(api: any, inviteCode: string): Promise<any> {
        return callFirst(api, ["acceptGroupInvite", "groupAcceptInvite"], inviteCode);
    }

    private async refreshOne(api: any, ownerId: string, value: any): Promise<void> {
        const groupId = typeof value === "string"
            ? value
            : String(value?.groupId ?? value?.groupID ?? value?.threadId ?? "");

        if (!groupId || typeof api.getGroupInfo !== "function") return;

        try {
            const info = await api.getGroupInfo(groupId);
            this.gateway.saveGroups(ownerId, [info]);
        } catch {
            // The mutation itself succeeded; refresh is best-effort.
        }
    }
}

async function callFirst(
    api: any,
    methods: string[],
    ...args: any[]
): Promise<any> {
    for (const name of methods) {
        if (typeof api?.[name] === "function") {
            return api[name](...args);
        }
    }

    throw new Error(
        `zca-js does not expose any compatible method: ${methods.join(", ")}`,
    );
}
