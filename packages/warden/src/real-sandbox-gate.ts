/**
 * Anti "hidden-green" gate for the real-backend sandbox denial probes.
 *
 * The unit sandbox tests run against a FAKE srt runtime, so a passing `pnpm test` never proves the
 * real OS sandbox (bubblewrap on Linux, seatbelt on macOS) actually denies anything. The real
 * denial probes (`srt-sandbox.real.test.ts`) exercise the vendored runtime for real, but they can
 * only do so on a host that has the sandbox tooling installed — otherwise there is nothing to run.
 *
 * The danger is a CI leg that is *supposed* to prove real denials but silently skips because the
 * tooling was never installed: it would report green while proving nothing (AGENTS.md "No hidden
 * green"). This gate makes that impossible: when `KEEL_REQUIRE_REAL_SANDBOX` is set, an unavailable
 * sandbox is a hard failure, not a skip. Local dev and tooling-less runners still skip cleanly.
 */

const REAL_SANDBOX_REQUIRED_ENV = "KEEL_REQUIRE_REAL_SANDBOX";

/**
 * True when the caller has explicitly demanded a real sandbox (the dedicated CI leg). Accepts `1`
 * or `true` (case-insensitive, surrounding whitespace tolerated); everything else — including unset,
 * empty, `0`, `false` — is false so the gate is never armed by accident.
 */
export function isRealSandboxRequired(env: NodeJS.ProcessEnv): boolean {
  const raw = env[REAL_SANDBOX_REQUIRED_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export interface RealSandboxGateInput {
  /** Whether a real sandbox was explicitly demanded (see {@link isRealSandboxRequired}). */
  readonly required: boolean;
  /** Whether the real sandbox backend reported itself available on this host. */
  readonly available: boolean;
  /** The backend's own reason string when unavailable, surfaced in the failure message. */
  readonly unavailableReason?: string;
}

export type RealSandboxGateDecision =
  | { readonly action: "run" }
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "fail"; readonly reason: string };

/**
 * Decide what the real-denial suite should do given whether a real sandbox was required and whether
 * one is actually available:
 *
 * - available            → run the probes (real evidence);
 * - unavailable + !required → skip (local dev / tooling-less runner — honest, not green-claiming);
 * - unavailable + required  → FAIL (the CI leg was told to prove real denials but cannot — refusing
 *                             to pass is the whole point; a skip here would be hidden-green).
 */
export function resolveRealSandboxGate(input: RealSandboxGateInput): RealSandboxGateDecision {
  if (input.available) return { action: "run" };
  if (!input.required) {
    return {
      action: "skip",
      reason: `real sandbox probes are opt-in; set ${REAL_SANDBOX_REQUIRED_ENV}=1 to require them (they run in the sandbox-real CI leg)`,
    };
  }
  const why = input.unavailableReason ?? "unknown";
  return {
    action: "fail",
    reason: `${REAL_SANDBOX_REQUIRED_ENV} is set but the real sandbox is unavailable (${why}); refusing to pass — a skip here would be hidden-green`,
  };
}
