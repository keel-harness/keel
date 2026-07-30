import { join } from "node:path";
import { SessionId, keelHome } from "@keel/shared";

// `keelHome` is the canonical, cross-process resolution of keel's state directory (kernel + warden
// share the ONE implementation in `@keel/shared` so they can never disagree on where state lives —
// P1-11). Re-exported here for the many kernel callers that import it from `session/paths`.
export { keelHome };

/** The directory holding session ledgers: `<keelHome>/sessions`. */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "sessions");
}

/**
 * The JSONL ledger path for one session: `<sessionsDir>/<id>.jsonl`. The id is the single
 * chokepoint where an external id (CLI/library input) reaches the filesystem, so it is
 * **structurally validated** against the `ses_<ULID>` format here — a session id is opaque,
 * never a path. This contains any traversal / absolute-path / `..` id before an fs op
 * (assume-hostile-inputs); `readSession`, `branch`, `create`, and `list` all route through it.
 */
export function sessionPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!SessionId.safeParse(id).success) {
    throw new Error(`invalid session id: ${JSON.stringify(id)} (expected ses_<ULID>)`);
  }
  return join(sessionsDir(env), `${id}.jsonl`);
}
