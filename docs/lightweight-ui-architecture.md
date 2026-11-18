# Lightweight UI architecture and login links

How Inboxer's review UI is built, written so the same pattern can be lifted into another project (wardx).
The source of truth is `src/ui/` (`views.ts`, `routes.ts`, `assets.ts`, `static/`) and `src/auth.ts`.

## At a glance

The UI is server-rendered HTML, htmx (52 KB) and one `app.js` of about 130 lines. There is no build step,
no bundler, no component framework and no client-side state. The server is the only source of truth; the
browser asks for HTML and swaps it in.

| Concern | How it is solved | Where |
| --- | --- | --- |
| Rendering | View functions return escaped HTML with Hono's `html` tag | `src/ui/views.ts` |
| Partial actions | htmx attributes (`hx-post`, `hx-target`, `hx-swap`) | `views.ts` |
| Fast navigation | `hx-boost` on `<body>`: links and forms swap the body without a page load | `views.ts` layout, `app.js` |
| Live updates | One SSE stream says "something changed"; the page refetches itself and swaps its `[data-live]` regions | `routes.ts` `/events`, `app.js` |
| Layout | One HTML tree, CSS decides panels: tab bar + one panel on a phone, sidebar + side-by-side panels on a wide screen | `static/style.css` |
| Static files | Content-hashed URLs, cached as `immutable` | `src/ui/assets.ts` |
| Access | One-time login links minted over MCP; each becomes a revocable device session | `src/auth.ts`, `src/mcp.ts` |

```
browser                                  server (Hono)
───────                                  ─────────────
click link / submit form ──hx-boost──▶  route → view fn → full HTML page
           ◀──── body swapped ─────────
button (hx-post) ──────────────────────▶ route → view fn → fragment
           ◀──── fragment swapped ─────
EventSource /events ◀── "change" ─────── Mail.write() after every write
fetch(location.href) ──────────────────▶ same route as a normal visit
           ◀──── [data-live] regions swapped by id
```

## 1. Views are functions that return HTML

Every screen is a plain function from data to an escaped HTML string. No JSX, no templates on disk.

```ts
import { html, raw } from "hono/html";

/** Views never await, so `html` returns a plain escaped string. */
function h(strings: TemplateStringsArray, ...values: unknown[]): View {
    return html(strings, ...values) as View;
}
const join = (items: View[]) => raw(items.join("")) as View;
const when = (condition: unknown, view: () => View) => condition ? view() : "";

export function archiveButton(thread: Thread): View {
    const label = thread.archived ? S.unarchive : S.archive;
    return h`<form id="archive" hx-post="/threads/${thread.id}/archive" hx-swap="outerHTML">
  <input type="hidden" name="archived" value="${thread.archived ? "0" : "1"}">
  <button class="icon-btn" aria-label="${label}">${icon(thread.archived ? "unarchive" : "archive")}</button>
</form>`;
}
```

Rules that keep it clean:

- **Escaping is the default.** Every `${value}` is escaped. `raw()` is only used for markup the code itself
  builds (icons, `aria-current`, joined child views). User content never goes through `raw()`.
- **A page is a fragment wrapped in `layout()`.** The same function that renders a draft card for the full
  page also answers the `hx-post` that changes it, so there is one representation of each piece of UI.
- **Strings live in one place** (`src/ui/strings.ts`), so copy changes never touch markup.
- **Routes stay thin.** A route reads the session, calls the domain (`Mail`, `Access`), and returns
  `page(c, title, view, current)` or `c.html(fragment)`.

## 2. htmx for actions and navigation

### Partial actions

Buttons that change one thing post to a route that answers with that thing's new HTML:

```html
<button hx-post="/drafts/42/send" hx-target="#draft-42" hx-swap="outerHTML">Send</button>
```

Patterns used:

- **The answer is the element's current state.** Send, discard and undo all reply with the draft card as it
  is now, so a late or double click shows what actually happened.
- **Self-refreshing elements.** A draft in its undo window reloads itself when the window closes:
  `hx-get="/drafts/42/card" hx-trigger="load delay:5400ms" hx-swap="outerHTML"`.
- **Sheets load on demand.** "Edit" does `hx-get` into an empty `<dialog id="edit-sheet">`; `app.js` opens it
  on `htmx:afterSwap`.
