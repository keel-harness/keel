import { createHash } from "node:crypto";

/**
 * A stable, one-way identity key for a workspace — the SHA-256 (hex) of the launch directory (ADR-0054).
 *
 * Used to scope `keel --continue` to sessions started in the SAME directory. The redacted `cwd` stored in
 * the ledger (SEC-014) is display-only and LOSSY: a deep path containing a digit collapses under the
 * high-entropy redaction net to the single literal `[redacted:high-entropy]`, so distinct workspaces would
 * share a `cwd` key — and `--continue` could resume (and append new turns into) a DIFFERENT workspace's
 * ledger. A hash of the cwd is collision-free for distinct paths and one-way: it never reveals the path
 * (no secret a path might contain leaks), and as plain hex it passes the redaction filter unchanged
 * (`looksLikeSecret` spares all-hex), so it round-trips through the ledger intact.
 *
 * (The hash is over the cwd string as launched. Symlinked/relative variants of the same directory hash
 * differently and so are treated as distinct workspaces — an acceptable v1 limitation; realpath
 * normalization is a possible future refinement.)
 */
export function workspaceKey(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}
