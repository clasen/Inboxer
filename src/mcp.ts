import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { Access } from "./auth.ts";
import { appUrl, threadPath } from "./config.ts";
import { ConflictError, toView, type Mail, type MessageView } from "./core/mail.ts";
import type { Actor, AttachmentMeta, InboxerConfig, Message, Thread } from "./types.ts";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

function json(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

type Cfg = Pick<InboxerConfig, "publicUrl">;

/** `url` opens the message's thread in the review UI, scrolled to the draft when it is one. */
function messageView(cfg: Cfg, m: MessageView) {
    return { ...m, url: appUrl(cfg, threadPath(m.thread_id, m.status === "draft" ? m.id : undefined)) };
}

function draftView(cfg: Cfg, d: Message) {
    return { ...messageView(cfg, toView(d)), bcc: d.bcc, html: d.html, pending: d.pending };
}

function threadView(cfg: Cfg, t: Thread) {
    return { ...t, url: appUrl(cfg, threadPath(t.id)) };
}

function wrap<A>(cfg: Cfg, fn: (args: A) => Promise<unknown>) {
    return async (args: A) => {
        try {
            return json(await fn(args));
        } catch (err) {
            const body: Record<string, unknown> = { error: (err as Error).message };
            if (err instanceof ConflictError) body.current = draftView(cfg, err.current);
            return { ...json(body), isError: true };
        }
    };
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_TYPES = /^(text\/|application\/(json|xml|csv)$)/;

function attachmentContent(cfg: Cfg, messageId: string, meta: AttachmentMeta, body: Uint8Array) {
    const data = Buffer.from(body).toString("base64");
    if (IMAGE_TYPES.has(meta.content_type)) return { type: "image" as const, data, mimeType: meta.content_type };
    if (TEXT_TYPES.test(meta.content_type)) return { type: "text" as const, text: new TextDecoder().decode(body) };
    const uri = appUrl(cfg, `/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(meta.id)}`);
    return { type: "resource" as const, resource: { uri, mimeType: meta.content_type, blob: data } };
}

const addresses = z.array(z.string()).describe("Addresses, e.g. \"Ana <ana@example.com>\" or \"ana@example.com\"; in a chat mailbox, one phone number, e.g. \"+5491155550000\"");
const isoDate = z.string().describe("ISO 8601 timestamp");
const metaFilter = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .describe("Every pair must match the thread's context or a participant's contact; values compare as text");
const metaPatch = z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .describe("Keys to set; null removes a key; keys not sent are kept");
const notePatch = z.string().nullable().describe("Replaces the note; null clears it");

function buildServer(mail: Mail, access: Access, actor: Actor): McpServer {
    const server = new McpServer({ name: "inboxer", version: VERSION });
    const cfg = mail.cfg;

    server.registerTool("list_mailboxes", { description: "Mailboxes this token reaches, each of kind mail or chat (a phone line, e.g. WhatsApp, where addresses are phone numbers and a thread is the whole conversation with one number); tokens for every mailbox also see the catch-all for unknown recipients." },
        wrap(cfg, async () => mail.listMailboxes(actor.scope)));

    server.registerTool("list_threads", {
        description: "Threads, newest first. status: unanswered (last message inbound and no pending draft), all (not archived), archived.",
        inputSchema: {
            mailbox: z.string().optional(),
            status: z.enum(["unanswered", "all", "archived"]).optional().describe("Default: unanswered"),
            label: z.string().optional(),
            since: isoDate.optional(),
            meta: metaFilter.optional(),
            limit: z.number().int().positive().optional().describe("Default: 50"),
        },
    }, wrap(cfg, async args => (await mail.listThreads(args, actor.scope)).map(t => threadView(cfg, t))));

    server.registerTool("search", {
        description: "Full-text search over subject, body, from and to, best match first. Accent and case insensitive; every term must match, the last one also as a prefix. Pass query, labels, meta, or a combination; without query, newest first.",
        inputSchema: {
            query: z.string().optional(),
            labels: z.array(z.string()).optional().describe("Every label must be on the message; case and accent insensitive"),
            meta: metaFilter.optional(),
            mailbox: z.string().optional(),
            from: z.string().optional().describe("Substring of the sender address"),
            since: isoDate.optional(),
            until: isoDate.optional(),
            limit: z.number().int().positive().optional().describe("Default: 50"),
        },
    }, wrap(cfg, async args => (await mail.search(args, actor.scope)).map(m => messageView(cfg, m))));

    server.registerTool("get_thread", {
        description: "A thread with its messages as plain text, pending drafts included, plus the thread's context and the contacts of its participants.",
        inputSchema: { thread_id: z.string() },
    }, wrap(cfg, async ({ thread_id }) => {
        const { thread, messages, ...context } = await mail.getThread(thread_id, actor.scope);
        return { thread: threadView(cfg, thread), ...context, messages: messages.map(m => messageView(cfg, m)) };
    }));

    server.registerTool("get_contact", {
        description: "Context stored for an email address or phone number: meta (e.g. ids in other systems) and a note. null when there is none.",
        inputSchema: { address: z.string() },
    }, wrap(cfg, async ({ address }) => mail.getContact(address, actor.scope)));

    server.registerTool("set_contact", {
        description: "Attach context to an email address or phone number, e.g. meta { license_id: \"BL-2231\" } or a note. Merges with what is stored. Shown in get_thread and in the review UI, and searchable with meta filters.",
        inputSchema: { address: z.string(), meta: metaPatch.optional(), note: notePatch.optional() },
    }, wrap(cfg, async ({ address, meta, note }) => mail.setContact(address, { meta, note }, actor)));

    server.registerTool("set_thread_meta", {
        description: "Attach context to a thread, e.g. meta { ticket: 45 } or a note such as \"promised an answer on Monday\". Merges with what is stored.",
        inputSchema: { thread_id: z.string(), meta: metaPatch.optional(), note: notePatch.optional() },
    }, wrap(cfg, async ({ thread_id, meta, note }) => mail.setThreadContext(thread_id, { meta, note }, actor)));

    server.registerTool("label", {
        description: "Add or remove labels, e.g. add [\"billing\"]. ids are message ids or thread ids (applies to every message in the thread). Find them again with search's labels or list_threads' label.",
        inputSchema: { ids: z.array(z.string()), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() },
    }, wrap(cfg, async ({ ids, add, remove }) => ({ updated: await mail.label(ids, add ?? [], remove ?? [], actor) })));

    server.registerTool("mark", {
        description: "Set read and/or archived. ids are message ids or thread ids.",
        inputSchema: { ids: z.array(z.string()), read: z.boolean().optional(), archived: z.boolean().optional() },
    }, wrap(cfg, async ({ ids, read, archived }) => ({ updated: await mail.mark(ids, { read, archived }, actor) })));

    server.registerTool("create_draft", {
        description: "Create a draft for a human to review. Pass reply_to_id to reply (recipients, subject and threading are derived), or mailbox + to + subject for a new conversation (a chat mailbox takes one phone number and no subject, cc, bcc or html). note is shown to the reviewer. The result's url opens the draft in the review UI; share it with the user.",
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
    }, wrap(cfg, async a => draftView(cfg, await mail.createDraft({
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
    }, wrap(cfg, async ({ id, version, force, ...patch }) => draftView(cfg, await mail.updateDraft(id, version, patch, actor, force ?? false))));

    server.registerTool("list_drafts", {
        description: "Pending drafts, newest first.",
        inputSchema: { mailbox: z.string().optional() },
    }, wrap(cfg, async ({ mailbox }) => (await mail.listDrafts(mailbox, actor.scope)).map(d => draftView(cfg, d))));

    server.registerTool("discard_draft", { description: "Discard a pending draft.", inputSchema: { id: z.string() } },
        wrap(cfg, async ({ id }) => { await mail.discardDraft(id, actor); return { discarded: id }; }));

    server.registerTool("send_draft", { description: "Send the last saved version of a draft.", inputSchema: { id: z.string() } },
        wrap(cfg, async ({ id }) => messageView(cfg, toView(await mail.sendDraft(id, actor)))));

    server.registerTool("send", {
        description: "Send a new message directly, without review. Use only when your rules allow it. subject is required in a mail mailbox; a chat mailbox takes one phone number and text only, and the message joins the conversation with that number.",
        inputSchema: {
            mailbox: z.string(),
            to: addresses,
            cc: addresses.optional(),
            bcc: addresses.optional(),
            subject: z.string().optional(),
            text: z.string(),
            html: z.string().optional(),
        },
    }, wrap(cfg, async a => messageView(cfg, toView(await mail.send({ ...a }, actor)))));

    server.registerTool("reply", {
        description: "Reply directly to a message, without review. Use only when your rules allow it.",
        inputSchema: { message_id: z.string().describe("Inboxer message id"), text: z.string(), reply_all: z.boolean().optional() },
    }, wrap(cfg, async ({ message_id, text, reply_all }) => messageView(cfg, toView(await mail.reply(message_id, text, reply_all ?? false, actor)))));

    server.registerTool("get_attachment", {
        description: "Content of an attachment: images as images, text as text, anything else (e.g. PDF) as an embedded resource. Larger than the server's limit returns an error.",
        inputSchema: { message_id: z.string(), attachment_id: z.string() },
    }, async ({ message_id, attachment_id }) => {
        try {
            const { meta, body } = await mail.getAttachment(message_id, attachment_id, actor.scope);
            if (body.byteLength > cfg.mcp.maxAttachmentMb * 1024 * 1024) {
                throw new Error(`Attachment is ${(body.byteLength / 1048576).toFixed(1)} MB, over the ${cfg.mcp.maxAttachmentMb} MB limit`);
            }
            return { content: [{ type: "text" as const, text: JSON.stringify(meta) }, attachmentContent(cfg, message_id, meta, body)] };
        } catch (err) {
            return { ...json({ error: (err as Error).message }), isError: true };
        }
    });

    server.registerTool("create_login_link", {
        description: "One-time link that signs one browser into the review UI, limited to the mailboxes this token reaches. Expires unused after a few minutes. Pass thread_id to land on that thread after signing in. Browsers already signed in can open a result's url directly.",
        inputSchema: {
            label: z.string().optional().describe("Shown in the device list, e.g. \"Martin's phone\""),
            thread_id: z.string().optional().describe("Thread to open after signing in"),
        },
    }, wrap(cfg, async ({ label, thread_id }) => access.createLoginLink(actor, label ?? null, thread_id ?? null)));

    server.registerTool("list_sessions", { description: "Browsers signed into the UI." },
        wrap(cfg, async () => access.listSessions(actor.scope)));

    server.registerTool("revoke_session", { description: "Sign a browser out of the UI.", inputSchema: { id: z.string() } },
        wrap(cfg, async ({ id }) => ({ revoked: await access.revokeSession(id, actor) })));

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
