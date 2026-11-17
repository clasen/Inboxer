import { nid, type Store } from "../store.ts";
import type { Message, Thread } from "../types.ts";
import { bareAddress } from "./address.ts";
import { normalizeSubject } from "./text.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function messageTime(message: Message): string {
    return message.sent_at ?? message.created_at;
}

export function participantsOf(message: Pick<Message, "from" | "to" | "cc">): string[] {
    return [message.from, ...message.to, ...message.cc].filter(Boolean).map(bareAddress);
}

export interface ThreadLookup {
    mailbox: string;
    inReplyTo: string | null;
    references: string[];
    subject: string;
    participants: string[];
    at: string;
}

/**
 * 1. In-Reply-To / References against a stored Message-ID.
 * 2. Same normalized subject and a shared external participant, within the window.
 * 3. A new thread.
 */
export async function resolveThreadId(
    store: Store,
    lookup: ThreadLookup,
    isOwn: (address: string) => boolean,
    windowDays: number,
): Promise<string> {
    for (const ref of [lookup.inReplyTo, ...[...lookup.references].reverse()]) {
        if (!ref) continue;
        const id = await store.lookupMessageId(ref);
        const message = id ? await store.getMessage(id) : null;
        if (message) return message.thread_id;
    }

    const subject = normalizeSubject(lookup.subject);
    const external = new Set(lookup.participants.filter(p => !isOwn(p)));
    if (subject && external.size) {
        const since = new Date(lookup.at).getTime() - windowDays * DAY_MS;
        const match = (await store.allThreads())
            .filter(t => t.mailbox === lookup.mailbox && t.norm_subject === subject && new Date(t.last_at).getTime() >= since)
            .filter(t => t.participants.some(p => external.has(p)))
            .sort((a, b) => b.last_at.localeCompare(a.last_at))[0];
        if (match) return match.id;
    }

    return nid();
}

export async function threadMessages(store: Store, thread: Thread): Promise<Message[]> {
    const messages = await Promise.all(thread.message_ids.map(id => store.requireMessage(id)));
    return messages.filter(m => m.status !== "discarded").sort((a, b) => messageTime(a).localeCompare(messageTime(b)));
}

/** Recomputes the thread summary, adding `newMessageId` when given. A thread left with only discarded drafts is removed. */
export async function refreshThread(store: Store, threadId: string, newMessageId?: string): Promise<Thread | null> {
    const existing = await store.getThread(threadId);
    const ids = existing?.message_ids ?? [];
    const thread: Thread = {
        id: threadId,
        mailbox: "",
        subject: "",
        norm_subject: "",
        participants: [],
        last_at: "",
        last_direction: "in",
        has_draft: false,
        unread: 0,
        archived: false,
        labels: {},
        message_ids: newMessageId && !ids.includes(newMessageId) ? [...ids, newMessageId] : ids,
    };
    const messages = await threadMessages(store, thread);
    if (!messages.length) {
        await store.deleteThread(threadId);
        return null;
    }

    const settled = messages.filter(m => m.status !== "draft");
    const first = settled[0] ?? messages[0]!;
    const last = settled.at(-1) ?? messages.at(-1)!;
    thread.mailbox = first.mailbox;
    thread.subject = first.subject;
    thread.norm_subject = normalizeSubject(first.subject);
    thread.participants = [...new Set(messages.flatMap(participantsOf))];
    thread.last_at = messageTime(last);
    thread.last_direction = last.direction;
    thread.has_draft = messages.some(m => m.status === "draft");
    thread.unread = messages.filter(m => m.direction === "in" && !m.read).length;
    thread.archived = settled.length > 0 && settled.every(m => m.archived);
    for (const m of messages) Object.assign(thread.labels, m.labels);

    await store.putThread(thread);
    return thread;
}
