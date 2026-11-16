import type { AttachmentMeta } from "../types.ts";

export type DeliveryStatus = "sent" | "delivered" | "bounced" | "failed";

export type ProviderEvent =
    | { type: "received"; providerId: string }
    | { type: "status"; providerId: string; status: DeliveryStatus; messageId: string | null };

export interface InboundMessage {
    providerId: string;
    messageId: string | null;
    inReplyTo: string | null;
    references: string[];
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo: string[];
    /** Envelope recipients, which include addresses that only appear in Bcc. */
    deliveredTo: string[];
    subject: string;
    text: string | null;
    html: string | null;
    headers: Record<string, string>;
    attachments: AttachmentMeta[];
    receivedAt: string;
}

export interface OutboundMessage {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo: string[];
    subject: string;
    text: string;
    html: string;
    headers: Record<string, string>;
    attachments: OutboundAttachment[];
}

export interface OutboundAttachment {
    filename: string;
    contentType: string;
    content: Uint8Array;
}

export interface OutboundStatus {
    providerId: string;
    status: DeliveryStatus;
}

export interface WebhookRequest {
    headers: Headers;
    body: string;
}

/** Everything Inboxer needs from an email service. Implementations normalize the service's shapes. */
export interface MailProvider {
    /** Stable identifier, stored on every message and used as the webhook route: `/webhooks/<name>`. */
    readonly name: string;
    /** Verifies the signature and returns the events Inboxer cares about. Throws `WebhookSignatureError`. */
    parseWebhook(req: WebhookRequest): ProviderEvent[];
    getInbound(providerId: string): Promise<InboundMessage>;
    /** Ids of inbound messages received at or after `since`. */
    listInbound(since: Date): AsyncIterable<string>;
    /** Delivery status of outbound messages created at or after `since`. */
    listOutbound(since: Date): AsyncIterable<OutboundStatus>;
    /** Sends once per `idempotencyKey`; a retry with the same key must not send again. */
    send(message: OutboundMessage, idempotencyKey: string): Promise<{ providerId: string }>;
    /** The bytes of an inbound attachment. */
    getAttachment(providerMessageId: string, attachmentId: string): Promise<Uint8Array>;
}

export type ProviderFactory = (config: Record<string, unknown>) => MailProvider;

export class WebhookSignatureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebhookSignatureError";
    }
}
