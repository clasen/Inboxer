import { Webhook, WebhookVerificationError } from "svix";
import type { AttachmentMeta } from "../types.ts";
import {
    WebhookSignatureError,
    type DeliveryStatus,
    type MailProvider,
    type MessageEvent,
    type OutboundMessage,
    type OutboundStatus,
    type ProviderEvent,
    type ProviderMessage,
    type WebhookRequest,
} from "./types.ts";

const API = "https://api.resend.com";
const PAGE_LIMIT = 100;

const WEBHOOK_STATUS: Record<string, DeliveryStatus> = {
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.bounced": "bounced",
    "email.failed": "failed",
    "email.suppressed": "failed",
};

/** `last_event` of a sent email. Engagement events imply delivery; pending ones carry no status yet. */
const LAST_EVENT_STATUS: Record<string, DeliveryStatus | null> = {
    queued: null,
    scheduled: null,
    delivery_delayed: null,
    sent: "sent",
    delivered: "delivered",
    opened: "delivered",
    clicked: "delivered",
    complained: "delivered",
    bounced: "bounced",
    failed: "failed",
    suppressed: "failed",
    canceled: "failed",
};

interface ResendAttachment {
    id: string;
    filename: string;
    content_type: string;
    size?: number;
    content_id?: string | null;
    content_disposition?: string | null;
}

interface ResendReceivedEmail {
    id: string;
    from: string;
    to: string[] | null;
    cc: string[] | null;
    bcc: string[] | null;
    reply_to: string[] | null;
    received_for?: string[] | null;
    subject: string | null;
    text: string | null;
    html: string | null;
    headers: Record<string, string | string[]> | null;
    message_id: string | null;
    attachments: ResendAttachment[] | null;
    created_at: string;
}

interface ResendList<T> {
    has_more: boolean;
    data: T[];
}

export interface ResendProviderConfig {
    apiKey: string;
    webhookSecret: string;
}

