import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Inbound attachment bytes on disk, under `<dataDir>/attachments/<message id>/`, so they outlive the provider's retention. */
export class AttachmentFiles {
    private readonly dir: string;

    constructor(dataDir: string) {
        this.dir = join(dataDir, "attachments");
    }

    private path(messageId: string, attachmentId: string): string {
        return join(this.dir, messageId, createHash("sha1").update(attachmentId).digest("hex"));
    }

    async read(messageId: string, attachmentId: string): Promise<Uint8Array | null> {
        try {
            return await readFile(this.path(messageId, attachmentId));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
    }

    /** Writes through a temporary file, so a crash never leaves a partial attachment behind. */
    async write(messageId: string, attachmentId: string, body: Uint8Array): Promise<void> {
        const target = this.path(messageId, attachmentId);
        await mkdir(join(this.dir, messageId), { recursive: true });
        await writeFile(`${target}.tmp`, body);
        await rename(`${target}.tmp`, target);
    }
}
