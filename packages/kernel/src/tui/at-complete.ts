import { readdirSync } from "node:fs";
import { keelHome } from "../session/paths.js";
import { Workspace } from "../tools/workspace.js";
import { loadTrustDecision } from "../trust/trust-store.js";
import { stripControlLine } from "./view-model.js";

/** The minimal directory-entry shape `completePath` needs — satisfied by `fs.Dirent` and trivial to
 *  fake in tests. */
export interface DirEntry {
  readonly name: string;
  isDirectory: () => boolean;
}

/** Dependencies for `completePath` — all injectable so the security behavior is hermetically testable
 *  (no real filesystem, no real trust store). */
export interface CompleteDeps {
  /** The workspace root (the cwd of the run). */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Trust gate — defaults to the persisted user-scope decision (`loadTrustDecision`). */
  readonly trust?: (cwd: string, env?: NodeJS.ProcessEnv) => "trusted" | "untrusted" | undefined;
  /** Directory lister — defaults to `fs.readdirSync(dir, {withFileTypes:true})`. */
  readonly readdir?: (dir: string) => readonly DirEntry[];
  /** Symlink resolver threaded into `Workspace` containment — defaults to `fs.realpathSync`. */
  readonly realpath?: (p: string) => string;
}

type TrustLookup = NonNullable<CompleteDeps["trust"]>;

/** Resolve the completion trust gate for one CLI run. An explicit `--trust` is already a human
 *  opt-in for that run, so it may unlock completion without writing a persisted decision. Every
 *  other path delegates to the normal user-scope trust store and therefore remains fail-closed. */
export function completionTrustGate(
  explicitTrust: boolean | undefined,
  persisted: TrustLookup = loadTrustDecision,
): TrustLookup {
  return explicitTrust === true ? () => "trusted" : persisted;
}

/** Max candidates returned — a calm overlay, never a wall of files. */
const MAX_CANDIDATES = 20;

/**
 * Trust-gated `@file` path completion (Epic 1.23 slice 5; SEC-012 trust-before-parse).
 *
 * Returns workspace-relative candidate paths for an `@`-reference `query` (a partial path). The
 * security contract is structural, not advisory:
 *
 * - **Fail-closed on trust.** In an untrusted or undecided workspace it returns `[]` and performs
 *   **ZERO workspace filesystem reads** — the model/UI never lists project files before the human
 *   grants trust. (Reading the user-scope trust store to *check* trust is the gate itself, not a
 *   workspace read.)
 * - **Contained.** When trusted, the directory listed and every entry offered are routed through
 *   `Workspace.resolve` (lexical + symlink + realpath containment) and the keelHome `deniedRoot`, so a
 *   `../` escape, a symlink whose target leaves the workspace, or the protected config dir never
 *   appears in the candidates.
 * - **Never throws.** An unreadable directory yields `[]`.
 */
export function completePath(query: string, deps: CompleteDeps): readonly string[] {
  const env = deps.env ?? process.env;
  const trust = deps.trust ?? loadTrustDecision;
  // SEC-012: no workspace reads before the human grants trust.
  if (trust(deps.cwd, env) !== "trusted") return [];

  const readdir = deps.readdir ?? ((dir) => readdirSync(dir, { withFileTypes: true }));
  const workspace = new Workspace(deps.cwd, {
    deniedRoots: [keelHome(env)],
    ...(deps.realpath !== undefined ? { realpath: deps.realpath } : {}),
  });

  // Split the query into a directory part (with its trailing slash) + a basename prefix.
  const slash = query.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : query.slice(0, slash + 1);
  const prefix = slash === -1 ? query : query.slice(slash + 1);

  // Resolve + contain the directory we are about to list (the workspace root for an empty dir part).
  const dir = workspace.resolve(dirPart === "" ? "." : dirPart);
  if (!dir.ok) return [];

  let entries: readonly DirEntry[];
  try {
    entries = readdir(dir.path);
  } catch {
    return []; // unreadable directory → no candidates (fail-closed, never throws)
  }

  const out: string[] = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    if (e.name.startsWith(".") && !prefix.startsWith(".")) continue; // hide dotfiles unless asked
    const rel = dirPart + e.name;
    // Re-contain each entry: a symlinked child whose real target escapes the workspace, or one inside
    // the protected config dir, is rejected here (Workspace.resolve does the realpath + denied check).
    if (!workspace.resolve(rel).ok) continue;
    // ER-020: a filename is untrusted bytes (a trusted-but-hostile repo can name a file with an OSC-8
    // hyperlink, a BEL, or a U+2028) and a candidate is INSERTED INTO THE BUFFER on Tab, not just
    // displayed — so sanitize at this data boundary, never emit a raw filename downstream.
    out.push(stripControlLine(e.isDirectory() ? `${rel}/` : rel));
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out.sort();
}
