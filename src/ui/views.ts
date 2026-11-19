import { crc32 } from "node:zlib";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { bareAddress } from "../core/address.ts";
import type { MessageView } from "../core/mail.ts";
import { type Contact, type Context, type Message, type Session, type Thread } from "../types.ts";
import { ASSETS } from "./assets.ts";
import { S } from "./strings.ts";

export type View = HtmlEscapedString;
export type Theme = "system" | "light" | "dark";
export type Page = "drafts" | "inbox" | "devices" | "settings" | null;

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

const ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9"/><path d="M10 13h4"/>',
    unarchive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9"/><path d="M12 17v-5M9.5 14.5L12 12l2.5 2.5"/>',
    drafts: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6a1 1 0 01-1 1H4a1 1 0 01-1-1z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    devices: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    send: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    attach: '<path d="M20.5 11.5l-8.2 8.2a5 5 0 01-7-7l8.2-8.2a3.3 3.3 0 014.7 4.7l-8.2 8.2a1.7 1.7 0 01-2.4-2.4l7.6-7.6"/>',
} as const;

function icon(name: keyof typeof ICONS): View {
    return raw(`<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`) as View;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function formatDay(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
        ? date.toLocaleDateString("en", { month: "short", day: "numeric" })
        : date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}

/** A time today, a day otherwise. */
function formatDate(iso: string): string {
    return sameDay(new Date(iso), new Date()) ? formatTime(iso) : formatDay(iso);
}

function dayLabel(iso: string): string {
    const date = new Date(iso);
    const yesterday = new Date(Date.now() - 86_400_000);
    if (sameDay(date, new Date())) return S.today;
    if (sameDay(date, yesterday)) return S.yesterday;
    return formatDay(iso);
}

/** Display name from `Name <a@b.com>`, else the bare address. */
function displayName(address: string): string {
    const match = /^\s*"?([^"<]+?)"?\s*</.exec(address);
    return match ? match[1]! : bareAddress(address);
}

