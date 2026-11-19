import type { ProviderConfig } from "../types.ts";
import { createKapsoProvider } from "./kapso.ts";
import { createResendProvider } from "./resend.ts";
import type { MailProvider, ProviderFactory } from "./types.ts";

const PROVIDERS: Record<string, ProviderFactory> = {
    resend: createResendProvider,
    kapso: createKapsoProvider,
};

/** One provider per entry of `providers`, named by its key. */
export function resolveProviders(configs: Record<string, ProviderConfig>): Record<string, MailProvider> {
    return Object.fromEntries(Object.entries(configs).map(([name, { type, ...options }]) => {
        const factory = PROVIDERS[type];
        if (!factory) throw new Error(`Unknown provider type "${type}" in providers.${name}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
        return [name, factory(name, options)];
    }));
}
