import { isAbsolute } from "node:path";
import { CATCHALL, type InboxerConfig } from "./types.ts";

function fail(path: string, expected: string): never {
    throw new Error(`Invalid inboxer config: ${path} must be ${expected}`);
}

function requireString(value: unknown, path: string): void {
    if (typeof value !== "string" || !value) fail(path, "a non-empty string");
}

function requirePositive(value: unknown, path: string): void {
    if (typeof value !== "number" || !(value > 0)) fail(path, "a positive number");
}

/** Asserts the shape `createInboxer` relies on. Configre merges public and secret files before this runs. */
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
    }

    if (requireProvider) requireString(cfg.provider?.type, "provider.type");
    if (!cfg.mcp?.tokens || typeof cfg.mcp.tokens !== "object") fail("mcp.tokens", "an object of named tokens");
    for (const [name, token] of Object.entries(cfg.mcp.tokens)) requireString(token, `mcp.tokens.${name}`);
    requireString(cfg.ui?.cookieSecret, "ui.cookieSecret");
    requirePositive(cfg.ui?.loginLinkTtlMin, "ui.loginLinkTtlMin");
}
