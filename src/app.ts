import { Hono } from "hono";
import { matchBearer, type Access } from "./auth.ts";
import { mcpTokens } from "./config.ts";
import { InvalidRequestError, type Mail } from "./core/mail.ts";
import { handleMcp } from "./mcp.ts";
import { WebhookSignatureError } from "./provider/types.ts";
import { NotFoundError } from "./store.ts";
import type { InboxerConfig } from "./types.ts";
import { ASSETS } from "./ui/assets.ts";
import { registerUi, type UiEnv } from "./ui/routes.ts";

export function buildApp(mail: Mail, access: Access, cfg: InboxerConfig, ready: Promise<void>): Hono<UiEnv> {
    const app = new Hono<UiEnv>();
    const tokens = mcpTokens(cfg);

    app.use("*", async (_c, next) => {
        await ready;
        await next();
    });

    app.onError((err, c) => {
        if (err instanceof NotFoundError) return c.text(err.message, 404);
        if (err instanceof InvalidRequestError) return c.text(err.message, 400);
        console.error("inboxer:", err);
        return c.text("Internal error", 500);
    });

    app.get("/static/:file", c => {
        const file = ASSETS[c.req.param("file")];
        if (!file) return c.notFound();
        return c.body(file.body, 200, { "Content-Type": file.type, "Cache-Control": "public, max-age=31536000, immutable" });
    });

    // A failure answers 500 so the provider retries; ingest is idempotent.
    app.post("/webhooks/:provider", async c => {
        if (c.req.param("provider") !== mail.provider.name) return c.notFound();
        let events;
        try {
            events = mail.provider.parseWebhook({ headers: c.req.raw.headers, body: await c.req.text() });
        } catch (err) {
            if (err instanceof WebhookSignatureError) return c.text("Invalid signature", 401);
            throw err;
        }
        for (const event of events) await mail.applyEvent(event);
        return c.json({ ok: true });
    });

    app.all("/mcp", async c => {
        const token = matchBearer(c.req.header("authorization"), tokens);
        if (!token) return c.text("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
        return handleMcp(c.req.raw, mail, access, { kind: "agent", name: token.name, scope: token.scope });
    });

    registerUi(app, mail, access, cfg);
    return app;
}
