import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import type { Access } from "../auth.ts";
import { bareAddress, splitAddresses } from "../core/address.ts";
import { ConflictError, InvalidRequestError, type Mail, type MessageView } from "../core/mail.ts";
import type { Actor, InboxerConfig, Session } from "../types.ts";
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

function uiActor(session: Session): Actor {
    return { kind: "ui", name: session.label ?? session.id.slice(0, 12) };
}

export function registerUi(app: Hono<UiEnv>, mail: Mail, access: Access, cfg: InboxerConfig): void {
    const secret = cfg.ui.cookieSecret;
    const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_MAX_AGE } as const;

    const page = async (c: Context<UiEnv>, title: string, body: V.View, current: V.Page, status: 200 | 401 | 404 = 200) => {
        const signedIn = !!c.get("session");
        const draftCount = signedIn ? (await mail.store.draftIds()).length : 0;
        return c.html(V.layout(title, body, { theme: theme(c), page: current, draftCount, signedIn }), status);
    };

    // Sign-in: GET only shows a button, so link previews and scanners do not burn the link.
    app.get("/auth/:token", async c => {
        const valid = await access.isLinkValid(c.req.param("token"));
        return page(c, S.signInTitle, V.signIn(c.req.param("token"), valid), null, valid ? 200 : 404);
    });

    app.post("/auth/:token", async c => {
        const sessionSecret = await access.consumeLoginLink(c.req.param("token"), clientInfo(c));
        if (!sessionSecret) return page(c, S.signInTitle, V.signIn("", false), null, 404);
        await setSignedCookie(c, SESSION_COOKIE, sessionSecret, secret, cookieOptions);
        return c.redirect("/", 303);
    });

    app.post("/theme", async c => {
        const value = String((await c.req.parseBody()).theme ?? "") as V.Theme;
        if (!THEMES.has(value)) return c.text("Invalid theme", 400);
        setCookie(c, THEME_COOKIE, value, { path: "/", sameSite: "Lax", maxAge: COOKIE_MAX_AGE });
        const back = c.req.header("referer");
        const path = back && new URL(back).origin === new URL(c.req.url).origin ? new URL(back).pathname + new URL(back).search : "/";
        return c.redirect(path, 303);
    });

    const ui = ["/", "/inbox", "/threads/*", "/drafts/*", "/devices", "/devices/*", "/logout"];
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

    const draftHistory = async (threadId: string, draftId: string): Promise<MessageView[]> => {
        if (!(await mail.store.getThread(threadId))) return [];
        const { messages } = await mail.getThread(threadId);
        return messages.filter(m => m.id !== draftId && m.status !== "draft");
    };

    app.get("/", async c => {
        const drafts = await mail.listDrafts();
        const items = await Promise.all(drafts.map(async draft => ({ draft, history: await draftHistory(draft.thread_id, draft.id) })));
        return page(c, S.navDrafts, V.draftsPage(items), "drafts");
    });

    app.get("/drafts/:id/card", async c => {
        const draft = await mail.store.requireMessage(c.req.param("id"));
        if (draft.status !== "draft") return c.html(V.draftDone(draft.id, `${S.status}: ${draft.status}`));
        return c.html(V.draftCard(draft, await draftHistory(draft.thread_id, draft.id)));
    });

    app.get("/drafts/:id/edit", async c => {
        const draft = await mail.store.requireMessage(c.req.param("id"));
        if (draft.status !== "draft") return c.html(V.draftDone(draft.id, `${S.status}: ${draft.status}`));
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
            if (body.send === "1") {
                const sent = await mail.sendDraft(id, actor);
                return c.html(V.draftDone(id, `${S.sentTo} ${sent.to.join(", ")}`));
            }
            const draft = await mail.store.requireMessage(id);
            return c.html(V.draftCard(draft, await draftHistory(draft.thread_id, id)));
        } catch (err) {
            if (err instanceof ConflictError) return c.html(V.draftEditor(err.current, form, err.current));
            if (err instanceof InvalidRequestError) return c.html(V.draftDone(id, err.message));
            throw err;
        }
    });

    app.post("/drafts/:id/send", async c => {
        const id = c.req.param("id");
        try {
            const sent = await mail.sendDraft(id, uiActor(c.get("session")));
            return c.html(V.draftDone(id, `${S.sentTo} ${sent.to.join(", ")}`));
        } catch (err) {
            if (err instanceof InvalidRequestError) return c.html(V.draftDone(id, err.message));
            throw err;
        }
    });

    app.post("/drafts/:id/discard", async c => {
        const id = c.req.param("id");
        try {
            await mail.discardDraft(id, uiActor(c.get("session")));
            return c.html(V.draftDone(id, S.discarded));
        } catch (err) {
            if (err instanceof InvalidRequestError) return c.html(V.draftDone(id, err.message));
            throw err;
        }
    });

    app.get("/inbox", async c => {
        const mailbox = c.req.query("mailbox") ?? "";
        const requested = c.req.query("status");
        const status = requested === "all" || requested === "archived" ? requested : "unanswered";
        const threads = await mail.listThreads({ mailbox: mailbox || undefined, status, limit: 200 });
        const mailboxes = mail.listMailboxes();
        const own = new Set(mailboxes.map(m => bareAddress(m.address)));
        return page(c, S.navInbox, V.inboxPage(threads, mailboxes.map(m => m.id), { mailbox, status }, own), "inbox");
    });

    app.get("/threads/:id", async c => {
        const id = c.req.param("id");
        let thread = await mail.store.requireThread(id);
        if (thread.unread) {
            await mail.mark([id], { read: true }, uiActor(c.get("session")));
            thread = await mail.store.requireThread(id);
        }
        const { messages } = await mail.getThread(id);
        const items = await Promise.all(messages.map(async m =>
            m.status === "draft" ? V.draftCard(await mail.store.requireMessage(m.id), []) : V.messageCard(m)));
        return page(c, thread.subject || S.navInbox, V.threadPage(thread, items), "inbox");
    });

    app.post("/threads/:id/archive", async c => {
        const id = c.req.param("id");
        const archived = (await c.req.parseBody()).archived === "1";
        await mail.mark([id], { archived }, uiActor(c.get("session")));
        return c.html(V.archiveButton(await mail.store.requireThread(id)));
    });

    app.get("/devices", async c => {
        const session = c.get("session");
        return page(c, S.navDevices, V.devicesPage(await access.listSessions(), session.id), "devices");
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
