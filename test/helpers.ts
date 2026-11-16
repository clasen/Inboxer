import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mail } from "../src/core/mail.ts";
import { createInboxer, type Inboxer } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { WebhookSignatureError, type InboundMessage, type MailProvider, type OutboundMessage, type OutboundStatus, type ProviderEvent } from "../src/provider/types.ts";
import type { InboxerConfig } from "../src/types.ts";

export class FakeProvider implements MailProvider {
    readonly name = "fake";
    inbound = new Map<string, InboundMessage>();
    outbound: OutboundStatus[] = [];
    sent: { message: OutboundMessage; idempotencyKey: string; providerId: string }[] = [];
    fetches = 0;
    failNextSend = false;

    parseWebhook({ headers, body }: { headers: Headers; body: string }): ProviderEvent[] {
        if (headers.get("x-signature") !== "ok") throw new WebhookSignatureError("bad signature");
        return JSON.parse(body) as ProviderEvent[];
    }

    async getInbound(providerId: string): Promise<InboundMessage> {
        this.fetches++;
        const message = this.inbound.get(providerId);
        if (!message) throw new Error(`no inbound ${providerId}`);
        return message;
    }

    async *listInbound(since: Date): AsyncIterable<string> {
        for (const m of this.inbound.values()) if (new Date(m.receivedAt) >= since) yield m.providerId;
    }

    async *listOutbound(): AsyncIterable<OutboundStatus> {
        yield* this.outbound;
    }

    async send(message: OutboundMessage, idempotencyKey: string): Promise<{ providerId: string }> {
        if (this.failNextSend) {
            this.failNextSend = false;
            throw new Error("provider down");
        }
        const previous = this.sent.find(s => s.idempotencyKey === idempotencyKey);
        if (previous) return { providerId: previous.providerId };
        const providerId = `out-${this.sent.length + 1}`;
        this.sent.push({ message, idempotencyKey, providerId });
        return { providerId };
    }

    async getAttachmentUrl(providerMessageId: string, attachmentId: string): Promise<string> {
        return `https://files.test/${providerMessageId}/${attachmentId}`;
    }

    addInbound(partial: Partial<InboundMessage> & { providerId: string }): InboundMessage {
        const message: InboundMessage = {
            messageId: `<${partial.providerId}@customer.test>`,
            inReplyTo: null,
            references: [],
            from: "Ana <ana@customer.test>",
            to: ["support@inboxer.test"],
            cc: [],
            bcc: [],
            replyTo: [],
            deliveredTo: [],
            subject: "Trial question",
            text: "Hello, how long is the trial?",
            html: null,
            headers: {},
            attachments: [],
            receivedAt: new Date().toISOString(),
            ...partial,
        };
        this.inbound.set(message.providerId, message);
        return message;
    }
}

export const TOKEN = "test-token-0123456789";
export const FEEDBACK_TOKEN = "feedback-token-0123456789";

export function testConfig(dataDir: string): InboxerConfig {
    return {
        publicUrl: "http://localhost:4000",
        dataDir,
        syncIntervalMin: 10,
        threadWindowDays: 30,
        mailboxes: {
            support: { address: "support@inboxer.test", name: "Inboxer Support", signatureText: "-- Support", signatureHtml: "<p>-- Support</p>" },
            feedback: { address: "feedback@inboxer.test", name: "Inboxer", tokens: { "feedback-bot": FEEDBACK_TOKEN } },
        },
        provider: { type: "fake" },
        mcp: { tokens: { agent: TOKEN } },
        ui: { cookieSecret: "cookie-secret-for-tests", loginLinkTtlMin: 10 },
    };
}

export interface Harness {
    inboxer: Inboxer;
    provider: FakeProvider;
    dataDir: string;
    close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxer-"));
    const provider = new FakeProvider();
    const inboxer = createInboxer(testConfig(dataDir), { provider });
    await inboxer.ready;
    return {
        inboxer,
        provider,
        dataDir,
        async close() {
            await inboxer.close();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}

export function webhook(h: Harness, events: ProviderEvent[], signature = "ok"): Promise<Response> {
    return h.inboxer.fetch(new Request("http://localhost/webhooks/fake", {
        method: "POST",
        headers: { "x-signature": signature },
        body: JSON.stringify(events),
    }));
}

export interface CoreHarness {
    mail: Mail;
    store: Store;
    provider: FakeProvider;
    close(): Promise<void>;
}

export async function startCore(): Promise<CoreHarness> {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxer-core-"));
    const provider = new FakeProvider();
    const store = new Store(dataDir);
    await store.connect();
    return {
        mail: new Mail(store, provider, testConfig(dataDir)),
        store,
        provider,
        async close() {
            await store.close();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}
