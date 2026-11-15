import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sha256, type Store } from "./store.ts";
import type { Actor, InboxerConfig, LoginLink, Session } from "./types.ts";

/** Name of the MCP token in `Authorization: Bearer <token>`, or null. Every token is compared in constant time. */
export function matchBearer(header: string | undefined, tokens: Record<string, string>): string | null {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    if (!match) return null;
    const presented = createHash("sha256").update(match[1]!).digest();
    let found: string | null = null;
    for (const [name, token] of Object.entries(tokens)) {
        const expected = createHash("sha256").update(token).digest();
        if (timingSafeEqual(presented, expected)) found = name;
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

    async createLoginLink(actor: Actor, label: string | null): Promise<{ url: string; expires_at: string }> {
        const token = randomBytes(32).toString("base64url");
        const now = Date.now();
        const link: LoginLink = {
            created_at: new Date(now).toISOString(),
            expires_at: new Date(now + this.cfg.ui.loginLinkTtlMin * 60_000).toISOString(),
            created_by: actor.name,
            label,
        };
        await this.store.serialize(async () => {
            await this.store.putLoginLink(sha256(token), link);
            await this.store.audit("login_link.create", actor, null, { label });
        });
        return { url: `${this.cfg.publicUrl.replace(/\/$/, "")}/auth/${token}`, expires_at: link.expires_at };
    }

    async isLinkValid(token: string): Promise<boolean> {
        const link = await this.store.getLoginLink(sha256(token));
        return !!link && link.expires_at > new Date().toISOString();
    }

    /** Check-and-delete runs inside the write queue, so only one caller can turn a link into a session. */
    consumeLoginLink(token: string, client: ClientInfo): Promise<string | null> {
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
            };
            await this.store.putSession(session);
            await this.store.audit("login_link.use", { kind: "ui", name: session.id.slice(0, 12) }, null, {
                ip: client.ip,
                user_agent: client.userAgent,
                created_by: link.created_by,
            });
            return secret;
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

    async listSessions(): Promise<Session[]> {
        return (await this.store.allSessions()).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
    }

    revokeSession(id: string, actor: Actor, action = "session.revoke"): Promise<boolean> {
        return this.store.serialize(async () => {
            if (!(await this.store.getSession(id))) return false;
            await this.store.deleteSession(id);
            await this.store.audit(action, actor, id);
            return true;
        });
    }
}
