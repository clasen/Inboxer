import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { MessageView } from "../core/mail.ts";
import type { Message, Session, Thread } from "../types.ts";
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

export function layout(title: string, body: View, opts: { theme: Theme; page: Page; draftCount?: number; signedIn: boolean }): View {
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
<main>${body}</main>
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

export function messageCard(m: MessageView): View {
    return h`<article class="card ${m.direction}">
  <div class="meta">
    <strong>${m.from}</strong>
    <span>${formatDate(m.date)}</span>
    ${when(m.direction === "out" && m.status !== "draft", () => h`<span>${m.status}</span>`)}
  </div>
  <div class="meta"><span>${S.to}: ${m.to.join(", ")}</span>${when(m.cc.length, () => h`<span>${S.cc}: ${m.cc.join(", ")}</span>`)}</div>
  <pre class="body">${m.text}</pre>
</article>`;
}

export function draftCard(d: Message, history: MessageView[]): View {
    return h`<article class="card" id="draft-${d.id}">
  <div class="meta">
    ${mailboxBadge(d.mailbox)}
    <span class="badge draft">${S.draft}</span>
    ${when(d.edited_by_human, () => h`<span>${S.editedByHuman}</span>`)}
    <span>${formatDate(d.created_at)}</span>
  </div>
  <div class="meta"><span>${S.to}: <strong>${d.to.join(", ")}</strong></span>${when(d.cc.length, () => h`<span>${S.cc}: ${d.cc.join(", ")}</span>`)}</div>
  <div class="subject">${d.subject}</div>
  ${when(d.note, () => h`<div class="note">${d.note}</div>`)}
  <pre class="body">${d.text}</pre>
  <div class="actions">
    <button hx-get="/drafts/${d.id}/edit" hx-target="#draft-${d.id}" hx-swap="outerHTML">${S.edit}</button>
    <button class="primary" hx-post="/drafts/${d.id}/send" hx-target="#draft-${d.id}" hx-swap="outerHTML" hx-confirm="${S.confirmSend}">${S.send}</button>
    <button class="danger" hx-post="/drafts/${d.id}/discard" hx-target="#draft-${d.id}" hx-swap="outerHTML" hx-confirm="${S.confirmDiscard}">${S.discard}</button>
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
    return h`<article class="card ${conflict ? "conflict" : ""}" id="draft-${d.id}">
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
    <div class="actions">
      <button type="submit">${S.save}</button>
      <button type="submit" name="send" value="1" class="primary" hx-confirm="${S.confirmSend}">${S.saveAndSend}</button>
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

export function draftDone(id: string, text: string): View {
    return h`<article class="card notice" id="draft-${id}">${text}</article>`;
}

export function draftsPage(drafts: { draft: Message; history: MessageView[] }[]): View {
    return h`<h1>${S.navDrafts}</h1>
${drafts.length ? join(drafts.map(d => draftCard(d.draft, d.history))) : h`<p class="empty">${S.draftsEmpty}</p>`}`;
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

export function threadPage(thread: Thread, items: View[]): View {
    return h`<h1>${thread.subject || "—"}</h1>
<div class="meta">${mailboxBadge(thread.mailbox)}${archiveButton(thread)}</div>
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
  </div>
  ${when(s.label && s.user_agent, () => h`<div class="meta"><span>${s.user_agent}</span></div>`)}
  <div class="meta">
    <span>${S.signedIn}: ${formatDate(s.created_at)}</span>
    <span>${S.lastSeen}: ${formatDate(s.last_seen)}</span>
    <span>${S.createdBy}: ${s.created_by}</span>
  </div>
  ${when(s.id !== currentId, () => h`<div class="actions"><button class="danger" hx-post="/devices/${s.id}/revoke" hx-target="#session-${s.id}" hx-swap="delete" hx-confirm="${S.confirmRevoke}">${S.revoke}</button></div>`)}
</article>`)) : h`<p class="empty">${S.devicesEmpty}</p>`}`;
}
