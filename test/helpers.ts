import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mail } from "../src/core/mail.ts";
import { createInboxer, type Inboxer } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { WebhookSignatureError, type MailProvider, type MessageEvent, type OutboundMessage, type OutboundStatus, type ProviderEvent, type ProviderKind, type ProviderMessage } from "../src/provider/types.ts";
import type { InboxerConfig } from "../src/types.ts";

export class FakeProvider implements MailProvider {
    readonly name: string;
    readonly kind: ProviderKind;
    inbound = new Map<string, ProviderMessage>();
    outbound: OutboundStatus[] = [];
    sent: { message: OutboundMessage; idempotencyKey: string; providerId: string }[] = [];
    fetches = 0;
    failNextSend = false;

    constructor(name = "fake", kind: ProviderKind = "mail") {
        this.name = name;
        this.kind = kind;
    }

    parseWebhook({ headers, body }: { headers: Headers; body: string }): ProviderEvent[] {
        if (headers.get("x-signature") !== "ok") throw new WebhookSignatureError("bad signature");
        return JSON.parse(body) as ProviderEvent[];
    }

    async getMessage(providerId: string): Promise<ProviderMessage> {
        this.fetches++;
        const message = this.inbound.get(providerId);
        if (!message) throw new Error(`no inbound ${providerId}`);
        return message;
    }

    async *listMessages(since: Date): AsyncIterable<MessageEvent> {
        for (const m of this.inbound.values()) if (new Date(m.at) >= since) yield { type: "message", providerId: m.providerId };
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

    /** Attachment bytes by `<providerId>/<attachmentId>`. */
    files = new Map<string, Uint8Array>();
    downloads = 0;

    async getAttachment(providerMessageId: string, attachmentId: string): Promise<Uint8Array> {
        this.downloads++;
        const body = this.files.get(`${providerMessageId}/${attachmentId}`);
        if (!body) throw new Error(`no attachment ${providerMessageId}/${attachmentId}`);
        return body;
    }

    addInbound(partial: Partial<ProviderMessage> & { providerId: string }): ProviderMessage {
        const message: ProviderMessage = {
            direction: "in",
            status: null,
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
            at: new Date().toISOString(),
            ...partial,
        };
        this.inbound.set(message.providerId, message);
        return message;
    }

    /** A message as a chat provider reports it: only the counterpart is known. */
    chatMessage(partial: Partial<ProviderMessage> & { providerId: string }, counterpart = "Lucía <+5491155550000>"): ProviderMessage {
        const incoming = (partial.direction ?? "in") === "in";
        return {
            direction: "in",
            status: null,
            messageId: null,
            inReplyTo: null,
            references: [],
            from: incoming ? counterpart : "",
            to: incoming ? [] : [counterpart.replace(/^.*<|>$/g, "")],
            cc: [],
            bcc: [],
            replyTo: [],
            deliveredTo: [],
            subject: "",
            text: "Hola, quiero publicitar",
            html: null,
            headers: {},
            attachments: [],
            at: new Date().toISOString(),
            ...partial,
        };
    }
}

export const TOKEN = "test-token-0123456789";
export const FEEDBACK_TOKEN = "feedback-token-0123456789";

export const LINE = "+12025550100";

/** `chat` adds a phone line served by a second provider, named "wa". */
export function testConfig(dataDir: string, { chat = false, uiReadOnly = false }: { chat?: boolean; uiReadOnly?: boolean } = {}): InboxerConfig {
    return {
        publicUrl: "http://localhost:4000",
        dataDir,
        syncIntervalMin: 10,
        threadWindowDays: 30,
        mailboxes: {
            support: { address: "support@inboxer.test", name: "Inboxer Support", provider: "fake", signatureText: "-- Support", signatureHtml: "<p>-- Support</p>" },
            feedback: { address: "feedback@inboxer.test", name: "Inboxer", provider: "fake", tokens: { "feedback-bot": FEEDBACK_TOKEN } },
            ...(chat ? { line: { address: LINE, name: "Flight Desk", provider: "wa", ...(uiReadOnly ? { uiReadOnly: true as const } : {}) } } : {}),
        },
        providers: { fake: { type: "fake" }, ...(chat ? { wa: { type: "fake" } } : {}) },
        mcp: { tokens: { agent: TOKEN }, maxAttachmentMb: 1 },
        ui: { cookieSecret: "cookie-secret-for-tests", loginLinkTtlMin: 10, undoSec: 0.05, maxUploadMb: 1 },
    };
}

export interface Harness {
    inboxer: Inboxer;
    provider: FakeProvider;
    /** The chat provider; it only serves a mailbox when the harness was started with `chat`. */
    wa: FakeProvider;
    dataDir: string;
    close(): Promise<void>;
}

export async function startHarness(options: Parameters<typeof testConfig>[1] = {}): Promise<Harness> {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxer-"));
    const provider = new FakeProvider();
    const wa = new FakeProvider("wa", "chat");
    const inboxer = createInboxer(testConfig(dataDir, options), { providers: options.chat ? { fake: provider, wa } : { fake: provider } });
    await inboxer.ready;
    return {
        inboxer,
        provider,
        wa,
        dataDir,
        async close() {
            await inboxer.close();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}

export function webhook(h: Harness, events: ProviderEvent[], signature = "ok", provider = "fake"): Promise<Response> {
    return h.inboxer.fetch(new Request(`http://localhost/webhooks/${provider}`, {
        method: "POST",
        headers: { "x-signature": signature },
        body: JSON.stringify(events),
    }));
}

export interface CoreHarness {
    mail: Mail;
    store: Store;
    provider: FakeProvider;
    wa: FakeProvider;
    close(): Promise<void>;
}

export async function startCore(options: Parameters<typeof testConfig>[1] = {}): Promise<CoreHarness> {
    const dataDir = mkdtempSync(join(tmpdir(), "inboxer-core-"));
    const provider = new FakeProvider();
    const wa = new FakeProvider("wa", "chat");
    const store = new Store(dataDir);
    await store.connect();
    return {
        mail: new Mail(store, options.chat ? { fake: provider, wa } : { fake: provider }, testConfig(dataDir, options)),
        store,
        provider,
        wa,
        async close() {
            await store.close();
            rmSync(dataDir, { recursive: true, force: true });
        },
    };
}
