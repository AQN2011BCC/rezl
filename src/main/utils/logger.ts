export function createLogger(scope: string) {
    return {
        info(message: string, ...args: unknown[]) {
            console.log(`[${scope}] ${message}`, ...args);
        },
        warn(message: string, ...args: unknown[]) {
            console.warn(`[${scope}] ${message}`, ...args);
        },
        error(message: string, ...args: unknown[]) {
            console.error(`[${scope}] ${message}`, ...args);
        },
        debug(message: string, ...args: unknown[]) {
            if (process.env.ZALO_DEBUG === "1") {
                console.debug(`[${scope}] ${message}`, ...args);
            }
        },
    };
}
