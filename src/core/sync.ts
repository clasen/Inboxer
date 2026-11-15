import type { Mail } from "./mail.ts";

/**
 * Backup for missed webhooks. Each run looks back to one interval before the previous run started,
 * so consecutive windows overlap; ingest and status updates are idempotent.
 */
export class Sync {
    private readonly mail: Mail;
    private readonly intervalMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running: Promise<void> | null = null;

    constructor(mail: Mail, intervalMin: number) {
        this.mail = mail;
        this.intervalMs = intervalMin * 60_000;
    }

    start(): void {
        this.timer = setInterval(() => {
            this.run().catch(err => console.error("inboxer: sync failed", err));
        }, this.intervalMs);
        this.timer.unref?.();
    }

    async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.running?.catch(() => {});
    }

    run(): Promise<void> {
        this.running ??= this.runOnce().finally(() => {
            this.running = null;
        });
        return this.running;
    }

    private async runOnce(): Promise<void> {
        const startedAt = new Date();
        const cursor = await this.mail.store.getSyncCursor();
        const since = new Date((cursor ? new Date(cursor).getTime() : startedAt.getTime()) - this.intervalMs);

        for await (const providerId of this.mail.provider.listInbound(since)) {
            await this.mail.ingest(providerId);
        }
        for await (const { providerId, status } of this.mail.provider.listOutbound(since)) {
            await this.mail.applyStatus(providerId, status, null);
        }
        await this.mail.store.setSyncCursor(startedAt.toISOString());
    }
}
