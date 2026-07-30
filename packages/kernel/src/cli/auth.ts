import type { SecretStore } from "../secrets/secret-store.js";
import { PROVIDERS, PROVIDER_KEY_ENV, type ProviderId } from "./runtime.js";

export interface AuthCliDeps {
  readonly store: SecretStore;
  /** Reads the secret value (the bin reads it from stdin; tests inject it). */
  readSecret(): Promise<string>;
  /** Environment used to report which providers have a key in their SDK env var (`list`). The store →
   *  env resolution mirrors `resolveApiKey`, so `list` answers "will keel find a key?" not just "is one
   *  in the file?". Defaults to `process.env`; injected in tests. */
  readonly env?: NodeJS.ProcessEnv;
}

const USAGE = "usage: keel auth <set <provider> | list | remove <provider>>";
const isProvider = (s: string | undefined): s is ProviderId =>
  s !== undefined && (PROVIDERS as readonly string[]).includes(s);

const hasEnvKey = (p: ProviderId, env: NodeJS.ProcessEnv): boolean =>
  (env[PROVIDER_KEY_ENV[p]] ?? "").trim() !== "";

/**
 * The `keel auth` command (Epic 1.9): manage provider API keys in the `0600` credentials file. Pure of
 * I/O except the injected `readSecret` (stdin) and the `store` side effects — the bin wires those.
 * **Secret values are never printed** (set confirms the backend; list shows only the source). Never
 * throws on a cancelled read or a failed store write — both return a clean one-line message so the bin
 * cannot crash with an unhandled rejection (M5, Epic 1.9 QC).
 */
export async function runAuthCli(args: readonly string[], deps: AuthCliDeps): Promise<string> {
  const [sub, provider] = args;
  const env = deps.env ?? process.env;

  switch (sub) {
    case "set": {
      if (!isProvider(provider)) {
        return `keel auth: unknown provider '${provider ?? ""}' (expected one of ${PROVIDERS.join(", ")})`;
      }
      let secret: string;
      try {
        secret = (await deps.readSecret()).trim();
      } catch {
        // Ctrl-C / EOF at the prompt — a deliberate cancel, not a crash. (The reason is intentionally
        // not interpolated: it must never carry partial secret input into the message.)
        return "keel auth: cancelled — no key stored";
      }
      if (secret === "") return "keel auth: no key provided (nothing stored)";
      try {
        deps.store.set(provider, secret);
      } catch (e) {
        return `keel auth: could not store the ${provider} key (${(e as Error).message})`;
      }
      return `stored the ${provider} key in the 0600 credentials file`;
    }
    case "list": {
      return [
        "provider          key",
        ...PROVIDERS.map((p) => {
          const source =
            deps.store.get(p) !== undefined ? "set (file)" : hasEnvKey(p, env) ? "set (env)" : "—";
          return `${p.padEnd(18)}${source}`;
        }),
      ].join("\n");
    }
    case "remove": {
      if (!isProvider(provider)) {
        return `keel auth: unknown provider '${provider ?? ""}' (expected one of ${PROVIDERS.join(", ")})`;
      }
      return deps.store.remove(provider)
        ? `removed the ${provider} key`
        : `no ${provider} key was set`;
    }
    default:
      return USAGE;
  }
}
