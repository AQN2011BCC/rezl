import fs from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
    constructor(
        private readonly filePath: string,
        private readonly defaultValue: T,
    ) {}

    async read(): Promise<T> {
        try {
            return JSON.parse(
                await fs.readFile(this.filePath, "utf8"),
            ) as T;
        } catch (error: any) {
            if (error?.code === "ENOENT") {
                return structuredClone(this.defaultValue);
            }
            throw error;
        }
    }

    async write(value: T): Promise<void> {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        await fs.writeFile(
            tempPath,
            JSON.stringify(value, null, 2),
            { encoding: "utf8", flag: "w" },
        );
        try {
            await fs.rename(tempPath, this.filePath);
        } catch (error) {
            try { await fs.unlink(tempPath); } catch {}
            throw error;
        }
    }
}
