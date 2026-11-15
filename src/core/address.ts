/** Bare, lowercased address from `Name <a@b.com>` or `a@b.com`. */
export function bareAddress(value: string): string {
    const match = /<([^<>]+)>\s*$/.exec(value);
    return (match ? match[1]! : value).trim().toLowerCase();
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
