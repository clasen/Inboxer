import { createHmac, timingSafeEqual } from "node:crypto";
import { bareAddress, formatAddress, phoneAddress } from "../core/address.ts";
import type { AttachmentMeta } from "../types.ts";
import {
    WebhookSignatureError,
    type DeliveryStatus,
    type MailProvider,
    type MessageEvent,
    type OutboundAttachment,
    type OutboundMessage,
    type OutboundStatus,
    type ProviderEvent,
    type ProviderMessage,
    type WebhookRequest,
} from "./types.ts";

const PLATFORM_API = "https://api.kapso.ai/platform/v1/whatsapp";
const META_API = "https://api.kapso.ai/meta/whatsapp/v24.0";
const PAGE_LIMIT = 100;
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

const STATUS: Record<string, DeliveryStatus> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };

const WEBHOOK_STATUS: Record<string, DeliveryStatus> = {
    "whatsapp.message.delivered": "delivered",
    "whatsapp.message.read": "read",
    "whatsapp.message.failed": "failed",
};

interface KapsoMedia {
    id?: string;
    caption?: string | null;
    filename?: string | null;
    mime_type?: string | null;
}

/** A WhatsApp Cloud API message with Kapso's `kapso` block. The media payload sits under the key named by `type`. */
interface KapsoMessage {
    id: string;
    timestamp: string;
    type: string;
    from?: string | null;
    to?: string | null;
    text?: { body: string };
    interactive?: { button_reply?: { title: string } };
    kapso?: {
        direction: string;
        status?: string;
        content?: string | null;
        contact_name?: string | null;
        phone_number?: string | null;
        transcript?: { text: string } | null;
        media_data?: { filename?: string | null; content_type?: string | null; byte_size?: number | null } | null;
    };
}

interface KapsoWebhookItem {
    message: KapsoMessage;
    conversation?: { contact_name?: string | null; phone_number?: string | null };
    phone_number_id: string;
}

interface KapsoPage {
    data: KapsoMessage[];
    paging?: { cursors?: { after?: string | null }; next?: string | null };
}

export interface KapsoProviderConfig {
    apiKey: string;
    webhookSecret: string;
    phoneNumberId: string;
}

