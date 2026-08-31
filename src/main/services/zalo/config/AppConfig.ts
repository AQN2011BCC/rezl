import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// backend/src/main/services/zalo/config/AppConfig.ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "../../../../..");
export const TMP_DIR = path.join(ROOT_DIR, "tmp");
export const CONFIG_FILE = path.join(TMP_DIR, "config.json");

/**
 * Storage layout:
 *
 *   default:
 *   %LOCALAPPDATA%\Programs\rezl\<ownerId>\
 *     index.db
 *     chats\<threadId>.db
 *     attachments\
 *
 * Temporary files remain in backend/tmp by default.
 *
 * If you want the Windows temp folder and/or a custom database root,
 * edit the generated tmp/config.json. JSON itself cannot contain comments,
 * so the commented example below is intentionally kept in this source file:
 *
 * // "storage": {
 * //   "useWindowsTemp": true,
 * //   "databaseRoot": "D:\\RezLData"
 * // }
 *
 * `databaseRoot` may contain these tokens:
 *   {ownerId}  -> current Zalo owner id
 *   {app}      -> "rezl"
 *   {localAppData} -> %LOCALAPPDATA%
 */

export interface AppConfig {
    database: {
        enabled: boolean;
        journalMode: "WAL" | "DELETE";
        busyTimeoutMs: number;
        splitPerConversation: boolean;
        indexDatabaseName: string;
        conversationDirectoryName: string;
        databaseRoot: string;
    };
    storage: {
        useWindowsTemp: boolean;
        tempDirectory: string;
        attachmentsDirectoryName: string;
        avatarDirectoryName: string;
    };
    history: {
        enabled: boolean;
        saveIncoming: boolean;
        saveOutgoing: boolean;
        saveRawEvents: boolean;
        attachments: boolean;
        preserveRecalledMessages: boolean;
        searchIndex: boolean;
    };
    cache: {
        enabled: boolean;
        userTtlMs: number;
        groupTtlMs: number;
    };
    sync: {
        enabled: boolean;
        friendsOnLogin: boolean;
        groupsOnLogin: boolean;
        friendRequestsOnLogin: boolean;
    };
    call: {
        enabled: boolean;
        nativeModulePath: string;
        nativeRuntimePath: string;
        eventPollIntervalMs: number;
        clientVersion: number;
    };
    resilience: {
        timeoutMs: number;
        retries: number;
        retryDelayMs: number;
        circuitFailureThreshold: number;
        circuitCooldownMs: number;
    };
}

export const DEFAULT_CONFIG: AppConfig = {
    database: {
        enabled: true,
        journalMode: "WAL",
        busyTimeoutMs: 5000,
        splitPerConversation: true,
        indexDatabaseName: "index.db",
        conversationDirectoryName: "chats",
        databaseRoot: "",
    },
    storage: {
        useWindowsTemp: false,
        tempDirectory: "",
        attachmentsDirectoryName: "attachments",
        avatarDirectoryName: "avatars",
    },
    history: {
        enabled: true,
        saveIncoming: true,
        saveOutgoing: true,
        saveRawEvents: false,
        attachments: true,
        preserveRecalledMessages: true,
        searchIndex: true,
    },
    cache: {
        enabled: true,
        userTtlMs: 5 * 60_000,
        groupTtlMs: 5 * 60_000,
    },
    sync: {
        enabled: true,
        friendsOnLogin: true,
        groupsOnLogin: true,
        friendRequestsOnLogin: true,
    },
    call: {
        enabled: true,
        nativeModulePath: "",
        nativeRuntimePath: "",
        eventPollIntervalMs: 30,
        clientVersion: 0,
    },
    resilience: {
        timeoutMs: 20_000,
        retries: 2,
        retryDelayMs: 800,
        circuitFailureThreshold: 5,
        circuitCooldownMs: 30_000,
    },
};

export async function ensureConfig(): Promise<AppConfig> {
    await fs.mkdir(TMP_DIR, { recursive: true });

    try {
        const raw = await fs.readFile(CONFIG_FILE, "utf8");
        const user = JSON.parse(raw);
        const merged = deepMerge(DEFAULT_CONFIG, user) as AppConfig;
        await writeJsonAtomic(CONFIG_FILE, merged);
        return merged;
    } catch (error: any) {
        if (error?.code !== "ENOENT") {
            console.warn(`[ZALO_SERVICE:config] invalid config, recreating: ${error?.message ?? error}`);
        }
        const fresh = structuredClone(DEFAULT_CONFIG);
        await writeJsonAtomic(CONFIG_FILE, fresh);
        return fresh;
    }
}

export function getTempRoot(config: AppConfig): string {
    if (config.storage.tempDirectory.trim()) {
        return expandTokens(config.storage.tempDirectory, "");
    }

    if (config.storage.useWindowsTemp) {
        return process.env.TEMP || process.env.TMP || os.tmpdir();
    }

    return TMP_DIR;
}

export function getOwnerDataRoot(config: AppConfig, ownerId: string): string {
    const owner = sanitizePathSegment(ownerId);
    const configured = config.database.databaseRoot.trim();

    if (configured) {
        return expandTokens(configured, owner);
    }

    const localAppData =
        process.env.LOCALAPPDATA ||
        path.join(os.homedir(), "AppData", "Local");

    return path.join(localAppData, "Programs", "rezl", owner);
}

export function getConversationDbPath(
    config: AppConfig,
    ownerId: string,
    threadId: string,
): string {
    const root = getOwnerDataRoot(config, ownerId);
    const fileName = `${sanitizePathSegment(threadId)}.db`;

    if (!config.database.splitPerConversation) {
        return path.join(root, config.database.indexDatabaseName);
    }

    return path.join(root, config.database.conversationDirectoryName, fileName);
}

export function getIndexDbPath(config: AppConfig, ownerId: string): string {
    return path.join(
        getOwnerDataRoot(config, ownerId),
        config.database.indexDatabaseName,
    );
}

export function getAvatarRoot(config: AppConfig): string {
    return path.join(getTempRoot(config), config.storage.avatarDirectoryName);
}

export function getAttachmentRoot(config: AppConfig, ownerId: string): string {
    return path.join(
        getOwnerDataRoot(config, ownerId),
        config.storage.attachmentsDirectoryName,
    );
}

export function sanitizePathSegment(value: string): string {
    const cleaned = String(value)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/[. ]+$/g, "")
        .trim();

    return cleaned || "_";
}

function expandTokens(input: string, ownerId: string): string {
    const localAppData =
        process.env.LOCALAPPDATA ||
        path.join(os.homedir(), "AppData", "Local");

    return input
        .replace(/\{ownerId\}/gi, ownerId)
        .replace(/\{app\}/gi, "rezl")
        .replace(/\{localAppData\}/gi, localAppData);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    await fs.writeFile(
        tempPath,
        JSON.stringify(value, null, 2),
        { encoding: "utf8", flag: "w" },
    );

    try {
        await fs.rename(tempPath, filePath);
    } catch (error) {
        try { await fs.unlink(tempPath); } catch {}
        throw error;
    }
}

function deepMerge(base: unknown, override: unknown): unknown {
    if (!base || typeof base !== "object" || Array.isArray(base)) {
        return override ?? base;
    }

    const out: Record<string, unknown> = {
        ...(base as Record<string, unknown>),
    };

    if (override && typeof override === "object" && !Array.isArray(override)) {
        for (const [key, value] of Object.entries(override)) {
            out[key] = key in out ? deepMerge(out[key], value) : value;
        }
    }

    return out;
}
