// Runs the web UI on dummy data to try it by hand. Mail goes to a fake provider: nothing leaves this machine.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createInboxer } from "../src/index.ts";
import type { AttachmentMeta } from "../src/types.ts";
import { FakeProvider, TOKEN, testConfig, webhook, type Harness } from "../test/helpers.ts";

const PORT = Number(process.env.PORT ?? 4100);
const dataDir = mkdtempSync(join(tmpdir(), "inboxer-preview-"));
const provider = new FakeProvider();
const wa = new FakeProvider("wa", "chat");
const config = testConfig(dataDir, { chat: true });
config.publicUrl = `http://localhost:${PORT}`;
config.ui.undoSec = 5;
const DOMAIN = "example.com";
for (const mailbox of Object.values(config.mailboxes)) mailbox.address = mailbox.address.replace(/@.*/, `@${DOMAIN}`);
const inboxer = createInboxer(config, { providers: { fake: provider, wa } });
await inboxer.ready;
const h: Harness = { inboxer, provider, wa, dataDir, close: async () => {} };

const client = new Client({ name: "preview", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    fetch: (input, init) => inboxer.fetch(new Request(input, init)),
}));
const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as { text: string }[])[0]!.text);
};

const inbound = (message: Parameters<FakeProvider["addInbound"]>[0]) => provider.addInbound({ to: [`support@${DOMAIN}`], ...message });
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const receive = async (...ids: string[]) => webhook(h, ids.map(providerId => ({ type: "message" as const, providerId })));
const file = (providerId: string, id: string, filename: string, content_type: string, body: string): AttachmentMeta => {
    provider.files.set(`${providerId}/${id}`, new TextEncoder().encode(body));
    return { id, filename, content_type, size: body.length, inline: false, content_id: null };
};
const threadOf = async (subject: string) =>
    (await call("list_threads", { status: "all" })).find((t: { subject: string }) => t.subject === subject);
const lastMessage = async (threadId: string) => (await call("get_thread", { thread_id: threadId })).messages.at(-1);

inbound({
    providerId: "laura-1", from: "Laura Pérez <laura@acme.io>", cc: ["finance@acme.io"], subject: "Invoice #2041 charged twice",
    text: "Hi,\n\nwe were charged twice for invoice #2041 this month, once on the 1st and again on the 3rd. Can you check and refund the duplicate?\n\nThanks,\nLaura",
    at: ago(60 * 50),
});
inbound({
    providerId: "tomas-1", from: "Tomás Kahn <tomas@kahn.dev>", subject: "Can't log in after password reset",
    text: "The link says expired every time I try, even right after requesting it. I'm on Safari 18.", at: ago(30),
});
inbound({
    providerId: "northwind-1", from: "Northwind Retail <buy@northwind.test>", to: [`feedback@${DOMAIN}`], subject: "Volume pricing for 40 seats",
    text: "We're evaluating for Q1 and would like a quote for 40 seats, billed yearly.", at: ago(60 * 26),
});
inbound({
    providerId: "marta-1", from: "Marta Soler <marta@soler.test>", subject: "Export to CSV drops the last column",
    text: "Attached two files, one from before the update and one from after. The \"notes\" column is gone in the new one.",
    attachments: [
        file("marta-1", "before", "export-before.csv", "text/csv", "id,name,notes\n1,Ana,VIP\n"),
        file("marta-1", "after", "export-after.csv", "text/csv", "id,name\n1,Ana\n"),
    ],
    at: ago(60 * 75),
});
inbound({
    providerId: "old-1", from: "Diego Ruiz <diego@ruiz.test>", subject: "Thanks for the quick fix",
    text: "All good now, you can close this one.", at: ago(60 * 24 * 6),
});
await receive("laura-1", "tomas-1", "northwind-1", "marta-1", "old-1");

const laura = await threadOf("Invoice #2041 charged twice");
await call("reply", { message_id: (await lastMessage(laura.id)).id, text: "Hi Laura, thanks for flagging this. I can see both charges on our side and asked billing to reverse the second one." });
inbound({
    providerId: "laura-2", from: "Laura Pérez <laura@acme.io>", cc: ["finance@acme.io"], subject: "Re: Invoice #2041 charged twice",
    inReplyTo: "<laura-1@customer.test>", references: ["<laura-1@customer.test>"],
    text: "Thanks. It's been three days and nothing yet, any update? Our finance team needs to close the month on Friday.",
    at: new Date().toISOString(),
});
await receive("laura-2");
await call("create_draft", {
    reply_to_id: (await lastMessage(laura.id)).id,
    text: "Hi Laura, the refund for the duplicate charge went out yesterday (ref. RF-88213). It can take 3 to 5 business days to show up.",
    note: "Billing confirmed the refund went out yesterday. Added the reference.",
});
await call("set_contact", { address: "laura@acme.io", meta: { company: "Acme", plan: "Business · 40 seats" }, note: "Prefers short replies." });
await call("set_thread_meta", { thread_id: laura.id, meta: { invoice: "#2041", refund_ref: "RF-88213" } });

const tomas = await threadOf("Can't log in after password reset");
await call("create_draft", {
    reply_to_id: (await lastMessage(tomas.id)).id,
    text: "Hi Tomás, sorry about that. Safari was opening the link twice and using it up. It's fixed now, please request a new one.",
    note: "Known Safari prefetch bug, fixed this morning.",
});

await call("send", { mailbox: "support", to: ["ana@customer.test"], subject: "Your trial ends Friday", text: "Hi Ana, a heads-up that your trial ends on Friday. Reply here if you need more time." });

const old = await threadOf("Thanks for the quick fix");
await call("mark", { ids: [old.id], archived: true });

const chat = (providerId: string, min: number, partial: Parameters<FakeProvider["chatMessage"]>[0] | object, counterpart?: string) =>
    ({ type: "message" as const, providerId, message: wa.chatMessage({ providerId, at: ago(min), ...partial }, counterpart) });
await webhook(h, [
    chat("wa-1", 95, { text: "Hola! Quiero publicitar mi cafetería en los vuelos a Bariloche" }),
    chat("wa-2", 94, { direction: "out", status: "read", text: "Hola Lucía, soy el asistente de Flight Desk. ¿Cómo se llama la cafetería y qué querés promocionar?" }),
    chat("wa-3", 90, { text: "Se llama Tostado. Una promo de desayuno para turistas" }),
    chat("wa-4", 89, { direction: "out", status: "read", text: "Perfecto. Pasé tu solicitud al equipo, te aviso apenas la revisen." }),
    chat("wa-5", 20, { direction: "out", status: "delivered", text: "¡Aprobada! Acá tenés el link de pago: https://pay.example.com/ord_81" }),
    chat("wa-6", 4, { text: "Genial, ¿puedo pagar con transferencia?" }),
    chat("wa-7", 300, { text: "Buenas, ¿cuánto sale una campaña de un mes?" }, "Bruno Díaz <+5491166660000>"),
    chat("wa-8", 299, { direction: "out", status: "delivered", text: "Hola Bruno, te cuento los planes disponibles." }, "Bruno Díaz <+5491166660000>"),
], "ok", "wa");
await call("set_contact", { address: "+5491155550000", meta: { stage: "approved", company: "Tostado" } });

const link = await call("create_login_link", { label: "preview" });
const server = createServer(inboxer.handler).listen(PORT, () => {
    console.log(`Inboxer preview on dummy data. Open this link to sign in:\n\n  ${link.url}\n\nCtrl+C stops it.`);
});

process.on("SIGINT", () => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
});
