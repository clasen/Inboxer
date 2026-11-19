import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, test } from "node:test";
import { createKapsoProvider } from "../src/provider/kapso.ts";
import { WebhookSignatureError, type MessageEvent } from "../src/provider/types.ts";

const SECRET = "kapso-test-secret";
const PHONE_ID = "923801917492966";
const realFetch = globalThis.fetch;

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (url: string, init: RequestInit) => unknown): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        const result = handler(url, init);
        return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return calls;
}

function signed(event: string, payload: unknown): { headers: Headers; body: string } {
    const body = JSON.stringify(payload);
    return { body, headers: new Headers({ "x-webhook-event": event, "x-webhook-signature": createHmac("sha256", SECRET).update(body).digest("hex") }) };
}

const received = {
    message: { id: "wamid.in", timestamp: "1793527200", type: "text", from: "5491155550000", text: { body: "Hola" }, kapso: { direction: "inbound", status: "received", content: "Hola" } },
    conversation: { contact_name: "Lucía", phone_number: "5491155550000" },
    phone_number_id: PHONE_ID,
};

const sent = {
    message: { id: "wamid.out", timestamp: "1793527260", type: "interactive", to: "5491155550000", kapso: { direction: "outbound", status: "sent", content: "Aprobar o rechazar" } },
    conversation: { contact_name: "Lucía", phone_number: "5491155550000" },
    phone_number_id: PHONE_ID,
};

