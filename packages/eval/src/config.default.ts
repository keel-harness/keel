import type { EvalConfigT } from "./config.js";

/**
 * The committed normative benchmark config (Appendix F). The OQ-3/OQ-4 decisions are pinned here
 * (set at Phase 1 start; change only by ADR — see ADR-0022): the reference model + cost caps (OQ-3)
 * and the reference harness (OQ-4). `referenceHarness.score` stays `null` until WE measure it on
 * identical infra with the same model (never a leaderboard number — §8.2). `perMonth` is declared
 * but not yet enforced (config.ts).
 */
export const defaultEvalConfig = {
  suite: "terminal-bench-2",
  subset: "keel-tb2-25",
  smoke: "keel-tb2-5",
  // OQ-3 (ADR-0022): pinned reference model. LiteLLM-based harnesses take `anthropic/claude-sonnet-4-6`.
  model: { provider: "anthropic", id: "claude-sonnet-4-6", pinnedAt: "2026-06-13" },
  reasoning: { plan: "high", execute: "medium", verify: "high" },
  // OQ-4 (ADR-0022): TB-2's own thin reference agent, run via Harbor on the same model+infra.
  // score: null until measured by us (published anchors are Sonnet-4.5 ~42.8%; the 4.6 number is ours).
  referenceHarness: { name: "terminus-2 (via harbor)", version: "harbor@v0.13.2", score: null },
  infra: {
    cpus: 4,
    memoryGB: 8,
    taskTimeoutSec: 1800,
    networkPolicy: "task-default",
    retries: 0,
  },
  trajectories: { store: true, dir: "eval/trajectories" },
  runs: 3,
  aggregate: "median",
  costCapUSD: { perRun: 25, perMonth: 300 }, // OQ-3 (ADR-0022): hard ceilings; guard refuses 0/unset.
  parityThreshold: 5,
  regressionThreshold: 2,
} satisfies EvalConfigT;
