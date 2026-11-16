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
const config = testConfig(dataDir);
config.publicUrl = `http://localhost:${PORT}`;
config.ui.undoSec = 5;
const inboxer = createInboxer(config, { provider });
await inboxer.ready;
const h: Harness = { inboxer, provider, dataDir, close: async () => {} };

const client = new Client({ name: "preview", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    fetch: (input, init) => inboxer.fetch(new Request(input, init)),
}));
const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse((res.content as { text: string }[])[0]!.text);
};

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const receive = async (...ids: string[]) => webhook(h, ids.map(providerId => ({ type: "received" as const, providerId })));
const file = (providerId: string, id: string, filename: string, content_type: string, body: string): AttachmentMeta => {
    provider.files.set(`${providerId}/${id}`, new TextEncoder().encode(body));
    return { id, filename, content_type, size: body.length, inline: false, content_id: null };
};
const threadOf = async (subject: string) =>
    (await call("list_threads", { status: "all" })).find((t: { subject: string }) => t.subject === subject);
const lastMessage = async (threadId: string) => (await call("get_thread", { thread_id: threadId })).messages.at(-1);

provider.addInbound({
    providerId: "laura-1", from: "Laura Pérez <laura@acme.io>", cc: ["finance@acme.io"], subject: "Invoice #2041 charged twice",
    text: "Hi,\n\nwe were charged twice for invoice #2041 this month, once on the 1st and again on the 3rd. Can you check and refund the duplicate?\n\nThanks,\nLaura",
    receivedAt: ago(60 * 50),
});
provider.addInbound({
    providerId: "tomas-1", from: "Tomás Kahn <tomas@kahn.dev>", subject: "Can't log in after password reset",
    text: "The link says expired every time I try, even right after requesting it. I'm on Safari 18.", receivedAt: ago(30),
});
provider.addInbound({
    providerId: "northwind-1", from: "Northwind Retail <buy@northwind.test>", to: ["feedback@inboxer.test"], subject: "Volume pricing for 40 seats",
    text: "We're evaluating for Q1 and would like a quote for 40 seats, billed yearly.", receivedAt: ago(60 * 26),
});
provider.addInbound({
    providerId: "marta-1", from: "Marta Soler <marta@soler.test>", subject: "Export to CSV drops the last column",
    text: "Attached two files, one from before the update and one from after. The \"notes\" column is gone in the new one.",
    attachments: [
        file("marta-1", "before", "export-before.csv", "text/csv", "id,name,notes\n1,Ana,VIP\n"),
        file("marta-1", "after", "export-after.csv", "text/csv", "id,name\n1,Ana\n"),
    ],
    receivedAt: ago(60 * 75),
});
provider.addInbound({
    providerId: "old-1", from: "Diego Ruiz <diego@ruiz.test>", subject: "Thanks for the quick fix",
    text: "All good now, you can close this one.", receivedAt: ago(60 * 24 * 6),
});
await receive("laura-1", "tomas-1", "northwind-1", "marta-1", "old-1");

const laura = await threadOf("Invoice #2041 charged twice");
await call("reply", { message_id: (await lastMessage(laura.id)).id, text: "Hi Laura, thanks for flagging this. I can see both charges on our side and asked billing to reverse the second one." });
provider.addInbound({
    providerId: "laura-2", from: "Laura Pérez <laura@acme.io>", cc: ["finance@acme.io"], subject: "Re: Invoice #2041 charged twice",
    inReplyTo: "<laura-1@customer.test>", references: ["<laura-1@customer.test>"],
    text: "Thanks. It's been three days and nothing yet, any update? Our finance team needs to close the month on Friday.",
    receivedAt: new Date().toISOString(),
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

const link = await call("create_login_link", { label: "preview" });
const server = createServer(inboxer.handler).listen(PORT, () => {
    console.log(`Inboxer preview on dummy data. Open this link to sign in:\n\n  ${link.url}\n\nCtrl+C stops it.`);
});

process.on("SIGINT", () => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
});
