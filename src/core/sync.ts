import type { MailProvider } from "../provider/types.ts";
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

    /** Providers sync one after another; one that fails does not hold back the rest. */
    private async runOnce(): Promise<void> {
        const failures: unknown[] = [];
        for (const provider of Object.values(this.mail.providers)) {
            await this.syncProvider(provider).catch(err => failures.push(err));
        }
        if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "several providers failed to sync");
    }

    /**
     * A chat mailbox mirrors conversations that began before Inboxer was attached to the line,
     * so its first run reads the whole history.
     */
    private async syncProvider(provider: MailProvider): Promise<void> {
        const startedAt = new Date();
        const cursor = await this.mail.store.getSyncCursor(provider.name);
        const since = cursor
            ? new Date(new Date(cursor).getTime() - this.intervalMs)
            : provider.kind === "chat" ? new Date(0) : new Date(startedAt.getTime() - this.intervalMs);

        for await (const event of provider.listMessages(since)) {
            await this.mail.applyEvent(provider.name, event);
        }
        for await (const { providerId, status } of provider.listOutbound(since)) {
            await this.mail.applyStatus(provider.name, providerId, status, null);
        }
        await this.mail.store.setSyncCursor(provider.name, startedAt.toISOString());
    }
}
