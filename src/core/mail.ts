import { randomUUID } from "node:crypto";
import type { DeliveryStatus, MailProvider, ProviderEvent } from "../provider/types.ts";
import { reaches } from "../config.ts";
import { NotFoundError, nid, type Store } from "../store.ts";
import { CATCHALL, type Actor, type Contact, type Context, type InboxerConfig, type MailboxConfig, type Message, type MetaValue, type Scope, type Thread } from "../types.ts";
import { bareAddress, domainOf, formatAddress } from "./address.ts";
import { mergeContext, metaMatches, type ContextPatch } from "./context.ts";
import { htmlToText, replySubject, textToHtml, tokenize } from "./text.ts";
import { messageTime, participantsOf, refreshThread, resolveThreadId, threadMessages } from "./threads.ts";

const STATUS_RANK: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, bounced: 3, failed: 3 };

export class ConflictError extends Error {
    readonly current: Message;
    constructor(current: Message) {
        super(`Draft ${current.id} changed (current version ${current.version})`);
        this.name = "ConflictError";
        this.current = current;
    }
}

export class InvalidRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidRequestError";
    }
}

export type ThreadStatus = "unanswered" | "all" | "archived";

export interface ListThreadsInput {
    mailbox?: string;
    status?: ThreadStatus;
    label?: string;
    since?: string;
    /** Threads whose context, or a participant's contact, has every pair. */
    meta?: Record<string, MetaValue>;
    limit?: number;
}

export interface SearchInput {
    query?: string;
    meta?: Record<string, MetaValue>;
    mailbox?: string;
    from?: string;
    since?: string;
    until?: string;
    limit?: number;
}

export interface CreateDraftInput {
    mailbox?: string;
    replyToId?: string;
    replyAll?: boolean;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text: string;
    html?: string;
    note?: string;
}

export interface DraftPatch {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    text?: string;
    html?: string | null;
    note?: string | null;
}

export interface MessageView {
    id: string;
    thread_id: string;
    mailbox: string;
    direction: Message["direction"];
    status: Message["status"];
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    date: string;
    text: string;
    labels: string[];
    read: boolean;
    attachments: Message["attachments"];
    note: string | null;
    version: number;
    edited_by_human: boolean;
}

/** The mail domain: everything the MCP tools, the UI and the webhook do goes through here. */
export class Mail {
    readonly store: Store;
    readonly provider: MailProvider;
    readonly cfg: InboxerConfig;
    private readonly ownAddresses: Set<string>;

    constructor(store: Store, provider: MailProvider, cfg: InboxerConfig) {
        this.store = store;
        this.provider = provider;
        this.cfg = cfg;
        this.ownAddresses = new Set(Object.values(cfg.mailboxes).map(m => bareAddress(m.address)));
    }

    listMailboxes(scope: Scope): { id: string; address: string; name: string }[] {
        return [
            ...Object.entries(this.cfg.mailboxes).map(([id, m]) => ({ id, address: m.address, name: m.name })),
            { id: CATCHALL, address: "*", name: "Catch-all" },
        ].filter(m => reaches(scope, m.id));
    }

    // Out of scope reads as missing, so a scoped token cannot probe other mailboxes.

    async requireMessage(id: string, scope: Scope): Promise<Message> {
        const message = await this.store.requireMessage(id);
        if (!reaches(scope, message.mailbox)) throw new NotFoundError(`Message ${id} not found`);
        return message;
    }

    async requireThread(id: string, scope: Scope): Promise<Thread> {
        const thread = await this.store.requireThread(id);
        if (!reaches(scope, thread.mailbox)) throw new NotFoundError(`Thread ${id} not found`);
        return thread;
    }

    /** Scoped actors only reach contacts that take part in one of their threads. */
    private async requireContactAccess(address: string, scope: Scope): Promise<void> {
        if (scope === null) return;
        const threads = await this.store.allThreads();
        if (!threads.some(t => reaches(scope, t.mailbox) && t.participants.includes(address))) {
            throw new NotFoundError(`Contact ${address} not found`);
        }
    }

    private mailboxFor(addresses: string[]): string {
        const bare = addresses.map(bareAddress);
        for (const [id, mailbox] of Object.entries(this.cfg.mailboxes)) {
            if (bare.includes(bareAddress(mailbox.address))) return id;
        }
        return CATCHALL;
    }

    private sendingMailbox(id: string): MailboxConfig {
        const mailbox = this.cfg.mailboxes[id];
        if (!mailbox) throw new InvalidRequestError(`Mailbox "${id}" cannot send (configured: ${Object.keys(this.cfg.mailboxes).join(", ")})`);
        return mailbox;
    }