- **Full refresh when needed.** A route can answer `HX-Refresh: true` when the page as a whole is stale.

### Navigation with `hx-boost`

`<body hx-boost="true">` turns every same-origin link and form into an htmx request that swaps the body and
pushes the URL. CSS and JS stay loaded, so a click costs one HTML response and no re-parse.

Three details make it correct:

1. **Body classes follow the page.** htmx swaps the body's content, not its attributes. The layout puts page
   state on `<body class="app full">`, so `app.js` copies it from the response:

   ```js
   document.addEventListener("htmx:beforeSwap", event => {
       if (!event.detail.boosted) return;
       if (event.detail.xhr.status >= 400) { event.detail.shouldSwap = true; event.detail.isError = false; }
       document.body.className = /<body[^>]*class="([^"]*)"/.exec(event.detail.serverResponse)?.[1] ?? "";
   });
   ```

   The same handler lets error pages (400, 401, 404) render; htmx would otherwise drop them silently.
2. **Page-load code runs on every page.** Code that used to run on `DOMContentLoaded` (scroll a thread to its
   latest message, start listening for changes) lives in one `pageShown()` that also runs after a boosted swap.
3. **Back and forward reload.** htmx caches body snapshots for history, which would bring back stale mail and
   the wrong body classes. The layout turns the cache off:

   ```html
   <meta name="htmx-config" content='{"historyCacheSize":0,"refreshOnHistoryMiss":true}'>
   ```

Opt out per element with `hx-boost="false"`. Inboxer does it on the theme form, because the theme lives on
`<html data-theme>`, which a body swap does not touch. Links with `target="_blank"` are never boosted.

## 3. Live updates over SSE, without an htmx extension

New mail, a draft written by an agent or a change from another tab shows up without a reload.

**Server.** Every write in the domain goes through one helper that announces it:

```ts
/** Fires "change" after every write, so open pages can refresh. */
readonly changes = new EventTarget();

private async write<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.store.serialize(fn);
    this.changes.dispatchEvent(new Event("change"));
    return result;
}
```

One authenticated route streams those pings. It carries no data, so it cannot leak content:

```ts
app.get("/events", c => streamSSE(c, async stream => {
    const ping = () => void stream.writeSSE({ event: "change", data: "1" });
    mail.changes.addEventListener("change", ping);
    await new Promise<void>(resolve => stream.onAbort(resolve));
    mail.changes.removeEventListener("change", ping);
}));
```

`data` must be non-empty: an SSE event with an empty data field is never dispatched.

**Page.** Regions that should stay current carry an `id` and `data-live`:

```html
<nav class="side-nav" id="side-nav" data-live>…draft count…</nav>
<section class="list" id="list" data-live>…</section>
<div class="messages" id="messages" data-live data-scroll-end>…</div>
```

On a ping, `app.js` waits for a short quiet spell (bursts collapse into one request), fetches the current URL
once and swaps each live region by id:

```js
async function refresh() {
    if (!document.querySelector("[data-live]")) return;
    const url = location.href;
    const res = await fetch(url);
    if (!res.ok || location.href !== url) return;
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    for (const region of document.querySelectorAll("[data-live]")) {
        const fresh = next.getElementById(region.id);
        if (!fresh || region.contains(document.activeElement?.closest("input, select, textarea"))) continue;
        const atEnd = region.scrollHeight - region.scrollTop - region.clientHeight < 2;
        const scrollTop = region.scrollTop;
        region.replaceWith(fresh);
        fresh.scrollTop = fresh.hasAttribute("data-scroll-end") && atEnd ? fresh.scrollHeight : scrollTop;
        htmx.process(fresh);
    }
}
```

Why this shape:

- **No second rendering path.** The refresh hits the same route a normal visit does, so live content can never
  drift from what a reload shows. No JSON API, no client templates.
- **One request per burst,** however many regions the page has.
- **What the user is doing survives.** A region holding the focused field is skipped; scroll position is kept,
  and a thread that was at its latest message stays there.
- **`htmx.process(fresh)`** wires the `hx-*` attributes in the new HTML.
- **Reconnects catch up.** `EventSource` reconnects on its own; after a reconnect the page refreshes once.

Limits to know:

- The ping goes to every open page, whatever mailboxes its session reaches. Each page then fetches only what
  its own session may see. A scoped session learns *that* something changed elsewhere, nothing more.
- Each open tab holds one HTTP connection. Over HTTP/1.1 browsers allow six per origin; HTTP/2 removes the
  limit.
- A proxy in front must not buffer `text/event-stream` (nginx: `proxy_buffering off` for that path).

## 4. Responsive panels from one HTML tree

The server renders one structure for every screen size. CSS alone decides how many panels show and where.
The breakpoint is 900px.

| Piece | Phone (< 900px) | Wide screen (≥ 900px) |
| --- | --- | --- |
| Navigation | Fixed bottom tab bar with a center compose button | 232px sticky sidebar |
| List + thread (`.split`) | One panel at a time: the list, or the thread when one is open | List (380px, own scroll) beside the thread |
| Context (`.context-panel`) | Bottom sheet over a backdrop, 70dvh, with a grab handle | Third column of the thread grid, 360px; the list hides to make room |
| Sheets (`dialog.sheet`) | Rise from the bottom, full width | Centered card, 640px |
| Thread page | Tab bar hides (`body.full`) so the reply box owns the bottom edge | Unchanged |

The markup that drives it:

```html
<body class="app full">                     <!-- app: signed in · full: a page that owns the screen -->
  <aside class="sidebar">…</aside>          <!-- hidden on a phone -->
  <main>
    <div class="split has-thread">          <!-- has-thread: a thread is open -->
      <section class="list">…</section>
      <section class="pane"><div class="thread">…</div></section>
    </div>
  </main>
  <nav class="tabbar">…</nav>               <!-- hidden on a wide screen and on full pages -->
  <dialog class="sheet" id="edit-sheet"></dialog>
</body>
```

And the CSS that turns it into panels:

```css
/* Phone: one panel; an open thread replaces the list */
@media (max-width: 899px) {
    .split .pane { display: none; }
    .split.has-thread .list { display: none; }
    .split.has-thread .pane { display: block; }
}
/* Wide: panels side by side, each scrolls on its own */
@media (min-width: 900px) {
    body.app { display: grid; grid-template-columns: 232px minmax(0, 1fr); }
    .split { display: flex; height: 100dvh; }
    .split .list { width: 380px; flex: none; overflow-y: auto; border-right: 1px solid var(--line); }
    .split .pane { flex: 1; min-width: 0; }
    body.context-open .split .list { display: none; }
    body.context-open .thread { grid-template-columns: minmax(0, 1fr) 360px; }
}
```

Why it works so well:

- **URLs are the state.** `/inbox` renders `.split` with an empty pane; `/threads/:id` renders the same split
  with `has-thread` and the list still in it. On a wide screen both show; on a phone the class picks one. The
  back button inside the thread is a plain link to the list URL, so it works the same everywhere.
- **The current row is marked by the server** (`aria-current="page"`), which styles the selection and is
  correct for screen readers with no client code.
- **Each panel scrolls on its own.** Panels are `100dvh` tall with `minmax(0, 1fr)` grid rows, so the list,
  the messages and the context panel never scroll the page or each other. `dvh` keeps the composer above the
  phone's browser chrome; `env(safe-area-inset-bottom)` keeps the tab bar clear of the home indicator.
- **One toggle, two behaviours.** `body.context-open` is flipped by a single delegated click handler. CSS makes
  it a side column on a wide screen and a bottom sheet on a phone. Escape closes it.
- **Native dialogs for sheets.** `<dialog>` + `showModal()` gives focus trapping, Escape, the backdrop and the
  top layer for free; a click on the backdrop closes it.
- **Theme tokens with `light-dark()`.** Every colour is a custom property such as
  `--bg: light-dark(#fbfbfa, #262624)`. `color-scheme` on `:root` follows the system, and
  `:root[data-theme="dark"]` forces one, so there is no duplicated dark-mode stylesheet.

## 5. Static assets: hashed and immutable

```ts
function load(file: string, type: string): Asset {
    const body = readFileSync(new URL(`./static/${file}`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
    return { body, type, url: `/static/${file}?v=${hash}` };
}
```