export function createResendProvider(name: string, config: Record<string, unknown>): MailProvider {
    const { apiKey, webhookSecret } = config as unknown as ResendProviderConfig;
    if (typeof apiKey !== "string" || !apiKey) throw new Error(`providers.${name}.apiKey is required for the resend provider`);
    if (typeof webhookSecret !== "string" || !webhookSecret) {
        throw new Error(`providers.${name}.webhookSecret is required for the resend provider`);
    }
    const webhook = new Webhook(webhookSecret);

    async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
        const res = await fetch(API + path, {
            method,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "User-Agent": "inboxer",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`Resend ${method} ${path} failed: ${res.status} ${await res.text()}`);
        }
        return (await res.json()) as T;
    }

    async function* paginate<T extends { id: string; created_at: string }>(path: string, since: Date): AsyncIterable<T> {
        let after: string | null = null;
        while (true) {
            const query: string = `limit=${PAGE_LIMIT}` + (after ? `&after=${encodeURIComponent(after)}` : "");
            const page: ResendList<T> = await request<ResendList<T>>("GET", `${path}?${query}`);
            for (const item of page.data) {
                if (parseResendDate(item.created_at) < since) return;
                yield item;
            }
            if (!page.has_more || page.data.length === 0) return;
            after = page.data[page.data.length - 1]!.id;
        }
    }

    return {
        name,
        kind: "mail",

        parseWebhook({ headers, body }: WebhookRequest): ProviderEvent[] {
            try {
                webhook.verify(body, {
                    "svix-id": headers.get("svix-id") ?? "",
                    "svix-timestamp": headers.get("svix-timestamp") ?? "",
                    "svix-signature": headers.get("svix-signature") ?? "",
                });
            } catch (err) {
                if (err instanceof WebhookVerificationError) throw new WebhookSignatureError(err.message);
                throw err;
            }
            const payload = JSON.parse(body) as { type: string; data: { email_id: string; message_id?: string | null } };
            if (payload.type === "email.received") return [{ type: "message", providerId: payload.data.email_id }];
            const status = WEBHOOK_STATUS[payload.type];
            if (!status) return [];
            return [{ type: "status", providerId: payload.data.email_id, status, messageId: payload.data.message_id ?? null }];
        },

        async getMessage(providerId: string): Promise<ProviderMessage> {
            const email = await request<ResendReceivedEmail>("GET", `/emails/receiving/${encodeURIComponent(providerId)}`);
            const headers = normalizeHeaders(email.headers ?? {});
            return {
                providerId: email.id,
                direction: "in",
                status: null,
                messageId: email.message_id ?? headers["message-id"] ?? null,
                inReplyTo: headers["in-reply-to"]?.trim() || null,
                references: (headers["references"] ?? "").split(/\s+/).filter(Boolean),
                from: email.from,
                to: email.to ?? [],
                cc: email.cc ?? [],
                bcc: email.bcc ?? [],
                replyTo: email.reply_to ?? [],
                deliveredTo: email.received_for ?? [],
                subject: email.subject ?? "",
                text: email.text,
                html: email.html,
                headers,
                attachments: (email.attachments ?? []).map(toAttachmentMeta),
                at: parseResendDate(email.created_at).toISOString(),
            };
        },

        async *listMessages(since: Date): AsyncIterable<MessageEvent> {
            for await (const item of paginate<{ id: string; created_at: string }>("/emails/receiving", since)) {
                yield { type: "message", providerId: item.id };
            }
        },

        async *listOutbound(since: Date): AsyncIterable<OutboundStatus> {
            for await (const item of paginate<{ id: string; created_at: string; last_event: string }>("/emails", since)) {
                const status = LAST_EVENT_STATUS[item.last_event];
                if (status === undefined) throw new Error(`Unknown Resend last_event: ${item.last_event}`);
                if (status) yield { providerId: item.id, status };
            }
        },

        async send(message: OutboundMessage, idempotencyKey: string): Promise<{ providerId: string }> {
            const body: Record<string, unknown> = {
                from: message.from,
                to: message.to,
                subject: message.subject,
                text: message.text,
                headers: message.headers,
            };
            if (message.html !== null) body.html = message.html;
            if (message.cc.length) body.cc = message.cc;
            if (message.bcc.length) body.bcc = message.bcc;
            if (message.replyTo.length) body.reply_to = message.replyTo;
            if (message.attachments.length) {
                body.attachments = message.attachments.map(a => ({
                    filename: a.filename,
                    content: Buffer.from(a.content).toString("base64"),
                    content_type: a.contentType,
                }));
            }
            const res = await request<{ id: string }>("POST", "/emails", body, { "Idempotency-Key": idempotencyKey });
            return { providerId: res.id };
        },

        async getAttachment(providerMessageId: string, attachmentId: string): Promise<Uint8Array> {
            const { download_url } = await request<{ download_url: string }>(
                "GET",
                `/emails/receiving/${encodeURIComponent(providerMessageId)}/attachments/${encodeURIComponent(attachmentId)}`,
            );
            const res = await fetch(download_url);
            if (!res.ok) throw new Error(`Resend attachment ${attachmentId} download failed: ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
        },
    };
}

function toAttachmentMeta(a: ResendAttachment): AttachmentMeta {
    const contentId = a.content_id ? a.content_id.replace(/^<|>$/g, "") : null;
    return {
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        size: a.size ?? null,
        inline: a.content_disposition === "inline" && !!contentId,
        content_id: contentId,
    };
}

function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return out;
}

/** The sent-email list uses `YYYY-MM-DD HH:MM:SS.ffffff+00`; the receiving API uses ISO 8601. */
export function parseResendDate(value: string): Date {
    const iso = value.includes("T") ? value : value.replace(" ", "T").replace(/\+00$/, "Z");
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) throw new Error(`Unparseable Resend date: ${value}`);
    return date;
}
