import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import type { Access } from "../auth.ts";
import { bareAddress, domainOf, splitAddresses } from "../core/address.ts";
import { ConflictError, InvalidRequestError, type Mail, type MessageView } from "../core/mail.ts";
import { CATCHALL, type Actor, type InboxerConfig, type Message, type Session } from "../types.ts";
import { S } from "./strings.ts";
import * as V from "./views.ts";

const SESSION_COOKIE = "inboxer_session";
const THEME_COOKIE = "inboxer_theme";
/** Browsers cap cookie lifetime at 400 days; the session cookie is re-issued on every request. */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const THEMES = new Set<V.Theme>(["system", "light", "dark"]);

export type UiEnv = { Variables: { session: Session; secret: string } };

function theme(c: Context): V.Theme {
    const value = getCookie(c, THEME_COOKIE) as V.Theme | undefined;
    return value && THEMES.has(value) ? value : "system";
}

function clientInfo(c: Context) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return { ip: forwarded || c.req.header("x-real-ip") || null, userAgent: c.req.header("user-agent") ?? null };
}

/** htmx sends the page URL; draft cards on a thread page leave out the thread around them. */
function onThreadPage(c: Context): boolean {
    const current = c.req.header("hx-current-url");
    return !!current && new URL(current).pathname.startsWith("/threads/");
}

function uiActor(session: Session): Actor {
    return { kind: "ui", name: session.label ?? session.id.slice(0, 12), scope: session.scope };
}