    // Inbound

    /** Stores an inbound message once per provider id and returns its id. */
    async ingest(providerId: string): Promise<string> {
        const known = await this.store.lookupProviderId(this.provider.name, providerId);
        if (known) return known;
        const inbound = await this.provider.getInbound(providerId);

        return this.store.serialize(async () => {
            const existing = await this.store.lookupProviderId(this.provider.name, providerId);
            if (existing) return existing;

            const mailbox = this.mailboxFor([...inbound.deliveredTo, ...inbound.to, ...inbound.cc]);
            const participants = participantsOf(inbound);
            const threadId = await resolveThreadId(
                this.store,
                {
                    mailbox,
                    inReplyTo: inbound.inReplyTo,
                    references: inbound.references,
                    subject: inbound.subject,
                    participants,
                    at: inbound.receivedAt,
                },
                this.ownAddresses,
                this.cfg.threadWindowDays,
            );
            const message: Message = {
                id: nid(),
                provider: this.provider.name,
                provider_id: inbound.providerId,
                mailbox,
                direction: "in",
                status: "received",
                message_id: inbound.messageId,
                in_reply_to: inbound.inReplyTo,
                references: inbound.references,
                thread_id: threadId,
                from: inbound.from,
                to: inbound.to,
                cc: inbound.cc,
                bcc: inbound.bcc,
                reply_to: inbound.replyTo,
                subject: inbound.subject,
                text: inbound.text ?? (inbound.html ? htmlToText(inbound.html) : ""),
                html: inbound.html,
                headers: inbound.headers,
                attachments: inbound.attachments,
                labels: {},
                note: null,
                created_by: null,
                read: false,
                archived: false,
                created_at: inbound.receivedAt,
                sent_at: null,
                version: 1,
                edited_by_human: false,
            };
            await this.store.putMessage(message);
            await this.store.indexProviderId(this.provider.name, inbound.providerId, message.id);
            if (message.message_id) await this.store.indexMessageId(message.message_id, message.id);
            await refreshThread(this.store, threadId, message.id);
            return message.id;
        });
    }

    async applyEvent(event: ProviderEvent): Promise<void> {
        if (event.type === "received") {
            await this.ingest(event.providerId);
            return;
        }
        await this.applyStatus(event.providerId, event.status, event.messageId);
    }

    /** Status updates never move backwards: a late `sent` does not overwrite `delivered`. */
    applyStatus(providerId: string, status: DeliveryStatus, messageId: string | null): Promise<void> {
        return this.store.serialize(async () => {
            const id = await this.store.lookupProviderId(this.provider.name, providerId);
            if (!id) return;
            const message = await this.store.requireMessage(id);
            if (message.direction !== "out") return;
            const current = STATUS_RANK[message.status as DeliveryStatus] ?? 0;
            if (STATUS_RANK[status] > current) message.status = status;
            if (messageId && messageId !== message.message_id) {
                message.message_id = messageId;
                await this.store.indexMessageId(messageId, id);
            }
            await this.store.putMessage(message);
        });
    }

    // Queries

    /** Matches a thread by its own context or by any participant's contact. */
    private async metaFilter(wanted: Record<string, MetaValue> | undefined) {
        if (!wanted || !Object.keys(wanted).length) return null;
        const threadContexts = await this.store.allThreadContexts();
        const contacts = new Map((await this.store.allContacts()).map(c => [c.address, c]));
        return (threadId: string, participants: string[]) =>
            metaMatches(threadContexts[threadId]?.meta, wanted) ||
            participants.some(p => metaMatches(contacts.get(p)?.meta, wanted));
    }

    async listThreads(input: ListThreadsInput, scope: Scope): Promise<Thread[]> {
        const status = input.status ?? "unanswered";
        const byMeta = await this.metaFilter(input.meta);
        const threads = (await this.store.allThreads()).filter(t => {
            if (!reaches(scope, t.mailbox)) return false;
            if (byMeta && !byMeta(t.id, t.participants)) return false;
            if (input.mailbox && t.mailbox !== input.mailbox) return false;
            if (input.label && !t.labels[input.label]) return false;
            if (input.since && t.last_at < input.since) return false;
            if (status === "archived") return t.archived;
            if (t.archived) return false;
            return status === "all" || (t.last_direction === "in" && !t.has_draft);
        });
        threads.sort((a, b) => b.last_at.localeCompare(a.last_at));
        return threads.slice(0, input.limit ?? 50);
    }

