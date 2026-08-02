import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

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

/**
 * Realpath the longest EXISTING prefix of `path`, re-joining the trailing components that do not
 * exist yet. Deny roots routinely name files that are absent (an unwritten `.env.local`), so a
 * plain `realpathSync` would throw and force the caller back to a byte comparison.
 */
function realExistingPath(path: string, realpath: (value: string) => string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Case- and Unicode-fold a path for comparison. macOS/APFS and Windows resolve `.ENV` to `.env`,
 * and APFS treats NFC and NFD spellings as the same file, but `realpathSync` canonicalizes NEITHER —
 * it only resolves symlinks. Folding here is deliberately unconditional rather than
 * volume-dependent: over-denying is the safe direction for a deny set, and every root keel denies
 * (`.env*`, `$KEEL_HOME`, `~/.ssh`, credential sources) is a distinctive name that no legitimate
 * sibling collides with under folding.
 */
function foldPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * Like {@link isInside}, but compares the FILES rather than the spellings: both sides are resolved
 * through symlinks (longest existing prefix) and then case/Unicode folded.
 *
 * `isInside` alone is a byte comparison of two `resolve()`d strings, so a deny decision built on it
 * is evaded by any alternate spelling of the same file — an in-workspace symlink, a symlinked
 * ancestor such as the macOS `/var` -> `/private/var` alias, a case variant on a case-insensitive
 * volume, or a different Unicode normalization form. Use this for any deny/allow root check where
 * the caller controls the spelling; `isInside` remains correct for comparisons between two paths
 * keel itself produced in the same form.
 */
export function isInsideCanonical(
  root: string,
  candidate: string,
  realpath: (value: string) => string = realpathSync,
): boolean {
  if (isInside(root, candidate)) return true;
  const canonicalRoot = foldPath(realExistingPath(root, realpath));
  const canonicalCandidate = foldPath(realExistingPath(candidate, realpath));
  return (
    canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)
  );
}
