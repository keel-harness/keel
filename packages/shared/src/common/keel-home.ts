import { homedir } from "node:os";
import { resolve } from "node:path";

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
}

/** The user's home directory: `$HOME`, or `os.homedir()` when `$HOME` is missing/empty/whitespace. */
function homeDir(env: NodeJS.ProcessEnv): string {
  return trimmedOrUndefined(env["HOME"]) ?? homedir();
}

/**
 * Canonical resolution of keel's state directory — the SINGLE source of truth shared by the kernel
 * and the warden. The two processes must agree byte-for-byte on where sessions, trust, command/egress
 * grants, and the audit chain live; any disagreement silently mis-locates grants and the warden's
 * deny-write roots relative to where state is actually written (P1-11). Resolution order:
 *
 *   1. `KEEL_HOME`            (explicit override)
 *   2. `$XDG_CONFIG_HOME/keel`
 *   3. `~/.config/keel`
 *
 * Values are trimmed (a whitespace-only override is treated as UNSET, never a directory literally
 * named with spaces) and resolved to an ABSOLUTE path — idempotent for an already-absolute value; a
 * relative value resolves against the current process cwd. Because the result is absolute and
 * `resolve` is idempotent, the kernel resolves once and passes the result to the warden's spawn env,
 * and the warden re-resolving it is a no-op — so a relative/unset value can never resolve differently
 * against the warden's (possibly different) cwd or HOME.
 */
export function keelHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = trimmedOrUndefined(env["KEEL_HOME"]);
  if (explicit !== undefined) return resolve(explicit);
  const xdg = trimmedOrUndefined(env["XDG_CONFIG_HOME"]);
  if (xdg !== undefined) return resolve(xdg, "keel");
  return resolve(homeDir(env), ".config", "keel");
}
