import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { buildApp } from "./app.ts";
import { Access } from "./auth.ts";
import { assertConfig } from "./config.ts";
import { Mail } from "./core/mail.ts";
import { Sync } from "./core/sync.ts";
import { resolveProvider } from "./provider/index.ts";
import type { MailProvider } from "./provider/types.ts";
import { Store } from "./store.ts";
import type { InboxerConfig } from "./types.ts";

export interface InboxerOptions {
    /** A provider instance to use instead of resolving `cfg.provider.type`. */
    provider?: MailProvider;
}

export interface Inboxer {
    /** Web-standard handler for `Bun.serve`, Hono, Deno or any fetch-based server. */
    fetch: (req: Request) => Promise<Response>;
    /** Node-style `(req, res)` handler, e.g. for a roster-server site. */
    handler: (req: IncomingMessage, res: ServerResponse) => void;
    /** Resolves once the database is open and the first sync has run. Requests wait for it. */
    ready: Promise<void>;
    /** Stops the sync timer and closes the database. */
    close: () => Promise<void>;
}

export function createInboxer(cfg: InboxerConfig, options: InboxerOptions = {}): Inboxer {
    assertConfig(cfg, { requireProvider: !options.provider });
    const provider = options.provider ?? resolveProvider(cfg.provider);
    const store = new Store(cfg.dataDir);
    const mail = new Mail(store, provider, cfg);
    const access = new Access(store, cfg);
    const sync = new Sync(mail, cfg.syncIntervalMin);

    const ready = (async () => {
        await store.connect();
        await sync.run().catch(err => console.error("inboxer: initial sync failed", err));
        sync.start();
    })();

    const app = buildApp(mail, access, cfg, ready);
    const fetch = async (req: Request) => app.fetch(req);

    return {
        fetch,
        handler: getRequestListener(fetch, { overrideGlobalObjects: false }) as Inboxer["handler"],
        ready,
        async close() {
            await ready.catch(() => {});
            await sync.stop();
            await store.close();
        },
    };
}

export { WebhookSignatureError } from "./provider/types.ts";
export type {
    DeliveryStatus,
    InboundMessage,
    MailProvider,
    OutboundMessage,
    OutboundStatus,
    ProviderEvent,
    WebhookRequest,
} from "./provider/types.ts";
export type { InboxerConfig, MailboxConfig, ProviderConfig } from "./types.ts";
