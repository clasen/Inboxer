import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHarness, TOKEN, webhook, type Harness } from "./helpers.ts";

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
        assert.equal((await webhook(h, [{ type: "received", providerId: "in-1" }], "bad")).status, 401);
        const other = await req(h, "/webhooks/resend", { method: "POST", body: "[]" });
        assert.equal(other.status, 404);
        assert.equal((await webhook(h, [{ type: "received", providerId: "in-1" }])).status, 200);
        assert.equal((await webhook(h, [{ type: "received", providerId: "in-1" }])).status, 200);

        const client = await mcpClient(h);
        const { data } = await call(client, "list_threads");
        assert.equal(data.length, 1);
        await client.close();
    });

    test("webhook answers 500 when processing fails, so the provider retries", async () => {
        const res = await webhook(h, [{ type: "received", providerId: "missing" }]);
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
        await webhook(h, [{ type: "received", providerId: "q" }]);
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
        await webhook(h, [{ type: "received", providerId: "q" }]);
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
        await req(h, "/logout", { method: "POST", cookie: phone });
        assert.equal((await req(h, "/", { cookie: phone })).status, 401);
        assert.equal((await req(h, "/", { cookie: laptop })).status, 200);

        const { data: remaining } = await call(client, "list_sessions");
        await call(client, "revoke_session", { id: remaining[0].id });
        assert.equal((await req(h, "/", { cookie: laptop })).status, 401);
        await client.close();
    });

    test("editing a draft in the UI detects agent changes and never overwrites silently", async () => {
        const cookie = await signIn(h);
        const client = await mcpClient(h);
        const { data: draft } = await call(client, "create_draft", {
            mailbox: "support", to: ["ana@customer.test"], subject: "Hi", text: "agent v1", note: "<b>check</b>",
        });

        const page = await (await req(h, "/", { cookie })).text();
        assert.ok(page.includes("&lt;b&gt;check&lt;/b&gt;"), "note is escaped");

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
        const sent = await (await req(h, `/drafts/${draft.id}/save`, { method: "POST", cookie, body: form })).text();
        assert.match(sent, /Sent to ana@customer.test/);
        assert.equal(h.provider.sent[0]!.message.text, "human edit\n\n-- Support");

        const blocked = await call(client, "list_drafts");
        assert.deepEqual(blocked.data, []);
        await client.close();
    });

    test("context set through MCP shows in get_thread and, escaped, in the UI", async () => {
        const cookie = await signIn(h);
        h.provider.addInbound({ providerId: "q" });
        await webhook(h, [{ type: "received", providerId: "q" }]);
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
        await webhook(h, [{ type: "received", providerId: "x" }]);
        const client = await mcpClient(h);
        const [thread] = (await call(client, "list_threads")).data;
        await client.close();
        const body = await (await req(h, `/threads/${thread.id}`, { cookie })).text();
        assert.ok(!body.includes("<script>alert"));
        assert.ok(body.includes("Hello there"));
    });
});
