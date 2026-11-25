// Dates render on the server in the browser's time zone and hour cycle unless Settings pins them; a page drawn
// before the server knew them, or after they changed, reloads once with them.
{
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cycle = ["h11", "h12"].includes(new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle) ? "h12" : "h23";
    const local = `${zone}|${cycle}`;
    const read = () => document.cookie.split("; ").find(c => c.startsWith("inboxer_local_clock="))?.slice("inboxer_local_clock=".length);
    if (read() !== encodeURIComponent(local)) {
        document.cookie = `inboxer_local_clock=${encodeURIComponent(local)}; path=/; max-age=34560000; samesite=lax; secure`;
        if (read() === encodeURIComponent(local) && document.body?.classList.contains("app")) location.reload();
    }
}

// New mail opens as a modal sheet, addressed when a mail address in a message opened it; a [data-close] button closes it, and so does a click outside it (closedby="any").
document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const compose = target.closest("[data-compose]");
    const dialog = document.getElementById("compose");
    // A mail address in a message carries itself in data-compose; without a mailbox to write from, its mailto: link stands.
    if (compose && dialog) {
        event.preventDefault();
        dialog.showModal();
        const to = dialog.querySelector("#compose-to");
        if (compose.dataset.compose) to.value = compose.dataset.compose;
        (compose.dataset.compose ? dialog.querySelector("#compose-subject") : to).focus();
    } else if (target.closest("[data-close]")) {
        target.closest("dialog").close();
    } else if (target.closest("[data-context-toggle]")) {
        document.body.classList.toggle("context-open");
    }
});

// Where closedby is missing, a press and a release that are both outside the sheet close it,
// so a text selection dragged onto the backdrop does not.
if (!("closedBy" in HTMLDialogElement.prototype)) {
    const outside = (event, dialog) => {
        const box = dialog.getBoundingClientRect();
        return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    };
    let pressed = null;
    document.addEventListener("pointerdown", event => {
        const dialog = event.target instanceof Element ? event.target.closest('dialog[closedby="any"]') : null;
        pressed = dialog && outside(event, dialog) ? dialog : null;
    });
    document.addEventListener("pointerup", event => {
        if (pressed?.open && outside(event, pressed)) pressed.close();
        pressed = null;
    });
}

// A draft's editor opens in the edit sheet; one draft is edited at a time.
document.addEventListener("htmx:afterSwap", event => {
    const sheet = event.detail.target;
    if (sheet.id !== "edit-sheet") return;
    if (!sheet.open) sheet.showModal();
    sheet.querySelector("textarea")?.focus();
});

document.addEventListener("change", event => {
    if (event.target.matches("[data-file-names]")) {
        event.target.closest("form").querySelector(".sheet-files").textContent = [...event.target.files].map(f => f.name).join(", ");
    }
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") document.body.classList.remove("context-open");
});

// Cmd+Enter (Ctrl+Enter off a Mac) in a message box presses its form's send button.
document.addEventListener("keydown", event => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !(event.target instanceof HTMLTextAreaElement)) return;
    // A click, so htmx posts the button's own name and value along with the form.
    const send = event.target.form?.querySelector("button[type=submit].primary");
    if (!send) return;
    event.preventDefault();
    send.click();
});

// Links and forms load the next page with htmx and swap only the body, so scripts and styles stay loaded.
// The body's classes come from the new page, and an error page shows instead of nothing.
// Back and forward reload the page (see htmx-config), so a page is never restored with stale mail.
document.addEventListener("htmx:beforeSwap", event => {
    if (!event.detail.boosted) return;
    if (event.detail.xhr.status >= 400) {
        event.detail.shouldSwap = true;
        event.detail.isError = false;
    }
    document.body.className = /<body[^>]*class="([^"]*)"/.exec(event.detail.serverResponse)?.[1] ?? "";
});

document.addEventListener("htmx:afterSwap", event => {
    if (event.detail.boosted) pageShown();
});

document.addEventListener("DOMContentLoaded", pageShown);

// A thread opens at its latest message; a signed-in page listens for changes.
function pageShown() {
    const messages = document.querySelector("[data-scroll-end]");
    if (messages) messages.scrollTop = messages.scrollHeight;
    listen();
}

// The server reports every change to the mail; the page then refetches itself once and swaps in its
// [data-live] regions by id. A burst of changes waits for a short quiet spell.
const REFRESH_DELAY_MS = 300;
let source = null;
let timer = null;

function listen() {
    const signedIn = document.body.classList.contains("app");
    if (signedIn && !source) {
        source = new EventSource("/events");
        source.addEventListener("change", refreshSoon);
        // After a reconnect, changes made while it was down are caught up.
        let opened = false;
        source.addEventListener("open", () => opened ? refreshSoon() : opened = true);
    } else if (!signedIn && source) {
        source.close();
        source = null;
    }
}

function refreshSoon() {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DELAY_MS);
}

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

// Files dropped on a [data-drop] zone go to its file input, which uploads them through htmx.
const zoneOf = event => event.target instanceof Element ? event.target.closest("[data-drop]") : null;
const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes("Files");

document.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const zone = zoneOf(event);
    event.dataTransfer.dropEffect = zone ? "copy" : "none";
    zone?.classList.add("dragging");
});

document.addEventListener("dragleave", event => {
    const zone = zoneOf(event);
    if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove("dragging");
});

document.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const zone = zoneOf(event);
    if (!zone) return;
    zone.classList.remove("dragging");
    const input = zone.querySelector("input[type=file]");
    input.files = event.dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
});
