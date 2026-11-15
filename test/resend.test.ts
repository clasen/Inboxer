import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Webhook } from "svix";
import { createResendProvider, parseResendDate } from "../src/provider/resend.ts";
import { WebhookSignatureError } from "../src/provider/types.ts";

const SECRET = "whsec_" + Buffer.from("resend-test-secret-0123456789").toString("base64");
const realFetch = globalThis.fetch;

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => unknown): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        return new Response(JSON.stringify(handler(url, init)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return calls;
}

function signed(payload: unknown): { headers: Headers; body: string } {
    const body = JSON.stringify(payload);
    const id = "msg_test";
    const timestamp = new Date();
    const signature = new Webhook(SECRET).sign(id, timestamp, body);
    return {
        body,
        headers: new Headers({ "svix-id": id, "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)), "svix-signature": signature }),
    };
}

describe("resend provider", () => {
    afterEach(() => { globalThis.fetch = realFetch; });
    const provider = createResendProvider({ apiKey: "re_test", webhookSecret: SECRET });

    test("parses signed webhooks into provider events", () => {
        assert.deepEqual(provider.parseWebhook(signed({ type: "email.received", data: { email_id: "r1" } })), [
            { type: "received", providerId: "r1" },
        ]);
        assert.deepEqual(provider.parseWebhook(signed({ type: "email.bounced", data: { email_id: "s1", message_id: "<m@x>" } })), [
            { type: "status", providerId: "s1", status: "bounced", messageId: "<m@x>" },
        ]);
        assert.deepEqual(provider.parseWebhook(signed({ type: "email.opened", data: { email_id: "s1" } })), []);
    });

    test("rejects a tampered webhook", () => {
        const req = signed({ type: "email.received", data: { email_id: "r1" } });
        assert.throws(() => provider.parseWebhook({ ...req, body: req.body.replace("r1", "r2") }), WebhookSignatureError);
    });

    test("normalizes a received email, threading headers included", async () => {
        mockFetch(() => ({
            id: "r1",
            from: "Ana <ana@customer.test>",
            to: ["support@inboxer.test"],
            cc: [],
            bcc: [],
            reply_to: [],
            received_for: ["support@inboxer.test"],
            subject: "Re: Trial",
            text: "Hi",
            html: "<p>Hi</p>",
            headers: { "In-Reply-To": "<a@inboxer.test>", References: "<z@x> <a@inboxer.test>" },
            message_id: "<r1@customer.test>",
            attachments: [{ id: "att1", filename: "a.png", content_type: "image/png", size: 10 }],
            created_at: "2026-11-01T10:00:00.000Z",
        }));
        const inbound = await provider.getInbound("r1");
        assert.equal(inbound.inReplyTo, "<a@inboxer.test>");
        assert.deepEqual(inbound.references, ["<z@x>", "<a@inboxer.test>"]);
        assert.deepEqual(inbound.deliveredTo, ["support@inboxer.test"]);
        assert.deepEqual(inbound.attachments, [{ id: "att1", filename: "a.png", content_type: "image/png", size: 10 }]);
    });

    test("pages sent emails until they are older than since", async () => {
        const calls = mockFetch(url => url.includes("after=e2")
            ? { has_more: true, data: [{ id: "e3", created_at: "2026-10-01 00:00:00.000000+00", last_event: "sent" }] }
            : {
                has_more: true,
                data: [
                    { id: "e1", created_at: "2026-11-02 00:00:00.000000+00", last_event: "opened" },
                    { id: "e2", created_at: "2026-11-01 00:00:00.000000+00", last_event: "queued" },
                ],
            });
        const out = [];
        for await (const s of provider.listOutbound(new Date("2026-10-15T00:00:00Z"))) out.push(s);
        assert.deepEqual(out, [{ providerId: "e1", status: "delivered" }]);
        assert.equal(calls.length, 2);
    });

    test("sends with the idempotency key", async () => {
        const calls = mockFetch(() => ({ id: "s1" }));
        const res = await provider.send({
            from: '"S" <s@inboxer.test>', to: ["a@x.test"], cc: [], bcc: [], replyTo: [], subject: "Hi", text: "t", html: "<p>t</p>",
            headers: { "Message-ID": "<id@inboxer.test>" },
        }, "draft-1");
        assert.equal(res.providerId, "s1");
        const headers = calls[0]!.init.headers as Record<string, string>;
        assert.equal(headers["Idempotency-Key"], "draft-1");
        const body = JSON.parse(String(calls[0]!.init.body));
        assert.equal(body.headers["Message-ID"], "<id@inboxer.test>");
        assert.equal("cc" in body, false);
    });

    test("parses both Resend date formats", () => {
        assert.equal(parseResendDate("2026-04-03 22:13:42.674981+00").toISOString(), "2026-04-03T22:13:42.674Z");
        assert.equal(parseResendDate("2026-04-03T22:13:42.674Z").toISOString(), "2026-04-03T22:13:42.674Z");
    });
});
