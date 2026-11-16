import type { Actor, Context, MetaValue } from "../types.ts";

export interface ContextPatch {
    /** Keys to set; `null` removes a key. Keys not mentioned are kept. */
    meta?: Record<string, MetaValue | null>;
    /** `null` clears the note. */
    note?: string | null;
}

export function mergeContext(existing: Context | null, patch: ContextPatch, actor: Actor): Context {
    const meta = { ...(existing?.meta ?? {}) };
    for (const [key, value] of Object.entries(patch.meta ?? {})) {
        if (value === null) delete meta[key];
        else meta[key] = value;
    }
    return {
        meta,
        note: patch.note !== undefined ? patch.note : (existing?.note ?? null),
        updated_at: new Date().toISOString(),
        updated_by: `${actor.kind}:${actor.name}`,
    };
}

/** Every pair must be present. Values compare as text, so `991` matches `"991"`. */
export function metaMatches(meta: Record<string, MetaValue> | undefined, wanted: Record<string, MetaValue>): boolean {
    if (!meta) return false;
    return Object.entries(wanted).every(([key, value]) => key in meta && String(meta[key]) === String(value));
}
