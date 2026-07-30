import { resolve, sep } from "node:path";

/**
 * Whether `candidate` resolves to `root` itself or a path strictly beneath it. The single
 * path-containment predicate shared by policy classification (`policy.ts`) and the warden's
 * filesystem deny/grant checks (`rpc-server.ts`) — one definition so the two security-relevant
 * call sites can never drift apart. Both arguments are resolved to absolute paths first, and the
 * `${root}${sep}` guard prevents the classic `/a/bc` ∈ `/a/b` false positive.
 */
export function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}
