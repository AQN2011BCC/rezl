import type { ZaloRuntime } from "../Runtime.js";
import type { ZCallConfig } from "../call/NativeZCall.js";

/** Public application facade. Renderer/Electron IPC should depend on this only. */
export class rezlApi {
    constructor(
        private readonly runtime: ZaloRuntime,
        private readonly api: any,
        private readonly ownerId: string,
    ) {}

    getOwnerId() { return this.ownerId; }
    getStatus() { return { ownerId: this.ownerId, started: true, call: this.runtime.calls.health() }; }

    getFriends() { return this.runtime.friends.readFriends(this.ownerId); }
    getFriendRequests() {
        return Promise.all([
            this.runtime.friends.getPendingRequests(this.api, this.ownerId),
            this.runtime.friends.getSentRequests(this.api, this.ownerId),
        ]).then(([incoming, outgoing]) => ({ incoming, outgoing }));
    }
    sendFriendRequest(userId: string, message?: string) { return this.runtime.friends.sendFriendRequest(this.api, userId, message); }
    acceptFriend(userId: string) { return this.runtime.friends.acceptFriend(this.api, userId); }
    rejectFriend(userId: string) { return this.runtime.friends.rejectFriend(this.api, userId); }
    cancelFriendRequest(userId: string) { return this.runtime.friends.cancelFriendRequest(this.api, userId); }
    removeFriend(userId: string) { return this.runtime.friends.removeFriend(this.api, userId); }
    getRecommendations() { return this.runtime.friends.getRecommendations(this.api, this.ownerId); }

    getGroups() { return this.runtime.groups.list(this.api, this.ownerId); }
    getGroup(groupId: string) { return this.runtime.groups.getInfo(this.api, this.ownerId, groupId); }
    createGroup(name: string, memberIds: string[] = []) { return this.runtime.groups.create(this.api, this.ownerId, name, memberIds); }
    addGroupMembers(groupId: string, userIds: string[]) { return this.runtime.groups.addMembers(this.api, this.ownerId, groupId, userIds); }
    removeGroupMembers(groupId: string, userIds: string[]) { return this.runtime.groups.removeMembers(this.api, this.ownerId, groupId, userIds); }
    promoteGroupAdmins(groupId: string, userIds: string[]) { return this.runtime.groups.promoteAdmins(this.api, groupId, userIds); }
    demoteGroupAdmins(groupId: string, userIds: string[]) { return this.runtime.groups.demoteAdmins(this.api, groupId, userIds); }
    changeGroupName(groupId: string, name: string) { return this.runtime.groups.changeName(this.api, this.ownerId, groupId, name); }
    changeGroupOwner(groupId: string, userId: string) { return this.runtime.groups.changeOwner(this.api, this.ownerId, groupId, userId); }
    leaveGroup(groupId: string) { return this.runtime.groups.leave(this.api, groupId); }
    getGroupAdmins(groupId: string) { return this.runtime.groups.getAdmins(this.api, groupId); }
    getGroupInviteLink(groupId: string) { return this.runtime.groups.getInviteLink(this.api, groupId); }
    revokeGroupInviteLink(groupId: string) { return this.runtime.groups.revokeInviteLink(this.api, groupId); }
    acceptGroupInvite(inviteCode: string) { return this.runtime.groups.acceptInvite(this.api, inviteCode); }

    getMessages(threadId: string, limit = 100, before?: number) { return this.runtime.chat.history(this.ownerId, threadId, limit, before); }
    searchMessages(query: string, limit = 50, threadId?: string) { return this.runtime.chat.search(this.ownerId, query, limit, threadId); }
    sendText(threadId: string, text: string, threadType = 0) { return this.runtime.chat.sendText(this.api, this.ownerId, threadId, text, threadType); }
    sendMessage(threadId: string, message: Record<string, unknown>, threadType = 0) { return this.runtime.chat.send(this.api, this.ownerId, threadId, message, threadType); }

    getUserInfo(userIds: string | string[]) { return this.runtime.gateway.getUserInfo(this.api, this.ownerId, userIds); }

    callHealth() { return this.runtime.calls.health(); }
    callTest() { return this.runtime.calls.test(); }
    configureCall(config: ZCallConfig, caller = true, video = true) { return this.runtime.calls.configure(config, caller, video); }
    makeCall(config: ZCallConfig, video = true) { return this.runtime.calls.makeCall(config, video); }
    answerCall(config: ZCallConfig, video = true) { return this.runtime.calls.answerCall(config, video); }
    stopCall() { return this.runtime.calls.stopCall(); }
    onCallEvent(listener: (event: unknown) => void) { return this.runtime.calls.onEvent(listener); }
    startCallEventPolling(intervalMs = 30) { return this.runtime.calls.startEventPolling(intervalMs); }
    stopCallEventPolling() { return this.runtime.calls.stopEventPolling(); }
    getCallControls() { return this.runtime.calls.controls(); }
}
