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
