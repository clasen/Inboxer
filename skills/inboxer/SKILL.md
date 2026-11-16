---
name: inboxer
description: Sets up, deploys and uses Inboxer, a self-hosted mail layer with an MCP server and a draft review UI. Use when adding Inboxer to a Node.js or Bun app or a roster-server site, configuring mailboxes, Resend and the domain, connecting an MCP client, or reading, triaging, drafting and sending email through Inboxer's MCP tools. Do not use for modifying Inboxer internals.
metadata:
  category: workflow-automation
  tags: [email, mcp, agent, resend, drafts, support, inbox]
---

# Inboxer

Inboxer stores every inbound and outbound email in one SQLite file, exposes MCP tools to read, draft and send, and serves a phone-friendly UI where a human reviews drafts. It has no business rules: the consumer's prompt decides what to answer and whether to send directly.

## Set up

Install with `npm install inboxer`; requires Node.js 22.16+ or Bun. `createInboxer` takes one plain object; load it the way the project already loads configuration (JSON file, environment variables, a loader such as Configre).

```javascript
const config = {
    publicUrl: "https://inboxer.example.com",
    dataDir: "/var/lib/inboxer",          // absolute
    syncIntervalMin: 10,
    threadWindowDays: 30,
    mailboxes: {
        support: { address: "support@example.com", name: "Example Support",
                   signatureText: "-- Example Support", signatureHtml: "<p>-- Example Support</p>",
                   tokens: { "support-schedule": "<openssl rand -hex 32>" } }   // support only
    },
    provider: { type: "resend", apiKey: "re_...", webhookSecret: "whsec_..." },
    mcp: { tokens: { "admin": "<openssl rand -hex 32>" }, maxAttachmentMb: 10 },  // every mailbox
    ui: { cookieSecret: "<openssl rand -hex 32>", loginLinkTtlMin: 10, undoSec: 10, maxUploadMb: 20 }
};
```

- Every key above is required except the mailbox signatures and mailbox tokens; `createInboxer` throws on a missing or invalid one. There are no defaults.
- `mailboxes` is an object keyed by id. `catchall` is reserved: unknown recipients land there, and it cannot send.
- `provider.apiKey`, `provider.webhookSecret`, every token and `ui.cookieSecret` are secrets: keep them out of Git and out of logs.

## Serve

`createInboxer(cfg, { provider? })` is synchronous, does not listen, and returns `{ fetch, handler, ready, close }`. Requests wait for `ready`.

```typescript
import { createInboxer } from "inboxer";

const inboxer = createInboxer(config);
Bun.serve({ port: 4000, fetch: inboxer.fetch });       // or createServer(inboxer.handler) on Node
```

For roster-server, return `inboxer.handler` from the `SiteFactory` and register `server.onClose(() => inboxer.close())`.

- Run exactly one process per `dataDir`. Login links and draft versions rely on an in-process write queue.
- Routes: `/` UI, `/static/*`, `/mcp`, `/webhooks/<provider>`, `/auth/<token>`.

## Resend and the domain

Keep two domains apart: the app runs on its own host, e.g. `inboxer.example.com` (`A`/`AAAA` + HTTPS, the `publicUrl`), while the addresses live on the mail domain, e.g. `support@example.com` (`MX` to Resend + SPF, DKIM, DMARC).

1. Deploy Inboxer over HTTPS at `publicUrl` first.
2. In Resend, add the domain, create its SPF, DKIM and MX records, and enable receiving. The MX switch moves the whole domain's mail to Resend; use a subdomain to keep the root elsewhere.
3. Add a DMARC TXT record at `_dmarc.<domain>`.
4. Create a full-access API key (Inboxer reads emails, not only sends) → `provider.apiKey`.
5. Create a webhook at `<publicUrl>/webhooks/resend` for `email.received`, `email.sent`, `email.delivered`, `email.bounced`, `email.failed`, `email.suppressed` → its signing secret is `provider.webhookSecret`.
6. Restart and send a test email from outside. A webhook `401` means a wrong signing secret.

Missed webhooks are recovered by the periodic sync.

## Another provider

Implement `MailProvider` (exported types) and pass it as `createInboxer(cfg, { provider })`; `cfg.provider.type` is then not required. `send()` must not deliver twice for the same `idempotencyKey` (Inboxer passes the draft id). `parseWebhook()` throws `WebhookSignatureError` on a bad signature.

