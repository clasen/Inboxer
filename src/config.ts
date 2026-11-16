import { isAbsolute } from "node:path";
import { CATCHALL, type InboxerConfig, type Scope } from "./types.ts";

/** Absolute URL of an app path under `publicUrl`. */
export function appUrl(cfg: Pick<InboxerConfig, "publicUrl">, path: string): string {
    return cfg.publicUrl.replace(/\/$/, "") + path;
}

/** UI path of a thread, scrolled to one of its drafts when given. */
export function threadPath(threadId: string, draftId?: string): string {
    return `/threads/${encodeURIComponent(threadId)}` + (draftId ? `#draft-${encodeURIComponent(draftId)}` : "");
}

function fail(path: string, expected: string): never {
    throw new Error(`Invalid inboxer config: ${path} must be ${expected}`);
}

function requireString(value: unknown, path: string): void {
    if (typeof value !== "string" || !value) fail(path, "a non-empty string");
}

function requirePositive(value: unknown, path: string): void {
    if (typeof value !== "number" || !(value > 0)) fail(path, "a positive number");
}

/** Asserts the shape `createInboxer` relies on. */
export function assertConfig(cfg: InboxerConfig, { requireProvider }: { requireProvider: boolean }): void {
    requireString(cfg.publicUrl, "publicUrl");
    requireString(cfg.dataDir, "dataDir");
    if (!isAbsolute(cfg.dataDir)) fail("dataDir", "an absolute path");
    requirePositive(cfg.syncIntervalMin, "syncIntervalMin");
    requirePositive(cfg.threadWindowDays, "threadWindowDays");

    if (!cfg.mailboxes || typeof cfg.mailboxes !== "object") fail("mailboxes", "an object keyed by mailbox id");
    if (CATCHALL in cfg.mailboxes) fail(`mailboxes.${CATCHALL}`, "absent (the id is reserved)");
    for (const [id, mailbox] of Object.entries(cfg.mailboxes)) {
        requireString(mailbox.address, `mailboxes.${id}.address`);
        requireString(mailbox.name, `mailboxes.${id}.name`);
        if (mailbox.tokens !== undefined && (!mailbox.tokens || typeof mailbox.tokens !== "object")) fail(`mailboxes.${id}.tokens`, "an object of named tokens");
    }

    if (requireProvider) requireString(cfg.provider?.type, "provider.type");
    if (!cfg.mcp?.tokens || typeof cfg.mcp.tokens !== "object") fail("mcp.tokens", "an object of named tokens");
    for (const [name, token] of Object.entries(cfg.mcp.tokens)) requireString(token, `mcp.tokens.${name}`);
    mcpTokens(cfg);
    requireString(cfg.ui?.cookieSecret, "ui.cookieSecret");
    requirePositive(cfg.ui?.loginLinkTtlMin, "ui.loginLinkTtlMin");
}

export interface McpToken {
    name: string;
    token: string;
    scope: Scope;
}

/**
 * Tokens in `mcp.tokens` reach every mailbox; tokens under `mailboxes.<id>.tokens` reach only that
 * mailbox. The same name and token under several mailboxes reach all of them.
 */
export function mcpTokens(cfg: InboxerConfig): McpToken[] {
    const byName = new Map<string, McpToken>();
    const add = (name: string, token: unknown, mailbox: string | null, path: string) => {
        requireString(token, path);
        const known = byName.get(name);
        if (known && known.token !== token) fail(path, `the same token as every other entry named "${name}"`);
        for (const other of byName.values()) {
            if (other.name !== name && other.token === token) fail(path, `a token not already used by "${other.name}"`);
        }
        const entry = known ?? { name, token: token as string, scope: [] };
        if (mailbox === null) entry.scope = null;
        else if (entry.scope && !entry.scope.includes(mailbox)) entry.scope.push(mailbox);
        byName.set(name, entry);
    };
    for (const [name, token] of Object.entries(cfg.mcp.tokens)) add(name, token, null, `mcp.tokens.${name}`);
    for (const [id, mailbox] of Object.entries(cfg.mailboxes)) {
        for (const [name, token] of Object.entries(mailbox.tokens ?? {})) add(name, token, id, `mailboxes.${id}.tokens.${name}`);
    }
    return [...byName.values()];
}

/** Whether `scope` reaches `mailbox`. */
export function reaches(scope: Scope, mailbox: string): boolean {
    return scope === null || scope.includes(mailbox);
}

/** Whether `outer` reaches every mailbox `inner` does. */
export function covers(outer: Scope, inner: Scope): boolean {
    return outer === null || (inner !== null && inner.every(m => outer.includes(m)));
}