    async search(input: SearchInput, scope: Scope): Promise<MessageView[]> {
        const terms = tokenize(input.query ?? "");
        const byMeta = await this.metaFilter(input.meta);
        if (!terms.length && !byMeta) throw new InvalidRequestError("pass a query with searchable terms, meta, or both");
        const from = input.from?.toLowerCase();
        const hits = (await this.store.allMessages()).filter(m => {
            if (m.status === "discarded" || !reaches(scope, m.mailbox)) return false;
            if (byMeta && !byMeta(m.thread_id, participantsOf(m))) return false;
            if (input.mailbox && m.mailbox !== input.mailbox) return false;
            if (from && !bareAddress(m.from).includes(from)) return false;
            const at = messageTime(m);
            if (input.since && at < input.since) return false;
            if (input.until && at > input.until) return false;
            const haystack = tokenize([m.subject, m.text, m.from, ...m.to].join(" ")).join(" ");
            return terms.every(term => haystack.includes(term));
        });
        hits.sort((a, b) => messageTime(b).localeCompare(messageTime(a)));
        return hits.slice(0, input.limit ?? 50).map(toView);
    }

    async getThread(threadId: string, scope: Scope): Promise<{ thread: Thread; context: Context | null; contacts: Contact[]; messages: MessageView[] }> {
        const thread = await this.requireThread(threadId, scope);
        return { thread, ...(await this.contextOf(thread)), messages: (await threadMessages(this.store, thread)).map(toView) };
    }

    /** The thread's own context and the contacts of its external participants that have one. */
    async contextOf(thread: Thread): Promise<{ context: Context | null; contacts: Contact[] }> {
        const external = thread.participants.filter(p => !this.ownAddresses.has(p));
        const contacts = (await Promise.all(external.map(p => this.store.getContact(p)))).filter((c): c is Contact => !!c);
        return { context: await this.store.getThreadContext(thread.id), contacts };
    }

    // Context

    async getContact(address: string, scope: Scope): Promise<Contact | null> {
        const bare = bareAddress(address);
        await this.requireContactAccess(bare, scope);
        return this.store.getContact(bare);
    }

    async setContact(address: string, patch: ContextPatch, actor: Actor): Promise<Contact> {
        const bare = bareAddress(address);
        if (!bare.includes("@")) throw new InvalidRequestError(`"${address}" is not an email address`);
        await this.requireContactAccess(bare, actor.scope);
        return this.store.serialize(async () => {
            const contact: Contact = { address: bare, ...this.merge(await this.store.getContact(bare), patch, actor) };
            await this.store.putContact(contact);
            await this.store.audit("contact.update", actor, bare, { ...patch });
            return contact;
        });
    }

    setThreadContext(threadId: string, patch: ContextPatch, actor: Actor): Promise<Context> {
        return this.store.serialize(async () => {
            await this.requireThread(threadId, actor.scope);
            const context = this.merge(await this.store.getThreadContext(threadId), patch, actor);
            await this.store.putThreadContext(threadId, context);
            await this.store.audit("thread.context", actor, threadId, { ...patch });
            return context;
        });
    }

    private merge(existing: Context | null, patch: ContextPatch, actor: Actor): Context {
        if (Object.keys(patch.meta ?? {}).some(key => !key.trim())) throw new InvalidRequestError("meta keys must be non-empty");
        return mergeContext(existing, patch, actor);
    }

