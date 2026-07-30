import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keelHome } from "../session/paths.js";
import { atomicWrite } from "../tools/atomic-write.js";

/**
 * Provider API-key storage (§3.2(6), Epic 1.9, ADR-0039). v1 ships a **pure-TypeScript `0600`-file
 * store** behind a small `SecretStore` port — **no opaque native dependency in the credential path**,
 * in keeping with keel's auditability / minimal-hostile-deps bar (an opaque third-party native binary
 * handling keys is exactly what a security audit of the credential path would flag). A real OS keychain
 * is a deliberately-vetted **future adapter** behind this port — preferring the OS's own tools over a
 * third-party binary. The `0600` file is owner-only, which is the right protection level for keel's
 * single-user threat model (§3.3 already concedes same-user malware).
 */
export interface SecretStore {
  /** The stored secret for `account`, or `undefined` if absent (never throws). */
  get(account: string): string | undefined;
  /** Store `secret` for `account`. */
  set(account: string, secret: string): void;
  /** Remove `account`'s secret; `true` if one existed. */
  remove(account: string): boolean;
}

/** The `0600` credentials file: `<keelHome>/credentials.json` (user scope, never the workspace). */
export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "credentials.json");
}

/**
 * A `0600` JSON-file secret store under `keelHome`. Owner-only perms; atomic temp+rename writes; reads
 * fail-soft (missing/malformed → empty, never a throw and never a silent grant of a wrong value).
 */
export class FileSecretStore implements SecretStore {
  readonly #env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  #read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(credentialsFilePath(this.#env), "utf8"));
      const out: Record<string, string> = {};
      if (parsed !== null && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {}; // missing or malformed → empty (fail-soft)
    }
  }

  #write(data: Record<string, string>): void {
    const home = keelHome(this.#env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    // Owner-only (`0o600`), atomic, fsync'd, and durable against a loose-perm leftover or a
    // planted-symlink temp: `atomicWrite` uses a unique temp opened with the exclusive `wx` flag
    // (SEC-1/SEC-2, Epic 1.9 QC). The mode is set at creation so `rename` preserves it.
    atomicWrite(credentialsFilePath(this.#env), JSON.stringify(data, null, 2), {}, 0o600);
  }

  get(account: string): string | undefined {
    return this.#read()[account];
  }

  set(account: string, secret: string): void {
    const data = this.#read();
    data[account] = secret;
    this.#write(data);
  }

  remove(account: string): boolean {
    const data = this.#read();
    if (!(account in data)) return false;
    delete data[account];
    this.#write(data);
    return true;
  }
}

/** The v1 default secret store: the pure-TS `0600` file. (The OS-keychain adapter is a future
 *  swap-in behind `SecretStore` — ADR-0039.) */
export function defaultSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return new FileSecretStore(env);
}
