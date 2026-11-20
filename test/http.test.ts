import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLoginLink } from "../src/index.ts";
import { FEEDBACK_TOKEN, startHarness, TOKEN, testConfig, webhook, type Harness } from "./helpers.ts";

const BASE = "http://localhost";
const NativeResponse = globalThis.Response;

async function mcpClient(h: Harness, token = TOKEN): Promise<Client> {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: (input, init) => h.inboxer.fetch(new Request(input, init)),
    });
    await client.connect(transport);
    return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    return { error: !!res.isError, data: JSON.parse(text) };
}

function req(h: Harness, path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    if (init.cookie) headers.set("cookie", init.cookie);
    return h.inboxer.fetch(new Request(BASE + path, { ...init, headers }));
}

function sessionCookie(res: Response): string {
    const header = res.headers.get("set-cookie") ?? "";
    const match = /inboxer_session=[^;]+/.exec(header);
    assert.ok(match, `no session cookie in ${header}`);
    return match[0];
}

async function signIn(h: Harness): Promise<string> {
    const client = await mcpClient(h);
    const { data } = await call(client, "create_login_link", { label: "laptop" });
    await client.close();
    const res = await req(h, new URL(data.url).pathname, { method: "POST" });
    assert.equal(res.status, 303);
    return sessionCookie(res);
}