export function registerUi(app: Hono<UiEnv>, mail: Mail, access: Access, cfg: InboxerConfig): void {
    const secret = cfg.ui.cookieSecret;
    const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_MAX_AGE } as const;

    const own = new Set(Object.values(cfg.mailboxes).map(m => bareAddress(m.address)));
    /** Recipients that are our own mailboxes are implied by the mailbox badge. */
    const shown = (m: MessageView): MessageView => ({
        ...m,
        to: m.to.filter(a => !own.has(bareAddress(a))),
        cc: m.cc.filter(a => !own.has(bareAddress(a))),
    });

    const page = async (c: Context<UiEnv>, title: string, body: V.View, current: V.Page, status: 200 | 401 | 404 = 200) => {
        const session = c.get("session");
        const draftCount = session ? (await mail.listDrafts(undefined, session.scope)).length : 0;
        const domains = session
            ? [...new Set(mail.listMailboxes(session.scope).filter(m => m.id !== CATCHALL).map(m => domainOf(m.address)))]
            : [];
        return c.html(V.layout(title, body, { theme: theme(c), page: current, draftCount, signedIn: !!session, domains }), status);
    };

    // Sign-in: GET only shows a button, so link previews and scanners do not burn the link.
    app.get("/auth/:token", async c => {
        const valid = await access.isLinkValid(c.req.param("token"));
        return page(c, S.signInTitle, V.signIn(c.req.param("token"), valid), null, valid ? 200 : 404);
    });

    app.post("/auth/:token", async c => {
        const signedIn = await access.consumeLoginLink(c.req.param("token"), clientInfo(c));
        if (!signedIn) return page(c, S.signInTitle, V.signIn("", false), null, 404);
        await setSignedCookie(c, SESSION_COOKIE, signedIn.secret, secret, cookieOptions);
        return c.redirect(signedIn.next, 303);
    });

    app.post("/theme", async c => {
        const value = String((await c.req.parseBody()).theme ?? "") as V.Theme;
        if (!THEMES.has(value)) return c.text("Invalid theme", 400);
        setCookie(c, THEME_COOKIE, value, { path: "/", sameSite: "Lax", maxAge: COOKIE_MAX_AGE });
        const back = c.req.header("referer");
        const path = back && new URL(back).origin === new URL(c.req.url).origin ? new URL(back).pathname + new URL(back).search : "/";
        return c.redirect(path, 303);
    });

    const ui = ["/", "/inbox", "/threads/*", "/drafts/*", "/attachments/*", "/devices", "/devices/*", "/logout"];
    for (const path of ui) {
        app.use(path, async (c, next) => {
            const value = await getSignedCookie(c, secret, SESSION_COOKIE);
            const session = value ? await access.authenticate(value) : null;
            if (!value || !session) {
                if (value) deleteCookie(c, SESSION_COOKIE, { path: "/" });
                return page(c, S.appName, V.message([S.notSignedIn]), null, 401);
            }
            await setSignedCookie(c, SESSION_COOKIE, value, secret, cookieOptions);
            c.set("session", session);
            c.set("secret", value);
            await next();
        });
    }

    /** The sent and received messages around a draft, newest first, and the context of its thread. */
    const draftExtras = async (draft: Message, session: Session): Promise<{ history: MessageView[]; ctx: V.ContextView }> => {
        const { messages, context, contacts } = await mail.getThread(draft.thread_id, session.scope);
        const history = messages.filter(m => m.id !== draft.id && m.status !== "draft").reverse().map(shown);
        return { history, ctx: { context, contacts } };
    };

    /** The card for a draft in whatever state it is now. */
    const draftView = async (c: Context<UiEnv>, id: string): Promise<V.View> => {
        const session = c.get("session");
        const draft = await mail.requireMessage(id, session.scope);
        if (draft.status === "discarded") return V.draftDone(id, S.discarded);
        if (draft.status !== "draft") return V.draftDone(id, `${S.sentTo} ${draft.to.join(", ")}`);
        if (onThreadPage(c)) return V.draftCard(draft, [], null);
        const { history, ctx } = await draftExtras(draft, session);
        return V.draftCard(draft, history, ctx);
    };

    app.get("/", async c => {
        const session = c.get("session");
        const drafts = await mail.listDrafts(undefined, session.scope);
        const items = await Promise.all(drafts.map(async draft => ({ draft, ...(await draftExtras(draft, session)) })));
        return page(c, S.navDrafts, V.draftsPage(items), "drafts");
    });

    app.get("/drafts/:id/card", async c => c.html(await draftView(c, c.req.param("id"))));

    app.get("/drafts/:id/edit", async c => {
        const draft = await mail.requireMessage(c.req.param("id"), c.get("session").scope);
        if (draft.status !== "draft" || draft.pending) return c.html(await draftView(c, draft.id));
        const form = { to: draft.to.join(", "), cc: draft.cc.join(", "), subject: draft.subject, text: draft.text };
        return c.html(V.draftEditor(draft, form, null));
    });

    app.post("/drafts/:id/save", async c => {
        const id = c.req.param("id");
        const body = await c.req.parseBody();
        const form = { to: String(body.to ?? ""), cc: String(body.cc ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") };
        const actor = uiActor(c.get("session"));
        try {
            await mail.updateDraft(id, Number(body.version), {
                to: splitAddresses(form.to),
                cc: splitAddresses(form.cc),
                subject: form.subject,
                text: form.text,
            }, actor);
            if (body.send === "1") await mail.schedule(id, "send", actor);
            return c.html(await draftView(c, id));
        } catch (err) {
            if (err instanceof ConflictError) return c.html(V.draftEditor(err.current, form, err.current));
            if (err instanceof InvalidRequestError) return c.html(V.draftDone(id, err.message));
            throw err;
        }
    });

    app.post("/drafts/:id/attachments", async c => {
        const id = c.req.param("id");
        const actor = uiActor(c.get("session"));
        const body = await c.req.parseBody({ all: true });
        const files = ([] as unknown[]).concat(body.files ?? []).filter((f): f is File => f instanceof File);
        const limit = cfg.ui.maxUploadMb * 1024 * 1024;
        let error: string | null = null;
        for (const file of files) {
            if (file.size > limit) {
                error = `${file.name} ${S.tooLarge} ${cfg.ui.maxUploadMb} MB`;
                continue;
            }
            await mail.attach(id, { filename: file.name, contentType: file.type, body: new Uint8Array(await file.arrayBuffer()) }, actor);
        }
        return c.html(V.draftFiles(await mail.requireMessage(id, actor.scope), error));
    });

    app.post("/drafts/:id/attachments/:attachmentId/remove", async c => {
        const draft = await mail.detach(c.req.param("id"), c.req.param("attachmentId"), uiActor(c.get("session")));
        return c.html(V.draftFiles(draft, null));
    });

    // Send, discard and undo answer with the draft's current card, so a late click shows what happened.
    for (const [path, act] of [
        ["send", (id: string, actor: Actor) => mail.schedule(id, "send", actor)],
        ["discard", (id: string, actor: Actor) => mail.schedule(id, "discard", actor)],
        ["undo", (id: string, actor: Actor) => mail.undo(id, actor)],
    ] as const) {
        app.post(`/drafts/:id/${path}`, async c => {
            const id = c.req.param("id");
            try {
                await act(id, uiActor(c.get("session")));
            } catch (err) {
                if (!(err instanceof InvalidRequestError)) throw err;
            }
            return c.html(await draftView(c, id));
        });
    }

    app.get("/inbox", async c => {
        const mailbox = c.req.query("mailbox") ?? "";
        const requested = c.req.query("status");
        const status = requested === "all" || requested === "archived" ? requested : "unanswered";
        const scope = c.get("session").scope;
        const threads = await mail.listThreads({ mailbox: mailbox || undefined, status, limit: 200 }, scope);
        const mailboxes = mail.listMailboxes(scope);
        const own = new Set(mailboxes.map(m => bareAddress(m.address)));
        return page(c, S.navInbox, V.inboxPage(threads, mailboxes.map(m => m.id), { mailbox, status }, own), "inbox");
    });

    app.get("/threads/:id", async c => {
        const id = c.req.param("id");
        const scope = c.get("session").scope;
        let thread = await mail.requireThread(id, scope);
        if (thread.unread) {
            await mail.mark([id], { read: true }, uiActor(c.get("session")));
            thread = await mail.requireThread(id, scope);
        }
        const { messages, context, contacts } = await mail.getThread(id, scope);
        const items = await Promise.all([...messages].reverse().map(async m =>
            m.status === "draft" ? V.draftCard(await mail.store.requireMessage(m.id), [], null) : V.messageCard(shown(m))));
        return page(c, thread.subject || S.navInbox, V.threadPage(thread, items, { context, contacts }), "inbox");
    });

    app.post("/threads/:id/archive", async c => {
        const id = c.req.param("id");
        const archived = (await c.req.parseBody()).archived === "1";
        await mail.mark([id], { archived }, uiActor(c.get("session")));
        return c.html(V.archiveButton(await mail.store.requireThread(id)));
    });

    // Attachments are untrusted: only plain images and PDFs open in the browser, everything runs sandboxed.
    app.get("/attachments/:messageId/:attachmentId", async c => {
        const { meta, body } = await mail.getAttachment(c.req.param("messageId"), c.req.param("attachmentId"), c.get("session").scope);
        const opens = V.isPreviewable(meta.content_type) || meta.content_type === "application/pdf";
        return c.body(body as Uint8Array<ArrayBuffer>, 200, {
            "Content-Type": opens ? meta.content_type : "application/octet-stream",
            "Content-Disposition": `${opens ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable",
        });
    });

    app.get("/devices", async c => {
        const session = c.get("session");
        return page(c, S.navDevices, V.devicesPage(await access.listSessions(session.scope), session.id), "devices");
    });

    app.post("/devices/:id/revoke", async c => {
        await access.revokeSession(c.req.param("id"), uiActor(c.get("session")));
        return c.body(null, 200);
    });

    app.post("/logout", async c => {
        const session = c.get("session");
        await access.revokeSession(session.id, uiActor(session), "session.logout");
        deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
        return c.html(V.layout(S.signedOut, V.message([S.signedOut]), { theme: theme(c), page: null, signedIn: false }));
    });
}