The files are read once at startup and served with `Cache-Control: public, max-age=31536000, immutable`. The
layout links `ASSETS["app.js"].url`, so a deploy changes the URL and every browser picks up the new file. No
bundler, no manifest file.

## 6. Login links: how a device gets access

There are no users or passwords. An agent that already holds an MCP token asks for a one-time link and hands
it to a person; opening it signs that browser in as a new **device** (session).

```
agent (MCP token)        server                         person's browser
─────────────────        ──────                         ────────────────
create_login_link ────▶  store sha256(token), TTL, scope
          ◀── url ─────
send url to person ──────────────────────────────────▶  GET /auth/:token
                                                        ◀── page with a "Sign in" button
                                                        POST /auth/:token
                         check + delete link (one use)
                         store sha256(secret) as session
                                                        ◀── signed cookie, 303 to next
```

### The pieces

| Piece | Behaviour |
| --- | --- |
| MCP tool `create_login_link` | Optional `label` ("Ana's phone") and `thread_id` to land on after sign-in. Returns `{ url, expires_at }`. |
| Link token | 32 random bytes, base64url. Only its SHA-256 is stored. Expires after `ui.loginLinkTtlMin` minutes. |
| Scope | The link inherits the scope of the MCP token that minted it, so a device never reaches more than its agent. |
| `GET /auth/:token` | Shows a button and nothing else. Link previews, chat unfurlers and mail scanners fetch with GET and would burn a link that signed in on GET. |
| `POST /auth/:token` | Check-and-delete runs inside the store's write queue, so only one request can turn a link into a session. |
| Session | 32 random bytes as the secret; the session id is its SHA-256. Stores label, user agent, IP, creator, scope and `last_seen`. |
| Cookie | `httpOnly`, `secure`, `SameSite=Lax`, signed with `ui.cookieSecret`. Re-issued on every request, so it lives 400 days (the browser maximum) from last use. |
| Devices page | Lists sessions in scope with label, browser, last seen and creator; any of them can be revoked. |
| MCP tools `list_sessions`, `revoke_session` | The agent can see and cut access too. |
| CLI `createLoginLink(cfg, { label, threadId })` | Mints a link from a server script when there is no MCP client yet. |
| Audit | `login_link.create`, `login_link.use`, `session.revoke` and `session.logout` are written to the audit log. |

### Edge cases handled

- **Used or expired link on a browser that is already signed in:** redirect to the app.
- **Used or expired link otherwise:** a "link already used" page with status 404.
- **Database leak:** only hashes of link tokens and session secrets are stored, so nothing in it can be
  replayed.
- **Deep links:** a `thread_id` becomes `next`, so the agent can say "review this draft" and the link opens it.

### Why it fits agent-first apps

The agent is already authenticated (its MCP token) and already talks to the person (chat, mail, Slack). The
link reuses both: no sign-up, no password reset, no OAuth app. Each device is named, visible and revocable,
and inherits exactly the agent's reach.

## 7. Checklist to replicate it in wardx

1. Server framework with an `html` tagged template that escapes by default (Hono `hono/html` or similar).
2. `views.ts` with `h`, `join`, `when` and one function per component; `layout()` wraps pages.
3. `strings.ts` for every user-facing string.
4. Copy `htmx.min.js` into `static/`; serve all static files through a hashed `ASSETS` map with
   `immutable` caching.
5. `<body hx-boost="true">`, the `htmx-config` meta tag, and the `beforeSwap` / `afterSwap` handlers from
   section 2.
6. Route every domain write through one `write()` that dispatches `change`; add the `/events` SSE route
   behind the session check; mark live regions with `id` + `data-live`; add `listen()` / `refresh()` to
   `app.js`.
7. Layout CSS: `.sidebar` / `.tabbar`, `.split` with `.list` and `.pane`, `has-thread` and `full` classes, one
   breakpoint, `100dvh` panels, `light-dark()` tokens, `<dialog>` sheets.
8. Auth: login link table (hash, expiry, scope, label, next), session table (hash of secret), the GET button
   page, the POST that consumes inside a write queue, signed cookie re-issued per request, devices page, and
   the `create_login_link` / `list_sessions` / `revoke_session` MCP tools.
9. Tests: sign in through a minted link, a link works only once, `/events` answers 401 when signed out and
   emits `change` after a write.
