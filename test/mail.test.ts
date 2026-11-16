import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ConflictError, InvalidRequestError, Mail } from "../src/core/mail.ts";
import { assertConfig, mcpTokens } from "../src/config.ts";
import { NotFoundError } from "../src/store.ts";
import { CATCHALL } from "../src/types.ts";
import { startCore, testConfig, type CoreHarness } from "./helpers.ts";

const agent = { kind: "agent", name: "schedule", scope: null } as const;
const human = { kind: "ui", name: "phone", scope: null } as const;
const feedbackBot = { kind: "agent", name: "feedback-bot", scope: ["feedback"] };

describe("mail core", () => {
    let h: CoreHarness;
    beforeEach(async () => { h = await startCore(); });
    afterEach(async () => { await h.close(); });

    test("ingest is idempotent by provider id", async () => {
        h.provider.addInbound({ providerId: "in-1" });
        const [a, b] = await Promise.all([h.mail.ingest("in-1"), h.mail.ingest("in-1")]);
        assert.equal(a, b);
        assert.equal((await h.store.allMessages()).length, 1);
        await h.mail.ingest("in-1");
        assert.equal(h.provider.fetches, 2, "a known id is not fetched again");
    });

    test("assigns the mailbox from To/Cc/envelope, unknown addresses fall into the catch-all", async () => {
        h.provider.addInbound({ providerId: "a", to: ["Team <FEEDBACK@inboxer.test>"] });
        h.provider.addInbound({ providerId: "b", to: ["someone@else.test"], deliveredTo: ["support@inboxer.test"] });
        h.provider.addInbound({ providerId: "c", to: ["nobody@inboxer.test"] });
        const mailbox = async (id: string) => (await h.store.requireMessage(await h.mail.ingest(id))).mailbox;
        assert.equal(await mailbox("a"), "feedback");
        assert.equal(await mailbox("b"), "support");
        assert.equal(await mailbox("c"), CATCHALL);
    });

    test("threads by In-Reply-To, then by subject and participant within the window, else a new thread", async () => {
        h.provider.addInbound({ providerId: "first", messageId: "<first@customer.test>" });
        const first = await h.store.requireMessage(await h.mail.ingest("first"));

        h.provider.addInbound({ providerId: "byref", inReplyTo: "<first@customer.test>", subject: "Something else" });
        assert.equal((await h.store.requireMessage(await h.mail.ingest("byref"))).thread_id, first.thread_id);

        h.provider.addInbound({ providerId: "bysubject", subject: "RE: Fwd: trial question", from: "ana@customer.test" });
        assert.equal((await h.store.requireMessage(await h.mail.ingest("bysubject"))).thread_id, first.thread_id);

        h.provider.addInbound({ providerId: "stranger", subject: "Trial question", from: "bob@other.test" });
        assert.notEqual((await h.store.requireMessage(await h.mail.ingest("stranger"))).thread_id, first.thread_id);

        const old = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
        h.provider.addInbound({ providerId: "old", subject: "Ancient", from: "carl@customer.test", receivedAt: old });
        const oldThread = (await h.store.requireMessage(await h.mail.ingest("old"))).thread_id;
        h.provider.addInbound({ providerId: "new", subject: "Re: Ancient", from: "carl@customer.test" });
        assert.notEqual((await h.store.requireMessage(await h.mail.ingest("new"))).thread_id, oldThread);
    });

    test("unanswered threads: last message inbound and no pending draft", async () => {
        h.provider.addInbound({ providerId: "q" });
        const id = await h.mail.ingest("q");
        assert.equal((await h.mail.listThreads({ status: "unanswered" }, null)).length, 1);
        const draft = await h.mail.createDraft({ replyToId: id, text: "7 days.", note: "check the license first" }, agent);
        assert.equal((await h.mail.listThreads({ status: "unanswered" }, null)).length, 0);
        await h.mail.discardDraft(draft.id, agent);
        assert.equal((await h.mail.listThreads({ status: "unanswered" }, null)).length, 1);
        await h.mail.reply(id, "7 days.", false, agent);
        assert.equal((await h.mail.listThreads({ status: "unanswered" }, null)).length, 0);
        assert.equal((await h.mail.listThreads({ status: "all" }, null)).length, 1);
    });

    test("a reply draft derives recipients, subject and threading headers", async () => {
        h.provider.addInbound({ providerId: "q", replyTo: ["ana.alt@customer.test"], cc: ["boss@customer.test", "support@inboxer.test"] });
        const id = await h.mail.ingest("q");
        const draft = await h.mail.createDraft({ replyToId: id, replyAll: true, text: "Hi" }, agent);
        assert.deepEqual(draft.to, ["ana.alt@customer.test"]);
        assert.deepEqual(draft.cc, ["boss@customer.test"]);
        assert.equal(draft.subject, "Re: Trial question");
        assert.equal(draft.in_reply_to, "<q@customer.test>");
        assert.deepEqual(draft.references, ["<q@customer.test>"]);
        assert.equal(draft.from, '"Inboxer Support" <support@inboxer.test>');
    });

    test("update_draft requires the current version and respects human edits", async () => {
        const draft = await h.mail.createDraft({ mailbox: "support", to: ["ana@customer.test"], subject: "Hi", text: "v1" }, agent);
        const v2 = await h.mail.updateDraft(draft.id, 1, { text: "v2" }, agent);
        assert.equal(v2.version, 2);
        await assert.rejects(h.mail.updateDraft(draft.id, 1, { text: "stale" }, agent), ConflictError);

        const edited = await h.mail.updateDraft(draft.id, 2, { text: "human" }, human);
        assert.equal(edited.edited_by_human, true);
        await assert.rejects(h.mail.updateDraft(draft.id, 3, { text: "agent" }, agent), /edited by a human/);
        const forced = await h.mail.updateDraft(draft.id, 3, { text: "agent" }, agent, true);
        assert.equal(forced.text, "agent");

        const actions = (await h.store.auditEntries()).map(e => `${e.action}:${e.actor}`);
        assert.ok(actions.includes("draft.update:ui:phone"));
    });

    test("send uses the draft id as idempotency key, adds the signature and keeps the Message-ID across retries", async () => {
        const draft = await h.mail.createDraft({ mailbox: "support", to: ["ana@customer.test"], subject: "Hi", text: "Body" }, agent);
        h.provider.failNextSend = true;
        await assert.rejects(h.mail.sendDraft(draft.id, agent), /provider down/);
        const pending = await h.store.requireMessage(draft.id);
        assert.equal(pending.status, "draft");
        assert.ok(pending.message_id);

        const sent = await h.mail.sendDraft(draft.id, agent);
        assert.equal(sent.status, "sent");
        assert.equal(sent.message_id, pending.message_id);
        const [call] = h.provider.sent;
        assert.equal(call!.idempotencyKey, draft.id);
        assert.equal(call!.message.headers["Message-ID"], pending.message_id);
        assert.match(call!.message.text, /Body\n\n-- Support$/);
        assert.match(call!.message.html, /<p>Body<\/p>\n<p>-- Support<\/p>/);
        await assert.rejects(h.mail.sendDraft(draft.id, agent), InvalidRequestError);
        assert.deepEqual(await h.mail.listDrafts(undefined, null), []);
    });

    test("a reply to our sent message threads back through the Message-ID index", async () => {
        const sent = await h.mail.send({ mailbox: "support", to: ["ana@customer.test"], subject: "Welcome", text: "Hi" }, agent);
        h.provider.addInbound({ providerId: "answer", inReplyTo: sent.message_id, subject: "Thanks" });
        assert.equal((await h.store.requireMessage(await h.mail.ingest("answer"))).thread_id, sent.thread_id);
    });

    test("delivery status never moves backwards and adopts the provider's Message-ID", async () => {
        const sent = await h.mail.send({ mailbox: "support", to: ["ana@customer.test"], subject: "S", text: "T" }, agent);
        await h.mail.applyStatus(sent.provider_id!, "delivered", "<rewritten@provider.test>");
        await h.mail.applyStatus(sent.provider_id!, "sent", null);
        const after = await h.store.requireMessage(sent.id);
        assert.equal(after.status, "delivered");
        assert.equal(after.message_id, "<rewritten@provider.test>");
        assert.equal(await h.store.lookupMessageId("<rewritten@provider.test>"), sent.id);
    });

    test("the catch-all cannot send", async () => {
        h.provider.addInbound({ providerId: "x", to: ["unknown@inboxer.test"] });
        const id = await h.mail.ingest("x");
        await assert.rejects(h.mail.createDraft({ replyToId: id, text: "hi" }, agent), /cannot send/);
    });

    test("search is accent and case insensitive and filters by mailbox", async () => {
        h.provider.addInbound({ providerId: "a", subject: "Licencia vencida", text: "No puedo activar la canción" });
        h.provider.addInbound({ providerId: "b", to: ["feedback@inboxer.test"], subject: "Licencia", text: "otra" });
        await h.mail.ingest("a");
        await h.mail.ingest("b");
        assert.equal((await h.mail.search({ query: "LICENCIA cancion" }, null)).length, 1);
        assert.equal((await h.mail.search({ query: "licencia" }, null)).length, 2);
        assert.equal((await h.mail.search({ query: "licencia", mailbox: "feedback" }, null)).length, 1);
    });

    test("labels and archive apply to whole threads; a new inbound message unarchives", async () => {
        h.provider.addInbound({ providerId: "a", messageId: "<a@c.test>" });
        const id = await h.mail.ingest("a");
        const threadId = (await h.store.requireMessage(id)).thread_id;
        await h.mail.label([threadId], ["trial"], [], agent);
        await h.mail.mark([threadId], { archived: true, read: true }, agent);
        assert.equal((await h.mail.listThreads({ status: "archived", label: "trial" }, null)).length, 1);
        h.provider.addInbound({ providerId: "b", inReplyTo: "<a@c.test>" });
        await h.mail.ingest("b");
        const thread = await h.store.requireThread(threadId);
        assert.equal(thread.archived, false);
        assert.equal(thread.unread, 1);
    });

    test("contact context merges by key, null removes, and addresses are normalized", async () => {
        await h.mail.setContact("Ana <ANA@customer.test>", { meta: { license_id: "BL-2231", plan: "trial" }, note: "Asked twice" }, agent);
        const updated = await h.mail.setContact("ana@customer.test", { meta: { plan: null, crm_id: 991 } }, agent);
        assert.deepEqual(updated.meta, { license_id: "BL-2231", crm_id: 991 });
        assert.equal(updated.note, "Asked twice");
        assert.equal(updated.updated_by, "agent:schedule");
        assert.equal((await h.mail.setContact("ana@customer.test", { note: null }, agent)).note, null);
        await assert.rejects(h.mail.setContact("not-an-address", { note: "x" }, agent), InvalidRequestError);
        await assert.rejects(h.mail.setContact("a@b.test", { meta: { " ": 1 } }, agent), InvalidRequestError);
        assert.ok((await h.store.auditEntries()).some(e => e.action === "contact.update" && e.target === "ana@customer.test"));
    });

    test("meta filters find threads through the contact or the thread context", async () => {
        h.provider.addInbound({ providerId: "a", from: "ana@customer.test" });
        h.provider.addInbound({ providerId: "b", from: "bob@other.test", subject: "Invoice" });
        const anaThread = (await h.store.requireMessage(await h.mail.ingest("a"))).thread_id;
        const bobThread = (await h.store.requireMessage(await h.mail.ingest("b"))).thread_id;
        await h.mail.setContact("ana@customer.test", { meta: { crm_id: 991 } }, agent);
        await h.mail.setThreadContext(bobThread, { meta: { ticket: "45" } }, agent);

        assert.deepEqual((await h.mail.listThreads({ status: "all", meta: { crm_id: "991" } }, null)).map(t => t.id), [anaThread]);
        assert.deepEqual((await h.mail.listThreads({ status: "all", meta: { ticket: 45 } }, null)).map(t => t.id), [bobThread]);
        assert.deepEqual(await h.mail.listThreads({ status: "all", meta: { crm_id: 1 } }, null), []);
        assert.equal((await h.mail.search({ meta: { crm_id: 991 } }, null))[0]!.thread_id, anaThread);
        assert.equal((await h.mail.search({ query: "invoice", meta: { crm_id: 991 } }, null)).length, 0);
        await assert.rejects(h.mail.search({}, null), InvalidRequestError);
    });

    test("getThread returns the thread context and external contacts, which survive new messages", async () => {
        h.provider.addInbound({ providerId: "a", messageId: "<a@c.test>", from: "ana@customer.test" });
        const threadId = (await h.store.requireMessage(await h.mail.ingest("a"))).thread_id;
        await h.mail.setThreadContext(threadId, { note: "promised an answer on Monday" }, agent);
        await h.mail.setContact("ana@customer.test", { meta: { crm_id: 991 } }, agent);
        await h.mail.setContact("support@inboxer.test", { note: "own address" }, agent);
        h.provider.addInbound({ providerId: "b", inReplyTo: "<a@c.test>", from: "ana@customer.test" });
        await h.mail.ingest("b");

        const { context, contacts, messages } = await h.mail.getThread(threadId, null);
        assert.equal(messages.length, 2);
        assert.equal(context?.note, "promised an answer on Monday");
        assert.deepEqual(contacts.map(c => c.address), ["ana@customer.test"]);
        await assert.rejects(h.mail.setThreadContext("missing", { note: "x" }, agent));
    });

    test("a scoped actor only reaches its mailboxes; the rest reads as missing", async () => {
        h.provider.addInbound({ providerId: "s", from: "ana@customer.test", subject: "Support question" });
        h.provider.addInbound({ providerId: "f", from: "bob@other.test", to: ["feedback@inboxer.test"], subject: "Feedback idea" });
        const support = await h.store.requireMessage(await h.mail.ingest("s"));
        const feedback = await h.store.requireMessage(await h.mail.ingest("f"));
        const scope = feedbackBot.scope;

        assert.deepEqual(h.mail.listMailboxes(scope).map(m => m.id), ["feedback"]);
        assert.ok(h.mail.listMailboxes(null).some(m => m.id === CATCHALL));
        assert.deepEqual((await h.mail.listThreads({ status: "all" }, scope)).map(t => t.id), [feedback.thread_id]);
        assert.deepEqual(await h.mail.listThreads({ status: "all", mailbox: "support" }, scope), []);
        assert.equal((await h.mail.search({ query: "question" }, scope)).length, 0);
        await assert.rejects(h.mail.getThread(support.thread_id, scope), NotFoundError);
        await assert.rejects(h.mail.label([support.thread_id], ["x"], [], feedbackBot), NotFoundError);
        await assert.rejects(h.mail.createDraft({ replyToId: support.id, text: "hi" }, feedbackBot), NotFoundError);
        await assert.rejects(h.mail.createDraft({ mailbox: "support", to: ["x@y.test"], subject: "s", text: "t" }, feedbackBot), /not available/);
        await assert.rejects(h.mail.setThreadContext(support.thread_id, { note: "x" }, feedbackBot), NotFoundError);

        const draft = await h.mail.createDraft({ replyToId: feedback.id, text: "Thanks" }, feedbackBot);
        assert.deepEqual((await h.mail.listDrafts(undefined, scope)).map(d => d.id), [draft.id]);
        await h.mail.createDraft({ replyToId: support.id, text: "Hi" }, agent);
        assert.equal((await h.mail.listDrafts(undefined, scope)).length, 1);

        await h.mail.setContact("bob@other.test", { meta: { crm_id: 7 } }, feedbackBot);
        await assert.rejects(h.mail.setContact("ana@customer.test", { note: "x" }, feedbackBot), NotFoundError);
        await assert.rejects(h.mail.getContact("ana@customer.test", scope), NotFoundError);
        assert.equal((await h.mail.getContact("bob@other.test", null))?.meta.crm_id, 7);
    });

    test("a token keeps one name, and the same name under several mailboxes reaches all of them", () => {
        const cfg = testConfig("/tmp/x");
        cfg.mailboxes.support!.tokens = { "feedback-bot": "other-token" };
        assert.throws(() => assertConfig(cfg, { requireProvider: true }), /feedback-bot/);
        cfg.mailboxes.support!.tokens = { renamed: cfg.mailboxes.feedback!.tokens!["feedback-bot"]! };
        assert.throws(() => assertConfig(cfg, { requireProvider: true }), /already used/);
        cfg.mailboxes.support!.tokens = { "feedback-bot": cfg.mailboxes.feedback!.tokens!["feedback-bot"]! };
        assert.deepEqual(mcpTokens(cfg).find(t => t.name === "feedback-bot")?.scope, ["support", "feedback"]);
        assert.equal(mcpTokens(cfg).find(t => t.name === "agent")?.scope, null);
    });

    test("a human's send waits for the undo window, survives a restart, and undo cancels it", async () => {
        const wait = () => new Promise(resolve => setTimeout(resolve, 120));
        const send = await h.mail.createDraft({ mailbox: "support", to: ["ana@customer.test"], subject: "Hi", text: "one" }, agent);
        const drop = await h.mail.createDraft({ mailbox: "support", to: ["bob@other.test"], subject: "Hi", text: "two" }, agent);

        await h.mail.schedule(drop.id, "discard", human);
        await h.mail.undo(drop.id, human);
        await h.mail.schedule(send.id, "send", human);
        h.mail.stopPending();
        await wait();
        assert.equal(h.provider.sent.length, 0, "nothing runs while the process is down");

        const restarted = new Mail(h.store, h.provider, testConfig("/tmp/unused"));
        await restarted.resumePending();
        await wait();
        restarted.stopPending();
        assert.equal(h.provider.sent.length, 1);
        assert.equal((await h.store.requireMessage(send.id)).status, "sent");
        const kept = await h.store.requireMessage(drop.id);
        assert.equal(kept.status, "draft");
        assert.equal(kept.pending, null);
        assert.ok((await h.store.auditEntries()).some(e => e.action === "send" && e.actor === "ui:phone"));
    });

    test("attachments are copied to disk at ingest and served from there; a failed copy retries on first read", async () => {
        h.provider.addInbound({ providerId: "a", attachments: [
            { id: "img", filename: "photo.png", content_type: "image/png", size: 3, inline: true, content_id: "ii_1" },
            { id: "doc", filename: "terms.pdf", content_type: "application/pdf", size: 4, inline: false, content_id: null },
        ] });
        h.provider.files.set("a/img", new Uint8Array([1, 2, 3]));
        const id = await h.mail.ingest("a");
        assert.equal(h.provider.downloads, 2, "the missing PDF was attempted too");

        const image = await h.mail.getAttachment(id, "img", null);
        assert.deepEqual([...image.body], [1, 2, 3]);
        assert.equal(image.meta.inline, true);
        assert.equal(h.provider.downloads, 2, "served from disk");

        h.provider.files.set("a/doc", new Uint8Array([4, 5, 6, 7]));
        assert.equal((await h.mail.getAttachment(id, "doc", null)).body.byteLength, 4);
        assert.equal(h.provider.downloads, 3);
        await assert.rejects(h.mail.getAttachment(id, "img", ["feedback"]), NotFoundError);
        await assert.rejects(h.mail.getAttachment(id, "missing", null), NotFoundError);
    });

    test("files attached to a draft go out with it; detaching removes them", async () => {
        const draft = await h.mail.createDraft({ mailbox: "support", to: ["ana@customer.test"], subject: "Docs", text: "attached" }, agent);
        await h.mail.attach(draft.id, { filename: "a.txt", contentType: "text/plain", body: new TextEncoder().encode("A") }, human);
        const withTwo = await h.mail.attach(draft.id, { filename: "b.bin", contentType: "", body: new Uint8Array([9]) }, human);
        assert.equal(withTwo.version, draft.version, "attaching never conflicts with text edits");
        assert.equal(withTwo.attachments[1]!.content_type, "application/octet-stream");
        await h.mail.detach(draft.id, withTwo.attachments[1]!.id, human);
        assert.deepEqual([...(await h.mail.getAttachment(draft.id, withTwo.attachments[0]!.id, null)).body], [65]);

        await h.mail.sendDraft(draft.id, human);
        const sent = h.provider.sent[0]!.message.attachments;
        assert.deepEqual(sent.map(a => [a.filename, a.contentType, [...a.content]]), [["a.txt", "text/plain", [65]]]);
        await assert.rejects(h.mail.attach(draft.id, { filename: "c", contentType: "text/plain", body: new Uint8Array() }, human), InvalidRequestError);
    });
});
