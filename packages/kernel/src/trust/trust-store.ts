import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { keelHome } from "../session/paths.js";
import { atomicWrite } from "../tools/atomic-write.js";
import { withFileLock } from "../tools/file-lock.js";
import type { TrustDecision } from "./resolve.js";

/**
 * The persisted workspace-trust store. The trust decision lives in **user-scope** config under
 * `keelHome` — NEVER in project-file scope (ADR-0033) — so an untrusted repo cannot grant itself
 * trust, and the model has no write path to it (it is set only by the human, via the prompt/flag, and
 * persisted here by the kernel). Keyed by the **realpath'd** workspace root so a symlinked path to the
 * same workspace shares one decision. Validated on read and **fail-closed**: a malformed/invalid file
 * reads as "no record" (re-decide), never as a silent grant.
 */
const TrustEntry = z
  .object({
    decision: z.enum(["trusted", "untrusted"]),
    decidedAt: z.string(),
    principal: z.string(),
  })
  .strict();

const TrustFile = z
  .object({
    version: z.literal(1),
    workspaces: z.record(z.string(), TrustEntry),
  })
  .strict();

type TrustFileT = z.infer<typeof TrustFile>;

/** `<keelHome>/trust.json` — the single user-scope trust store. */
export function trustFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "trust.json");
}

/** Canonical key for a workspace: its realpath'd absolute path (falls back to a lexical resolve if
 *  the path cannot be realpath'd — e.g. it does not exist). Canonicalizing means symlinked aliases to
 *  the same root share one decision. */
function workspaceKey(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The deciding principal recorded on the entry — provenance, not a security boundary (this is
 *  user-scope config the human owns). Read from the standard `USER`/`LOGNAME` env, else "unknown". */
function principal(env: NodeJS.ProcessEnv): string {
  return env["USER"] ?? env["LOGNAME"] ?? "unknown";
}

/** Read + validate the store, fail-closed to an empty store on any IO/parse/schema error. */
function readStore(env: NodeJS.ProcessEnv): TrustFileT {
  try {
    const parsed = TrustFile.safeParse(JSON.parse(readFileSync(trustFilePath(env), "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or unreadable file → empty store */
  }
  return { version: 1, workspaces: {} };
}

/**
 * The persisted trust decision for `root`, or `undefined` if there is no (valid) record — in which
 * case the caller decides fresh (prompt / fail-closed default). Never throws.
 */
export function loadTrustDecision(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): TrustDecision | undefined {
  const entry = readStore(env).workspaces[workspaceKey(root)];
  return entry?.decision;
}

/**
 * Persist a human's trust decision for `root` (a later decision supersedes an earlier one). Writes the
 * user-scope `trust.json` atomically (temp + rename) with `0600` perms. The model never calls this —
 * it is invoked by the kernel after a human prompt/flag decision (ADR-0017).
 *
 * **Fail-soft** (symmetric with `loadTrustDecision`): persistence is best-effort. If the config dir is
 * unwritable, the write is silently skipped — the in-memory decision still governs THIS run; the next
 * run simply re-decides (re-prompts) rather than losing the whole session to an unwritable `keelHome`.
 */
export function saveTrustDecision(
  root: string,
  decision: TrustDecision,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    // Lock the read-modify-write so two concurrent sessions cannot lose each other's decision, and
    // write atomically so a torn file never forces a fail-closed re-prompt. Still best-effort: an
    // unwritable/contended config dir must not crash an otherwise-good run (see docstring).
    withFileLock(trustFilePath(env), () => {
      const store = readStore(env);
      const next: TrustFileT = {
        version: 1,
        workspaces: {
          ...store.workspaces,
          [workspaceKey(root)]: {
            decision,
            decidedAt: new Date().toISOString(),
            principal: principal(env),
          },
        },
      };
      atomicWrite(trustFilePath(env), JSON.stringify(next, null, 2), {}, 0o600);
    });
  } catch {
    // best-effort: an unwritable/contended config dir must not crash an otherwise-good run.
  }
}