## Connect an MCP client

One token per client, so the audit log names the actor and revoking one leaves the rest. Revoke by deleting the entry and restarting.

Tokens in `mcp.tokens` reach every mailbox. A token under `mailboxes.<id>.tokens` reaches only that mailbox: everything else reads as not found, it reaches only contacts in its own threads, and its login links sign browsers into the same mailboxes. Repeat the same name and token under several mailboxes to reach all of them.

```bash
claude mcp add --transport http inboxer https://inboxer.example.com/mcp --header "Authorization: Bearer <token>"
```

JSON clients: `{ "type": "http", "url": "<publicUrl>/mcp", "headers": { "Authorization": "Bearer <token>" } }`. OAuth-only connectors are not supported.

## Work with mail through MCP

Typical support loop:

1. `list_threads({ mailbox: "support" })`: status defaults to `unanswered` (last message inbound and no pending draft).
2. `get_thread({ thread_id })`: messages as plain text, oldest first, with pending drafts, plus `context` (the thread's) and `contacts` (its external participants').
3. Decide with the consumer's own rules and data.
4. `create_draft({ reply_to_id, text, note })` for human review, or `reply({ message_id, text })` only when the rules allow sending without review.

Rules for agents:

- Pass a **message id** as `reply_to_id` or `message_id`. Recipients, `Re:` subject, `In-Reply-To` and `References` are derived; do not set them by hand. `reply_all` adds the original To/Cc minus the mailbox itself.
- Put what the reviewer must do or check in `note`, not in the body. The note is never sent.
- A new conversation needs `mailbox`, `to` and `subject`.
- `update_draft` needs the draft's current `version`. On a conflict the error includes `current`; re-read it before retrying.
- A draft whose `pending` is set is in the reviewer's undo window and is about to be sent or discarded; `update_draft` fails until it ends.
- Never `force` an update of a draft with `edited_by_human: true` unless the user explicitly asks; the human's edit wins.
- `send_draft` sends the last saved version. A failed send leaves the draft pending and retrying is safe.
- `label` and `mark` accept message ids or thread ids; a thread id applies to every message in it. Archived threads come back to the inbox when a new message arrives.
- `search` matches every term, ignoring case and accents, across subject, body, from and to; narrow with `mailbox`, `from`, `since`, `until`, `meta`. Pass `query`, `meta`, or both.
- Messages list their `attachments` (`inline: true` is an image embedded in the body). `get_attachment` returns the content: images as images you can look at, text as text, other files (PDF, documents) as an embedded resource. Files over `mcp.maxAttachmentMb` return an error. Agents cannot attach files to drafts; the reviewer can, in the UI, and they are listed in the draft's `attachments`.
- Threads, messages and drafts in results carry `url`, which opens them in the review UI (scrolled to the draft). When telling the user what you drafted or sent, include that `url`.
- Times are ISO 8601. `catchall` messages can be read and labeled but not answered from Inboxer.

Context:

- Read `contacts` and `context` from `get_thread` before looking anything up elsewhere; earlier runs may have stored it.
- After identifying a sender in another system, store the link with `set_contact({ address, meta: { <system>_id: ... } })`. Use the key names the consumer's prompt defines and keep them stable across runs.
- Use `set_thread_meta` for facts about one conversation (ticket, promise, pending step) and `note` for short human-readable context.
- Updates merge: send only the keys you change; `null` removes a key or clears the note. Never resend the whole object to "replace" it.
- To find every conversation with a customer, use `list_threads({ status: "all", meta: { ... } })`; without `status: "all"` only unanswered threads come back.
- The reviewer sees contact and thread context in the UI. Do not store secrets there.

## Give a human access to the UI

Call `create_login_link({ label: "Ana's phone" })` and hand the returned URL to the person; add `thread_id` to land on that thread after signing in. It works once, expires after `ui.loginLinkTtlMin` minutes if unused, and signs in one browser for good. `list_sessions` and `revoke_session({ id })` manage devices. Without MCP, call `createLoginLink(cfg, { label, threadId? })` (exported by `inboxer`) from a script on the server with the app's config; it returns `{ url, expires_at }`.