function initials(address: string): string {
    const name = displayName(address).replace(/^\+/, "");
    const words = (name.includes("@") ? name.split("@")[0]! : name).split(/[\s._-]+/).filter(Boolean);
    return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

export interface Mailbox {
    id: string;
    address: string;
}

/** Pastel hues (OKLCH degrees) for the accent, so several Inboxers tell apart at a glance. */
const ACCENT_HUES = [45, 75, 105, 145, 175, 205, 235, 265, 295, 325, 355];

/** The accent hue of an instance, picked by a hash of its mail domains. */
export function accentHue(domains: string[]): number {
    return ACCENT_HUES[crc32([...domains].sort().join(",")) % ACCENT_HUES.length]!;
}

export interface LayoutOptions {
    theme: Theme;
    /** The accent's hue, from `accentHue`. */
    hue: number;
    page: Page;
    signedIn: boolean;
    draftCount?: number;
    /** Mailboxes the session can send from; New mail shows only when there is one. */
    senders?: Mailbox[];
    /** Thread pages fill the screen on a phone, so the tab bar gives way to the reply box. */
    fullScreen?: boolean;
}

export function layout(title: string, body: View, opts: LayoutOptions): View {
    const link = (page: Page, href: string, label: string, name: keyof typeof ICONS, extra: View | "" = "") =>
        h`<a href="${href}" ${raw(opts.page === page ? 'aria-current="page"' : "")}>${icon(name)}<span>${label}</span>${extra}</a>`;
    const count = opts.draftCount ? h`<span class="count">${opts.draftCount}</span>` : "";
    const canSend = !!opts.senders?.length;
    return h`<!doctype html>
<html lang="en" style="--hue: ${opts.hue}" ${raw(opts.theme === "system" ? "" : `data-theme="${opts.theme}"`)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · ${S.appName}</title>
<meta name="htmx-config" content='{"historyCacheSize":0,"refreshOnHistoryMiss":true}'>
<link rel="stylesheet" href="${ASSETS["style.css"]!.url}">
<script src="${ASSETS["htmx.min.js"]!.url}" defer></script>
<script src="${ASSETS["app.js"]!.url}" defer></script>
</head>
<body class="${opts.signedIn ? "app" : ""} ${opts.fullScreen ? "full" : ""}" hx-boost="true">
${when(opts.signedIn, () => h`<aside class="sidebar">
  <div class="brand">${S.appName}<span>.</span></div>
  ${when(canSend, () => h`<button type="button" class="primary new-mail" data-compose>${icon("plus")}${S.newMail}</button>`)}
  <nav class="side-nav" id="side-nav" data-live aria-label="${S.mainNav}">
    ${link("drafts", "/", S.navDrafts, "drafts", count)}
    ${link("inbox", "/inbox", S.navInbox, "inbox")}
    ${link("devices", "/devices", S.navDevices, "devices")}
  </nav>
  <nav class="side-nav side-end" aria-label="${S.navSettings}">${link("settings", "/settings", S.navSettings, "settings")}</nav>
</aside>`)}
<main>${body}</main>
${when(opts.signedIn, () => h`<nav class="tabbar" id="tabbar" data-live aria-label="${S.mainNav}">
  ${link("drafts", "/", S.navDrafts, "drafts", count)}
  ${link("inbox", "/inbox", S.navInbox, "inbox")}
  ${when(canSend, () => h`<button type="button" class="tab-compose" data-compose aria-label="${S.newMail}"><span>${icon("plus")}</span></button>`)}
  ${link("devices", "/devices", S.navDevices, "devices")}
  ${link("settings", "/settings", S.navSettings, "settings")}
</nav>`)}
${when(opts.signedIn && canSend, () => composeDialog(opts.senders!))}
${when(opts.signedIn, () => h`<dialog class="sheet" id="edit-sheet" aria-label="${S.edit}"></dialog>`)}
</body>
</html>`;
}

/** New mail, opened from the sidebar or the tab bar; a bottom sheet on a phone. */
function composeDialog(senders: Mailbox[]): View {
    const from = senders.length > 1
        ? h`<span class="select"><select id="compose-from" name="mailbox">${join(senders.map(m => h`<option value="${m.id}">${m.address}</option>`))}</select></span>`
        : h`<input type="hidden" name="mailbox" value="${senders[0]!.id}"><output id="compose-from">${senders[0]!.address}</output>`;
    return h`<dialog class="sheet" id="compose" aria-label="${S.newMail}">${mailForm("compose", "/compose", {
        head: h`<div class="field compact"><label for="compose-from">${S.from}</label>${from}</div>`, headIsRow: true, to: "", cc: "", subject: "", text: "",
    })}</dialog>`;
}

/** A reply opened from the reply box, shown in the edit sheet; nothing is saved until Save or Send. */
export function replyForm(threadId: string, query: string, replyToId: string, fields: { to: string; cc: string; subject: string; text: string }): View {
    return mailForm("reply", `/threads/${threadId}/reply/full?${query}`, {
        ...fields,
        head: h`<input type="hidden" name="reply_to_id" value="${replyToId}">`,
    });
}

/** New mail and the full reply: recipients, subject, body and files, saved or sent in one post. `head` is either a row or only hidden fields. */
function mailForm(id: string, action: string, f: { head: View; headIsRow?: boolean; to: string; cc: string; subject: string; text: string }): View {
    return h`<form method="post" action="${action}" enctype="multipart/form-data" data-drop>
    <div class="grabber" aria-hidden="true"></div>
    <button type="button" class="icon-btn sheet-close" data-close aria-label="${S.close}">${icon("close")}</button>
    ${f.head}
    <div class="field ${f.headIsRow ? "" : "compact"}">
      <label for="${id}-to">${S.to}</label>
      <input id="${id}-to" name="to" value="${f.to}" autocomplete="off" required>
      ${when(!f.cc, () => h`<button type="button" class="link" onclick="this.remove();var r=document.getElementById('${id}-cc-row');r.hidden=false;r.querySelector('input').focus()">${S.cc}</button>`)}
    </div>
    <div class="field" id="${id}-cc-row" ${raw(f.cc ? "" : "hidden")}>
      <label for="${id}-cc">${S.cc}</label>
      <input id="${id}-cc" name="cc" value="${f.cc}" autocomplete="off">
    </div>
    <div class="field">
      <label for="${id}-subject">${S.subject}</label>
      <input id="${id}-subject" name="subject" value="${f.subject}" required>
    </div>
    <textarea name="text" aria-label="${S.body}" required>${f.text}</textarea>
    <div class="sheet-actions">
      <label class="icon-btn" aria-label="${S.attach}">${icon("attach")}<input type="file" name="files" multiple hidden data-file-names></label>
      <output class="sheet-files"></output>
      <button type="submit" name="action" value="save">${S.saveDraft}</button>
      <button type="submit" name="action" value="send" class="primary">${S.send}${icon("send")}</button>
    </div>
  </form>`;
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

function localPart(address: string): string {
    return address.includes("@") ? address.slice(0, address.lastIndexOf("@")) : address;
}

/** An account by the local part of the address it receives mail at. */
function mailboxBadge(address: string): View {
    return h`<span class="badge mailbox">${localPart(address)}</span>`;
}

function draftAccount(d: Message): string {
    return bareAddress(d.from);
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

function recipients(m: MessageView): View | "" {
    if (!m.to.length && !m.cc.length) return "";
    return h`<div class="meta">${when(m.to.length, () => h`<span>${S.to}: ${m.to.join(", ")}</span>`)}${when(m.cc.length, () => h`<span>${S.cc}: ${m.cc.join(", ")}</span>`)}</div>`;
}

/** A message in a thread: received ones on the left, ours on the right. */
export function messageBubble(m: MessageView, showSender: boolean): View {
    const mine = m.direction === "out";
    const extra = m.cc.length || m.to.length > (mine ? 1 : 0);
    return h`<article class="msg ${mine ? "mine" : "theirs"}" id="m-${m.id}">
  ${when(showSender && !mine, () => h`<div class="msg-from">${displayName(m.from)}</div>`)}
  ${extra ? recipients(m) : ""}
  <pre class="body">${withoutImagePlaceholders(m)}</pre>
  ${attachments(m)}
  <span class="msg-time">${formatTime(m.date)}${mine ? ` · ${m.status}` : ""}</span>
</article>`;
}

export interface ContextView {
    context: Context | null;
    contacts: Contact[];
}

function contextRows(ctx: ContextView): { who: string; meta: Context["meta"]; note: string | null }[] {
    return [
        ...(ctx.context ? [{ who: S.thisThread, meta: ctx.context.meta, note: ctx.context.note }] : []),
        ...ctx.contacts.map(c => ({ who: c.address, meta: c.meta, note: c.note })),
    ].filter(r => r.note || Object.keys(r.meta).length);
}

function contextSections(rows: ReturnType<typeof contextRows>): View {
    return join(rows.map(r => h`<section>
  <div class="who">${r.who}</div>
  ${when(Object.keys(r.meta).length, () => h`<dl>${join(Object.entries(r.meta).map(([k, v]) => h`<dt>${k}</dt><dd>${String(v)}</dd>`))}</dl>`)}
  ${when(r.note, () => h`<p>${r.note}</p>`)}
</section>`));
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

/** A draft for review, on our side of its thread; without actions where the session can only read. */
export function draftCard(d: Message, canAct: boolean): View {
    if (d.pending) return pendingCard(d);
    return h`<article class="card draft" id="draft-${d.id}">
  <div class="meta">
    <span class="badge draft">${S.draft}</span>
    ${mailboxBadge(draftAccount(d))}
    <span>${d.edited_by_human ? S.editedByHuman : S.byAgent} · ${formatDate(d.created_at)}</span>
  </div>
  <div class="draft-head">
    <div class="meta"><span>${S.to}: <strong>${d.to.join(", ")}</strong></span>${when(d.cc.length, () => h`<span>${S.cc}: ${d.cc.join(", ")}</span>`)}</div>
    ${when(d.subject, () => h`<div class="subject">${d.subject}</div>`)}
  </div>
  ${when(d.note, () => h`<div class="note">${d.note}</div>`)}
  <pre class="body">${d.text}</pre>
  ${attachments(d)}
  ${when(canAct, () => h`<div class="actions">
    <button class="danger" hx-post="/drafts/${d.id}/discard" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.discard}</button>
    <button hx-get="/drafts/${d.id}/edit" hx-target="#edit-sheet" hx-swap="innerHTML">${S.edit}</button>
    <button class="primary" hx-post="/drafts/${d.id}/send" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.send}</button>
  </div>`)}
</article>`;
}

export interface DraftForm {
    to: string;
    cc: string;
    subject: string;
    text: string;
}

/** The edit sheet's content; one draft is edited at a time. A chat message has a recipient and a body only. */
export function draftEditor(d: Message, form: DraftForm, conflict: Message | null, chat: boolean): View {
    const version = conflict ? conflict.version : d.version;
    return h`<form class="${conflict ? "conflict" : ""}" hx-post="/drafts/${d.id}/save" hx-target="#edit-sheet" hx-swap="innerHTML" data-drop>
  <div class="grabber" aria-hidden="true"></div>
  <div class="drop-hint">${S.dropFiles}</div>
  <button type="button" class="icon-btn sheet-close" data-close aria-label="${S.close}">${icon("close")}</button>
  <div class="sheet-head"><span class="badge draft">${S.draft}</span>${mailboxBadge(draftAccount(d))}</div>
  ${when(d.note, () => h`<div class="note">${d.note}</div>`)}
  ${when(conflict, () => h`<div class="sheet-conflict">
    <p class="warn">${S.conflictTitle}</p>
    <details>
      <summary>${S.currentVersion}</summary>
      <div class="meta"><span>${S.to}: ${conflict!.to.join(", ")}</span>${when(conflict!.cc.length, () => h`<span>${S.cc}: ${conflict!.cc.join(", ")}</span>`)}</div>
      <div class="subject">${conflict!.subject}</div>
      <pre class="body">${conflict!.text}</pre>
    </details>
  </div>`)}
  <input type="hidden" name="version" value="${version}">
  <div class="field">
    <label for="to-${d.id}">${S.to}</label>
    <input id="to-${d.id}" name="to" value="${form.to}" autocomplete="off" required>
    ${when(!chat && !form.cc, () => h`<button type="button" class="link" onclick="this.remove();var r=document.getElementById('cc-row-${d.id}');r.hidden=false;r.querySelector('input').focus()">${S.cc}</button>`)}
  </div>
  ${when(!chat, () => h`<div class="field" id="cc-row-${d.id}" ${raw(form.cc ? "" : "hidden")}>
    <label for="cc-${d.id}">${S.cc}</label>
    <input id="cc-${d.id}" name="cc" value="${form.cc}" autocomplete="off">
  </div>
  <div class="field">
    <label for="subject-${d.id}">${S.subject}</label>
    <input id="subject-${d.id}" name="subject" value="${form.subject}" required>
  </div>`)}
  <textarea id="text-${d.id}" name="text" aria-label="${S.body}" required>${form.text}</textarea>
  <div class="sheet-actions">
    ${draftFiles(d, null)}
    <button type="submit">${S.save}</button>
    <button type="submit" name="send" value="1" class="primary">${S.saveAndSend}</button>
  </div>
</form>`;
}

/** The editor's attachment list with remove buttons, and the picker that drag and drop also feeds. */
export function draftFiles(d: Message, error: string | null): View {
    return h`<div class="draft-files" id="files-${d.id}">
  <label class="icon-btn" aria-label="${S.attach}">${icon("attach")}<input type="file" name="files" multiple hidden hx-post="/drafts/${d.id}/attachments" hx-encoding="multipart/form-data" hx-trigger="change" hx-target="#files-${d.id}" hx-swap="outerHTML" hx-include="this"></label>
  ${join(d.attachments.map(a => h`<span class="file"><span>${a.filename}</span><span class="size">${formatSize(a.size)}</span><button type="button" class="link" aria-label="${S.remove} ${a.filename}" hx-post="/drafts/${d.id}/attachments/${a.id}/remove" hx-target="#files-${d.id}" hx-swap="outerHTML">×</button></span>`))}
  ${when(error, () => h`<p class="warn">${error}</p>`)}
</div>`;
}

export function draftDone(id: string, text: string): View {
    return h`<article class="card notice" id="draft-${id}">${text}</article>`;
}

/** A list's title: the session's sending domains, with the list's name beside them. */
function listTitle(domains: string[], label: string): View {
    return domains.length
        ? h`<h1>${domains.join(" · ")} <small>${label}</small></h1>`
        : h`<h1>${label}</h1>`;
}

/** Drafts waiting for review, listed like the inbox; each opens its thread. */
export function draftList(drafts: Message[], domains: string[], current: string | null): View {
    return h`<section class="list" id="list" data-live>
  <header class="list-head">${listTitle(domains, S.navDrafts)}</header>
  ${drafts.length ? join(drafts.map(d => h`<a class="row" href="/drafts/${d.id}" ${raw(d.id === current ? 'aria-current="page"' : "")}>
    <span class="avatar" aria-hidden="true">${initials(d.to[0] ?? d.mailbox)}</span>
    <span class="row-main">
      <span class="row-top"><span class="who">${d.to.map(displayName).join(", ") || "—"}</span><time datetime="${d.created_at}">${formatDate(d.created_at)}</time></span>
      <span class="row-subject">${d.subject || "—"}</span>
      <span class="row-snippet">${d.text}</span>
      <span class="row-tags">
        ${mailboxBadge(draftAccount(d))}
        <span class="row-by">${d.edited_by_human ? S.editedByHuman : S.byAgent}</span>
      </span>
    </span>
  </a>`)) : h`<p class="empty">${S.draftsEmpty}</p>`}
</section>`;
}

export interface InboxFilter {
    mailbox: string;
    status: string;
}

export function inboxQuery(filter: InboxFilter): string {
    return new URLSearchParams({ status: filter.status, ...(filter.mailbox ? { mailbox: filter.mailbox } : {}) }).toString();
}

/** The thread list; on a wide screen it stays beside the open thread. */
export function threadList(threads: Thread[], opts: ThreadListOptions & { domains: string[] }): View {
    const { filter } = opts;
    const mailboxLabel = (m: string) => opts.domains.length === 1 ? localPart(opts.addressOf(m)) : opts.addressOf(m);
    const tab =(status: string, label: string) =>
        h`<a class="chip" href="/inbox?${inboxQuery({ ...filter, status })}" ${raw(filter.status === status ? 'aria-current="page"' : "")}>${label}</a>`;
    return h`<section class="list" id="list" data-live>
  <header class="list-head">
    ${listTitle(opts.domains, S.navInbox)}
    <form class="filters" method="get" action="/inbox">
      <input type="hidden" name="status" value="${filter.status}">
      <nav class="chips" aria-label="${S.filter}">${tab("unanswered", S.filterPending)}${tab("all", S.filterAll)}${tab("archived", S.filterArchived)}</nav>
      ${when(opts.accounts.length > 1, () => h`<span class="select"><select name="mailbox" aria-label="${S.allMailboxes}" onchange="this.form.requestSubmit()">
        <option value="">${S.allMailboxes}</option>
        ${join(opts.accounts.map(m => h`<option value="${m}" ${raw(m === filter.mailbox ? "selected" : "")}>${mailboxLabel(m)}</option>`))}
      </select></span>`)}
    </form>
  </header>
  ${threads.length ? join(threads.map(t => threadRow(t, opts))) : h`<p class="empty">${S.inboxEmpty}</p>`}
</section>`;
}

interface ThreadListOptions {
    /** Mailbox ids and catch-all addresses, as filter values. */
    accounts: string[];
    accountOf: (t: Thread) => string;
    addressOf: (account: string) => string;
    filter: InboxFilter;
    own: (address: string) => boolean;
    isChat: (mailbox: string) => boolean;
    current: string | null;
}

function threadRow(t: Thread, opts: ThreadListOptions): View {
    const chat = opts.isChat(t.mailbox);
    const people = t.participants.filter(p => !opts.own(p)).map(p => (chat && t.names[p]) || p);
    return h`<a class="row ${t.unread ? "unread" : ""}" href="/threads/${t.id}?${inboxQuery(opts.filter)}" ${raw(t.id === opts.current ? 'aria-current="page"' : "")}>
  <span class="avatar" aria-hidden="true">${initials(people[0] ?? t.mailbox)}</span>
  <span class="row-main">
    <span class="row-top"><span class="who">${people.join(", ") || t.mailbox}</span><time datetime="${t.last_at}">${formatDate(t.last_at)}</time></span>
    ${when(!chat, () => h`<span class="row-subject">${t.subject || "—"}</span>`)}
    ${when(t.has_draft || opts.accounts.length > 1 || t.unread, () => h`<span class="row-tags">
      ${when(t.has_draft, () => h`<span class="badge draft">${S.hasDraft}</span>`)}
      ${when(opts.accounts.length > 1, () => mailboxBadge(opts.addressOf(opts.accountOf(t))))}
      ${when(t.unread, () => h`<span class="dot" title="${S.unread}"></span>`)}
    </span>`)}
  </span>
</a>`;
}

/** The thread list and the open thread side by side; a phone shows one of the two. */
export function inboxPage(list: View, thread: View | null): View {
    return h`<div class="split ${thread ? "has-thread" : ""}">${list}<section class="pane">${thread ?? ""}</section></div>`;
}

export interface ThreadEntry {
    at: string;
    view: View;
}

/** The conversation, oldest first, with day separators, a reply box and the context panel. A chat is titled by who it is with. */
export function threadView(thread: Thread, entries: ThreadEntry[], ctx: ContextView, opts: { back: string; filter: InboxFilter; own: (address: string) => boolean; account: string; chat: boolean; reply: { allowed: boolean; replyAll: boolean } }): View {
    const query = inboxQuery(opts.filter);
    const rows = contextRows(ctx);
    const people = thread.participants.filter(p => !opts.own(p));
    const heading = opts.chat ? people.map(p => thread.names[p] ?? p).join(", ") : thread.subject;
    const title = h`<span class="thread-subject">${heading || "—"}</span><span class="thread-meta">${[...people, opts.account].join(" · ")}</span>`;
    const items: View[] = [];
    let day = "";
    for (const entry of entries) {
        const label = dayLabel(entry.at);
        if (label !== day) items.push(h`<div class="day">${label}</div>`);
        day = label;
        items.push(entry.view);
    }
    return h`<div class="thread">
  <header class="thread-head">
    <a class="icon-btn back" href="${opts.back}" aria-label="${S.back}">${icon("back")}</a>
    ${rows.length
        ? h`<button type="button" class="thread-title" data-context-toggle aria-controls="context">${title}</button>`
        : h`<div class="thread-title">${title}</div>`}
    ${when(rows.length, () => h`<button type="button" class="context-btn" data-context-toggle aria-controls="context">${S.context}</button>`)}
    ${archiveButton(thread)}
  </header>
  <div class="messages" id="messages" data-live data-scroll-end>${join(items)}</div>
  ${when(opts.reply.allowed, () => h`<form class="composer" method="post" action="/threads/${thread.id}/reply?${query}">
    ${when(opts.reply.replyAll, () => h`<label class="reply-all"><input type="checkbox" name="reply_all" value="1">${S.replyAll}</label>`)}
    ${when(!opts.chat, () => h`<button type="button" class="icon-btn" aria-label="${S.fullReply}" title="${S.fullReply}" hx-get="/threads/${thread.id}/reply/full?${query}" hx-include="closest form" hx-target="#edit-sheet" hx-swap="innerHTML">${icon("plus")}</button>`)}
    <textarea name="text" rows="1" aria-label="${S.reply}" placeholder="${S.reply}…" required></textarea>
    <button type="submit" name="action" value="save" class="icon-btn" aria-label="${S.saveDraft}" title="${S.saveDraft}">${icon("drafts")}</button>
    <button type="submit" name="action" value="send" class="primary send" aria-label="${S.send}" title="${S.send}">${icon("send")}</button>
  </form>`)}
  ${when(rows.length, () => h`<aside class="context-panel" id="context" aria-label="${S.context}">
    <div class="context-head"><h2>${S.context}</h2><button type="button" class="icon-btn" data-context-toggle aria-label="${S.close}">${icon("close")}</button></div>
    <div class="context-body">${contextSections(rows)}</div>
  </aside>
  <div class="context-backdrop" data-context-toggle></div>`)}
</div>`;
}

export function archiveButton(thread: Thread): View {
    const label = thread.archived ? S.unarchive : S.archive;
    return h`<form id="archive" hx-post="/threads/${thread.id}/archive" hx-swap="outerHTML">
  <input type="hidden" name="archived" value="${thread.archived ? "0" : "1"}">
  <button class="icon-btn" aria-label="${label}" title="${label}">${icon(thread.archived ? "unarchive" : "archive")}</button>
</form>`;
}

export function devicesPage(sessions: Session[], currentId: string, addressOf: (account: string) => string): View {
    return h`<section class="list">
  <header class="list-head"><h1>${S.navDevices}</h1></header>
  ${sessions.length ? join(sessions.map(s => h`<div class="row device" id="session-${s.id}">
    <span class="avatar" aria-hidden="true">${icon("devices")}</span>
    <span class="row-main">
      <span class="row-top"><span class="who">${s.label ?? s.user_agent ?? S.unknownDevice}</span><time datetime="${s.last_seen}">${formatDate(s.last_seen)}</time></span>
      ${when(s.label && s.user_agent, () => h`<span class="row-subject">${s.user_agent}</span>`)}
      <span class="row-tags">
        ${when(s.id === currentId, () => h`<span class="badge">${S.thisDevice}</span>`)}
        ${when(s.scope, () => join(s.scope!.map(m => mailboxBadge(addressOf(m)))))}
        <span class="row-by">${S.signedIn} ${formatDate(s.created_at)} · ${S.createdBy} ${s.created_by}</span>
      </span>
    </span>
    ${s.id === currentId
        ? h`<form method="post" action="/logout"><button class="danger">${S.logout}</button></form>`
        : h`<button class="danger" hx-post="/devices/${s.id}/revoke" hx-target="#session-${s.id}" hx-swap="delete">${S.revoke}</button>`}
  </div>`)) : h`<p class="empty">${S.devicesEmpty}</p>`}
</section>`;
}

export function settingsPage(theme: Theme): View {
    return h`<div class="page">
<h1>${S.navSettings}</h1>
<form class="setting" method="post" action="/theme" hx-boost="false">
  <label for="theme">${S.theme}</label>
  <span class="select"><select id="theme" name="theme" onchange="this.form.submit()">
    ${join((["system", "light", "dark"] as const).map(t =>
        h`<option value="${t}" ${raw(t === theme ? "selected" : "")}>${{ system: S.themeSystem, light: S.themeLight, dark: S.themeDark }[t]}</option>`))}
  </select></span>
</form>
<form class="setting" method="post" action="/logout"><button class="danger">${S.logout}</button></form>
</div>`;
}
