export interface MailboxConfig {
    address: string;
    name: string;
    signatureHtml?: string;
    signatureText?: string;
}

export interface ProviderConfig {
    type: string;
    [key: string]: unknown;
}

export interface InboxerConfig {
    publicUrl: string;
    dataDir: string;
    syncIntervalMin: number;
    threadWindowDays: number;
    mailboxes: Record<string, MailboxConfig>;
    provider: ProviderConfig;
    mcp: { tokens: Record<string, string> };
    ui: { cookieSecret: string; loginLinkTtlMin: number };
}

export const CATCHALL = "catchall";

export type Direction = "in" | "out";
export type MessageStatus = "received" | "draft" | "sent" | "delivered" | "bounced" | "failed" | "discarded";
export type Actor = { kind: "agent" | "ui" | "cli"; name: string };

export interface AttachmentMeta {
    id: string;
    filename: string;
    content_type: string;
    size: number | null;
}

export interface Message {
    id: string;
    provider: string;
    provider_id: string | null;
    mailbox: string;
    direction: Direction;
    status: MessageStatus;
    message_id: string | null;
    in_reply_to: string | null;
    references: string[];
    thread_id: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    reply_to: string[];
    subject: string;
    text: string;
    html: string | null;
    headers: Record<string, string>;
    attachments: AttachmentMeta[];
    labels: Record<string, true>;
    note: string | null;
    created_by: "agent" | "ui" | null;
    read: boolean;
    archived: boolean;
    created_at: string;
    sent_at: string | null;
    version: number;
    edited_by_human: boolean;
}

export interface Thread {
    id: string;
    mailbox: string;
    subject: string;
    norm_subject: string;
    participants: string[];
    last_at: string;
    last_direction: Direction;
    has_draft: boolean;
    unread: number;
    archived: boolean;
    labels: Record<string, true>;
    message_ids: string[];
}

export type MetaValue = string | number | boolean;

/** Context a consumer attaches to a contact or a thread. Inboxer stores it without interpreting it. */
export interface Context {
    meta: Record<string, MetaValue>;
    note: string | null;
    updated_at: string;
    updated_by: string;
}

export interface Contact extends Context {
    address: string;
}

export interface AuditEntry {
    action: string;
    actor: string;
    target: string | null;
    at: string;
    detail?: Record<string, unknown>;
}

export interface LoginLink {
    created_at: string;
    expires_at: string;
    created_by: string;
    label: string | null;
    /** App path to open after signing in. */
    next: string | null;
}

export interface Session {
    id: string;
    created_at: string;
    last_seen: string;
    user_agent: string | null;
    ip: string | null;
    label: string | null;
    created_by: string;
}
