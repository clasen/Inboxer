import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ConflictError, InvalidRequestError } from "../src/core/mail.ts";
import { CATCHALL } from "../src/types.ts";
import { startCore, type CoreHarness } from "./helpers.ts";

const agent = { kind: "agent", name: "schedule" } as const;
const human = { kind: "ui", name: "phone" } as const;

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
        assert.equal((await h.mail.listThreads({ status: "unanswered" })).length, 1);
        const draft = await h.mail.createDraft({ replyToId: id, text: "7 days.", note: "check the license first" }, agent);
        assert.equal((await h.mail.listThreads({ status: "unanswered" })).length, 0);
        await h.mail.discardDraft(draft.id, agent);
        assert.equal((await h.mail.listThreads({ status: "unanswered" })).length, 1);
        await h.mail.reply(id, "7 days.", false, agent);
        assert.equal((await h.mail.listThreads({ status: "unanswered" })).length, 0);
        assert.equal((await h.mail.listThreads({ status: "all" })).length, 1);
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
        assert.deepEqual(await h.mail.listDrafts(), []);
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
        assert.equal((await h.mail.search({ query: "LICENCIA cancion" })).length, 1);
        assert.equal((await h.mail.search({ query: "licencia" })).length, 2);
        assert.equal((await h.mail.search({ query: "licencia", mailbox: "feedback" })).length, 1);
    });

    test("labels and archive apply to whole threads; a new inbound message unarchives", async () => {
        h.provider.addInbound({ providerId: "a", messageId: "<a@c.test>" });
        const id = await h.mail.ingest("a");
        const threadId = (await h.store.requireMessage(id)).thread_id;
        await h.mail.label([threadId], ["trial"], [], agent);
        await h.mail.mark([threadId], { archived: true, read: true }, agent);
        assert.equal((await h.mail.listThreads({ status: "archived", label: "trial" })).length, 1);
        h.provider.addInbound({ providerId: "b", inReplyTo: "<a@c.test>" });
        await h.mail.ingest("b");
        const thread = await h.store.requireThread(threadId);
        assert.equal(thread.archived, false);
        assert.equal(thread.unread, 1);
    });
});
