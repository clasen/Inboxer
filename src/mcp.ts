import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Access } from "./auth.ts";
import { ConflictError, toView, type Mail } from "./core/mail.ts";
import type { Actor, Message } from "./types.ts";

const VERSION = "0.1.0";

function json(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
    return async (args: A) => {
        try {
            return json(await fn(args));
        } catch (err) {
            const body: Record<string, unknown> = { error: (err as Error).message };
            if (err instanceof ConflictError) body.current = draftView(err.current);
            return { ...json(body), isError: true };
        }
    };
}

function draftView(d: Message) {
    return { ...toView(d), bcc: d.bcc, html: d.html };
}

const addresses = z.array(z.string()).describe("Addresses, e.g. \"Ana <ana@example.com>\" or \"ana@example.com\"");
const isoDate = z.string().describe("ISO 8601 timestamp");

function buildServer(mail: Mail, access: Access, actor: Actor): McpServer {
    const server = new McpServer({ name: "inboxer", version: VERSION });

    server.registerTool("list_mailboxes", { description: "Configured mailboxes, plus the catch-all for unknown recipients." },
        wrap(async () => mail.listMailboxes()));

    server.registerTool("list_threads", {
        description: "Threads, newest first. status: unanswered (last message inbound and no pending draft), all (not archived), archived.",
        inputSchema: {
            mailbox: z.string().optional(),
            status: z.enum(["unanswered", "all", "archived"]).optional().describe("Default: unanswered"),
            label: z.string().optional(),
            since: isoDate.optional(),
            limit: z.number().int().positive().optional().describe("Default: 50"),
        },
    }, wrap(async args => mail.listThreads(args)));

    server.registerTool("search", {
        description: "Full-text search over subject, body, from and to. Accent and case insensitive; every term must match.",
        inputSchema: {
            query: z.string(),
            mailbox: z.string().optional(),
            from: z.string().optional().describe("Substring of the sender address"),
            since: isoDate.optional(),
            until: isoDate.optional(),
            limit: z.number().int().positive().optional().describe("Default: 50"),
        },
    }, wrap(async args => mail.search(args)));

    server.registerTool("get_thread", {
        description: "A thread with its messages as plain text, pending drafts included.",
        inputSchema: { thread_id: z.string() },
    }, wrap(async ({ thread_id }) => mail.getThread(thread_id)));

    server.registerTool("label", {
        description: "Add or remove labels. ids are message ids or thread ids (applies to every message in the thread).",
        inputSchema: { ids: z.array(z.string()), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() },
    }, wrap(async ({ ids, add, remove }) => ({ updated: await mail.label(ids, add ?? [], remove ?? [], actor) })));

    server.registerTool("mark", {
        description: "Set read and/or archived. ids are message ids or thread ids.",
        inputSchema: { ids: z.array(z.string()), read: z.boolean().optional(), archived: z.boolean().optional() },
    }, wrap(async ({ ids, read, archived }) => ({ updated: await mail.mark(ids, { read, archived }, actor) })));

    server.registerTool("create_draft", {
        description: "Create a draft for a human to review. Pass reply_to_id to reply (recipients, subject and threading are derived), or mailbox + to + subject for a new conversation. note is shown to the reviewer.",
        inputSchema: {
            mailbox: z.string().optional(),
            reply_to_id: z.string().optional().describe("Message id to reply to"),
            reply_all: z.boolean().optional(),
            to: addresses.optional(),
            cc: addresses.optional(),
            bcc: addresses.optional(),
            subject: z.string().optional(),
            text: z.string(),
            html: z.string().optional(),
            note: z.string().optional(),
        },
    }, wrap(async a => draftView(await mail.createDraft({
        mailbox: a.mailbox, replyToId: a.reply_to_id, replyAll: a.reply_all, to: a.to, cc: a.cc, bcc: a.bcc,
        subject: a.subject, text: a.text, html: a.html, note: a.note,
    }, actor))));

    server.registerTool("update_draft", {
        description: "Update a pending draft. version must be the current one. Fails if a human edited the draft unless force is true.",
        inputSchema: {
            id: z.string(),
            version: z.number().int(),
            to: addresses.optional(),
            cc: addresses.optional(),
            bcc: addresses.optional(),
            subject: z.string().optional(),
            text: z.string().optional(),
            html: z.string().nullable().optional(),
            note: z.string().nullable().optional(),
            force: z.boolean().optional(),
        },
    }, wrap(async ({ id, version, force, ...patch }) => draftView(await mail.updateDraft(id, version, patch, actor, force ?? false))));

    server.registerTool("list_drafts", {
        description: "Pending drafts, newest first.",
        inputSchema: { mailbox: z.string().optional() },
    }, wrap(async ({ mailbox }) => (await mail.listDrafts(mailbox)).map(draftView)));

    server.registerTool("discard_draft", { description: "Discard a pending draft.", inputSchema: { id: z.string() } },
        wrap(async ({ id }) => { await mail.discardDraft(id, actor); return { discarded: id }; }));

    server.registerTool("send_draft", { description: "Send the last saved version of a draft.", inputSchema: { id: z.string() } },
        wrap(async ({ id }) => toView(await mail.sendDraft(id, actor))));

    server.registerTool("send", {
        description: "Send a new message directly, without review. Use only when your rules allow it.",
        inputSchema: {
            mailbox: z.string(),
            to: addresses,
            cc: addresses.optional(),
            bcc: addresses.optional(),
            subject: z.string(),
            text: z.string(),
            html: z.string().optional(),
        },
    }, wrap(async a => toView(await mail.send({ ...a }, actor))));

    server.registerTool("reply", {
        description: "Reply directly to a message, without review. Use only when your rules allow it.",
        inputSchema: { message_id: z.string().describe("Inboxer message id"), text: z.string(), reply_all: z.boolean().optional() },
    }, wrap(async ({ message_id, text, reply_all }) => toView(await mail.reply(message_id, text, reply_all ?? false, actor))));

    server.registerTool("get_attachment", {
        description: "Temporary download URL for an inbound attachment.",
        inputSchema: { message_id: z.string(), attachment_id: z.string() },
    }, wrap(async ({ message_id, attachment_id }) => ({ url: await mail.getAttachmentUrl(message_id, attachment_id) })));

    server.registerTool("create_login_link", {
        description: "One-time link that signs one browser into the review UI. Expires unused after a few minutes.",
        inputSchema: { label: z.string().optional().describe("Shown in the device list, e.g. \"Martin's phone\"") },
    }, wrap(async ({ label }) => access.createLoginLink(actor, label ?? null)));

    server.registerTool("list_sessions", { description: "Browsers signed into the UI." },
        wrap(async () => access.listSessions()));

    server.registerTool("revoke_session", { description: "Sign a browser out of the UI.", inputSchema: { id: z.string() } },
        wrap(async ({ id }) => ({ revoked: await access.revokeSession(id, actor) })));

    return server;
}

/** Stateless Streamable HTTP: a fresh server and transport per request. */
export async function handleMcp(req: Request, mail: Mail, access: Access, actor: Actor): Promise<Response> {
    const server = buildServer(mail, access, actor);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
        return await transport.handleRequest(req);
    } finally {
        await server.close();
    }
}