describe("kapso provider", () => {
    afterEach(() => { globalThis.fetch = realFetch; });
    const provider = createKapsoProvider("whatsapp", { apiKey: "key", webhookSecret: SECRET, phoneNumberId: PHONE_ID });

    test("is a chat provider named by its config key, and requires its settings", () => {
        assert.equal(provider.name, "whatsapp");
        assert.equal(provider.kind, "chat");
        assert.throws(() => createKapsoProvider("whatsapp", { apiKey: "key", webhookSecret: SECRET }), /providers\.whatsapp\.phoneNumberId/);
    });

    test("rejects a webhook that is not signed with the secret", () => {
        const req = signed("whatsapp.message.received", received);
        assert.throws(() => provider.parseWebhook({ ...req, body: req.body.replace("Hola", "Chau") }), WebhookSignatureError);
        assert.throws(() => provider.parseWebhook({ headers: new Headers(), body: req.body }), WebhookSignatureError);
    });

    test("a received message carries the counterpart only", () => {
        const [event] = provider.parseWebhook(signed("whatsapp.message.received", received)) as MessageEvent[];
        assert.equal(event!.providerId, "wamid.in");
        assert.deepEqual(
            { ...event!.message, references: undefined, cc: undefined, bcc: undefined, replyTo: undefined, deliveredTo: undefined, headers: undefined },
            {
                providerId: "wamid.in", direction: "in", status: null, messageId: null, inReplyTo: null, references: undefined,
                from: '"Lucía" <+5491155550000>', to: [], cc: undefined, bcc: undefined, replyTo: undefined, deliveredTo: undefined,
                subject: "", text: "Hola", html: null, headers: undefined, attachments: [], at: "2026-11-01T10:00:00.000Z",
            },
        );
    });

    test("a message sent on the line is mirrored, described by Kapso when it has no body", () => {
        const [event] = provider.parseWebhook(signed("whatsapp.message.sent", sent)) as MessageEvent[];
        assert.deepEqual([event!.message!.direction, event!.message!.status, event!.message!.from, event!.message!.to, event!.message!.text],
            ["out", "sent", "", ["+5491155550000"], "Aprobar o rechazar"]);
    });

    test("delivery events become statuses; batches, other lines and other events are handled", () => {
        assert.deepEqual(provider.parseWebhook(signed("whatsapp.message.read", sent)), [{ type: "status", providerId: "wamid.out", status: "read", messageId: null }]);
        assert.deepEqual(provider.parseWebhook(signed("whatsapp.message.failed", sent)), [{ type: "status", providerId: "wamid.out", status: "failed", messageId: null }]);
        assert.equal(provider.parseWebhook(signed("whatsapp.message.received", { batch: true, data: [received, received] })).length, 2);
        assert.deepEqual(provider.parseWebhook(signed("whatsapp.message.received", { ...received, phone_number_id: "another" })), []);
        assert.deepEqual(provider.parseWebhook(signed("whatsapp.conversation.ended", received)), []);
    });

    test("media becomes an attachment with its caption as text; a voice note shows its transcript", () => {
        const image = { ...received, message: { ...received.message, type: "image", text: undefined, image: { id: "media-1", caption: "El logo" }, kapso: { direction: "inbound", content: "Image attached", media_data: { filename: "logo.png", content_type: "image/png", byte_size: 2048 } } } };
        const [{ message }] = provider.parseWebhook(signed("whatsapp.message.received", image)) as [MessageEvent];
        assert.equal(message!.text, "El logo");
        assert.deepEqual(message!.attachments, [{ id: "media-1", filename: "logo.png", content_type: "image/png", size: 2048, inline: false, content_id: null }]);

        const audio = { ...received, message: { ...received.message, type: "audio", text: undefined, audio: { id: "media-2" }, kapso: { direction: "inbound", transcript: { text: "Hola, soy Lucía" } } } };
        const [voice] = provider.parseWebhook(signed("whatsapp.message.received", audio)) as [MessageEvent];
        assert.equal(voice.message!.text, "Hola, soy Lucía");
        assert.equal(voice.message!.attachments[0]!.filename, "audio");
    });

    test("skips a message with no phone number", () => {
        const anonymous = { ...received, message: { ...received.message, from: null }, conversation: {} };
        assert.deepEqual(provider.parseWebhook(signed("whatsapp.message.received", anonymous)), []);
    });

    test("lists the history newest first until it is older than since", async () => {
        const record = (id: string, timestamp: string) => ({ ...sent.message, id, timestamp, kapso: { ...sent.message.kapso, status: "read", contact_name: "Lucía", phone_number: "5491155550000" } });
        const calls = mockFetch(url => url.includes("after=c1")
            ? { data: [record("m3", "1793450000"), record("m4", "1793300000")], paging: { cursors: { after: "c2" }, next: "more" } }
            : { data: [record("m1", "1793527260"), record("m2", "1793527200")], paging: { cursors: { after: "c1" }, next: "more" } });
        const seen: MessageEvent[] = [];
        for await (const event of provider.listMessages(new Date("2026-10-31T00:00:00Z"))) seen.push(event);
        assert.deepEqual(seen.map(e => [e.providerId, e.message!.status]), [["m1", "read"], ["m2", "read"], ["m3", "read"]]);
        assert.equal(calls.length, 2);
        assert.match(calls[0]!.url, /platform\/v1\/whatsapp\/messages\?phone_number_id=923801917492966&limit=100$/);
        assert.equal((calls[0]!.init.headers as Record<string, string>)["X-API-Key"], "key");
    });

    test("sends text to the number", async () => {
        const calls = mockFetch(() => ({ messages: [{ id: "wamid.new" }] }));
        const res = await provider.send({ from: "", to: ["+5491155550000"], cc: [], bcc: [], replyTo: [], subject: "", text: "Hola", html: null, headers: {}, attachments: [] }, "draft-1");
        assert.equal(res.providerId, "wamid.new");
        assert.equal(calls[0]!.url, `https://api.kapso.ai/meta/whatsapp/v24.0/${PHONE_ID}/messages`);
        assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { messaging_product: "whatsapp", recipient_type: "individual", to: "5491155550000", type: "text", text: { body: "Hola" } });
    });

    test("uploads an attachment and sends it with the text as caption", async () => {
        const calls = mockFetch(url => url.endsWith("/media") ? { id: "media-9" } : { messages: [{ id: "wamid.img" }] });
        const base = { from: "", to: ["+5491155550000"], cc: [], bcc: [], replyTo: [], subject: "", html: null, headers: {} };
        await provider.send({ ...base, text: "Tu preview", attachments: [{ filename: "p.png", contentType: "image/png", content: new Uint8Array([1]) }] }, "d");
        assert.ok(calls[0]!.init.body instanceof FormData);
        assert.deepEqual(JSON.parse(calls[1]!.init.body as string).image, { id: "media-9", caption: "Tu preview" });

        await provider.send({ ...base, text: "", attachments: [{ filename: "plan.pdf", contentType: "application/pdf", content: new Uint8Array([1]) }] }, "d");
        assert.deepEqual(JSON.parse(calls[3]!.init.body as string).document, { id: "media-9", filename: "plan.pdf" });

        await assert.rejects(provider.send({ ...base, text: "x".repeat(4097), attachments: [] }, "d"), /4096/);
    });

    test("downloads media through a fresh link, and surfaces API errors", async () => {
        const calls = mockFetch(url => url.includes("/v24.0/media-1") ? { download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=t" } : new Response(new Uint8Array([7, 8])));
        assert.deepEqual([...await provider.getAttachment("wamid.in", "media-1")], [7, 8]);
        assert.match(calls[0]!.url, /v24\.0\/media-1\?phone_number_id=923801917492966$/);

        mockFetch(() => new Response("Re-engagement message", { status: 422 }));
        await assert.rejects(provider.getMessage("wamid.x"), /422 Re-engagement message/);
    });
});
