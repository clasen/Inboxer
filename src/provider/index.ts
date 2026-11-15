import type { ProviderConfig } from "../types.ts";
import { createResendProvider } from "./resend.ts";
import type { MailProvider, ProviderFactory } from "./types.ts";

const PROVIDERS: Record<string, ProviderFactory> = {
    resend: createResendProvider,
};

export function resolveProvider(config: ProviderConfig): MailProvider {
    const { type, ...options } = config;
    const factory = PROVIDERS[type];
    if (!factory) throw new Error(`Unknown provider type "${type}". Available: ${Object.keys(PROVIDERS).join(", ")}`);
    return factory(options);
}