    async listDrafts(mailbox: string | undefined, scope: Scope): Promise<Message[]> {
        const drafts = await Promise.all((await this.store.draftIds()).map(id => this.store.requireMessage(id)));
        return drafts
            .filter(d => reaches(scope, d.mailbox) && (!mailbox || d.mailbox === mailbox))
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    // Organizing

    /** Message ids, or thread ids to apply the change to every message in the thread. */
    private async resolveMessageIds(ids: string[], scope: Scope): Promise<string[]> {
        const out: string[] = [];
        for (const id of ids) {
            const thread = await this.store.getThread(id);
            if (thread && reaches(scope, thread.mailbox)) out.push(...thread.message_ids);
            else out.push((await this.requireMessage(id, scope)).id);
        }
        return [...new Set(out)];
    }

    private updateMessages(ids: string[], actor: Actor, action: string, change: (m: Message) => void): Promise<number> {
        return this.store.serialize(async () => {
            const messageIds = await this.resolveMessageIds(ids, actor.scope);
            const threads = new Set<string>();
            for (const id of messageIds) {
                const message = await this.store.requireMessage(id);
                change(message);
                await this.store.putMessage(message);
                threads.add(message.thread_id);
            }
            for (const threadId of threads) await refreshThread(this.store, threadId);
            await this.store.audit(action, actor, ids.join(","));
            return messageIds.length;
        });
    }

    label(ids: string[], add: string[], remove: string[], actor: Actor): Promise<number> {
        return this.updateMessages(ids, actor, "label", m => {
            for (const label of add) m.labels[label] = true;
            for (const label of remove) delete m.labels[label];
        });
    }

    mark(ids: string[], flags: { read?: boolean; archived?: boolean }, actor: Actor): Promise<number> {
        return this.updateMessages(ids, actor, "mark", m => {
            if (flags.read !== undefined) m.read = flags.read;
            if (flags.archived !== undefined) m.archived = flags.archived;
        });
    }

    // Drafts and sending

    createDraft(input: CreateDraftInput, actor: Actor): Promise<Message> {
        return this.store.serialize(() => this.createDraftUnlocked(input, actor));
    }

    private async createDraftUnlocked(input: CreateDraftInput, actor: Actor): Promise<Message> {
        const now = new Date().toISOString();
        let mailbox: string;
        let to: string[];
        let cc = input.cc ?? [];
        let subject: string;
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let threadId: string;

        if (input.replyToId) {
            const original = await this.requireMessage(input.replyToId, actor.scope);
            mailbox = input.mailbox ?? original.mailbox;
            const own = bareAddress(this.sendingMailbox(mailbox).address);
            to = input.to ?? (original.direction === "in" ? (original.reply_to.length ? original.reply_to : [original.from]) : original.to);
            if (input.replyAll && !input.cc) {
                const already = new Set([own, ...to.map(bareAddress)]);
                cc = [...original.to, ...original.cc].filter(a => !already.has(bareAddress(a)));
            }
            subject = input.subject ?? replySubject(original.subject);
            inReplyTo = original.message_id;
            references = original.message_id ? [...original.references, original.message_id] : original.references;
            threadId = original.thread_id;
        } else {
            if (!input.mailbox) throw new InvalidRequestError("mailbox is required when not replying");
            if (!input.to?.length) throw new InvalidRequestError("to is required when not replying");
            if (input.subject === undefined) throw new InvalidRequestError("subject is required when not replying");
            mailbox = input.mailbox;
            to = input.to;
            subject = input.subject;
            threadId = nid();
        }
        const sender = this.sendingMailbox(mailbox);
        if (!reaches(actor.scope, mailbox)) throw new InvalidRequestError(`Mailbox "${mailbox}" is not available to ${actor.name}`);

        const draft: Message = {
            id: nid(),
            provider: this.provider.name,
            provider_id: null,
            mailbox,
            direction: "out",
            status: "draft",
            message_id: null,
            in_reply_to: inReplyTo,
            references,
            thread_id: threadId,
            from: formatAddress(sender.name, sender.address),
            to,
            cc,
            bcc: input.bcc ?? [],
            reply_to: [],
            subject,
            text: input.text,
            html: input.html ?? null,
            headers: {},
            attachments: [],
            labels: {},
            note: input.note ?? null,
            created_by: actor.kind === "ui" ? "ui" : "agent",
            read: true,
            archived: false,
            created_at: now,
            sent_at: null,
            version: 1,
            edited_by_human: actor.kind === "ui",
        };
        await this.store.putMessage(draft);
        await this.store.setDraft(draft.id, true);
        await refreshThread(this.store, threadId, draft.id);
        await this.store.audit("draft.create", actor, draft.id);
        return draft;
    }

    private async requireDraft(id: string, scope: Scope): Promise<Message> {
        const draft = await this.requireMessage(id, scope);
        if (draft.status !== "draft") throw new InvalidRequestError(`Message ${id} is not a pending draft (status: ${draft.status})`);
        return draft;
    }

    /**
     * Optimistic concurrency: `version` must be the current one. An agent cannot overwrite a draft a
     * human edited unless it passes `force`. A UI edit regenerates the HTML from the text at send time.
     */
    updateDraft(id: string, version: number, patch: DraftPatch, actor: Actor, force = false): Promise<Message> {
        return this.store.serialize(async () => {
            const draft = await this.requireDraft(id, actor.scope);
            if (draft.version !== version) throw new ConflictError(draft);
            if (actor.kind !== "ui" && draft.edited_by_human && !force) {
                throw new InvalidRequestError(`Draft ${id} was edited by a human; pass force to overwrite it`);
            }
            const changed = Object.keys(patch).filter(k => patch[k as keyof DraftPatch] !== undefined);
            Object.assign(draft, Object.fromEntries(changed.map(k => [k, patch[k as keyof DraftPatch]])));
            if (actor.kind === "ui") {
                draft.edited_by_human = true;
                if (patch.text !== undefined && patch.html === undefined) draft.html = null;
            }
            draft.version += 1;
            await this.store.putMessage(draft);
            await refreshThread(this.store, draft.thread_id);
            await this.store.audit("draft.update", actor, id, { fields: changed, version: draft.version });
            return draft;
        });
    }

    discardDraft(id: string, actor: Actor): Promise<void> {
        return this.store.serialize(async () => {
            const draft = await this.requireDraft(id, actor.scope);
            draft.status = "discarded";
            await this.store.putMessage(draft);
            await this.store.setDraft(id, false);
            await refreshThread(this.store, draft.thread_id);
            await this.store.audit("draft.discard", actor, id);
        });
    }

    sendDraft(id: string, actor: Actor): Promise<Message> {
        return this.store.serialize(() => this.sendDraftUnlocked(id, actor));
    }

    /**
     * The draft id is the idempotency key and the Message-ID is stored before the provider call,
     * so retrying a failed send repeats the same request instead of sending twice.
     */
    private async sendDraftUnlocked(id: string, actor: Actor): Promise<Message> {
        const draft = await this.requireDraft(id, actor.scope);
        const sender = this.sendingMailbox(draft.mailbox);
        if (!draft.message_id) {
            draft.message_id = `<${randomUUID()}@${domainOf(sender.address)}>`;
            await this.store.putMessage(draft);
        }
        const headers: Record<string, string> = { "Message-ID": draft.message_id };
        if (draft.in_reply_to) headers["In-Reply-To"] = draft.in_reply_to;
        if (draft.references.length) headers["References"] = draft.references.join(" ");

        const { providerId } = await this.provider.send(
            {
                from: draft.from,
                to: draft.to,
                cc: draft.cc,
                bcc: draft.bcc,
                replyTo: draft.reply_to,
                subject: draft.subject,
                text: sender.signatureText ? `${draft.text}\n\n${sender.signatureText}` : draft.text,
                html: (draft.html ?? textToHtml(draft.text)) + (sender.signatureHtml ? `\n${sender.signatureHtml}` : ""),
                headers,
            },
            draft.id,
        );

        draft.status = "sent";
        draft.provider_id = providerId;
        draft.sent_at = new Date().toISOString();
        draft.headers = headers;
        await this.store.putMessage(draft);
        await this.store.indexProviderId(this.provider.name, providerId, draft.id);
        await this.store.indexMessageId(draft.message_id, draft.id);
        await this.store.setDraft(draft.id, false);
        await refreshThread(this.store, draft.thread_id);
        await this.store.audit("send", actor, draft.id, { provider_id: providerId });
        return draft;
    }

    /** Direct send. If the provider fails, the message stays as a pending draft. */
    send(input: CreateDraftInput, actor: Actor): Promise<Message> {
        return this.store.serialize(async () => {
            const draft = await this.createDraftUnlocked(input, actor);
            return this.sendDraftUnlocked(draft.id, actor);
        });
    }

    reply(messageId: string, text: string, replyAll: boolean, actor: Actor): Promise<Message> {
        return this.send({ replyToId: messageId, replyAll, text }, actor);
    }

    async getAttachmentUrl(messageId: string, attachmentId: string, scope: Scope): Promise<string> {
        const message = await this.requireMessage(messageId, scope);
        if (!message.provider_id || message.direction !== "in") {
            throw new InvalidRequestError(`Message ${messageId} has no downloadable attachments`);
        }
        if (!message.attachments.some(a => a.id === attachmentId)) {
            throw new InvalidRequestError(`Attachment ${attachmentId} not found in message ${messageId}`);
        }
        return this.provider.getAttachmentUrl(message.provider_id, attachmentId);
    }
}

export function toView(m: Message): MessageView {
    return {
        id: m.id,
        thread_id: m.thread_id,
        mailbox: m.mailbox,
        direction: m.direction,
        status: m.status,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        date: messageTime(m),
        text: m.text || (m.html ? htmlToText(m.html) : ""),
        labels: Object.keys(m.labels),
        read: m.read,
        attachments: m.attachments,
        note: m.note,
        version: m.version,
        edited_by_human: m.edited_by_human,
    };
}
