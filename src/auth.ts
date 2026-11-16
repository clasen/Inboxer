import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appUrl, covers, reaches, threadPath, type McpToken } from "./config.ts";
import { NotFoundError, sha256, type Store } from "./store.ts";
import type { Actor, InboxerConfig, LoginLink, Scope, Session } from "./types.ts";

/** The MCP token in `Authorization: Bearer <token>`, or null. Every token is compared in constant time. */
export function matchBearer(header: string | undefined, tokens: McpToken[]): McpToken | null {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    if (!match) return null;
    const presented = createHash("sha256").update(match[1]!).digest();
    let found: McpToken | null = null;
    for (const entry of tokens) {
        const expected = createHash("sha256").update(entry.token).digest();
        if (timingSafeEqual(presented, expected)) found = entry;
    }
    return found;
}

export interface ClientInfo {
    ip: string | null;
    userAgent: string | null;
}

/**
 * One-time login links and the browser sessions they create. Only hashes are stored: a leaked
 * database does not reveal a usable link or cookie.
 */
export class Access {
    private readonly store: Store;
    private readonly cfg: InboxerConfig;

    constructor(store: Store, cfg: InboxerConfig) {
        this.store = store;
        this.cfg = cfg;
    }

    /** The session the link creates reaches the actor's mailboxes. `threadId` makes it open that thread after signing in. */
    async createLoginLink(actor: Actor, label: string | null, threadId: string | null = null): Promise<{ url: string; expires_at: string }> {
        if (threadId && !reaches(actor.scope, (await this.store.requireThread(threadId)).mailbox)) throw new NotFoundError(`Thread ${threadId} not found`);
        const token = randomBytes(32).toString("base64url");
        const now = Date.now();
        const link: LoginLink = {
            created_at: new Date(now).toISOString(),
            expires_at: new Date(now + this.cfg.ui.loginLinkTtlMin * 60_000).toISOString(),
            created_by: actor.name,
            label,
            next: threadId ? threadPath(threadId) : null,
            scope: actor.scope,
        };
        await this.store.serialize(async () => {
            await this.store.putLoginLink(sha256(token), link);
            await this.store.audit("login_link.create", actor, null, { label });
        });
        return { url: appUrl(this.cfg, `/auth/${token}`), expires_at: link.expires_at };
    }

    async isLinkValid(token: string): Promise<boolean> {
        const link = await this.store.getLoginLink(sha256(token));
        return !!link && link.expires_at > new Date().toISOString();
    }

    /** Check-and-delete runs inside the write queue, so only one caller can turn a link into a session. */
    consumeLoginLink(token: string, client: ClientInfo): Promise<{ secret: string; next: string } | null> {
        const hash = sha256(token);
        return this.store.serialize(async () => {
            const link = await this.store.getLoginLink(hash);
            if (!link) return null;
            await this.store.deleteLoginLink(hash);
            if (link.expires_at <= new Date().toISOString()) return null;

            const secret = randomBytes(32).toString("base64url");
            const now = new Date().toISOString();
            const session: Session = {
                id: sha256(secret),
                created_at: now,
                last_seen: now,
                user_agent: client.userAgent,
                ip: client.ip,
                label: link.label,
                created_by: link.created_by,
                scope: link.scope,
            };
            await this.store.putSession(session);
            await this.store.audit("login_link.use", { kind: "ui", name: session.id.slice(0, 12), scope: session.scope }, null, {
                ip: client.ip,
                user_agent: client.userAgent,
                created_by: link.created_by,
            });
            return { secret, next: link.next ?? "/" };
        });
    }

    async authenticate(secret: string): Promise<Session | null> {
        const session = await this.store.getSession(sha256(secret));
        if (!session) return null;
        session.last_seen = new Date().toISOString();
        await this.store.serialize(async () => {
            if (await this.store.getSession(session.id)) await this.store.putSession(session);
        });
        return session;
    }

    /** Sessions whose mailboxes `scope` reaches. */
    async listSessions(scope: Scope): Promise<Session[]> {
        return (await this.store.allSessions())
            .filter(s => covers(scope, s.scope))
            .sort((a, b) => b.last_seen.localeCompare(a.last_seen));
    }

    revokeSession(id: string, actor: Actor, action = "session.revoke"): Promise<boolean> {
        return this.store.serialize(async () => {
            const session = await this.store.getSession(id);
            if (!session || !covers(actor.scope, session.scope)) return false;
            await this.store.deleteSession(id);
            await this.store.audit(action, actor, id);
            return true;
        });
    }
}