/** One WhatsApp number through Kapso's proxy of the WhatsApp Cloud API. */
export function createKapsoProvider(name: string, config: Record<string, unknown>): MailProvider {
    const { apiKey, webhookSecret, phoneNumberId } = config as unknown as KapsoProviderConfig;
    for (const [key, value] of Object.entries({ apiKey, webhookSecret, phoneNumberId })) {
        if (typeof value !== "string" || !value) throw new Error(`providers.${name}.${key} is required for the kapso provider`);
    }

    async function request<T>(method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<T> {
        const res = await fetch(url, { method, headers: { "X-API-Key": apiKey, "User-Agent": "inboxer", ...headers }, body });
        if (!res.ok) throw new Error(`Kapso ${method} ${url} failed: ${res.status} ${await res.text()}`);
        return (await res.json()) as T;
    }

    async function upload(file: OutboundAttachment): Promise<string> {
        const form = new FormData();
        form.set("messaging_product", "whatsapp");
        form.set("file", new Blob([file.content as Uint8Array<ArrayBuffer>], { type: file.contentType }), file.filename);
        return (await request<{ id: string }>("POST", `${META_API}/${phoneNumberId}/media`, form)).id;
    }

    return {
        name,
        kind: "chat",

        parseWebhook({ headers, body }: WebhookRequest): ProviderEvent[] {
            const expected = createHmac("sha256", webhookSecret).update(body).digest();
            const given = Buffer.from(headers.get("x-webhook-signature") ?? "", "hex");
            if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new WebhookSignatureError("Invalid Kapso webhook signature");

            const event = headers.get("x-webhook-event") ?? "";
            const payload = JSON.parse(body) as KapsoWebhookItem | { batch: true; data: KapsoWebhookItem[] };
            const items = "batch" in payload ? payload.data : [payload];
            const events: ProviderEvent[] = [];
            for (const item of items) {
                if (item.phone_number_id !== phoneNumberId) continue;
                const status = WEBHOOK_STATUS[event];
                if (status) {
                    events.push({ type: "status", providerId: item.message.id, status, messageId: null });
                } else if (event === "whatsapp.message.received" || event === "whatsapp.message.sent") {
                    const message = normalize(item.message, item.conversation);
                    if (message) events.push({ type: "message", providerId: message.providerId, message });
                }
            }
            return events;
        },

        async getMessage(providerId: string): Promise<ProviderMessage> {
            const { data } = await request<{ data: KapsoMessage }>("GET", `${PLATFORM_API}/messages/${encodeURIComponent(providerId)}`);
            const message = normalize(data);
            if (!message) throw new Error(`Kapso message ${providerId} has no phone number`);
            return message;
        },

        /** The history is listed newest first, with no date filter. */
        async *listMessages(since: Date): AsyncIterable<MessageEvent> {
            let after: string | null = null;
            while (true) {
                const query = new URLSearchParams({ phone_number_id: phoneNumberId, limit: String(PAGE_LIMIT), ...(after ? { after } : {}) });
                const page: KapsoPage = await request<KapsoPage>("GET", `${PLATFORM_API}/messages?${query}`);
                for (const item of page.data) {
                    if (timeOf(item) < since) return;
                    const message = normalize(item);
                    if (message) yield { type: "message", providerId: message.providerId, message };
                }
                after = page.paging?.cursors?.after ?? null;
                if (!page.paging?.next || !after || page.data.length === 0) return;
            }
        },

        /** `listMessages` already carries the status of every outbound message. */
        async *listOutbound(): AsyncIterable<OutboundStatus> {},

        /** The Cloud API takes no idempotency key: a send whose response was lost can repeat on retry. */
        async send(message: OutboundMessage): Promise<{ providerId: string }> {
            const body: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to: bareAddress(message.to[0]!).slice(1) };
            const [file] = message.attachments;
            if (!file) {
                if (message.text.length > TEXT_LIMIT) throw new Error(`A WhatsApp text takes up to ${TEXT_LIMIT} characters`);
                Object.assign(body, { type: "text", text: { body: message.text } });
            } else {
                const type = mediaType(file.contentType);
                if (message.text && type === "audio") throw new Error("A WhatsApp audio message takes no text");
                if (message.text.length > CAPTION_LIMIT) throw new Error(`A WhatsApp caption takes up to ${CAPTION_LIMIT} characters`);
                const media: Record<string, string> = { id: await upload(file) };
                if (message.text) media.caption = message.text;
                if (type === "document") media.filename = file.filename;
                Object.assign(body, { type, [type]: media });
            }
            const res = await request<{ messages: { id: string }[] }>(
                "POST", `${META_API}/${phoneNumberId}/messages`, JSON.stringify(body), { "Content-Type": "application/json" });
            return { providerId: res.messages[0]!.id };
        },

        /** The attachment id is the media id; its download link is short-lived, so it is asked for each time. */
        async getAttachment(_providerMessageId: string, attachmentId: string): Promise<Uint8Array> {
            const { download_url } = await request<{ download_url: string }>(
                "GET", `${META_API}/${encodeURIComponent(attachmentId)}?${new URLSearchParams({ phone_number_id: phoneNumberId })}`);
            const res = await fetch(download_url);
            if (!res.ok) throw new Error(`Kapso media ${attachmentId} download failed: ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
        },
    };
}

function timeOf(message: KapsoMessage): Date {
    const date = new Date(Number(message.timestamp) * 1000);
    if (Number.isNaN(date.getTime())) throw new Error(`Unparseable Kapso timestamp: ${message.timestamp}`);
    return date;
}

function mediaOf(message: KapsoMessage): KapsoMedia | null {
    if (!MEDIA_TYPES.has(message.type)) return null;
    return (message as unknown as Record<string, KapsoMedia | undefined>)[message.type] ?? null;
}

/** Media shows its caption (a voice note, its transcript); anything else without a body shows Kapso's description of it. */
function textOf(message: KapsoMessage): string {
    if (message.type === "text") return message.text?.body ?? "";
    if (MEDIA_TYPES.has(message.type)) return mediaOf(message)?.caption ?? message.kapso?.transcript?.text ?? "";
    return message.interactive?.button_reply?.title ?? message.kapso?.content ?? `[${message.type}]`;
}

function attachmentsOf(message: KapsoMessage): AttachmentMeta[] {
    const media = mediaOf(message);
    if (!media?.id) return [];
    const data = message.kapso?.media_data;
    return [{
        id: media.id,
        filename: data?.filename ?? media.filename ?? message.type,
        content_type: data?.content_type ?? media.mime_type ?? "application/octet-stream",
        size: data?.byte_size ?? null,
        inline: false,
        content_id: null,
    }];
}

/** null for a message that carries no phone number (a contact known only by a business-scoped user id). */
function normalize(message: KapsoMessage, conversation?: KapsoWebhookItem["conversation"]): ProviderMessage | null {
    if (!message.kapso) throw new Error(`Kapso message ${message.id} has no kapso block`);
    const direction = message.kapso.direction === "outbound" ? "out" : "in";
    const number = (direction === "in" ? message.from : message.to) ?? message.kapso.phone_number ?? conversation?.phone_number;
    const phone = number ? phoneAddress(number) : null;
    if (!phone) {
        console.warn(`inboxer: Kapso message ${message.id} skipped, it has no phone number`);
        return null;
    }
    const name = conversation?.contact_name ?? message.kapso.contact_name;
    return {
        providerId: message.id,
        direction,
        status: direction === "out" ? STATUS[message.kapso.status ?? ""] ?? null : null,
        messageId: null,
        inReplyTo: null,
        references: [],
        from: direction === "in" ? (name ? formatAddress(name, phone) : phone) : "",
        to: direction === "in" ? [] : [phone],
        cc: [],
        bcc: [],
        replyTo: [],
        deliveredTo: [],
        subject: "",
        text: textOf(message),
        html: null,
        headers: {},
        attachments: attachmentsOf(message),
        at: timeOf(message).toISOString(),
    };
}

function mediaType(contentType: string): "image" | "video" | "audio" | "document" {
    if (contentType === "image/jpeg" || contentType === "image/png") return "image";
    if (contentType === "video/mp4" || contentType === "video/3gpp") return "video";
    if (contentType.startsWith("audio/")) return "audio";
    return "document";
}
