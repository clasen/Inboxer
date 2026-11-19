import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidRequestError, Mail } from "../src/core/mail.ts";
import { Sync } from "../src/core/sync.ts";
import { LINE, startCore, startHarness, testConfig, TOKEN, webhook, type CoreHarness, type Harness } from "./helpers.ts";

const agent = { kind: "agent", name: "bot", scope: null } as const;
const human = { kind: "ui", name: "phone", scope: null } as const;
const LUCIA = "+5491155550000";

describe("chat mailbox", () => {
    let h: CoreHarness;
    beforeEach(async () => { h = await startCore({ chat: true }); });
    afterEach(async () => { await h.close(); });

    const receive = (providerId: string, partial = {}, counterpart?: string) =>
        h.mail.ingest("wa", providerId, h.wa.chatMessage({ providerId, ...partial }, counterpart));

    test("keeps one thread per phone number, with what anyone sent on the line", async () => {
        const first = await receive("in-1", { at: "2026-11-01T10:00:00.000Z" });
        const mirrored = await receive("out-bot", { direction: "out", status: "delivered", text: "Hola Lucía", at: "2026-11-01T10:01:00.000Z" });
        await receive("in-2", { text: "Gracias", at: "2026-11-01T10:02:00.000Z" });
        await receive("other", {}, "Bruno <+5491166660000>");

        const threads = await h.mail.listThreads({ status: "all" }, null);
        assert.equal(threads.length, 2);
        const thread = (await h.mail.getThread((await h.store.requireMessage(first)).thread_id, null));
        assert.deepEqual(thread.messages.map(m => [m.direction, m.status, m.text]), [
            ["in", "received", "Hola, quiero publicitar"],
            ["out", "delivered", "Hola Lucía"],
            ["in", "received", "Gracias"],
        ]);
        assert.deepEqual(thread.thread.participants.sort(), [LINE, LUCIA]);
        assert.deepEqual(thread.thread.names, { [LUCIA]: "Lucía" });
        assert.equal(thread.thread.unread, 2, "a mirrored outbound message is not unread");

        const out = await h.store.requireMessage(mirrored);
        assert.equal(out.from, `"Flight Desk" <${LINE}>`);
        assert.deepEqual(out.to, [LUCIA]);
        assert.equal(out.mailbox, "line");
    });

    test("a reply goes out as written and its echo only updates the status", async () => {
        const inbound = await receive("in-1");
        const sent = await h.mail.reply(inbound, "Te paso los planes", false, agent);

        const [call] = h.wa.sent;
        assert.deepEqual(call!.message.to, [LUCIA]);
        assert.equal(call!.message.text, "Te paso los planes");
        assert.equal(call!.message.html, null);
        assert.equal(call!.message.subject, "");
        assert.deepEqual(call!.message.headers, {});
        assert.equal(h.provider.sent.length, 0, "the mail provider is not involved");

        await h.mail.applyEvent("wa", { type: "message", providerId: sent.provider_id!, message: h.wa.chatMessage({ providerId: sent.provider_id!, direction: "out", status: "delivered" }) });
        const { messages } = await h.mail.getThread(sent.thread_id, null);
        assert.deepEqual(messages.map(m => m.status), ["received", "delivered"]);

        await h.mail.applyEvent("wa", { type: "status", providerId: sent.provider_id!, status: "read", messageId: null });
        await h.mail.applyEvent("wa", { type: "status", providerId: sent.provider_id!, status: "delivered", messageId: null });
        assert.equal((await h.store.requireMessage(sent.id)).status, "read");
    });

    test("a new message joins the conversation with that number, however it is written", async () => {
        const inbound = await receive("in-1");
        const sent = await h.mail.send({ mailbox: "line", to: ["+54 9 11 5555-0000"], text: "Seguimos por acá" }, agent);
        assert.equal(sent.thread_id, (await h.store.requireMessage(inbound)).thread_id);
        assert.deepEqual(sent.to, [LUCIA]);

        const fresh = await h.mail.send({ mailbox: "line", to: ["5491177770000"], text: "Hola" }, agent);
        assert.notEqual(fresh.thread_id, sent.thread_id);
    });

    test("rejects what a chat cannot carry", async () => {
        const base = { mailbox: "line", to: [LUCIA], text: "Hola" };
        await assert.rejects(h.mail.createDraft({ ...base, subject: "Hi" }, agent), InvalidRequestError);
        await assert.rejects(h.mail.createDraft({ ...base, cc: ["+5491166660000"] }, agent), InvalidRequestError);
        await assert.rejects(h.mail.createDraft({ ...base, html: "<p>Hola</p>" }, agent), InvalidRequestError);
        await assert.rejects(h.mail.createDraft({ ...base, to: [LUCIA, "+5491166660000"] }, agent), /exactly one recipient/);
        await assert.rejects(h.mail.createDraft({ ...base, to: ["ana@customer.test"] }, agent), /not a phone number/);

        const draft = await h.mail.createDraft(base, agent);
        await assert.rejects(h.mail.updateDraft(draft.id, draft.version, { subject: "Hi" }, agent), InvalidRequestError);
        const file = { filename: "a.png", contentType: "image/png", body: new Uint8Array([1]) };
        await h.mail.attach(draft.id, file, agent);
        await assert.rejects(h.mail.attach(draft.id, file, agent), /one attachment/);

        await assert.rejects(h.mail.send({ mailbox: "support", to: ["ana@customer.test"], text: "Hola" }, agent), /subject is required/);
    });

    test("media of a mirrored outbound message is fetched from the provider", async () => {
        const id = await receive("out-img", { direction: "out", attachments: [{ id: "media-1", filename: "preview.png", content_type: "image/png", size: 3, inline: false, content_id: null }] });
        assert.equal(h.wa.downloads, 1, "tried at ingest");
        h.wa.files.set("out-img/media-1", new Uint8Array([1, 2, 3]));
        assert.equal((await h.mail.getAttachment(id, "media-1", null)).body.byteLength, 3);
    });

    test("contacts are keyed by phone number", async () => {
        const inbound = await receive("in-1");
        await h.mail.setContact("+54 9 11 5555 0000", { meta: { stage: "approved" } }, agent);
        const thread = await h.store.requireThread((await h.store.requireMessage(inbound)).thread_id);
        assert.deepEqual((await h.mail.contextOf(thread)).contacts.map(c => [c.address, c.meta]), [[LUCIA, { stage: "approved" }]]);
        assert.equal((await h.mail.listThreads({ status: "all", meta: { stage: "approved" } }, null)).length, 1);
        await assert.rejects(h.mail.setContact("not-an-address", { note: "x" }, agent), InvalidRequestError);
    });

    test("the first sync reads the whole history of a chat, and only the last interval of mail", async () => {
        const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        h.provider.addInbound({ providerId: "old-mail", at: old });
        h.wa.inbound.set("old-chat", h.wa.chatMessage({ providerId: "old-chat", at: old }));

        await new Sync(h.mail, 10).run();
        assert.equal(await h.store.lookupProviderId("fake", "old-mail"), null);
        assert.ok(await h.store.lookupProviderId("wa", "old-chat"));

        h.wa.inbound.set("older-chat", h.wa.chatMessage({ providerId: "older-chat", at: old }));
        await new Sync(h.mail, 10).run();
        assert.equal(await h.store.lookupProviderId("wa", "older-chat"), null, "later runs look back one interval");
    });

    test("a chat provider must serve exactly one mailbox", () => {
        assert.throws(() => new Mail(h.store, { fake: h.provider, wa: h.wa }, testConfig("/tmp/unused")), /must serve exactly one mailbox/);
    });
});

