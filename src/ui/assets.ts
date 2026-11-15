import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface Asset {
    body: string;
    type: string;
    url: string;
}

function load(file: string, type: string): Asset {
    const body = readFileSync(new URL(`./static/${file}`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 10);
    return { body, type, url: `/static/${file}?v=${hash}` };
}

/** Static files with content-hashed URLs, so they can be cached forever and change on every deploy. */
export const ASSETS: Record<string, Asset> = {
    "style.css": load("style.css", "text/css; charset=utf-8"),
    "htmx.min.js": load("htmx.min.js", "text/javascript; charset=utf-8"),
};
