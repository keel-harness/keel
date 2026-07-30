import type { SessionEventT } from "@keel/shared";
import { deriveTaskFacts } from "../context/derive.js";

/**
 * §4.9.6 intent-alignment heuristics — **non-security** signals that keep the work matched to the
 * user's intent. They are NOT a containment boundary and MUST NOT be described as one: policy/sandbox
 * control *what is allowed* (Phase 2A, the warden); these only flag *whether the work still looks like
 * what the user wanted*. Computed purely from the session ledger (ledger-as-truth) so they are honest
 * and reproducible.
 *
 * Phase 1 ships the **signal computation** (this module) over what the ledger cheaply + honestly
 * yields: the file-count scope budget, the broad-rewrite guard's dependency-manifest / multi-package
 * arms, and a repeated-same-file-edit thrash proxy for the low-confidence stop. Richer signals
 * (changed-line counts, public-interface / frozen-schema detection) need change-size tracking we do
 * not have yet; the live pause-prompt surface + warden-backed `review` enforcement are Phase 2A
 * (§4.9.3). Loop detection + the per-file edit counter already live in the Epic 1.1 loop.
 */

/** Scope tier (§4.9.6; default `medium`, ADR-0033). Bounds blast radius by *intent*, not by policy. */
export type ScopeTier = "small" | "medium" | "large";

/** Per-tier file budget (§4.9.6). The line thresholds are advisory until change-size tracking lands. */
const TIER_FILE_BUDGET: Record<ScopeTier, number> = { small: 3, medium: 10, large: 25 };

/** Dependency manifests whose change is always a broad-rewrite signal (fires regardless of tier). */
const DEP_MANIFESTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "requirements.txt",
  "pyproject.toml",
]);

/** Default repeated-edit count at which a file looks like thrashing (the low-confidence proxy). */
const DEFAULT_THRASH_THRESHOLD = 3;

export interface AlignmentInput {
  readonly events: readonly SessionEventT[];
  /** Scope tier (default `medium`). */
  readonly tier?: ScopeTier;
  /** Same-file edit count that trips the thrash signal (default 3). */
  readonly thrashThreshold?: number;
}

/** A single advisory alignment signal — surfaced as guidance / a review prompt, never a deny verdict. */
export interface AlignmentSignal {
  readonly kind: "scope_budget_exceeded" | "broad_rewrite" | "low_confidence";
  /** One-line, human-readable description of what tripped. */
  readonly detail: string;
  /** The recommended next step (ask / narrow / inspect) — the §4.9.6 "what · why · what to do". */
  readonly recommendation: string;
}

/** Whether a path IS, or ends in, one of the dependency manifests (root or nested). */
const isDepManifest = (p: string): boolean =>
  [...DEP_MANIFESTS].some((m) => p === m || p.endsWith(`/${m}`));

/** The `packages/<name>` root a path belongs to, or undefined if it is not under one. */
const packageRoot = (p: string): string | undefined => {
  const m = /(?:^|\/)(packages\/[^/]+)\//.exec(p);
  return m?.[1];
};

/** Count confirmed `edit` tool calls per path (a repeated-edit thrash proxy; correlated by call id). */
function editCountsByPath(events: readonly SessionEventT[]): Map<string, number> {
  const pathById = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === "assistant" && ev.toolCalls !== undefined) {
      for (const c of ev.toolCalls) {
        if (c.name === "edit" && typeof c.args["path"] === "string") {
          pathById.set(c.id, c.args["path"]);
        }
      }
    }
  }
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "tool_result") {
      const path = pathById.get(ev.toolCallId);
      if (path !== undefined) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Evaluate the §4.9.6 alignment heuristics over a session ledger. Returns zero or more advisory
 * signals (scope budget · broad-rewrite · low-confidence). Pure; non-security.
 */
export function evaluateAlignment(input: AlignmentInput): AlignmentSignal[] {
  const tier = input.tier ?? "medium";
  const thrash = input.thrashThreshold ?? DEFAULT_THRASH_THRESHOLD;
  const modified = deriveTaskFacts(input.events).filesModified.map((f) => f.path);
  const signals: AlignmentSignal[] = [];

  // Scope budget — file count vs the tier's budget (exceeding triggers a *review*, never a denial).
  const budget = TIER_FILE_BUDGET[tier];
  if (modified.length > budget) {
    signals.push({
      kind: "scope_budget_exceeded",
      detail: `${String(modified.length)} files modified (${tier} budget is ${String(budget)})`,
      recommendation: "pause and confirm the scope, or narrow the change",
    });
  }

  // Broad-rewrite guard (fires regardless of tier): dependency manifests + multi-package edits.
  const deps = [...new Set(modified.filter(isDepManifest))];
  if (deps.length > 0) {
    signals.push({
      kind: "broad_rewrite",
      detail: `dependency manifest changed: ${deps.join(", ")}`,
      recommendation: "confirm the dependency change before continuing",
    });
  }
  const pkgs = [...new Set(modified.map(packageRoot).filter((r): r is string => r !== undefined))];
  if (pkgs.length > 1) {
    signals.push({
      kind: "broad_rewrite",
      detail: `edits span ${String(pkgs.length)} packages: ${pkgs.join(", ")}`,
      recommendation: "confirm the multi-package change, or split it",
    });
  }

  // Low-confidence stop — a repeated-same-file-edit thrash proxy (loop detection + the per-file edit
  // counter proper live in the Epic 1.1 loop; this is the ledger-derived complement).
  for (const [path, count] of editCountsByPath(input.events)) {
    if (count >= thrash) {
      signals.push({
        kind: "low_confidence",
        detail: `${path} edited ${String(count)} times — possible thrashing`,
        recommendation: `re-read ${path} and reassess the approach before editing again`,
      });
    }
  }

  return signals;
}
