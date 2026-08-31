import { loginZalo } from "./src/main/services/zalo/login.js";
import { getLoginInfo } from "./src/main/services/zalo/getLoginInfo.js";
import { getUserInfo } from "./src/main/services/zalo/getUserInfo.js";
import { createZaloFeatureService } from "./src/main/services/zalo/featureBootstrap.js";
import { rezlApi } from "./src/main/services/zalo/api/rezlApi.js";

async function main() {

    // ================================================
    // 1. LOGIN
    // ================================================

    let loginResult: any;

    try {
        loginResult = await loginZalo();
    } catch (error: any) {
        console.error(
            `[ZALO_SERVICE:login] ${error?.message ?? error}`,
        );

        return;
    }

    const { api, restored } = loginResult;

    if (!api) {
        console.error(
            "[ZALO_SERVICE:login] Login succeeded but api object is missing.",
        );

        return;
    }

    const ownerId = String(api.getOwnId());

    console.log(
        `[ZALO_SERVICE:login] Login complete! ownerId=${ownerId}, restored=${restored}`,
    );

    // ================================================
    // 2. LOGIN INFO
    // ================================================

    try {
        await getLoginInfo();

        console.log(
            "[ZALO_SERVICE:getLoginInfo] Get login info completed!",
        );
    } catch (error: any) {
        console.error(
            `[ZALO_SERVICE:getLoginInfo] ${error?.message ?? error}`,
        );
    }

    // ================================================
    // 3. USER INFO
    // ================================================

    try {
        const myProfile: any = await getUserInfo(api, ownerId);

        console.log(
            "[ZALO_SERVICE:getUserInfo]",
            {
                userId: myProfile?.userId,
                displayName: myProfile?.displayName,
            },
        );
    } catch (error: any) {
        console.error(
            `[ZALO_SERVICE:getUserInfo] ${error?.message ?? error}`,
        );
    }

    // ================================================
    // 4. START FEATURES SAU LOGIN
    // ================================================

    let runtime: any;

    try {
        const feature = await createZaloFeatureService();
        runtime = feature.runtime;

        console.log(
            "[ZALO_SERVICE:featureBootstrap] Feature service started!",
        );
    } catch (error: any) {
        console.error(
            `[ZALO_SERVICE:featureBootstrap] ${error?.message ?? error}`,
        );

        return;
    }

    // ================================================
    // 5. START LISTENER
    // ================================================

    try {
        await runtime.start(api, ownerId);

        const appApi = new rezlApi(runtime, api, ownerId);

        console.log(
            "[ZALO_SERVICE:runtime] Listener started!",
        );
        console.log(
            "[ZALO_SERVICE:api] UI facade ready:",
            Object.getOwnPropertyNames(Object.getPrototypeOf(appApi))
                .filter((name) => name !== "constructor"),
        );
    } catch (error: any) {
        console.error(
            `[ZALO_SERVICE:runtime] ${error?.message ?? error}`,
        );
    }

    console.log(
        "[ZALO_SERVICE:index] Boot completed!",
    );
}

main().catch((error) => {
    console.error(
        "[ZALO_SERVICE:fatal]",
        error,
    );

    process.exitCode = 1;
});
