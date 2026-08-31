import type { rezlApi } from "../services/zalo/api/rezlApi.js";

export type RezlIpcCommand =
    | { method: "getStatus" }
    | { method: "getOwnerId" }
    | { method: "getFriends" }
    | { method: "getFriendRequests" }
    | { method: "getRecommendations" }
    | { method: "getGroups" }
    | { method: "getGroup"; args: [string] }
    | { method: "getMessages"; args: [string, number?, number?] }
    | { method: "searchMessages"; args: [string, number?, string?] }
    | { method: "sendText"; args: [string, string, number?] }
    | { method: "sendMessage"; args: [string, Record<string, unknown>, number?] }
    | { method: "getUserInfo"; args: [string | string[]] }
    | { method: "callHealth" }
    | { method: "callTest" }
    | { method: "makeCall"; args: [any, boolean?] }
    | { method: "answerCall"; args: [any, boolean?] }
    | { method: "stopCall" };

const ALLOWED = new Set<keyof rezlApi>([
    "getOwnerId", "getStatus", "getFriends", "getFriendRequests", "getRecommendations",
    "getGroups", "getGroup", "getMessages", "searchMessages", "sendText", "sendMessage",
    "getUserInfo", "callHealth", "callTest", "makeCall", "answerCall", "stopCall",
]);

export function createRezlIpcRouter(api: rezlApi) {
    return async (command: RezlIpcCommand): Promise<unknown> => {
        if (!command || typeof command.method !== "string") throw new Error("Invalid IPC command.");
        if (!ALLOWED.has(command.method as keyof rezlApi)) throw new Error(`IPC method not allowed: ${command.method}`);
        const fn = (api as any)[command.method];
        if (typeof fn !== "function") throw new Error(`API method unavailable: ${command.method}`);
        return await fn.apply(api, "args" in command ? command.args : []);
    };
}
