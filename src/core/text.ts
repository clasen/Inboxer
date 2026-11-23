const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ENTITY = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;

function decodeEntity(match: string, code: string): string {
    if (code[0] === "#") {
        const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
}

export function decodeEntities(value: string): string {
    return value.replace(ENTITY, decodeEntity);
}

/** Readable plain text from an HTML body. Never used for rendering. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<[^>]+>/g, "")
        .replace(ENTITY, decodeEntity)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[ch]};`);
}

export function textToHtml(text: string): string {
    return text
        .split(/\n{2,}/)
        .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("\n");
}

const REPLY_PREFIX = /^\s*((re|fw|fwd|rv|aw|sv|tr|res|enc)\s*(\[\d+\])?\s*:\s*)+/i;

export function normalizeSubject(subject: string): string {
    return subject.replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function replySubject(subject: string): string {
    return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}
