import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { MessageView } from "../core/mail.ts";
import type { Contact, Context, Message, Session, Thread } from "../types.ts";
import { ASSETS } from "./assets.ts";
import { S } from "./strings.ts";

export type View = HtmlEscapedString;
export type Theme = "system" | "light" | "dark";
export type Page = "drafts" | "inbox" | "devices" | null;

/** Views never await, so `html` returns a plain escaped string. */
function h(strings: TemplateStringsArray, ...values: unknown[]): View {
    return html(strings, ...values) as View;
}

function join(items: View[]): View {
    return raw(items.join("")) as View;
}

function when(condition: unknown, view: () => View): View | "" {
    return condition ? view() : "";
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

export function layout(title: string, body: View, opts: { theme: Theme; page: Page; draftCount?: number; signedIn: boolean; domains?: string[] }): View {
    const nav = (page: Page, href: string, label: string, extra: View | "" = "") =>
        h`<a href="${href}" ${raw(opts.page === page ? 'aria-current="page"' : "")}>${label}${extra}</a>`;
    return h`<!doctype html>
<html lang="en" ${raw(opts.theme === "system" ? "" : `data-theme="${opts.theme}"`)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${S.appName}</title>
<link rel="stylesheet" href="${ASSETS["style.css"]!.url}">
<script src="${ASSETS["htmx.min.js"]!.url}" defer></script>
<script src="${ASSETS["app.js"]!.url}" defer></script>
</head>
<body>
${when(opts.signedIn, () => h`<header>
  <nav>
    ${nav("drafts", "/", S.navDrafts, opts.draftCount ? h` <span class="count">${opts.draftCount}</span>` : "")}
    ${nav("inbox", "/inbox", S.navInbox)}
    ${nav("devices", "/devices", S.navDevices)}
  </nav>
  <form method="post" action="/theme">
    <span class="select"><select name="theme" aria-label="${S.theme}" onchange="this.form.submit()">
      ${join((["system", "light", "dark"] as const).map(t =>
          h`<option value="${t}" ${raw(t === opts.theme ? "selected" : "")}>${{ system: S.themeSystem, light: S.themeLight, dark: S.themeDark }[t]}</option>`))}
    </select></span>
  </form>
  <form method="post" action="/logout"><button class="link">${S.logout}</button></form>
</header>`)}
<main>${when(opts.domains?.length, () => h`<div class="domain">${opts.domains!.join(" · ")}</div>`)}${body}</main>
</body>
</html>`;
}

export function message(lines: string[]): View {
    return h`<div class="centered">${join(lines.map(l => h`<p>${l}</p>`))}</div>`;
}

export function signIn(token: string, valid: boolean): View {
    if (!valid) return message([S.linkUsed]);
    return h`<div class="centered">
  <h1>${S.signInTitle}</h1>
  <form method="post" action="/auth/${token}"><button class="primary">${S.signInButton}</button></form>
</div>`;
}

function mailboxBadge(mailbox: string): View {
    return h`<span class="badge">${mailbox}</span>`;
}

const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Image types a browser renders without running code; SVG is left out on purpose. */
export function isPreviewable(contentType: string): boolean {
    return PREVIEWABLE.has(contentType);
}

function formatSize(bytes: number | null): string {
    if (bytes === null) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Images first as thumbnails, inline ones included; the rest as file links. */
function attachments(m: Pick<MessageView, "id" | "attachments">): View | "" {
    if (!m.attachments.length) return "";
    const href = (id: string) => `/attachments/${encodeURIComponent(m.id)}/${encodeURIComponent(id)}`;
    const images = m.attachments.filter(a => isPreviewable(a.content_type));
    const files = m.attachments.filter(a => !isPreviewable(a.content_type));
    return h`${when(images.length, () => h`<div class="images">${join(images.map(a =>
        h`<a href="${href(a.id)}" target="_blank" rel="noopener"><img src="${href(a.id)}" alt="${a.filename}" loading="lazy"></a>`))}</div>`)}
${when(files.length, () => h`<div class="files">${join(files.map(a =>
        h`<a class="file" href="${href(a.id)}" target="_blank" rel="noopener"><span>${a.filename}</span><span class="size">${formatSize(a.size)}</span></a>`))}</div>`)}`;
}

/** Mail clients write "[image: name.png]" in the text part where an image sat; the image shows below instead. */
function withoutImagePlaceholders(m: MessageView): string {
    let text = m.text;
    for (const a of m.attachments) {
        if (isPreviewable(a.content_type)) text = text.split(`[image: ${a.filename}]`).join("");
    }
    return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function messageCard(m: MessageView): View {
    return h`<article class="card ${m.direction}">
  <div class="meta">
    <strong>${m.from}</strong>
    <span>${formatDate(m.date)}</span>
    ${when(m.direction === "out" && m.status !== "draft", () => h`<span>${m.status}</span>`)}
  </div>
  ${when(m.to.length || m.cc.length, () => h`<div class="meta">${when(m.to.length, () => h`<span>${S.to}: ${m.to.join(", ")}</span>`)}${when(m.cc.length, () => h`<span>${S.cc}: ${m.cc.join(", ")}</span>`)}</div>`)}
  <pre class="body">${withoutImagePlaceholders(m)}</pre>
  ${attachments(m)}
</article>`;
}

export interface ContextView {
    context: Context | null;
    contacts: Contact[];
}

/** Read-only context agents attached to the thread and its participants. */
function contextBlock(ctx: ContextView | null): View | "" {
    if (!ctx) return "";
    const rows = [
        ...ctx.contacts.map(c => ({ who: c.address, meta: c.meta, note: c.note })),
        ...(ctx.context ? [{ who: S.thisThread, meta: ctx.context.meta, note: ctx.context.note }] : []),
    ].filter(r => r.note || Object.keys(r.meta).length);
    if (!rows.length) return "";
    return h`<details class="context"><summary>${S.context}</summary>${join(rows.map(r => h`<section>
  <div class="who">${r.who}</div>
  ${when(Object.keys(r.meta).length, () => h`<dl>${join(Object.entries(r.meta).map(([k, v]) => h`<dt>${k}</dt><dd>${String(v)}</dd>`))}</dl>`)}
  ${when(r.note, () => h`<p>${r.note}</p>`)}
</section>`))}</details>`;
}

/** A send or discard in its undo window; reloads itself when the window closes. */
function pendingCard(d: Message): View {
    const left = Math.max(0, Date.parse(d.pending!.at) - Date.now());
    return h`<article class="card pending" id="draft-${d.id}" hx-get="/drafts/${d.id}/card" hx-trigger="load delay:${left + 400}ms" hx-swap="outerHTML">
  <div class="pending-row">
    <span>${d.pending!.action === "send" ? h`${S.sending} <strong>${d.to.join(", ")}</strong>` : S.discarding}</span>
    <button hx-post="/drafts/${d.id}/undo" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.undo}</button>
  </div>
  <i class="countdown" style="animation-duration: ${left}ms"></i>
</article>`;
}

export function draftCard(d: Message, history: MessageView[], ctx: ContextView | null): View {
    if (d.pending) return pendingCard(d);
    return h`<article class="card" id="draft-${d.id}">
  <div class="meta">
    ${mailboxBadge(d.mailbox)}
    <span class="badge draft">${S.draft}</span>
    ${when(d.edited_by_human, () => h`<span>${S.editedByHuman}</span>`)}
    <span>${formatDate(d.created_at)}</span>
  </div>
  <div class="meta"><span>${S.to}: <strong>${d.to.join(", ")}</strong></span>${when(d.cc.length, () => h`<span>${S.cc}: ${d.cc.join(", ")}</span>`)}</div>
  <div class="subject">${d.subject}</div>
  ${contextBlock(ctx)}
  ${when(d.note, () => h`<div class="note">${d.note}</div>`)}
  <pre class="body">${d.text}</pre>
  ${attachments(d)}
  <div class="actions">
    <button hx-get="/drafts/${d.id}/edit" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.edit}</button>
    <button class="primary" hx-post="/drafts/${d.id}/send" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.send}</button>
    <button class="danger" hx-post="/drafts/${d.id}/discard" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.discard}</button>
  </div>
  ${when(history.length, () => h`<details>
    <summary>${S.thread} (${history.length})</summary>
    ${join(history.map(messageCard))}
  </details>`)}
</article>`;
}

export interface DraftForm {
    to: string;
    cc: string;
    subject: string;
    text: string;
}

export function draftEditor(d: Message, form: DraftForm, conflict: Message | null): View {
    const version = conflict ? conflict.version : d.version;
    return h`<article class="card ${conflict ? "conflict" : ""}" id="draft-${d.id}" data-drop>
  <div class="drop-hint">${S.dropFiles}</div>
  <div class="meta">${mailboxBadge(d.mailbox)}<span class="badge draft">${S.draft}</span></div>
  ${when(d.note, () => h`<div class="note">${d.note}</div>`)}
  ${when(conflict, () => h`<p class="warn">${S.conflictTitle}</p><div class="subject">${S.yourVersion}</div>`)}
  <form hx-post="/drafts/${d.id}/save" hx-target="#draft-${d.id}" hx-swap="outerHTML">
    <input type="hidden" name="version" value="${version}">
    <div class="field">
      <label for="to-${d.id}">${S.to}</label>
      <input id="to-${d.id}" name="to" value="${form.to}" autocomplete="off" required>
      ${when(!form.cc, () => h`<button type="button" class="link" onclick="this.remove();var r=document.getElementById('cc-row-${d.id}');r.hidden=false;r.querySelector('input').focus()">${S.cc}</button>`)}
    </div>
    <div class="field" id="cc-row-${d.id}" ${raw(form.cc ? "" : "hidden")}>
      <label for="cc-${d.id}">${S.cc}</label>
      <input id="cc-${d.id}" name="cc" value="${form.cc}" autocomplete="off">
    </div>
    <div class="field">
      <label for="subject-${d.id}">${S.subject}</label>
      <input id="subject-${d.id}" name="subject" value="${form.subject}" required>
    </div>
    <textarea id="text-${d.id}" name="text" aria-label="${S.body}" required>${form.text}</textarea>
    ${draftFiles(d, null)}
    <div class="actions">
      <button type="submit">${S.save}</button>
      <button type="submit" name="send" value="1" class="primary">${S.saveAndSend}</button>
      <button type="button" class="link" hx-get="/drafts/${d.id}/card" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.cancel}</button>
    </div>
  </form>
  ${when(conflict, () => h`<details open>
    <summary>${S.currentVersion}</summary>
    <div class="card">
      <div class="meta"><span>${S.to}: ${conflict!.to.join(", ")}</span>${when(conflict!.cc.length, () => h`<span>${S.cc}: ${conflict!.cc.join(", ")}</span>`)}</div>
      <div class="subject">${conflict!.subject}</div>
      <pre class="body">${conflict!.text}</pre>
    </div>
  </details>`)}
</article>`;
}

/** The editor's attachment list with remove buttons, and the picker that drag and drop also feeds. */
export function draftFiles(d: Message, error: string | null): View {
    return h`<div class="draft-files" id="files-${d.id}">
  ${join(d.attachments.map(a => h`<span class="file"><span>${a.filename}</span><span class="size">${formatSize(a.size)}</span><button type="button" class="link" aria-label="${S.remove} ${a.filename}" hx-post="/drafts/${d.id}/attachments/${a.id}/remove" hx-target="#files-${d.id}" hx-swap="outerHTML">×</button></span>`))}
  <label class="file attach">${S.attach}<input type="file" name="files" multiple hidden hx-post="/drafts/${d.id}/attachments" hx-encoding="multipart/form-data" hx-trigger="change" hx-target="#files-${d.id}" hx-swap="outerHTML" hx-include="this"></label>
  ${when(error, () => h`<p class="warn">${error}</p>`)}
</div>`;
}

export function draftDone(id: string, text: string): View {
    return h`<article class="card notice" id="draft-${id}">${text}</article>`;
}

export function draftsPage(drafts: { draft: Message; history: MessageView[]; ctx: ContextView }[]): View {
    return h`<h1>${S.navDrafts}</h1>
${drafts.length ? join(drafts.map(d => draftCard(d.draft, d.history, d.ctx))) : h`<p class="empty">${S.draftsEmpty}</p>`}`;
}

export function inboxPage(threads: Thread[], mailboxes: string[], filter: { mailbox: string; status: string }, own: Set<string>): View {
    const tab = (status: string, label: string) => {
        const query = new URLSearchParams({ status, ...(filter.mailbox ? { mailbox: filter.mailbox } : {}) });
        return h`<a href="/inbox?${query.toString()}" ${raw(filter.status === status ? 'aria-current="page"' : "")}>${label}</a>`;
    };
    return h`<h1>${S.navInbox}</h1>
<form class="filters" method="get" action="/inbox">
  <input type="hidden" name="status" value="${filter.status}">
  <span class="select"><select name="mailbox" aria-label="${S.filter}" onchange="this.form.submit()">
    <option value="">${S.allMailboxes}</option>
    ${join(mailboxes.map(m => h`<option value="${m}" ${raw(m === filter.mailbox ? "selected" : "")}>${m}</option>`))}
  </select></span>
  <nav class="tabs">${tab("unanswered", S.filterUnanswered)}${tab("all", S.filterAll)}${tab("archived", S.filterArchived)}</nav>
</form>
${threads.length ? join(threads.map(t => threadRow(t, own))) : h`<p class="empty">${S.inboxEmpty}</p>`}`;
}

function threadRow(t: Thread, own: Set<string>): View {
    return h`<a class="card thread-row" href="/threads/${t.id}">
  <div class="meta">
    ${mailboxBadge(t.mailbox)}
    ${when(t.unread, () => h`<span class="dot" title="${S.unread}"></span>`)}
    ${when(t.has_draft, () => h`<span class="badge draft">${S.hasDraft}</span>`)}
    <span>${formatDate(t.last_at)}</span>
  </div>
  <div class="subject">${t.subject || "—"}</div>
  <div class="meta"><span>${t.participants.filter(p => !own.has(p)).join(", ")}</span></div>
</a>`;
}

export function threadPage(thread: Thread, items: View[], ctx: ContextView): View {
    return h`<h1>${thread.subject || "—"}</h1>
<div class="meta thread-head">${mailboxBadge(thread.mailbox)}${archiveButton(thread)}</div>
${contextBlock(ctx)}
<section class="messages">${join(items)}</section>`;
}

export function archiveButton(thread: Thread): View {
    return h`<form id="archive" hx-post="/threads/${thread.id}/archive" hx-swap="outerHTML">
  <input type="hidden" name="archived" value="${thread.archived ? "0" : "1"}">
  <button class="link">${thread.archived ? S.unarchive : S.archive}</button>
</form>`;
}

export function devicesPage(sessions: Session[], currentId: string): View {
    return h`<h1>${S.navDevices}</h1>
${sessions.length ? join(sessions.map(s => h`<article class="card" id="session-${s.id}">
  <div class="meta">
    <strong>${s.label ?? s.user_agent ?? S.unknownDevice}</strong>
    ${when(s.id === currentId, () => h`<span class="badge">${S.thisDevice}</span>`)}
    ${when(s.scope, () => join(s.scope!.map(mailboxBadge)))}
  </div>
  ${when(s.label && s.user_agent, () => h`<div class="meta"><span>${s.user_agent}</span></div>`)}
  <div class="meta">
    <span>${S.signedIn}: ${formatDate(s.created_at)}</span>
    <span>${S.lastSeen}: ${formatDate(s.last_seen)}</span>
    <span>${S.createdBy}: ${s.created_by}</span>
  </div>
  ${when(s.id !== currentId, () => h`<div class="actions"><button class="danger" hx-post="/devices/${s.id}/revoke" hx-target="#session-${s.id}" hx-swap="delete">${S.revoke}</button></div>`)}
</article>`)) : h`<p class="empty">${S.devicesEmpty}</p>`}`;
}
