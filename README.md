# Inboxer

Your own mail layer for agents. Inboxer stores every email that comes in or goes out, gives agents an MCP server to read, draft and send, and gives you a small web UI to review drafts from your phone before they leave.

Inboxer has no business rules. It does not decide what to answer or when. Each consumer, such as a scheduled agent, a support bot or you in a chat, brings its own rules in its prompt and uses the same tools. Sending goes through a **provider**. Inboxer ships with [Resend](https://resend.com), and the provider interface lets you plug in another service without touching the rest.

- **One process, one SQLite file.** Persistence uses [DeepBase](https://github.com/clasen/DeepBase) on the runtime's built-in `node:sqlite`, so there is nothing to compile and no external database.
- **Webhooks plus a backup sync.** Inbound mail and delivery events arrive by webhook. A periodic sync picks up anything a webhook missed.
- **Threads that hold together.** Messages join threads by `In-Reply-To` / `References`, then by subject and participants, so replies stay grouped even when a client drops headers.
- **Drafts with a human in the loop.** Agents write drafts with a note for the reviewer. You edit and send them from the UI. Concurrent edits are detected, never silently overwritten.
- **No passwords.** The UI uses one-time login links that an agent requests through MCP. Every link signs in one browser.
- **Runs on Node.js and Bun.** It works standalone or as a [roster-server](https://github.com/clasen/RosterServer) site.

## Use cases

Inboxer handles storage, threading and delivery. The decisions belong to whoever calls the tools, so the same instance can serve very different workflows.

**Support with a human in the loop.** A scheduled agent runs every hour with a prompt that holds your support rules. It calls `list_threads({ mailbox: "support", status: "unanswered" })` and reads each thread with `get_thread`. It looks the sender up in your own systems, such as a license server or a CRM, and writes a reply with `create_draft`, adding a `note` for you: "Extend the trial by 7 days before sending." You open the Drafts screen on your phone, do what the note asks, adjust the text if needed and press Send.

**Automatic answers for the easy cases.** The same agent can be allowed to answer some questions directly. Its prompt says which ones, for example "if the question is only about pricing, `reply` with the pricing page". Everything else still becomes a draft. Inboxer does not enforce the split; the prompt does, and the audit log records which token sent what.

**Several addresses, one inbox.** `support@`, `billing@` and `feedback@` are separate mailboxes with their own sender name and signature. Agents filter by mailbox, and mail to any other address of the domain lands in `catchall` instead of bouncing.

**Triage and follow-up.** An agent labels threads (`label`), archives the ones that need no answer (`mark`), and finds earlier conversations with a customer before replying (`search({ query: "license", from: "ana@" })`).

**Ad hoc work from your own assistant.** Connect Inboxer to the agent you use day to day and ask it to "summarize what customers asked this week" or "find every thread about refunds since Monday and draft a reply for each". It uses the same tools as the scheduled jobs, under its own token.

## Quick start

Requires **Node.js 22.16 or later**, or **Bun**.

```bash
npm install inboxer configre
```

Create `config/index.cjs` with the public settings:

```javascript
module.exports = {
    publicUrl: "https://mail.example.com",
    dataDir: "/var/lib/inboxer",       // absolute path
    syncIntervalMin: 10,
    threadWindowDays: 30,
    mailboxes: {
        support:  { address: "support@example.com",  name: "Example Support",
                    signatureText: "-- Example Support", signatureHtml: "<p>-- Example Support</p>" },
        feedback: { address: "feedback@example.com", name: "Example" }
    },
    provider: { type: "resend" },
    ui: { loginLinkTtlMin: 10 }
};
```

Put the secrets in `config/index.secret.cjs`. [Configre](https://github.com/clasen/Configre) merges them over the public file and keeps them encrypted in Git:

```javascript
module.exports = {
    provider: { apiKey: "re_...", webhookSecret: "whsec_..." },
    mcp: { tokens: { "support-schedule": "...", "laptop": "..." } },
    ui: { cookieSecret: "..." }
};
```

Generate each token and the cookie secret with:

```bash
openssl rand -hex 32
```

Serve it with Bun:

```typescript
import Configre from "configre";
import { join } from "node:path";
import { createInboxer } from "inboxer";

const inboxer = createInboxer(Configre(join(import.meta.dirname, "config")));
Bun.serve({ port: 4000, fetch: inboxer.fetch });
```

Or with Node.js:

```typescript
import { createServer } from "node:http";

createServer(inboxer.handler).listen(4000);
```

Everything lives under one origin:

| Route | Purpose |
| --- | --- |
| `/` | Review UI |
| `/static/*` | CSS and the vendored htmx script |
| `/mcp` | MCP server (Streamable HTTP, stateless) |
| `/webhooks/<provider>` | Provider webhooks, e.g. `/webhooks/resend` |
| `/auth/<token>` | One-time login links |

## The `createInboxer` API

`createInboxer(cfg, options?)` does not listen on a port. It returns:

```typescript
{
    fetch: (req: Request) => Promise<Response>,  // Bun.serve, Hono, any fetch-based server
    handler: (req, res) => void,                 // Node-style, e.g. for roster-server
    ready: Promise<void>,                        // database open and first sync done
    close: () => Promise<void>                   // stops the sync and closes the database
}
```

The function is synchronous, so a host that needs a synchronous factory can call it directly. Requests wait for `ready` before they are handled.

`options.provider` takes a provider instance instead of resolving `cfg.provider.type`. See [Providers](#providers).

### As a roster-server site

```typescript
// www/mail.example.com/index.ts
import type { SiteFactory } from "roster-server";
import Configre from "configre";
import { join } from "node:path";
import { createInboxer } from "inboxer";

const site: SiteFactory = server => {
    const inboxer = createInboxer(Configre(join(import.meta.dirname, "config")));
    server.onClose(() => inboxer.close());
    return inboxer.handler;
};
export default site;
```

With roster's default isolation the site runs in its own process, so the database and the sync timer are never duplicated. Inboxer assumes a single process: login-link consumption and draft versioning rely on an in-process write queue.

## Configuration

| Key | Meaning |
| --- | --- |
| `publicUrl` | Base URL used in login links |
| `dataDir` | Absolute directory for `inboxer.db` |
| `syncIntervalMin` | Minutes between backup syncs with the provider |
| `threadWindowDays` | How far back a subject match may join an existing thread |
| `mailboxes.<id>` | `address`, `name`, optional `signatureText` and `signatureHtml` |
| `provider` | `type` plus the provider's own options (secrets go in the secret file) |
| `mcp.tokens.<name>` | Bearer tokens for MCP; the name is recorded as the actor in the audit log |
| `ui.cookieSecret` | Signs the UI session cookie |
| `ui.loginLinkTtlMin` | Minutes before an unused login link expires |

`mailboxes` is an object keyed by id rather than an array, so a Configre profile can override one mailbox without repeating the others. Mail sent to an address that matches no mailbox lands in the reserved `catchall` mailbox, which can be read but cannot send.

## Providers

A provider adapts one email service to the `MailProvider` interface. Nothing outside the provider knows which service is in use: messages store the provider's name and id, and the webhook route is `/webhooks/<name>`.

```typescript
interface MailProvider {
    readonly name: string;
    parseWebhook(req: { headers: Headers; body: string }): ProviderEvent[];  // throws WebhookSignatureError
    getInbound(providerId: string): Promise<InboundMessage>;
    listInbound(since: Date): AsyncIterable<string>;
    listOutbound(since: Date): AsyncIterable<{ providerId: string; status: DeliveryStatus }>;
    send(message: OutboundMessage, idempotencyKey: string): Promise<{ providerId: string }>;
    getAttachmentUrl(providerMessageId: string, attachmentId: string): Promise<string>;
}

type ProviderEvent =
    | { type: "received"; providerId: string }
    | { type: "status"; providerId: string; status: DeliveryStatus; messageId: string | null };

type DeliveryStatus = "sent" | "delivered" | "bounced" | "failed";
```

`send()` must not deliver twice for the same `idempotencyKey`. Inboxer uses the draft id, so retrying a failed send is safe. Pass your own implementation with `createInboxer(cfg, { provider })`. All the types above are exported from `inboxer`.

### Resend

`provider: { type: "resend", apiKey, webhookSecret }`.

Resend handles sending and receiving. Inboxer talks to it in three ways:

| Direction | How |
| --- | --- |
| Resend → Inboxer | A webhook to `<publicUrl>/webhooks/resend` for every received email and delivery event, signed with Svix |
| Inboxer → Resend | The REST API with your API key: fetch received emails, send, read delivery status, get attachment URLs |
| Backup | Every `syncIntervalMin` minutes Inboxer lists recent received and sent emails, in case a webhook was lost |

#### Setting up Resend and your domain

The steps below assume your mail domain is `example.com` and Inboxer runs at `https://mail.example.com`.

1. **Deploy Inboxer first.** Point `mail.example.com` at your server, serve it over HTTPS (roster-server issues certificates on its own; otherwise use your reverse proxy), and set `publicUrl` to that URL. The webhook and login links depend on it.
2. **Add the domain in Resend.** In *Domains*, add `example.com`. Resend lists the DNS records to create at your DNS provider: the SPF and DKIM records for sending, and the MX record for receiving. Enable receiving for the domain. Wait until Resend shows the domain as verified.
3. **Mind the MX switch.** Once the MX record points to Resend, every address of the domain is delivered to Resend and no longer to your previous mail host or forwarding rules. Mail to addresses you did not configure still reaches Inboxer, in the `catchall` mailbox. If you need to keep the root domain on another host, use a subdomain such as `help.example.com` for Inboxer's addresses.
4. **Add DMARC.** Create a TXT record at `_dmarc.example.com`, for example `v=DMARC1; p=none; rua=mailto:dmarc@example.com`, and tighten the policy once reports look clean.
5. **Create an API key.** In *API Keys*, create a key with full access: Inboxer reads received and sent emails, not just sends. Put it in `provider.apiKey`.
6. **Create the webhook.** In *Webhooks*, add an endpoint at `https://mail.example.com/webhooks/resend` with the `email.received`, `email.sent`, `email.delivered`, `email.bounced`, `email.failed` and `email.suppressed` events. Copy its signing secret into `provider.webhookSecret`.
7. **Restart and test.** Restart Inboxer so it loads the secrets. Send an email from an outside account to `support@example.com`. Within seconds it should appear in the UI's Inbox and in `list_threads`. Resend's webhook page shows each delivery and Inboxer's response; a `401` means the signing secret is wrong.

Inbound webhooks carry no body, so Inboxer fetches each message from the receiving API. The webhook answers `500` when processing fails, so Resend retries; processing is idempotent by Resend id.

Inboxer sets its own `Message-ID` (`<uuid@your-domain>`) on outgoing mail. If the provider reports a different one in a delivery event, Inboxer adopts it, so replies still find the thread. When neither header matches, the subject-and-participant rule keeps the conversation together.

## MCP

The MCP server is at `<publicUrl>/mcp`. It speaks Streamable HTTP without sessions, and every request carries `Authorization: Bearer <token>`.

### Connecting a client

Give each client its own token, so the audit log shows who did what and you can revoke one without touching the rest. Add it under `mcp.tokens` in `config/index.secret.cjs`:

```javascript
module.exports = {
    mcp: {
        tokens: {
            "support-schedule": "3f9c...",  // openssl rand -hex 32
            "laptop": "a71e..."
        }
    }
};
```

Restart Inboxer to load it. To revoke a token, delete its entry and restart.

With Claude Code:

```bash
claude mcp add --transport http inboxer https://mail.example.com/mcp --header "Authorization: Bearer <token>"
```

With a client configured by JSON, such as a project `.mcp.json`:

```json
{
    "mcpServers": {
        "inboxer": {
            "type": "http",
            "url": "https://mail.example.com/mcp",
            "headers": { "Authorization": "Bearer ${INBOXER_TOKEN}" }
        }
    }
}
```

Ask the client to call `list_mailboxes` to check the connection. Connectors that require OAuth, such as the ones added from the claude.ai web interface, are not supported yet; they need a client that can send a static header.

### Tools


| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Configured mailboxes plus `catchall` |
| `list_threads(mailbox?, status?, label?, since?, limit?)` | `status`: `unanswered` (default; last message inbound and no pending draft), `all` or `archived` |
| `search(query, mailbox?, from?, since?, until?, limit?)` | Full text over subject, body, from and to; accent and case insensitive |
| `get_thread(thread_id)` | Messages as plain text, pending drafts included |
| `label(ids, add?, remove?)` | Labels on messages, or on every message of a thread when given a thread id |
| `mark(ids, read?, archived?)` | Read and archived flags, same id rules |
| `create_draft(reply_to_id \| mailbox+to+subject, text, html?, note?, reply_all?, cc?, bcc?)` | A draft for review; `note` is shown highlighted to the reviewer |
| `update_draft(id, version, ..., force?)` | Requires the current `version`; refuses a draft a human edited unless `force: true` |
| `list_drafts(mailbox?)` · `discard_draft(id)` · `send_draft(id)` | Draft lifecycle; `send_draft` sends the last saved version |
| `send(mailbox, to, subject, text, ...)` · `reply(message_id, text, reply_all?)` | Direct sending, for consumers whose rules allow it |
| `get_attachment(message_id, attachment_id)` | Temporary download URL |
| `create_login_link(label?)` · `list_sessions` · `revoke_session(id)` | Access to the UI |

## The review UI

The UI is server-rendered with Hono and htmx, without a front-end build, and works on a phone.

- **Drafts:** mailbox, recipient, the agent's note and the thread underneath, with Edit, Send and Discard.
- **Editing:** To, Cc, Subject and a plain-text body, with Save and Save & Send. HTML is generated from the text at send time, with the mailbox signature. If the agent changed the draft while you were editing, saving shows both versions instead of overwriting. Your edits mark the draft `edited_by_human`, so agents leave it alone.
- **Inbox:** threads per mailbox, filtered by mailbox and by unanswered, all or archived.
- **Thread:** messages in order, as plain text. Incoming HTML is never rendered.
- **Devices:** the browsers signed in, each with a Revoke button.

The theme follows the system setting, with a System / Light / Dark switch stored in a cookie. Every UI string lives in `src/ui/strings.ts`.

### Signing in

1. An MCP client calls `create_login_link`. Inboxer stores only a SHA-256 hash of the token.
2. Opening the link shows a **Sign in on this device** button. Link previews and mail scanners only issue GET requests, so they do not use up the link.
3. The button's POST consumes the link and creates a session. Any later attempt sees "This link was already used or expired."
4. The session cookie is `HttpOnly`, `Secure`, `SameSite=Lax` and signed. Sessions do not expire; the cookie is re-issued on every visit so browsers keep it. A session ends on logout or revocation.

Each link creates one independent session. Revoking a phone does not sign out a laptop.

If you have no MCP client at hand, mint a link on the server:

```bash
npx inboxer-login-link ./config "my phone"
```

Pass `--config=<profile>` to select a Configre profile.

## Data

DeepBase is a nested key-value store without secondary indexes, so Inboxer maintains its own indexes in the same serialized write as the record they point to:

| Path | Content |
| --- | --- |
| `messages/<id>` | Every message: direction, status, headers, body, attachment metadata, labels, draft note and version |
| `threads/<id>` | Thread summary used by `list_threads` |
| `drafts/<id>` | Pending drafts |
| `msgid/<sha1(Message-ID)>` | Message lookup for threading |
| `ext/<provider>/<sha1(provider id)>` | Idempotent ingest and delivery updates |
| `audit/<id>` | Sends, edits, discards, labels, login links and session changes, with the actor |
| `login_links/<sha256>` · `sessions/<sha256>` | UI access |

Search scans messages in memory. That is enough for support volumes; a dedicated full-text index can be added later without changing the tools.

## Development

```bash
npm test          # Node.js test runner
npm run test:bun  # the same suite under Bun
npm run build     # compiles to dist/
```

## License

The MIT License (MIT)

Copyright (c) Martin Clasen

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
