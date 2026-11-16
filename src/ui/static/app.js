// New mail opens as a modal sheet; a click on its backdrop or a [data-close] button closes it.
document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-compose]")) {
        const dialog = document.getElementById("compose");
        dialog.showModal();
        dialog.querySelector("#compose-to").focus();
    } else if (target.closest("[data-close]")) {
        target.closest("dialog").close();
    } else if (target instanceof HTMLDialogElement && target.open) {
        target.close();
    } else if (target.closest("[data-context-toggle]")) {
        document.body.classList.toggle("context-open");
    }
});

// A draft's editor opens in the edit sheet; one draft is edited at a time.
document.addEventListener("htmx:afterSwap", event => {
    const sheet = event.detail.target;
    if (sheet.id !== "edit-sheet") return;
    if (!sheet.open) sheet.showModal();
    sheet.querySelector("textarea")?.focus();
});

// Closing the sheet on a reply started from the reply box shows its new draft in the thread.
document.addEventListener("close", event => {
    if (event.target.id === "edit-sheet" && event.target.querySelector("[data-reload-on-close]")) location.reload();
}, true);

document.addEventListener("change", event => {
    if (event.target.id === "compose-files") {
        document.getElementById("compose-file-names").textContent = [...event.target.files].map(f => f.name).join(", ");
    }
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape") document.body.classList.remove("context-open");
});

// A thread opens at its latest message.
document.addEventListener("DOMContentLoaded", () => {
    const messages = document.querySelector("[data-scroll-end]");
    if (messages) messages.scrollTop = messages.scrollHeight;
});

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
