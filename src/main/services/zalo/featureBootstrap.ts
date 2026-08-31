import { createDatabaseManager } from "./database/index.js";
import { ZaloRuntime } from "./Runtime.js";

export async function createZaloFeatureService() {
    const { config, db } = await createDatabaseManager();
    const runtime = new ZaloRuntime(config, db);

    return {
        config,
        db,
        runtime,
    };
}
