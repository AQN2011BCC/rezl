import fs from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
    constructor(
        private readonly filePath: string,
        private readonly defaultValue: T,
    ) {}

    async read(): Promise<T> {
        try {
            const raw = await fs.readFile(
                this.filePath,
                "utf8",
            );

            return JSON.parse(raw) as T;
        } catch (error: any) {
            if (error?.code === "ENOENT") {
                return structuredClone(this.defaultValue);
            }

            throw error;
        }
    }

    async write(value: T): Promise<void> {
        const directory =
            path.dirname(this.filePath);

        await fs.mkdir(directory, {
            recursive: true,
        });

        const tempFile =
            `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

        const data =
            JSON.stringify(
                value,
                null,
                2,
            );

        await fs.writeFile(
            tempFile,
            data,
            {
                encoding: "utf8",
                flag: "wx",
            },
        );

        try {
            await fs.rename(
                tempFile,
                this.filePath,
            );
        } catch (error) {
            try {
                await fs.unlink(tempFile);
            } catch {}

            throw error;
        }
    }
}
