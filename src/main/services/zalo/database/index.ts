import { ensureConfig } from "../config/AppConfig.js";
import { DatabaseManager } from "./DatabaseManager.js";

export async function createDatabaseManager() {
    const config = await ensureConfig();
    return {
        config,
        db: new DatabaseManager(config),
    };
}
