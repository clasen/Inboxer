import { createHash, randomBytes } from "node:crypto";
import DeepBase from "deepbase";
import { fullTextSearch, type SearchPlugin } from "deepbase/plugins/search";
import SqliteDriver from "deepbase-sqlite";
import type { Actor, AuditEntry, Contact, Context, LoginLink, Message, Session, Thread } from "./types.ts";

export function sha1(value: string): string {
    return createHash("sha1").update(value).digest("hex");
}

export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function nid(): string {
    return randomBytes(12).toString("base64url");
}

/**
 * DeepBase paths and the indexes kept beside them. DeepBase has no secondary indexes, so every
 * index is written in the same serialized operation as the record it points to.
 */
export class Store {
    readonly db: DeepBase;
    private readonly search: SearchPlugin;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(dataDir: string) {
        this.search = fullTextSearch({
            indexes: { messages: { path: ["messages"], fields: ["subject", "text", "from", "to"], tags: ["labels"] } },
        });
        this.db = new DeepBase(new SqliteDriver({ path: dataDir, name: "inboxer" })).use(this.search);
    }

    async connect(): Promise<void> {
        await this.db.connect();
        await this.migrateLabels();
    }

    /** Labels were once stored as `{ label: true }`; the search index reads them as an array. */
    private async migrateLabels(): Promise<void> {
        for (const collection of ["messages", "threads"]) {
            const records: Record<string, { labels: string[] | Record<string, true> }> = (await this.db.get(collection)) ?? {};
            for (const [id, record] of Object.entries(records)) {
                if (!Array.isArray(record.labels)) await this.db.set(collection, id, { ...record, labels: Object.keys(record.labels) });
            }
        }
    }

    async close(): Promise<void> {
        await this.queue.catch(() => {});
        await this.db.disconnect();
    }

    /** Runs `fn` after every previously queued write. Inboxer runs in one process, so this makes read-modify-write atomic. */
    serialize<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => {});
        return run;
    }

    getMessage(id: string): Promise<Message | null> {
        return this.db.get("messages", id);
    }

    async requireMessage(id: string): Promise<Message> {
        const message = await this.getMessage(id);
        if (!message) throw new NotFoundError(`Message ${id} not found`);
        return message;
    }

    putMessage(message: Message): Promise<unknown> {
        return this.db.set("messages", message.id, message);
    }

    async allMessages(): Promise<Message[]> {
        return Object.values((await this.db.get("messages")) ?? {});
    }

    /**
     * Messages matching every term of `query` (the last one also as a prefix) and carrying every label,
     * best match first; with no terms, every message with the labels.
     */
    async searchMessages(query: string, labels: string[]): Promise<Message[]> {
        const hits = await this.search.query("messages", query, { prefix: true, ...(labels.length ? { tags: { labels } } : {}) });
        return Promise.all(hits.map(hit => this.requireMessage(hit.key)));
    }

    getThread(id: string): Promise<Thread | null> {
        return this.db.get("threads", id);
    }

    async requireThread(id: string): Promise<Thread> {
        const thread = await this.getThread(id);
        if (!thread) throw new NotFoundError(`Thread ${id} not found`);
        return thread;
    }

    putThread(thread: Thread): Promise<unknown> {
        return this.db.set("threads", thread.id, thread);
    }

    deleteThread(id: string): Promise<unknown> {
        return this.db.del("threads", id);
    }

    async allThreads(): Promise<Thread[]> {
        return Object.values((await this.db.get("threads")) ?? {});
    }

    getContact(address: string): Promise<Contact | null> {
        return this.db.get("contacts", sha1(address));
    }

    putContact(contact: Contact): Promise<unknown> {
        return this.db.set("contacts", sha1(contact.address), contact);
    }

    async allContacts(): Promise<Contact[]> {
        return Object.values((await this.db.get("contacts")) ?? {});
    }

    /** Kept apart from `threads/`, whose summary is rebuilt from the messages on every change. */
    getThreadContext(threadId: string): Promise<Context | null> {
        return this.db.get("thread_context", threadId);
    }

    putThreadContext(threadId: string, context: Context): Promise<unknown> {
        return this.db.set("thread_context", threadId, context);
    }

    async allThreadContexts(): Promise<Record<string, Context>> {
        return (await this.db.get("thread_context")) ?? {};
    }

    async draftIds(): Promise<string[]> {
        return this.db.keys("drafts");
    }

    setDraft(id: string, pending: boolean): Promise<unknown> {
        return pending ? this.db.set("drafts", id, true) : this.db.del("drafts", id);
    }

    lookupMessageId(messageId: string): Promise<string | null> {
        return this.db.get("msgid", sha1(messageId));
    }

    indexMessageId(messageId: string, id: string): Promise<unknown> {
        return this.db.set("msgid", sha1(messageId), id);
    }

    lookupProviderId(provider: string, providerId: string): Promise<string | null> {
        return this.db.get("ext", provider, sha1(providerId));
    }

    indexProviderId(provider: string, providerId: string, id: string): Promise<unknown> {
        return this.db.set("ext", provider, sha1(providerId), id);
    }

    audit(action: string, actor: Actor, target: string | null, detail?: Record<string, unknown>): Promise<unknown> {
        const entry: AuditEntry = { action, actor: `${actor.kind}:${actor.name}`, target, at: new Date().toISOString() };
        if (detail) entry.detail = detail;
        return this.db.set("audit", `${Date.now().toString(36)}${nid()}`, entry);
    }

    async auditEntries(): Promise<AuditEntry[]> {
        return Object.values((await this.db.get("audit")) ?? {});
    }

    getLoginLink(hash: string): Promise<LoginLink | null> {
        return this.db.get("login_links", hash);
    }

    putLoginLink(hash: string, link: LoginLink): Promise<unknown> {
        return this.db.set("login_links", hash, link);
    }

    deleteLoginLink(hash: string): Promise<unknown> {
        return this.db.del("login_links", hash);
    }

    getSession(id: string): Promise<Session | null> {
        return this.db.get("sessions", id);
    }

    putSession(session: Session): Promise<unknown> {
        return this.db.set("sessions", session.id, session);
    }

    deleteSession(id: string): Promise<unknown> {
        return this.db.del("sessions", id);
    }

    async allSessions(): Promise<Session[]> {
        return Object.values((await this.db.get("sessions")) ?? {});
    }

    getSyncCursor(provider: string): Promise<string | null> {
        return this.db.get("sync_cursor", provider);
    }

    setSyncCursor(provider: string, at: string): Promise<unknown> {
        return this.db.set("sync_cursor", provider, at);
    }
}

export class NotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NotFoundError";
    }
}
