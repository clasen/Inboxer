import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Access } from "../auth.ts";
import { domainOf, splitAddresses } from "../core/address.ts";
import { ConflictError, InvalidRequestError, toView, type Mail, type MessageView, type ThreadStatus } from "../core/mail.ts";
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

function uiActor(session: Session): Actor {
    return { kind: "ui", name: session.label ?? session.id.slice(0, 12), scope: session.scope };
}

export function registerUi(app: Hono<UiEnv>, mail: Mail, access: Access, cfg: InboxerConfig): void {
    const secret = cfg.ui.cookieSecret;
    const cookieOptions = { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_MAX_AGE } as const;

    const mailDomains = (mailboxes: { address: string; kind: string }[]): string[] =>
        [...new Set(mailboxes.filter(m => m.kind === "mail").map(m => domainOf(m.address)))];
    const mailboxesOf = (session: Session) => mail.listMailboxes(session.scope).filter(m => m.id !== CATCHALL);
    const hue = V.accentHue(mailDomains(mail.listMailboxes(null).filter(m => m.id !== CATCHALL)));
    const isChat = (mailbox: string): boolean => mail.kindOf(mailbox) === "chat";
    const own = (address: string): boolean => mail.isOwn(address);
    /** Recipients that are our own addresses are implied by the mailbox badge. */
    const shown = (m: MessageView): MessageView => ({
        ...m,
        to: m.to.filter(a => !own(a)),
        cc: m.cc.filter(a => !own(a)),
    });

    /** Mailboxes a session can start new mail from: the mail ones in its scope it may write in, but the catch-all. */
    const senders = (session: Session): V.Mailbox[] => mailboxesOf(session).filter(m => m.kind === "mail" && mail.uiCanWrite(m.id));
    const domainsOf = (session: Session): string[] => mailDomains(mailboxesOf(session));

    const page = async (c: Context<UiEnv>, title: string, body: V.View, current: V.Page, status: 200 | 400 | 401 | 404 = 200, fullScreen = false) => {
        const session = c.get("session");
        const shell = session
            ? { draftCount: (await mail.listDrafts(undefined, session.scope)).length, senders: senders(session) }
            : {};
        return c.html(V.layout(title, body, { theme: theme(c), hue, page: current, signedIn: !!session, fullScreen, ...shell }), status);
    };

    // Sign-in: GET only shows a button, so link previews and scanners do not burn the link.
    // A used or expired link on a browser that is already signed in just opens the app.
    const signedInSession = async (c: Context<UiEnv>): Promise<Session | null> => {
        const value = await getSignedCookie(c, secret, SESSION_COOKIE);
        return value ? access.authenticate(value) : null;
    };

    app.get("/auth/:token", async c => {
        const valid = await access.isLinkValid(c.req.param("token"));
        if (!valid && (await signedInSession(c))) return c.redirect("/", 303);
        return page(c, S.signInTitle, V.signIn(c.req.param("token"), valid), null, valid ? 200 : 404);
    });

    app.post("/auth/:token", async c => {
        const signedIn = await access.consumeLoginLink(c.req.param("token"), clientInfo(c));
        if (!signedIn && (await signedInSession(c))) return c.redirect("/", 303);
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

    const ui = ["/", "/inbox", "/threads/*", "/drafts/*", "/attachments/*", "/compose", "/devices", "/devices/*", "/settings", "/logout", "/events"];
    for (const path of ui) {
        app.use(path, async (c, next) => {
            const value = await getSignedCookie(c, secret, SESSION_COOKIE);
            const session = value ? await access.authenticate(value) : null;
            if (!value || !session) {
                if (value) deleteCookie(c, SESSION_COOKIE, { path: "/" });
                return page(c, S.appName, V.message([S.notSignedIn, S.askForLink]), null, 401);
            }
            await setSignedCookie(c, SESSION_COOKIE, value, secret, cookieOptions);
            c.set("session", session);
            c.set("secret", value);
            await next();
        });
    }

    /** The card for a draft in whatever state it is now; once sent, its message in the thread. */
    const draftView = async (c: Context<UiEnv>, id: string): Promise<V.View> => {
        const draft = await mail.requireMessage(id, c.get("session").scope);
        if (draft.status === "discarded") return V.draftDone(id, S.discarded);
        if (draft.status !== "draft") return V.messageBubble(shown(toView(draft)), false, draft.html);
        return V.draftCard(draft, mail.uiCanWrite(draft.mailbox));
    };

    app.get("/", async c => {
        const session = c.get("session");
        const drafts = await mail.listDrafts(undefined, session.scope);
        return page(c, S.navDrafts, V.inboxPage(V.draftList(drafts, domainsOf(session), null), null), "drafts");
    });

    app.get("/drafts/:id", async c => {
        const session = c.get("session");
        const draft = await mail.requireMessage(c.req.param("id"), session.scope);
        if (draft.status !== "draft") return c.redirect(`/threads/${draft.thread_id}?status=all`, 303);
        const { thread, view } = await threadPane(c, draft.thread_id, "/");
        const drafts = await mail.listDrafts(undefined, session.scope);
        return page(c, thread.subject || S.navDrafts, V.inboxPage(V.draftList(drafts, domainsOf(session), draft.id), view), "drafts", 200, true);
    });

    app.get("/drafts/:id/card", async c => c.html(await draftView(c, c.req.param("id"))));

    app.get("/drafts/:id/edit", async c => {
        const draft = await mail.requireMessage(c.req.param("id"), c.get("session").scope);
        if (draft.status !== "draft" || draft.pending) {
            c.header("HX-Refresh", "true");
            return c.body(null, 204);
        }
        const form = { to: draft.to.join(", "), cc: draft.cc.join(", "), subject: draft.subject, text: draft.text };
        return c.html(V.draftEditor(draft, form, null, isChat(draft.mailbox)));
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
            c.header("HX-Refresh", "true");
            return c.html(await draftView(c, id));
        } catch (err) {
            if (err instanceof ConflictError) return c.html(V.draftEditor(err.current, form, err.current, isChat(err.current.mailbox)));
            if (err instanceof InvalidRequestError) return c.html(V.draftDone(id, err.message));
            throw err;
        }
    });

    /** Uploaded files within the size limit, and a message naming the last one over it. */
    const uploads = (body: Record<string, unknown>): { files: File[]; error: string | null } => {
        const all = ([] as unknown[]).concat(body.files ?? []).filter((f): f is File => f instanceof File && f.name !== "");
        const limit = cfg.ui.maxUploadMb * 1024 * 1024;
        const over = all.filter(f => f.size > limit).at(-1);
        return { files: all.filter(f => f.size <= limit), error: over ? `${over.name} ${S.tooLarge} ${cfg.ui.maxUploadMb} MB` : null };
    };
    const attachAll = async (draftId: string, files: File[], actor: Actor) => {
        for (const file of files) {
            await mail.attach(draftId, { filename: file.name, contentType: file.type, body: new Uint8Array(await file.arrayBuffer()) }, actor);
        }
    };

    app.post("/drafts/:id/attachments", async c => {
        const id = c.req.param("id");
        const actor = uiActor(c.get("session"));
        const { files, error } = uploads(await c.req.parseBody({ all: true }));
        await attachAll(id, files, actor);
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

    /** The inbox filter from the query, carried along when a thread opens beside the list. */
    const inboxFilter = (c: Context<UiEnv>): V.InboxFilter => {
        const requested = c.req.query("status");
        const status = requested === "all" || requested === "archived" ? requested : "unanswered";
        return { mailbox: c.req.query("mailbox") ?? "", status, q: c.req.query("q")?.trim() ?? "" };
    };

    const threadList = async (c: Context<UiEnv>, current: string | null): Promise<V.View> => {
        const session = c.get("session");
        const filter = inboxFilter(c);
        const threads = filter.q
            ? await mail.searchThreads(filter.q, filter.mailbox || undefined, session.scope, 200)
            : await mail.listThreads({ mailbox: filter.mailbox || undefined, status: filter.status as ThreadStatus, limit: 200 }, session.scope);
        const accounts = await mail.listAccounts(session.scope);
        return V.threadList(threads, { accounts, accountOf: t => mail.accountOf(t), addressOf: a => mail.addressOf(a), domains: domainsOf(session), filter, own, isChat, current });
    };

    app.get("/inbox", async c => page(c, S.navInbox, V.inboxPage(await threadList(c, null), null), "inbox"));

    /** A thread with its drafts in place; opening it marks it read. */
    const threadPane = async (c: Context<UiEnv>, id: string, back: string) => {
        const session = c.get("session");
        let thread = await mail.requireThread(id, session.scope);
        if (thread.unread) {
            await mail.mark([id], { read: true }, uiActor(session));
            thread = await mail.requireThread(id, session.scope);
        }
        const { messages, context, contacts } = await mail.getThread(id, session.scope);
        const people = thread.participants.filter(p => !own(p));
        const entries = await Promise.all(messages.map(async m => {
            const stored = await mail.store.requireMessage(m.id);
            return {
                at: m.date,
                view: m.status === "draft" ? V.draftCard(stored, mail.uiCanWrite(m.mailbox)) : V.messageBubble(shown(m), people.length > 1, stored.html),
            };
        }));
        const account = mail.accountOf(thread);
        const chat = isChat(thread.mailbox);
        const reply = { allowed: account !== CATCHALL && mail.uiCanWrite(thread.mailbox), replyAll: people.length > 1 && !chat };
        return { thread, view: V.threadView(thread, entries, { context, contacts }, { back, filter: inboxFilter(c), own, account, chat, reply }) };
    };

    app.get("/threads/:id", async c => {
        const id = c.req.param("id");
        const { thread, view } = await threadPane(c, id, `/inbox?${V.inboxQuery(inboxFilter(c))}`);
        return page(c, thread.subject || S.navInbox, V.inboxPage(await threadList(c, id), view), "inbox", 200, true);
    });

    /** Replies to the latest message; a reply sent from here gets the same undo window as a draft. */
    /** The reply box's full form, for Cc, subject and files; nothing is created until it is posted. */
    app.get("/threads/:id/reply/full", async c => {
        const id = c.req.param("id");
        const scope = c.get("session").scope;
        const { messages } = await mail.getThread(id, scope);
        const latest = messages.filter(m => m.status !== "draft").at(-1);
        if (!latest) throw new InvalidRequestError("nothing to reply to");
        const reply = await mail.replyTo(latest.id, c.req.query("reply_all") === "1", scope);
        const fields = { to: reply.to.join(", "), cc: reply.cc.join(", "), subject: reply.subject, text: c.req.query("text") ?? "" };
        return c.html(V.replyForm(id, V.inboxQuery(inboxFilter(c)), latest.id, fields));
    });

    app.post("/threads/:id/reply/full", async c => {
        const actor = uiActor(c.get("session"));
        const body = await c.req.parseBody({ all: true });
        const { files, error } = uploads(body);
        if (error) return page(c, S.reply, V.message([error]), "inbox", 400);
        try {
            const draft = await mail.createDraft({
                replyToId: String(body.reply_to_id ?? ""),
                to: splitAddresses(String(body.to ?? "")),
                cc: splitAddresses(String(body.cc ?? "")),
                subject: String(body.subject ?? ""),
                text: String(body.text ?? ""),
            }, actor);
            await attachAll(draft.id, files, actor);
            if (body.action === "send") await mail.schedule(draft.id, "send", actor);
        } catch (err) {
            if (err instanceof InvalidRequestError) return page(c, S.reply, V.message([err.message]), "inbox", 400);
            throw err;
        }
        return c.redirect(`/threads/${c.req.param("id")}?${V.inboxQuery(inboxFilter(c))}`, 303);
    });

    app.post("/threads/:id/reply", async c => {
        const id = c.req.param("id");
        const actor = uiActor(c.get("session"));
        const body = await c.req.parseBody();
        const text = String(body.text ?? "");
        const { messages } = await mail.getThread(id, actor.scope);
        const latest = messages.filter(m => m.status !== "draft").at(-1);
        const back = `/threads/${id}?${V.inboxQuery(inboxFilter(c))}`;
        if (!latest || !text.trim()) return c.redirect(back, 303);
        try {
            const draft = await mail.createDraft({ replyToId: latest.id, replyAll: body.reply_all === "1", text }, actor);
            if (body.action === "send") await mail.schedule(draft.id, "send", actor);
        } catch (err) {
            if (err instanceof InvalidRequestError) return page(c, S.reply, V.message([err.message]), "inbox", 400);
            throw err;
        }
        return c.redirect(back, 303);
    });

    app.post("/compose", async c => {
        const actor = uiActor(c.get("session"));
        const body = await c.req.parseBody({ all: true });
        const { files, error } = uploads(body);
        if (error) return page(c, S.newMail, V.message([error]), null, 400);
        try {
            const draft = await mail.createDraft({
                mailbox: String(body.mailbox ?? ""),
                to: splitAddresses(String(body.to ?? "")),
                cc: splitAddresses(String(body.cc ?? "")),
                subject: String(body.subject ?? ""),
                text: String(body.text ?? ""),
            }, actor);
            await attachAll(draft.id, files, actor);
            if (body.action === "send") await mail.schedule(draft.id, "send", actor);
            return c.redirect(`/threads/${draft.thread_id}?status=all`, 303);
        } catch (err) {
            if (err instanceof InvalidRequestError) return page(c, S.newMail, V.message([err.message]), null, 400);
            throw err;
        }
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
        return page(c, S.navDevices, V.devicesPage(await access.listSessions(session.scope), session.id, a => mail.addressOf(a)), "devices");
    });

    // Every write pings open pages, which refetch their live regions; the stream carries no mail data.
    app.get("/events", c => streamSSE(c, async stream => {
        const ping = () => void stream.writeSSE({ event: "change", data: "1" });
        mail.changes.addEventListener("change", ping);
        await new Promise<void>(resolve => stream.onAbort(resolve));
        mail.changes.removeEventListener("change", ping);
    }));

    app.get("/settings", async c => page(c, S.navSettings, V.settingsPage(theme(c)), "settings"));

    app.post("/devices/:id/revoke", async c => {
        await access.revokeSession(c.req.param("id"), uiActor(c.get("session")));
        return c.body(null, 200);
    });

    app.post("/logout", async c => {
        const session = c.get("session");
        await access.revokeSession(session.id, uiActor(session), "session.logout");
        deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
        return c.html(V.layout(S.signedOut, V.message([S.signedOut]), { theme: theme(c), hue, page: null, signedIn: false }));
    });
}
