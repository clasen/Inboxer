import type { AttachmentMeta, Direction } from "../types.ts";

export type DeliveryStatus = "sent" | "delivered" | "read" | "bounced" | "failed";

/**
 * `mail`: subjects, several recipients, HTML, threading by headers.
 * `chat`: one counterpart per thread, plain text, at most one attachment per message.
 */
export type ProviderKind = "mail" | "chat";

export interface MessageEvent {
    type: "message";
    providerId: string;
    /** The message itself, when the provider already has it; otherwise Inboxer calls `getMessage`. */
    message?: ProviderMessage;
}

export type ProviderEvent =
    | MessageEvent
    | { type: "status"; providerId: string; status: DeliveryStatus; messageId: string | null };

/**
 * A message as the provider holds it. `out` ones were sent by anyone on the account, Inboxer included.
 * A chat provider only knows the counterpart: it leaves `to` empty on `in` and `from` empty on `out`,
 * and Inboxer fills in the mailbox's own address.
 */
export interface ProviderMessage {
    providerId: string;
    direction: Direction;
    /** Delivery status of an `out` message, when the provider reports it with the message. */
    status: DeliveryStatus | null;
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
    /** When it was received or sent. */
    at: string;
}

export interface OutboundMessage {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo: string[];
    subject: string;
    text: string;
    /** null in a chat. */
    html: string | null;
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

/** Everything Inboxer needs from a messaging service. Implementations normalize the service's shapes. */
export interface MailProvider {
    /** Its key in `providers`, stored on every message and used as the webhook route: `/webhooks/<name>`. */
    readonly name: string;
    readonly kind: ProviderKind;
    /** Verifies the signature and returns the events Inboxer cares about. Throws `WebhookSignatureError`. */
    parseWebhook(req: WebhookRequest): ProviderEvent[];
    getMessage(providerId: string): Promise<ProviderMessage>;
    /** Messages received or sent at or after `since`. */
    listMessages(since: Date): AsyncIterable<MessageEvent>;
    /** Delivery status of outbound messages created at or after `since`, when `listMessages` does not carry it. */
    listOutbound(since: Date): AsyncIterable<OutboundStatus>;
    /** Sends once per `idempotencyKey`; a retry with the same key must not send again. */
    send(message: OutboundMessage, idempotencyKey: string): Promise<{ providerId: string }>;
    /** The bytes of an attachment of a message the provider holds. */
    getAttachment(providerMessageId: string, attachmentId: string): Promise<Uint8Array>;
}

export type ProviderFactory = (name: string, config: Record<string, unknown>) => MailProvider;

export class WebhookSignatureError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WebhookSignatureError";
    }
}
