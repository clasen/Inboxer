#!/usr/bin/env node
import { resolve } from "node:path";
import Configre from "configre";
import { Access } from "../auth.ts";
import { assertConfig } from "../config.ts";
import { Store } from "../store.ts";
import type { InboxerConfig } from "../types.ts";

const [configDir, label] = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
if (!configDir) {
    console.error("Usage: inboxer-login-link <config-dir> [label] [--config=<profile>]");
    process.exit(1);
}

const cfg = Configre(resolve(configDir)) as InboxerConfig;
assertConfig(cfg, { requireProvider: false });
const store = new Store(cfg.dataDir);
await store.connect();
try {
    const link = await new Access(store, cfg).createLoginLink({ kind: "cli", name: "cli" }, label ?? null);
    console.log(link.url);
} finally {
    await store.close();
}
