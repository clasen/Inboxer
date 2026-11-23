import { randomUUID } from "node:crypto";
import { tokenize } from "deepbase/plugins/search";
import type { DeliveryStatus, MailProvider, ProviderEvent, ProviderKind, ProviderMessage } from "../provider/types.ts";
import { reaches } from "../config.ts";
import { NotFoundError, nid, type Store } from "../store.ts";
import { CATCHALL, type Actor, type Contact, type Context, type AttachmentMeta, type InboxerConfig, type MailboxConfig, type Message, type MetaValue, type PendingAction, type Scope, type Thread } from "../types.ts";
import { AttachmentFiles } from "./attachments.ts";
import { bareAddress, domainOf, formatAddress, phoneAddress } from "./address.ts";
import { mergeContext, metaMatches, type ContextPatch } from "./context.ts";
import { htmlToText, replySubject, textToHtml } from "./text.ts";
import { chatThreadId, messageTime, participantsOf, refreshThread, resolveThreadId, threadMessages } from "./threads.ts";

const STATUS_RANK: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, read: 3, bounced: 4, failed: 4 };

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

/** The one phone number a chat message goes to. */
function chatRecipient(to: string[]): string[] {
    if (to.length !== 1) throw new InvalidRequestError("a chat message takes exactly one recipient");
    const phone = phoneAddress(to[0]!);
    if (!phone) throw new InvalidRequestError(`"${to[0]}" is not a phone number`);
    return [phone];
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
    /** Every one must be on the message. */
    labels?: string[];
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
    readonly providers: Record<string, MailProvider>;
    readonly cfg: InboxerConfig;
    private readonly ownAddresses: Set<string>;
    private readonly domains: Set<string>;
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly files: AttachmentFiles;
    /** Fires "change" after every write, so open pages can refresh. */
    readonly changes = new EventTarget();

    constructor(store: Store, providers: Record<string, MailProvider>, cfg: InboxerConfig) {
        this.store = store;
        this.providers = providers;
        this.cfg = cfg;
        const mailboxes = Object.values(cfg.mailboxes);
        for (const [name, provider] of Object.entries(providers)) {
            if (provider.name !== name) throw new Error(`Provider "${provider.name}" is registered as "${name}"`);
            if (provider.kind === "chat" && mailboxes.filter(m => m.provider === name).length !== 1) {
                throw new Error(`Invalid inboxer config: chat provider "${name}" must serve exactly one mailbox`);
            }
        }
        this.ownAddresses = new Set(mailboxes.map(m => bareAddress(m.address)));
        this.domains = new Set(mailboxes.filter(m => this.provider(m.provider).kind === "mail").map(m => domainOf(m.address)));
        this.files = new AttachmentFiles(cfg.dataDir);
    }

    /** Runs `fn` in the store's write queue, then announces the change. */
    private async write<T>(fn: () => Promise<T>): Promise<T> {
        const result = await this.store.serialize(fn);
        this.changes.dispatchEvent(new Event("change"));
        return result;
    }

    private provider(name: string): MailProvider {
        const provider = this.providers[name];
        if (!provider) throw new Error(`Unknown provider "${name}"`);
        return provider;
    }

    /** The catch-all only collects mail. */
    kindOf(mailbox: string): ProviderKind {
        const configured = this.cfg.mailboxes[mailbox];
        return configured ? this.provider(configured.provider).kind : "mail";
    }

    /** Whether the review UI may draft and send in `mailbox`. */
    uiCanWrite(mailbox: string): boolean {
        return !this.cfg.mailboxes[mailbox]?.uiReadOnly;
    }

    private assertCanWrite(mailbox: string, actor: Actor): void {
        if (actor.kind === "ui" && !this.uiCanWrite(mailbox)) throw new InvalidRequestError(`Mailbox "${mailbox}" is read-only in the review UI`);
    }

    listMailboxes(scope: Scope): { id: string; address: string; name: string; kind: ProviderKind }[] {
        return [
            ...Object.entries(this.cfg.mailboxes).map(([id, m]) => ({ id, address: m.address, name: m.name, kind: this.kindOf(id) })),
            { id: CATCHALL, address: "*", name: "Catch-all", kind: "mail" as const },
        ].filter(m => reaches(scope, m.id));
    }

    /** A configured mailbox address or any other address on a mail domain, such as one the catch-all received. */
    isOwn(address: string): boolean {
        const bare = bareAddress(address);
        return this.ownAddresses.has(bare) || this.domains.has(domainOf(bare));
    }

    /** The first address on our domains that is not a configured mailbox: the one a catch-all message was written to. */
    private catchAllAddress(addresses: string[]): string | null {
        return addresses.map(bareAddress).find(a => this.domains.has(domainOf(a)) && !this.ownAddresses.has(a)) ?? null;
    }

    /** The account a thread belongs to: its mailbox or, in the catch-all, the address it was written to. */
    accountOf(thread: Thread): string {
        return thread.mailbox === CATCHALL ? this.catchAllAddress(thread.participants) ?? CATCHALL : thread.mailbox;
    }

    /** The address an account receives mail at: a configured mailbox's address, or the catch-all address itself. */
    addressOf(account: string): string {
        const mailbox = this.cfg.mailboxes[account];
        return mailbox ? bareAddress(mailbox.address) : account;
    }

    /** Mailboxes in scope, with the catch-all split into the addresses it has received mail for. */
    async listAccounts(scope: Scope): Promise<string[]> {
        const mailboxes = this.listMailboxes(scope).map(m => m.id).filter(id => id !== CATCHALL);
        if (!reaches(scope, CATCHALL)) return mailboxes;
        const caught = (await this.store.allThreads()).filter(t => t.mailbox === CATCHALL).map(t => this.accountOf(t));
        return [...mailboxes, ...[...new Set(caught)].sort()];
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

    /** A chat provider serves one mailbox; mail goes to the mailbox it is addressed to, else to the catch-all. */
    private mailboxFor(provider: MailProvider, addresses: string[]): string {
        const served = Object.entries(this.cfg.mailboxes).filter(([, m]) => m.provider === provider.name);
        if (provider.kind === "chat") return served[0]![0];
        const bare = addresses.map(bareAddress);
        return served.find(([, m]) => bare.includes(bareAddress(m.address)))?.[0] ?? CATCHALL;
    }

    /** Who sends for `id`; the catch-all answers as `address`, with the name and signature of a mailbox on that domain. */
    private sendingMailbox(id: string, address: string | null): MailboxConfig {
        const peer = id === CATCHALL && address ? Object.values(this.cfg.mailboxes).find(m => domainOf(m.address) === domainOf(address)) : undefined;
        if (peer && address) return { name: peer.name, address: bareAddress(address), provider: peer.provider, signatureText: peer.signatureText, signatureHtml: peer.signatureHtml };
        const mailbox = this.cfg.mailboxes[id];
        if (!mailbox) throw new InvalidRequestError(`Mailbox "${id}" cannot send (configured: ${Object.keys(this.cfg.mailboxes).join(", ")})`);
        return mailbox;
    }

    // Inbound

    /**
     * Stores a message the provider holds once per provider id and returns its id: one received, or
     * one sent on the account by someone else. A message already known only takes the delivery
     * status that came with it. Attachments are copied to disk right away; one that fails to
     * download is fetched again the first time it is opened.
     */
    async ingest(providerName: string, providerId: string, given?: ProviderMessage): Promise<string> {
        const provider = this.provider(providerName);
        const known = await this.store.lookupProviderId(provider.name, providerId);
        if (known) {
            if (given?.status) await this.applyStatus(provider.name, providerId, given.status, null);
            return known;
        }
        const id = await this.storeMessage(provider, given ?? await provider.getMessage(providerId));
        const message = await this.store.requireMessage(id);
        for (const meta of message.attachments) {
            await this.attachmentBody(message, meta).catch(err =>
                console.error(`inboxer: attachment ${meta.id} of message ${id} not stored`, err));
        }
        return id;
    }

    private storeMessage(provider: MailProvider, given: ProviderMessage): Promise<string> {
        return this.write(async () => {
            const existing = await this.store.lookupProviderId(provider.name, given.providerId);
            if (existing) return existing;

            const incoming = given.direction === "in";
            const mailbox = this.mailboxFor(provider, incoming ? [...given.deliveredTo, ...given.to, ...given.cc] : [given.from]);
            const line = provider.kind === "chat" ? this.cfg.mailboxes[mailbox]! : null;
            const inbound: ProviderMessage = line
                ? { ...given, ...(incoming ? { to: [bareAddress(line.address)] } : { from: formatAddress(line.name, line.address) }) }
                : given;
            const threadId = line
                ? await chatThreadId(this.store, mailbox, bareAddress(incoming ? inbound.from : inbound.to[0]!))
                : await resolveThreadId(
                    this.store,
                    {
                        mailbox,
                        inReplyTo: inbound.inReplyTo,
                        references: inbound.references,
                        subject: inbound.subject,
                        participants: participantsOf(inbound),
                        at: inbound.at,
                    },
                    address => this.isOwn(address),
                    this.cfg.threadWindowDays,
                );
            const message: Message = {
                id: nid(),
                provider: provider.name,
                provider_id: inbound.providerId,
                mailbox,
                direction: inbound.direction,
                status: incoming ? "received" : inbound.status ?? "sent",
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
                labels: [],
                note: null,
                created_by: null,
                read: !incoming,
                archived: false,
                created_at: inbound.at,
                sent_at: incoming ? null : inbound.at,
                version: 1,
                edited_by_human: false,
                pending: null,
            };
            await this.store.putMessage(message);
            await this.store.indexProviderId(provider.name, inbound.providerId, message.id);
            if (message.message_id) await this.store.indexMessageId(message.message_id, message.id);
            await refreshThread(this.store, threadId, message.id);
            return message.id;
        });
    }

    async applyEvent(provider: string, event: ProviderEvent): Promise<void> {
        if (event.type === "message") {
            await this.ingest(provider, event.providerId, event.message);
            return;
        }
        await this.applyStatus(provider, event.providerId, event.status, event.messageId);
    }

    /** Status updates never move backwards: a late `sent` does not overwrite `delivered`. */
    applyStatus(provider: string, providerId: string, status: DeliveryStatus, messageId: string | null): Promise<void> {
        return this.write(async () => {
            const id = await this.store.lookupProviderId(provider, providerId);
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
            if (input.mailbox && t.mailbox !== input.mailbox && this.accountOf(t) !== input.mailbox) return false;
            if (input.label && !t.labels.includes(input.label)) return false;
            if (input.since && t.last_at < input.since) return false;
            if (status === "archived") return t.archived;
            if (t.archived) return false;
            return status === "all" || (t.last_direction === "in" && !t.has_draft);
        });
        threads.sort((a, b) => b.last_at.localeCompare(a.last_at));
        return threads.slice(0, input.limit ?? 50);
    }

    async search(input: SearchInput, scope: Scope): Promise<MessageView[]> {
        return (await this.matchingMessages(input, scope)).slice(0, input.limit ?? 50).map(toView);
    }

    /** Threads with a message matching `query`, best match first; none when the query has no terms. */
    async searchThreads(query: string, mailbox: string | undefined, scope: Scope, limit: number): Promise<Thread[]> {
        if (!tokenize(query).length) return [];
        const ids = [...new Set((await this.matchingMessages({ query }, scope)).map(m => m.thread_id))];
        const threads = await Promise.all(ids.map(id => this.store.requireThread(id)));
        return threads.filter(t => !mailbox || t.mailbox === mailbox || this.accountOf(t) === mailbox).slice(0, limit);
    }

    /** Best match first when the query has terms, newest first otherwise. */
    private async matchingMessages(input: SearchInput, scope: Scope): Promise<Message[]> {
        const ranked = tokenize(input.query ?? "").length > 0;
        const labels = input.labels ?? [];
        const byMeta = await this.metaFilter(input.meta);
        if (!ranked && !labels.length && !byMeta) throw new InvalidRequestError("pass a query with searchable terms, labels, meta, or a combination");
        const from = input.from?.toLowerCase();
        const candidates = ranked || labels.length ? await this.store.searchMessages(input.query ?? "", labels) : await this.store.allMessages();
        const hits = candidates.filter(m => {
            if (m.status === "discarded" || !reaches(scope, m.mailbox)) return false;
            if (byMeta && !byMeta(m.thread_id, participantsOf(m))) return false;
            if (input.mailbox && m.mailbox !== input.mailbox) return false;
            if (from && !bareAddress(m.from).includes(from)) return false;
            const at = messageTime(m);
            if (input.since && at < input.since) return false;
            return !(input.until && at > input.until);
        });
        if (!ranked) hits.sort((a, b) => messageTime(b).localeCompare(messageTime(a)));
        return hits;
    }

    async getThread(threadId: string, scope: Scope): Promise<{ thread: Thread; context: Context | null; contacts: Contact[]; messages: MessageView[] }> {
        const thread = await this.requireThread(threadId, scope);
        return { thread, ...(await this.contextOf(thread)), messages: (await threadMessages(this.store, thread)).map(toView) };
    }

    /** The thread's own context and the contacts of its external participants that have one. */
    async contextOf(thread: Thread): Promise<{ context: Context | null; contacts: Contact[] }> {
        const external = thread.participants.filter(p => !this.isOwn(p));
        const contacts = (await Promise.all(external.map(p => this.store.getContact(p)))).filter((c): c is Contact => !!c);
        return { context: await this.store.getThreadContext(thread.id), contacts };
    }

    // Context

    async getContact(address: string, scope: Scope): Promise<Contact | null> {
        const bare = phoneAddress(address) ?? bareAddress(address);
        await this.requireContactAccess(bare, scope);
        return this.store.getContact(bare);
    }

    async setContact(address: string, patch: ContextPatch, actor: Actor): Promise<Contact> {
        const bare = phoneAddress(address) ?? bareAddress(address);
        if (!bare.includes("@") && !bare.startsWith("+")) throw new InvalidRequestError(`"${address}" is not an email address or a phone number`);
        await this.requireContactAccess(bare, actor.scope);
        return this.write(async () => {
            const contact: Contact = { address: bare, ...this.merge(await this.store.getContact(bare), patch, actor) };
            await this.store.putContact(contact);
            await this.store.audit("contact.update", actor, bare, { ...patch });
            return contact;
        });
    }

    setThreadContext(threadId: string, patch: ContextPatch, actor: Actor): Promise<Context> {
        return this.write(async () => {
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
        return this.write(async () => {
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
            m.labels = [...new Set([...m.labels, ...add])].filter(label => !remove.includes(label));
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
        return this.write(() => this.createDraftUnlocked(input, actor));
    }

    /** Who a reply to `replyToId` goes to and its subject, without creating anything. */
    async replyTo(replyToId: string, replyAll: boolean, scope: Scope): Promise<{ mailbox: string; to: string[]; cc: string[]; subject: string }> {
        return this.replyDefaults(await this.requireMessage(replyToId, scope), {}, replyAll);
    }

    private replyDefaults(original: Message, given: { mailbox?: string; to?: string[] }, replyAll: boolean) {
        const mailbox = given.mailbox ?? original.mailbox;
        const to = given.to ?? (original.direction === "in" ? (original.reply_to.length ? original.reply_to : [original.from]) : original.to);
        const caught = mailbox === CATCHALL ? this.catchAllAddress(original.direction === "out" ? [original.from] : [...original.to, ...original.cc]) : null;
        const sender = this.sendingMailbox(mailbox, caught);
        const already = new Set([bareAddress(sender.address), ...to.map(bareAddress)]);
        const cc = replyAll ? [...original.to, ...original.cc].filter(a => !already.has(bareAddress(a))) : [];
        return { mailbox, sender, to, cc, subject: replySubject(original.subject) };
    }

    private async createDraftUnlocked(input: CreateDraftInput, actor: Actor): Promise<Message> {
        const now = new Date().toISOString();
        let mailbox: string;
        let sender: MailboxConfig;
        let to: string[];
        let cc = input.cc ?? [];
        let subject: string | undefined;
        let inReplyTo: string | null = null;
        let references: string[] = [];
        let threadId: string | undefined;

        if (input.replyToId) {
            const original = await this.requireMessage(input.replyToId, actor.scope);
            const defaults = this.replyDefaults(original, input, !!input.replyAll && !input.cc);
            mailbox = defaults.mailbox;
            sender = defaults.sender;
            to = defaults.to;
            if (!input.cc) cc = defaults.cc;
            subject = input.subject ?? defaults.subject;
            inReplyTo = original.message_id;
            references = original.message_id ? [...original.references, original.message_id] : original.references;
            threadId = original.thread_id;
        } else {
            if (!input.mailbox) throw new InvalidRequestError("mailbox is required when not replying");
            if (!input.to?.length) throw new InvalidRequestError("to is required when not replying");
            mailbox = input.mailbox;
            sender = this.sendingMailbox(mailbox, null);
            to = input.to;
            subject = input.subject;
        }
        if (!reaches(actor.scope, mailbox)) throw new InvalidRequestError(`Mailbox "${mailbox}" is not available to ${actor.name}`);
        this.assertCanWrite(mailbox, actor);

        if (this.provider(sender.provider).kind === "chat") {
            if (cc.length || input.bcc?.length || input.html !== undefined || input.subject) {
                throw new InvalidRequestError(`Mailbox "${mailbox}" is a chat: a message is plain text to one phone number`);
            }
            to = chatRecipient(to);
            subject = "";
            threadId ??= await chatThreadId(this.store, mailbox, to[0]!);
        }
        if (subject === undefined) throw new InvalidRequestError("subject is required when not replying");
        threadId ??= nid();

        const draft: Message = {
            id: nid(),
            provider: sender.provider,
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
            labels: [],
            note: input.note ?? null,
            created_by: actor.kind === "ui" ? "ui" : "agent",
            read: true,
            archived: false,
            created_at: now,
            sent_at: null,
            version: 1,
            edited_by_human: actor.kind === "ui",
            pending: null,
        };
        await this.store.putMessage(draft);
        await this.store.setDraft(draft.id, true);
        await refreshThread(this.store, threadId, draft.id);
        await this.store.audit("draft.create", actor, draft.id);
        return draft;
    }

    private async requireDraft(id: string, actor: Actor): Promise<Message> {
        const draft = await this.requireMessage(id, actor.scope);
        if (draft.status !== "draft") throw new InvalidRequestError(`Message ${id} is not a pending draft (status: ${draft.status})`);
        this.assertCanWrite(draft.mailbox, actor);
        return draft;
    }

    /**
     * Optimistic concurrency: `version` must be the current one. An agent cannot overwrite a draft a
     * human edited unless it passes `force`. A UI edit regenerates the HTML from the text at send time.
     */
    updateDraft(id: string, version: number, patch: DraftPatch, actor: Actor, force = false): Promise<Message> {
        return this.write(async () => {
            const draft = await this.requireDraft(id, actor);
            if (draft.version !== version) throw new ConflictError(draft);
            if (draft.pending) throw new InvalidRequestError(`Draft ${id} is about to ${draft.pending.action}; undo it first`);
            if (actor.kind !== "ui" && draft.edited_by_human && !force) {
                throw new InvalidRequestError(`Draft ${id} was edited by a human; pass force to overwrite it`);
            }
            const changed = Object.keys(patch).filter(k => patch[k as keyof DraftPatch] !== undefined);
            Object.assign(draft, Object.fromEntries(changed.map(k => [k, patch[k as keyof DraftPatch]])));
            if (this.provider(draft.provider).kind === "chat") {
                if (draft.cc.length || draft.bcc.length || draft.html || draft.subject) {
                    throw new InvalidRequestError(`Draft ${id} is a chat message: plain text to one phone number`);
                }
                draft.to = chatRecipient(draft.to);
            }
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
        return this.write(() => this.discardDraftUnlocked(id, actor));
    }

    private async discardDraftUnlocked(id: string, actor: Actor): Promise<void> {
        const draft = await this.requireDraft(id, actor);
        draft.status = "discarded";
        draft.pending = null;
        await this.store.putMessage(draft);
        await this.store.setDraft(id, false);
        await refreshThread(this.store, draft.thread_id);
        await this.store.audit("draft.discard", actor, id);
    }

    /** Attaching does not change `version`: it never conflicts with text edits in flight. */
    attach(id: string, file: { filename: string; contentType: string; body: Uint8Array }, actor: Actor): Promise<Message> {
        return this.write(async () => {
            const draft = await this.requireDraft(id, actor);
            if (draft.pending) throw new InvalidRequestError(`Draft ${id} is about to ${draft.pending.action}; undo it first`);
            if (draft.attachments.length && this.provider(draft.provider).kind === "chat") {
                throw new InvalidRequestError(`Draft ${id} is a chat message: it carries one attachment`);
            }
            const meta: AttachmentMeta = {
                id: nid(),
                filename: file.filename,
                content_type: file.contentType || "application/octet-stream",
                size: file.body.byteLength,
                inline: false,
                content_id: null,
            };
            await this.files.write(draft.id, meta.id, file.body);
            draft.attachments.push(meta);
            await this.store.putMessage(draft);
            await this.store.audit("draft.attach", actor, id, { filename: meta.filename, size: meta.size });
            return draft;
        });
    }

    detach(id: string, attachmentId: string, actor: Actor): Promise<Message> {
        return this.write(async () => {
            const draft = await this.requireDraft(id, actor);
            if (draft.pending) throw new InvalidRequestError(`Draft ${id} is about to ${draft.pending.action}; undo it first`);
            const index = draft.attachments.findIndex(a => a.id === attachmentId);
            if (index < 0) throw new NotFoundError(`Attachment ${attachmentId} not found in draft ${id}`);
            const [removed] = draft.attachments.splice(index, 1);
            await this.store.putMessage(draft);
            await this.store.audit("draft.detach", actor, id, { filename: removed!.filename });
            return draft;
        });
    }

    // Undo window: a human's send or discard waits `ui.undoSec` and survives a restart.

    /** Starts the undo window for a send or discard. Calling it again keeps the first one. */
    schedule(id: string, action: PendingAction["action"], actor: Actor): Promise<Message> {
        return this.write(async () => {
            const draft = await this.requireDraft(id, actor);
            if (!draft.pending) {
                draft.pending = { action, at: new Date(Date.now() + this.cfg.ui.undoSec * 1000).toISOString(), by: actor.name };
                await this.store.putMessage(draft);
                await this.store.audit("draft.schedule", actor, id, { action });
            }
            this.arm(draft);
            return draft;
        });
    }

    undo(id: string, actor: Actor): Promise<Message> {
        return this.write(async () => {
            const draft = await this.requireDraft(id, actor);
            clearTimeout(this.timers.get(id));
            this.timers.delete(id);
            if (draft.pending) {
                const { action } = draft.pending;
                draft.pending = null;
                await this.store.putMessage(draft);
                await this.store.audit("draft.undo", actor, id, { action });
            }
            return draft;
        });
    }

    /** Re-arms undo windows left by a previous process; overdue ones run now. */
    async resumePending(): Promise<void> {
        for (const id of await this.store.draftIds()) {
            const draft = await this.store.requireMessage(id);
            if (draft.pending) this.arm(draft);
        }
    }

    stopPending(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    private arm(draft: Message): void {
        clearTimeout(this.timers.get(draft.id));
        const delay = Math.max(0, Date.parse(draft.pending!.at) - Date.now());
        this.timers.set(draft.id, setTimeout(() => {
            this.runPending(draft.id).catch(err => console.error(`inboxer: pending action on draft ${draft.id} failed`, err));
        }, delay));
    }

    /** A failed send leaves a plain pending draft, so the reviewer sees it was not sent. */
    private runPending(id: string): Promise<void> {
        this.timers.delete(id);
        return this.write(async () => {
            const draft = await this.store.getMessage(id);
            if (!draft || draft.status !== "draft" || !draft.pending) return;
            const { action, by } = draft.pending;
            const actor: Actor = { kind: "ui", name: by, scope: null };
            draft.pending = null;
            await this.store.putMessage(draft);
            if (action === "send") await this.sendDraftUnlocked(id, actor);
            else await this.discardDraftUnlocked(id, actor);
        });
    }

    sendDraft(id: string, actor: Actor): Promise<Message> {
        return this.write(() => this.sendDraftUnlocked(id, actor));
    }

    /**
     * The draft id is the idempotency key and a mail's Message-ID is stored before the provider call,
     * so retrying a failed send repeats the same request instead of sending twice. A chat message
     * goes out as written: no headers, HTML or signature.
     */
    private async sendDraftUnlocked(id: string, actor: Actor): Promise<Message> {
        const draft = await this.requireDraft(id, actor);
        const provider = this.provider(draft.provider);
        const chat = provider.kind === "chat";
        const sender = this.sendingMailbox(draft.mailbox, draft.from);
        const headers: Record<string, string> = {};
        if (!chat) {
            if (!draft.message_id) {
                draft.message_id = `<${randomUUID()}@${domainOf(sender.address)}>`;
                await this.store.putMessage(draft);
            }
            headers["Message-ID"] = draft.message_id;
            if (draft.in_reply_to) headers["In-Reply-To"] = draft.in_reply_to;
            if (draft.references.length) headers["References"] = draft.references.join(" ");
        }

        const attachments = await Promise.all(draft.attachments.map(async a => ({
            filename: a.filename,
            contentType: a.content_type,
            content: await this.attachmentBody(draft, a),
        })));
        const { providerId } = await provider.send(
            {
                from: draft.from,
                to: draft.to,
                cc: draft.cc,
                bcc: draft.bcc,
                replyTo: draft.reply_to,
                subject: draft.subject,
                text: !chat && sender.signatureText ? `${draft.text}\n\n${sender.signatureText}` : draft.text,
                html: chat ? null : (draft.html ?? textToHtml(draft.text)) + (sender.signatureHtml ? `\n${sender.signatureHtml}` : ""),
                headers,
                attachments,
            },
            draft.id,
        );

        draft.status = "sent";
        draft.pending = null;
        draft.provider_id = providerId;
        draft.sent_at = new Date().toISOString();
        draft.headers = headers;
        await this.store.putMessage(draft);
        await this.store.indexProviderId(provider.name, providerId, draft.id);
        if (draft.message_id) await this.store.indexMessageId(draft.message_id, draft.id);
        await this.store.setDraft(draft.id, false);
        await refreshThread(this.store, draft.thread_id);
        await this.store.audit("send", actor, draft.id, { provider_id: providerId });
        return draft;
    }

    /** Direct send. If the provider fails, the message stays as a pending draft. */
    send(input: CreateDraftInput, actor: Actor): Promise<Message> {
        return this.write(async () => {
            const draft = await this.createDraftUnlocked(input, actor);
            return this.sendDraftUnlocked(draft.id, actor);
        });
    }

    reply(messageId: string, text: string, replyAll: boolean, actor: Actor): Promise<Message> {
        return this.send({ replyToId: messageId, replyAll, text }, actor);
    }

    /** An attachment's metadata and bytes, from disk or, the first time for a message the provider holds, from the provider. */
    async getAttachment(messageId: string, attachmentId: string, scope: Scope): Promise<{ meta: AttachmentMeta; body: Uint8Array }> {
        const message = await this.requireMessage(messageId, scope);
        const meta = message.attachments.find(a => a.id === attachmentId);
        if (!meta) throw new NotFoundError(`Attachment ${attachmentId} not found in message ${messageId}`);
        return { meta, body: await this.attachmentBody(message, meta) };
    }

    private async attachmentBody(message: Message, meta: AttachmentMeta): Promise<Uint8Array> {
        const stored = await this.files.read(message.id, meta.id);
        if (stored) return stored;
        if (!message.provider_id || message.created_by) throw new NotFoundError(`Attachment ${meta.id} not found`);
        const body = await this.provider(message.provider).getAttachment(message.provider_id, meta.id);
        await this.files.write(message.id, meta.id, body);
        return body;
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
        labels: m.labels,
        read: m.read,
        attachments: m.attachments,
        note: m.note,
        version: m.version,
        edited_by_human: m.edited_by_human,
    };
}
