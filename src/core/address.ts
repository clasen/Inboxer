/** Bare, lowercased address from `Name <a@b.com>` or `a@b.com`. A chat address is a phone number: `+5491155550000`. */
export function bareAddress(value: string): string {
    const match = /<([^<>]+)>\s*$/.exec(value);
    return (match ? match[1]! : value).trim().toLowerCase();
}

/** Display name from `Name <address>`, or null when there is none. */
export function nameOf(value: string): string | null {
    const match = /^\s*"?([^"<]+?)"?\s*</.exec(value);
    return match ? match[1]! : null;
}

/** The E.164 address of a phone number written with or without the plus, spaces or dashes; null when it is not one. */
export function phoneAddress(value: string): string | null {
    const digits = bareAddress(value).replace(/[\s().-]/g, "").replace(/^\+/, "");
    return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

export function formatAddress(name: string, address: string): string {
    return `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
}

/** Splits a comma-separated recipient field, keeping commas inside quoted names. */
export function splitAddresses(value: string): string[] {
    return (value.match(/("[^"]*"|[^,])+/g) ?? []).map(part => part.trim()).filter(Boolean);
}

export function domainOf(address: string): string {
    const bare = bareAddress(address);
    return bare.slice(bare.lastIndexOf("@") + 1);
}
