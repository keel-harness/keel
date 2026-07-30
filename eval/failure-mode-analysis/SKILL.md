---
name: failure-mode-analysis
description: Use after a Terminal-Bench run to turn the run's RAW trajectories into a ranked list of failure modes with one targeted, generalizing harness change proposed per mode (the Epic 1.11 §2.3 iteration-loop proposer). Raw trajectories, not summaries, are the input.
---

# Failure-mode analysis (the §2.3 iteration loop)

This is the proposer half of the parity-gate loop (the same pattern Meta-Harness/LangChain used). The
**deterministic** half is `@keel/eval`'s `analyzeFailures(trajectories)` — it groups + ranks unresolved
tasks by root-cause signature and attaches the §8.2 quality metrics, leaving each `proposedChange` null.
Your job is the **creative** half: read the raw traces and fill in each targeted change.

> **Raw trajectories, not summaries, are the input.** The published ablation showed summary-only
> feedback roughly *halves* achievable improvement. Read the actual stored trajectories.

## Procedure

1. **Load the deterministic scaffold.** Run `analyzeFailures` over the run's stored trajectories
   (`eval/trajectories/<suite>/<runId>/*.json`). It returns the ranked `failureModes` (each with its
   `signature`, `severity`, `count`, and the resolvable `trajectories` refs) + `aggregateQuality`
   (§8.2). Work the modes in ranked order (high severity / high count first).
2. **Read the raw traces per mode.** For each failure mode, open the FULL trajectories it references
   (not the report's summary). Look at the actual tool calls, args, results, turn reasons, and any
   completion attempts. Form ONE root-cause hypothesis grounded in what the traces show.
3. **Propose ONE targeted, GENERALIZING change.** Fill the mode's `proposedChange` with a single harness
   change (a prompt/interceptor/loop-detection/context-assembly tweak — never a new speculative ACI
   feature unless a trace proves it generalizes). State the mechanism and *why it should help across
   tasks*, citing the trajectory IDs as evidence.
4. **Apply the OVERFIT GUARD (hard).** Reject any change that targets a specific task's surface details
   (a task name, a fixture path, a magic string). The change must plausibly help the **held-out set**
   (`keel-tb2-heldout`), not just the tuned subset. Generalization beats single-task wins — if it only
   helps one task, drop it.
5. **One PR per change.** Each proposed change ships as its own PR, tagged with the failure mode it
   targets and the trajectory IDs as evidence, with the overfit-guard checklist (the PR template)
   answered. No bundling.
6. **Re-run the cadence.** After a change merges: re-run the smoke set → the full subset → record the
   per-iteration score + the §8.2 trajectory-quality metrics on the scoreboard (regressions included).
   Target regressions in the **quality metrics**, not only pass-rate — a task passed by stumbling is a
   latent regression.

## Signatures (what `analyzeFailures` classifies)

| signature | meaning | typical targeted change |
|---|---|---|
| `invalid-tool-args` | structurally-invalid tool arguments | tool schema/guidance, arg validation feedback |
| `premature-completion` | claimed/attempted done, grader says unresolved | strengthen the pre-completion verification interceptor |
| `error-cascade` | tool errors mostly not recovered from | recovery guidance after a failed tool result |
| `ran-out-of-turns` | never reached a final answer | budget-awareness / planning prompts; loop detection |
| `redundant-work` | repeated identical tool calls | loop/redundant-read detection; context assembly |
| `unresolved-other` | no specific deterministic signal | read the trace — this is where new signatures are discovered |

## Honesty

The deterministic report is factual (derived from the trajectory store, no model). The proposed changes
are *your* hypotheses — label them as proposals, never as proven. The scoreboard's measured re-run is
what confirms or refutes them. Never weaken a test or the cost cap to make a number look better.
