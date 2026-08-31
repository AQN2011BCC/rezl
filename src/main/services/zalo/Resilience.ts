export class CircuitBreaker {
    private failures = 0;
    private openedAt = 0;

    constructor(
        private readonly threshold = 5,
        private readonly cooldownMs = 30_000,
    ) {}

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        if (
            this.openedAt &&
            Date.now() - this.openedAt < this.cooldownMs
        ) {
            throw new Error("Temporary request pause after repeated failures.");
        }

        if (this.openedAt) {
            this.openedAt = 0;
            this.failures = 0;
        }

        try {
            const value = await fn();
            this.failures = 0;
            return value;
        } catch (error) {
            this.failures += 1;
            if (this.failures >= this.threshold) {
                this.openedAt = Date.now();
            }
            throw error;
        }
    }
}

export class TTLCache<T> {
    private readonly map = new Map<
        string,
        { value: T; expires: number }
    >();

    constructor(private readonly ttlMs: number) {}

    get(key: string): T | undefined {
        const hit = this.map.get(key);
        if (!hit) return undefined;
        if (hit.expires < Date.now()) {
            this.map.delete(key);
            return undefined;
        }
        return hit.value;
    }

    set(key: string, value: T): void {
        this.map.set(key, {
            value,
            expires: Date.now() + this.ttlMs,
        });
    }

    clear(): void {
        this.map.clear();
    }
}

export async function withRetry<T>(
    operation: () => Promise<T>,
    retries: number,
    delayMs: number,
): Promise<T> {
    let last: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            last = error;
            if (attempt === retries) break;
            await new Promise((resolve) =>
                setTimeout(resolve, delayMs * (attempt + 1)),
            );
        }
    }

    throw last;
}