describe("chat mailbox, read-only in the UI", () => {
    let h: CoreHarness;
    beforeEach(async () => { h = await startCore({ chat: true, uiReadOnly: true }); });
    afterEach(async () => { await h.close(); });

    test("a session reads and organizes, an agent still sends", async () => {
        const inbound = await h.mail.ingest("wa", "in-1", h.wa.chatMessage({ providerId: "in-1" }));
        await assert.rejects(h.mail.createDraft({ replyToId: inbound, text: "Hola" }, human), /read-only/);

        const draft = await h.mail.createDraft({ replyToId: inbound, text: "Hola" }, agent);
        await assert.rejects(h.mail.schedule(draft.id, "send", human), /read-only/);
        await assert.rejects(h.mail.updateDraft(draft.id, draft.version, { text: "Chau" }, human), /read-only/);
        await assert.rejects(h.mail.discardDraft(draft.id, human), /read-only/);

        assert.equal(await h.mail.mark([inbound], { read: true }, human), 1);
        assert.equal((await h.mail.sendDraft(draft.id, agent)).status, "sent");
    });
});

describe("chat over http", () => {
    let h: Harness;
    let client: Client;
    afterEach(async () => {
        await client.close();
        await h.close();
    });

    async function mcp(): Promise<(name: string, args?: Record<string, unknown>) => Promise<{ error: boolean; data: any }>> {
        client = new Client({ name: "test", version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
            requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
            fetch: (input, init) => h.inboxer.fetch(new Request(input, init)),
        }));
        return async (name, args = {}) => {
            const res = await client.callTool({ name, arguments: args });
            return { error: !!res.isError, data: JSON.parse((res.content as { text: string }[])[0]!.text) };
        };
    }

    async function signIn(call: Awaited<ReturnType<typeof mcp>>): Promise<string> {
        const { data } = await call("create_login_link");
        const res = await h.inboxer.fetch(new Request(`http://localhost${new URL(data.url).pathname}`, { method: "POST" }));
        return /inboxer_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "")![0];
    }

    const page = async (cookie: string, path: string, init: RequestInit = {}) =>
        h.inboxer.fetch(new Request(`http://localhost${path}`, { ...init, headers: { cookie, ...init.headers } }));

    test("each provider has its webhook, and agents send to a number without a subject", async () => {
        h = await startHarness({ chat: true });
        const message = h.wa.chatMessage({ providerId: "in-1" });
        assert.equal((await webhook(h, [{ type: "message", providerId: "in-1", message }], "ok", "wa")).status, 200);
        assert.equal((await webhook(h, [], "ok", "constructor")).status, 404);

        const call = await mcp();
        assert.deepEqual((await call("list_mailboxes")).data.map((m: { id: string; kind: string }) => [m.id, m.kind]),
            [["support", "mail"], ["feedback", "mail"], ["line", "chat"], ["catchall", "mail"]]);
        const sent = await call("send", { mailbox: "line", to: [LUCIA], text: "Hola Lucía" });
        assert.equal(sent.error, false);
        assert.equal(h.wa.sent[0]!.message.text, "Hola Lucía");
        assert.match((await call("send", { mailbox: "support", to: ["ana@customer.test"], text: "Hi" })).data.error, /subject is required/);
    });

    test("the UI shows a chat by who it is with, and replies with text only", async () => {
        h = await startHarness({ chat: true });
        await webhook(h, [{ type: "message", providerId: "in-1", message: h.wa.chatMessage({ providerId: "in-1" }) }], "ok", "wa");
        const call = await mcp();
        const cookie = await signIn(call);
        const [thread] = (await call("list_threads", { mailbox: "line" })).data;

        const html = await (await page(cookie, `/threads/${thread.id}?status=all`)).text();
        assert.match(html, /<span class="who">Lucía<\/span>/);
        assert.match(html, /<span class="thread-subject">Lucía<\/span>/);
        assert.match(html, /Hola, quiero publicitar/);
        assert.match(html, /class="composer"/);
        assert.doesNotMatch(html, /reply\/full/);
        assert.doesNotMatch(html, /<option value="line">/, "new mail starts from mail mailboxes only");

        const res = await page(cookie, `/threads/${thread.id}/reply`, { method: "POST", body: new URLSearchParams({ text: "Hola", action: "save" }) });
        assert.equal(res.status, 303);
        const [draft] = (await call("list_drafts", { mailbox: "line" })).data;
        const editor = await (await page(cookie, `/drafts/${draft.id}/edit`)).text();
        assert.doesNotMatch(editor, /name="subject"|name="cc"/);
    });

    test("a read-only mailbox has no reply box and no draft actions", async () => {
        h = await startHarness({ chat: true, uiReadOnly: true });
        await webhook(h, [{ type: "message", providerId: "in-1", message: h.wa.chatMessage({ providerId: "in-1" }) }], "ok", "wa");
        const call = await mcp();
        const cookie = await signIn(call);
        const [thread] = (await call("list_threads", { mailbox: "line" })).data;
        await call("create_draft", { reply_to_id: (await call("get_thread", { thread_id: thread.id })).data.messages[0].id, text: "Borrador del bot" });

        const html = await (await page(cookie, `/threads/${thread.id}?status=all`)).text();
        assert.match(html, /Borrador del bot/);
        assert.doesNotMatch(html, /class="composer"/);
        assert.doesNotMatch(html, /hx-post="\/drafts\/[^"]+\/send"/);
        const res = await page(cookie, `/threads/${thread.id}/reply`, { method: "POST", body: new URLSearchParams({ text: "Hola", action: "send" }) });
        assert.equal(res.status, 400);
        assert.equal(h.wa.sent.length, 0);
    });
});