describe("http", () => {
    let h: Harness;
    beforeEach(async () => { h = await startHarness(); });
    afterEach(async () => { await h.close(); });

    test("leaves the host's globals alone, so fetch works under Bun.serve and handler under node:http", async () => {
        assert.equal(globalThis.Response, NativeResponse);
        assert.ok((await req(h, "/")) instanceof NativeResponse);

        const server = createServer(h.inboxer.handler);
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
            const { port } = server.address() as AddressInfo;
            assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 401);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test("webhook: 401 on a bad signature, 404 for another provider, ingests once", async () => {
        h.provider.addInbound({ providerId: "in-1" });
        assert.equal((await webhook(h, [{ type: "message", providerId: "in-1" }], "bad")).status, 401);
        const other = await req(h, "/webhooks/resend", { method: "POST", body: "[]" });
        assert.equal(other.status, 404);
        assert.equal((await webhook(h, [{ type: "message", providerId: "in-1" }])).status, 200);
        assert.equal((await webhook(h, [{ type: "message", providerId: "in-1" }])).status, 200);

        const client = await mcpClient(h);
        const { data } = await call(client, "list_threads");
        assert.equal(data.length, 1);
        await client.close();
    });

    test("webhook answers 500 when processing fails, so the provider retries", async () => {
        const res = await webhook(h, [{ type: "message", providerId: "missing" }]);
        assert.equal(res.status, 500);
    });

    test("mcp rejects unknown bearers and records the token name as actor", async () => {
        const res = await req(h, "/mcp", { method: "POST", headers: { Authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
        assert.equal(res.status, 401);

        const client = await mcpClient(h);
        const tools = (await client.listTools()).tools.map(t => t.name);
        for (const name of ["list_mailboxes", "list_threads", "search", "get_thread", "label", "mark", "create_draft", "update_draft",
            "list_drafts", "discard_draft", "send_draft", "send", "reply", "get_attachment", "create_login_link", "list_sessions", "revoke_session",
            "get_contact", "set_contact", "set_thread_meta"]) {
            assert.ok(tools.includes(name), `missing tool ${name}`);
        }

        h.provider.addInbound({ providerId: "q" });
        await webhook(h, [{ type: "message", providerId: "q" }]);
        const [thread] = (await call(client, "list_threads", { mailbox: "support" })).data;
        const { data: full } = await call(client, "get_thread", { thread_id: thread.id });
        const { data: draft } = await call(client, "create_draft", { reply_to_id: full.messages[0].id, text: "Seven days.", note: "extend trial first" });
        assert.equal(draft.version, 1);
        assert.equal(draft.url, `http://localhost:4000/threads/${thread.id}#draft-${draft.id}`);
        assert.equal(thread.url, `http://localhost:4000/threads/${thread.id}`);
        const stale = await call(client, "update_draft", { id: draft.id, version: 0, text: "x" });
        assert.equal(stale.error, true);
        assert.equal(stale.data.current.version, 1);
        const { data: sent } = await call(client, "send_draft", { id: draft.id });
        assert.equal(sent.status, "sent");
        assert.equal(sent.url, `http://localhost:4000/threads/${thread.id}`);
        await client.close();
    });

    test("a login link: GET does not consume it, only one POST wins, then it is gone", async () => {
        const client = await mcpClient(h);
        const { data } = await call(client, "create_login_link", { label: "phone" });
        await client.close();
        const path = new URL(data.url).pathname;

        assert.equal((await req(h, path)).status, 200);
        assert.equal((await req(h, path)).status, 200);

        const results = await Promise.all([req(h, path, { method: "POST" }), req(h, path, { method: "POST" })]);
        assert.deepEqual(results.map(r => r.status).sort(), [303, 404]);
        assert.equal((await req(h, path)).status, 404);
        assert.match(await (await req(h, path)).text(), /already used or expired/);
    });

    test("a login link with a thread lands on that thread", async () => {
        h.provider.addInbound({ providerId: "q" });
        await webhook(h, [{ type: "message", providerId: "q" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        const { data } = await call(client, "create_login_link", { thread_id: thread.id });
        const unknown = await call(client, "create_login_link", { thread_id: "nope" });
        await client.close();
        assert.equal(unknown.error, true);

        const res = await req(h, new URL(data.url).pathname, { method: "POST" });
        assert.equal(res.status, 303);
        assert.equal(res.headers.get("location"), `/threads/${thread.id}`);
        assert.equal((await req(h, `/threads/${thread.id}`, { cookie: sessionCookie(res) })).status, 200);
    });

    test("a used link opens the app on a browser that is already signed in", async () => {
        const link = await createLoginLink(testConfig(h.dataDir), {});
        const path = new URL(link.url).pathname;
        const cookie = sessionCookie(await req(h, path, { method: "POST" }));

        for (const method of ["GET", "POST"]) {
            const res = await req(h, path, { method, cookie });
            assert.equal(res.status, 303);
            assert.equal(res.headers.get("location"), "/");
            assert.equal((await req(h, path, { method })).status, 404);
        }
    });

    test("createLoginLink mints a link from a script, without an MCP client", async () => {
        h.provider.addInbound({ providerId: "q" });
        await webhook(h, [{ type: "message", providerId: "q" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;

        const link = await createLoginLink(testConfig(h.dataDir), { label: "server", threadId: thread.id });
        assert.ok(link.url.startsWith("http://localhost:4000/auth/"));
        const res = await req(h, new URL(link.url).pathname, { method: "POST" });
        assert.equal(res.headers.get("location"), `/threads/${thread.id}`);
        const { data: sessions } = await call(client, "list_sessions");
        assert.deepEqual(sessions.map((s: { label: string; scope: unknown }) => [s.label, s.scope]), [["server", null]]);
        await client.close();
    });

    test("the UI needs a session; sessions are independent and revocable", async () => {
        assert.equal((await req(h, "/")).status, 401);
        const laptop = await signIn(h);
        const phone = await signIn(h);

        const home = await req(h, "/", { cookie: laptop });
        assert.equal(home.status, 200);
        assert.ok(home.headers.get("set-cookie")?.includes("Max-Age=34560000"), "cookie is re-issued");

        const client = await mcpClient(h);
        const { data: sessions } = await call(client, "list_sessions");
        assert.equal(sessions.length, 2);
        const devices = await (await req(h, "/devices", { cookie: phone })).text();
        assert.equal(devices.match(/action="\/logout"/g)?.length, 1, "own session offers log out");
        assert.equal(devices.match(/\/revoke"/g)?.length, 1, "other session offers revoke");
        await req(h, "/logout", { method: "POST", cookie: phone });
        assert.equal((await req(h, "/", { cookie: phone })).status, 401);
        assert.equal((await req(h, "/", { cookie: laptop })).status, 200);

        const { data: remaining } = await call(client, "list_sessions");
        await call(client, "revoke_session", { id: remaining[0].id });
        assert.equal((await req(h, "/", { cookie: laptop })).status, 401);
        await client.close();
    });

    test("a mailbox token sees only its mailbox, and so do the browsers it signs in", async () => {
        h.provider.addInbound({ providerId: "s", subject: "Support question" });
        h.provider.addInbound({ providerId: "f", from: "bob@other.test", to: ["feedback@inboxer.test"], subject: "Feedback idea" });
        await webhook(h, [{ type: "message", providerId: "s" }, { type: "message", providerId: "f" }]);
        const admin = await mcpClient(h);
        const bot = await mcpClient(h, FEEDBACK_TOKEN);

        const { data: mailboxes } = await call(bot, "list_mailboxes");
        assert.deepEqual(mailboxes.map((m: { id: string }) => m.id), ["feedback"]);
        const { data: threads } = await call(bot, "list_threads", { status: "all" });
        assert.deepEqual(threads.map((t: { subject: string }) => t.subject), ["Feedback idea"]);
        const support = (await call(admin, "list_threads", { mailbox: "support" })).data[0];
        assert.match((await call(bot, "get_thread", { thread_id: support.id })).data.error, /not found/);
        assert.equal((await call(bot, "create_login_link", { thread_id: support.id })).error, true);

        await signIn(h);
        const { data: link } = await call(bot, "create_login_link", { label: "feedback phone" });
        const cookie = sessionCookie(await req(h, new URL(link.url).pathname, { method: "POST" }));
        const inbox = await (await req(h, "/inbox?status=all", { cookie })).text();
        assert.ok(inbox.includes("Feedback idea"));
        assert.ok(!inbox.includes("Support question"));
        assert.equal((await req(h, `/threads/${support.id}`, { cookie })).status, 404);

        const { data: botSessions } = await call(bot, "list_sessions");
        assert.deepEqual(botSessions.map((s: { label: string }) => s.label), ["feedback phone"]);
        assert.equal((await call(admin, "list_sessions")).data.length, 2);
        const laptop = (await call(admin, "list_sessions")).data.find((s: { label: string }) => s.label === "laptop");
        assert.equal((await call(bot, "revoke_session", { id: laptop.id })).data.revoked, false);
        await admin.close();
        await bot.close();
    });

    test("attachments: the UI serves them safely and get_attachment returns their content", async () => {
        const cookie = await signIn(h);
        const meta = (id: string, filename: string, content_type: string) => ({ id, filename, content_type, size: null, inline: false, content_id: null });
        h.provider.addInbound({ providerId: "a", text: "see [image: photo.png] here", attachments: [
            meta("img", "photo.png", "image/png"), meta("page", "x.html", "text/html"), meta("pdf", "terms.pdf", "application/pdf"), meta("big", "big.bin", "application/zip"),
        ] });
        h.provider.files.set("a/img", new Uint8Array([137, 80, 78, 71]));
        h.provider.files.set("a/page", new TextEncoder().encode("<script>alert(1)</script>"));
        h.provider.files.set("a/pdf", new TextEncoder().encode("%PDF-1.7"));
        h.provider.files.set("a/big", new Uint8Array(1024 * 1024 + 1));
        await webhook(h, [{ type: "message", providerId: "a" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        const { data } = await call(client, "get_thread", { thread_id: thread.id });
        const messageId = data.messages[0].id;

        const page = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        assert.ok(page.includes(`<img src="/attachments/${messageId}/img"`));
        assert.ok(!page.includes("[image: photo.png]"));
        const image = await req(h, `/attachments/${messageId}/img`, { cookie });
        assert.equal(image.headers.get("content-type"), "image/png");
        assert.match(image.headers.get("content-disposition")!, /^inline/);
        const html = await req(h, `/attachments/${messageId}/page`, { cookie });
        assert.equal(html.headers.get("content-type"), "application/octet-stream");
        assert.match(html.headers.get("content-disposition")!, /^attachment; filename\*=UTF-8''x\.html/);
        assert.match(html.headers.get("content-security-policy")!, /sandbox/);
        assert.equal((await req(h, `/attachments/${messageId}/img`)).status, 401);

        const get = (attachment_id: string) => client.callTool({ name: "get_attachment", arguments: { message_id: messageId, attachment_id } });
        const content = async (id: string) => ((await get(id)).content as { type: string; [k: string]: unknown }[])[1]!;
        assert.deepEqual(await content("img"), { type: "image", data: "iVBORw==", mimeType: "image/png" });
        assert.deepEqual(await content("page"), { type: "text", text: "<script>alert(1)</script>" });
        const pdf = await content("pdf") as { resource: { mimeType: string; blob: string } };
        assert.equal(pdf.resource.mimeType, "application/pdf");
        assert.equal(Buffer.from(pdf.resource.blob, "base64").toString(), "%PDF-1.7");
        const big = await get("big");
        assert.equal(big.isError, true);
        assert.match((big.content as { text: string }[])[0]!.text, /over the 1 MB limit/);
        await client.close();
    });

    test("the editor uploads files, refuses ones over the limit, and sends them", async () => {
        const cookie = await signIn(h);
        const client = await mcpClient(h);
        const { data: draft } = await call(client, "create_draft", { mailbox: "support", to: ["ana@customer.test"], subject: "Hi", text: "see attached" });
        const editor = await (await req(h, `/drafts/${draft.id}/edit`, { cookie })).text();
        assert.ok(editor.includes("data-drop"));

        const form = new FormData();
        form.append("files", new File(["hello"], "notes.txt", { type: "text/plain" }));
        form.append("files", new File([new Uint8Array(1024 * 1024 + 1)], "huge.zip", { type: "application/zip" }));
        const list = await (await req(h, `/drafts/${draft.id}/attachments`, { method: "POST", cookie, body: form })).text();
        assert.match(list, /notes\.txt/);
        assert.match(list, /huge\.zip is larger than 1 MB/);

        const { data: drafts } = await call(client, "list_drafts");
        assert.deepEqual(drafts[0].attachments.map((a: { filename: string }) => a.filename), ["notes.txt"]);
        await call(client, "send_draft", { id: draft.id });
        assert.equal(new TextDecoder().decode(h.provider.sent[0]!.message.attachments[0]!.content), "hello");
        await client.close();
    });

    test("editing a draft in the UI detects agent changes and never overwrites silently", async () => {
        const cookie = await signIn(h);
        const client = await mcpClient(h);
        const { data: draft } = await call(client, "create_draft", {
            mailbox: "support", to: ["ana@customer.test"], subject: "Hi", text: "agent v1", note: "<b>check</b>",
        });

        const list = await (await req(h, "/", { cookie })).text();
        assert.ok(list.includes(`href="/drafts/${draft.id}"`), "Drafts lists the draft");
        const page = await (await req(h, `/drafts/${draft.id}`, { cookie })).text();
        assert.ok(page.includes("&lt;b&gt;check&lt;/b&gt;"), "note is escaped");
        assert.ok(page.includes(`hx-target="#edit-sheet"`), "Edit opens the one edit sheet");

        const editor = await (await req(h, `/drafts/${draft.id}/edit`, { cookie })).text();
        assert.match(editor, new RegExp(`id="cc-row-${draft.id}" hidden`), "an empty Cc starts hidden");

        await call(client, "update_draft", { id: draft.id, version: 1, text: "agent v2" });
        const form = new URLSearchParams({ version: "1", to: "ana@customer.test", cc: "", subject: "Hi", text: "human edit" });
        const conflict = await (await req(h, `/drafts/${draft.id}/save`, { method: "POST", cookie, body: form })).text();
        assert.match(conflict, /changed while you were editing/);
        assert.match(conflict, /agent v2/);
        assert.match(conflict, /human edit/);

        form.set("version", "2");
        form.set("send", "1");
        const pending = await (await req(h, `/drafts/${draft.id}/save`, { method: "POST", cookie, body: form })).text();
        assert.match(pending, /Sending to <strong>ana@customer.test/);
        assert.equal(h.provider.sent.length, 0);

        const undone = await (await req(h, `/drafts/${draft.id}/undo`, { method: "POST", cookie })).text();
        assert.match(undone, /human edit/);
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(h.provider.sent.length, 0, "an undone send never goes out");

        await req(h, `/drafts/${draft.id}/send`, { method: "POST", cookie });
        assert.equal((await call(client, "update_draft", { id: draft.id, version: 3, text: "late", force: true })).error, true);
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(h.provider.sent[0]!.message.text, "human edit\n\n-- Support");
        assert.match(await (await req(h, `/drafts/${draft.id}/undo`, { method: "POST", cookie })).text(), /class="msg mine"[\s\S]*human edit/, "a late undo shows the sent message");

        const blocked = await call(client, "list_drafts");
        assert.deepEqual(blocked.data, []);
        await client.close();
    });

    test("a reply from the thread view goes out after the undo window; a saved one stays a draft", async () => {
        const cookie = await signIn(h);
        h.provider.addInbound({ providerId: "r" });
        await webhook(h, [{ type: "message", providerId: "r" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;

        const page = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        assert.ok(page.includes(`action="/threads/${thread.id}/reply?status=unanswered"`));

        const saved = await req(h, `/threads/${thread.id}/reply?status=all`, { method: "POST", cookie, body: new URLSearchParams({ text: "Draft only", action: "save" }) });
        assert.equal(saved.headers.get("location"), `/threads/${thread.id}?status=all`);
        const { data: drafts } = await call(client, "list_drafts");
        assert.deepEqual(drafts.map((d: { text: string; to: string[] }) => [d.text, d.to]), [["Draft only", ["Ana <ana@customer.test>"]]]);
        assert.equal(h.provider.sent.length, 0);

        await req(h, `/threads/${thread.id}/reply`, { method: "POST", cookie, body: new URLSearchParams({ text: "Sent now", action: "send" }) });
        assert.equal(h.provider.sent.length, 0, "the send waits for the undo window");
        await new Promise(resolve => setTimeout(resolve, 120));
        const [sent] = h.provider.sent;
        assert.deepEqual(sent!.message.to, ["Ana <ana@customer.test>"]);
        assert.equal(sent!.message.subject, "Re: Trial question");
        assert.ok(sent!.message.headers["In-Reply-To"], "threaded as a reply");
        assert.match(sent!.message.text, /^Sent now/);

        const { data: { messages } } = await call(client, "get_thread", { thread_id: thread.id });
        const reply = messages.at(-1);
        const card = await (await req(h, `/drafts/${reply.id}/card`, { cookie, headers: { "hx-current-url": `${BASE}/threads/${thread.id}` } })).text();
        assert.ok(card.includes(`class="msg mine"`), "the sent reply takes its place as a bubble");
        assert.ok(card.includes("Sent now"));

        const before = (await call(client, "list_drafts")).data.length;
        const full = await (await req(h, `/threads/${thread.id}/reply/full?text=Longer+answer`, { cookie })).text();
        assert.ok(full.includes(`value="Re: Trial question"`) && full.includes(`type="file"`) && full.includes("Longer answer"), "the full reply edits subject and takes files");
        assert.equal((await call(client, "list_drafts")).data.length, before, "opening the full reply creates nothing");

        const replyToId = /name="reply_to_id" value="([^"]+)"/.exec(full)![1]!;
        const body = new FormData();
        for (const [k, v] of Object.entries({ reply_to_id: replyToId, to: "ana@customer.test", cc: "", subject: "Re: Trial question", text: "Longer answer", action: "save" })) body.set(k, v);
        body.append("files", new File(["x"], "terms.txt", { type: "text/plain" }));
        assert.equal((await req(h, `/threads/${thread.id}/reply/full`, { method: "POST", cookie, body })).status, 303);
        const { data: after } = await call(client, "list_drafts");
        const created = after.find((d: { text: string }) => d.text === "Longer answer");
        assert.deepEqual([after.length, created.thread_id, created.attachments.map((a: { filename: string }) => a.filename)], [before + 1, thread.id, ["terms.txt"]]);
        await client.close();
    });

    test("a catch-all thread shows the address it was written to and can be answered from it", async () => {
        const cookie = await signIn(h);
        h.provider.addInbound({ providerId: "c", to: ["info@inboxer.test"] });
        await webhook(h, [{ type: "message", providerId: "c" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        await client.close();

        const page = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        assert.ok(page.includes(`<span class="who">ana@customer.test</span>`), "our own address is not a participant");
        assert.ok(page.includes(`<span class="badge mailbox">info</span>`) && !page.includes(">catchall<"), "tagged by the address, not the catch-all");
        assert.ok(page.includes(`<option value="info@inboxer.test" `), "the address is an account to filter by");
        assert.ok(page.includes(`action="/threads/${thread.id}/reply?status=unanswered"`), "the reply box is there");

        await req(h, `/threads/${thread.id}/reply`, { method: "POST", cookie, body: new URLSearchParams({ text: "Hi Ana", action: "send" }) });
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.deepEqual(h.provider.sent.map(s => [s.message.from, s.message.to]), [[`"Inboxer Support" <info@inboxer.test>`, ["Ana <ana@customer.test>"]]]);
    });

    test("New mail starts a thread with a draft, or sends it", async () => {
        const cookie = await signIn(h);
        const home = await (await req(h, "/", { cookie })).text();
        assert.ok(home.includes(`<option value="support">support@inboxer.test</option>`), "the sheet offers sending mailboxes");
        assert.ok(!home.includes(`<option value="catchall">`), "never the catch-all");

        const form = { mailbox: "support", to: "bob@other.test", cc: "", subject: "Hello", text: "First line", action: "save" };
        const saved = await req(h, "/compose", { method: "POST", cookie, body: new URLSearchParams(form) });
        assert.equal(saved.status, 303);
        const thread = await (await req(h, saved.headers.get("location")!, { cookie })).text();
        assert.ok(thread.includes("First line"));
        assert.equal(h.provider.sent.length, 0);

        await req(h, "/compose", { method: "POST", cookie, body: new URLSearchParams({ ...form, subject: "Now", action: "send" }) });
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.deepEqual(h.provider.sent.map(s => [s.message.to, s.message.subject]), [[["bob@other.test"], "Now"]]);

        const refused = await req(h, "/compose", { method: "POST", cookie, body: new URLSearchParams({ ...form, mailbox: "catchall" }) });
        assert.equal(refused.status, 400);
    });

    test("New mail sends the files attached to it", async () => {
        const cookie = await signIn(h);
        const home = await (await req(h, "/", { cookie })).text();
        assert.ok(home.includes(`enctype="multipart/form-data"`) && home.includes(`name="files"`), "the sheet takes files");

        const body = new FormData();
        for (const [k, v] of Object.entries({ mailbox: "support", to: "bob@other.test", subject: "Report", text: "Attached", action: "send" })) body.set(k, v);
        body.append("files", new File(["a,b\n1,2\n"], "report.csv", { type: "text/csv" }));
        assert.equal((await req(h, "/compose", { method: "POST", cookie, body })).status, 303);
        await new Promise(resolve => setTimeout(resolve, 120));
        const [sent] = h.provider.sent;
        assert.deepEqual(sent!.message.attachments.map(a => [a.filename, new TextDecoder().decode(a.content)]), [["report.csv", "a,b\n1,2\n"]]);

        const big = new FormData();
        for (const [k, v] of Object.entries({ mailbox: "support", to: "bob@other.test", subject: "Big", text: "x", action: "send" })) big.set(k, v);
        big.append("files", new File([new Uint8Array(1024 * 1024 + 1)], "big.bin"));
        assert.equal((await req(h, "/compose", { method: "POST", cookie, body: big })).status, 400, "an oversized file stops the mail");
        const client = await mcpClient(h);
        assert.equal((await call(client, "list_drafts")).data.length, 0, "and creates no draft");
        await client.close();
    });

    test("context set through MCP shows in get_thread and, escaped, in the UI", async () => {
        const cookie = await signIn(h);
        h.provider.addInbound({ providerId: "q" });
        await webhook(h, [{ type: "message", providerId: "q" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        await call(client, "set_contact", { address: "ana@customer.test", meta: { license_id: "BL-2231" }, note: "<i>VIP</i>" });
        await call(client, "set_thread_meta", { thread_id: thread.id, meta: { ticket: 45 } });
        const { data } = await call(client, "get_thread", { thread_id: thread.id });
        assert.equal(data.contacts[0].meta.license_id, "BL-2231");
        assert.equal(data.context.meta.ticket, 45);
        const found = await call(client, "list_threads", { meta: { license_id: "BL-2231" } });
        assert.equal(found.data[0].id, thread.id);
        await client.close();

        const body = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        assert.ok(body.includes("<dt>license_id</dt><dd>BL-2231</dd>"));
        assert.ok(body.includes("<dt>ticket</dt><dd>45</dd>"));
        assert.ok(body.includes("&lt;i&gt;VIP&lt;/i&gt;"));
    });

    test("incoming HTML is never rendered in the thread view", async () => {
        const cookie = await signIn(h);
        h.provider.addInbound({ providerId: "x", text: null, html: "<script>alert(1)</script><p>Hello <b>there</b></p>" });
        await webhook(h, [{ type: "message", providerId: "x" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        await client.close();
        const body = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        assert.ok(!body.includes("<script>alert"));
        assert.ok(body.includes("Hello there"));
    });

    test("addresses in a message are links, and the ones in brackets after a label stay out of the way", async () => {
        const cookie = await signIn(h);
        h.provider.addInbound({ providerId: "x", text: 'See https://example.com/a?b=1&c=2. Also (https://example.com/wiki/Mail_(disambiguation)) and <https://example.com/x>"onmouseover="y\nhttps://example.com/v?t=1\n[https://example.com/v?t=1]\nSite [https://example.com/s]\n(pic [https://example.com/i.png?v=2])\nWrite to hi@there.test (hi@there.test).' });
        await webhook(h, [{ type: "message", providerId: "x" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        await client.close();
        const body = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        const hrefs = [...body.matchAll(/<pre class="body">[^]*?<\/pre>/g)].flatMap(pre => [...pre[0].matchAll(/<a href="([^"]*)" target="_blank" rel="noopener noreferrer">/g)].map(a => a[1]));
        assert.deepEqual(hrefs, [
            "https://example.com/a?b=1&amp;c=2",
            "https://example.com/wiki/Mail_(disambiguation)",
            "https://example.com/x",
            "https://example.com/v?t=1",
            "https://example.com/s",
        ]);
        assert.ok(body.includes('</a>\nSite [<a href="https://example.com/s" target="_blank" rel="noopener noreferrer">example.com</a>]\n(pic)\n'));
        assert.ok(body.includes('Write to <a href="mailto:hi@there.test" data-compose="hi@there.test">hi@there.test</a>.'));
        assert.ok(!body.includes('"onmouseover="'));
    });

    test("events: a signed-in page hears every change to the mail, a signed-out one gets 401", async () => {
        assert.equal((await req(h, "/events")).status, 401);
        const cookie = await signIn(h);
        const abort = new AbortController();
        const res = await req(h, "/events", { cookie, signal: abort.signal });
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

        h.provider.addInbound({ providerId: "in-1" });
        await webhook(h, [{ type: "message", providerId: "in-1" }]);
        let text = "";
        while (!text.includes("event: change")) text += (await reader.read()).value;
        abort.abort();
    });
});
