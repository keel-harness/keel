/**
 * The resolved workspace-trust decision. `trusted` unlocks project-local context loading (env snapshot,
 * AGENTS.md, skills); `untrusted` leaves the agent functional with empty project context (§7 Epic 1.7).
 */
export type TrustDecision = "trusted" | "untrusted";

/**
 * Inputs to the trust decision. Resolution order (four steps):
 *   1. explicit human opt-in (`--trust` flag / `KEEL_TRUST=1`, a per-run override) → trusted;
 *   2. a persisted prior decision (user-scope, keyed by the root) → that decision;
 *   3. an interactive prompt, **TTY only** → the human's answer (persisted);
 *   4. otherwise **fail closed to untrusted** — the right default for a non-interactive run
 *      (`keel run -p`, CI) where no human can answer a prompt.
 * `cwd` is the persistence key.
 */
/** What the interactive prompt is shown about the pending trust decision. */
export interface TrustPromptInfo {
  readonly cwd: string;
}

export interface ResolveTrustDeps {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The explicit `--trust` CLI flag — a deliberate human act, like `KEEL_TRUST=1`. */
  readonly trustFlag?: boolean;
  /** Look up a persisted decision for the workspace root (defaults to none if absent). Injected so
   *  the function never touches disk unless a caller wires the real `loadTrustDecision`. */
  readonly loadPersisted?: (root: string, env: NodeJS.ProcessEnv) => TrustDecision | undefined;
  /** Whether stdin/stdout is an interactive terminal — required before any prompt. */
  readonly isTTY?: boolean;
  /** The interactive y/n effect (injected; the bin renders `trustPromptText` + reads a line). Only
   *  invoked when `isTTY` and nothing else has decided — never in a non-interactive run. */
  readonly prompt?: (info: TrustPromptInfo) => Promise<boolean>;
  /** Persist a freshly prompted decision (the bin wires `saveTrustDecision`). */
  readonly persist?: (root: string, decision: TrustDecision, env: NodeJS.ProcessEnv) => void;
}

/**
 * Resolve whether this workspace is trusted. **Trust is a human act** (ADR-0017: the model may not mark
 * a workspace trusted) — this function never consults model output, only human-supplied signals.
 * Order: explicit opt-in → persisted prior decision → interactive prompt (TTY only) → fail closed to
 * untrusted. A non-interactive run NEVER prompts; it falls straight to the fail-closed default.
 */
export async function resolveWorkspaceTrust(deps: ResolveTrustDeps): Promise<TrustDecision> {
  const env = deps.env ?? process.env;
  if (deps.trustFlag === true || env["KEEL_TRUST"] === "1") return "trusted";
  const persisted = deps.loadPersisted?.(deps.cwd, env);
  if (persisted !== undefined) return persisted;
  if (deps.isTTY === true && deps.prompt !== undefined) {
    const decision: TrustDecision = (await deps.prompt({ cwd: deps.cwd }))
      ? "trusted"
      : "untrusted";
    deps.persist?.(deps.cwd, decision, env);
    return decision;
  }
  return "untrusted";
}
