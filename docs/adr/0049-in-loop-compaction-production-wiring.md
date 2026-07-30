# 0049 — In-loop compaction production wiring (Epic 1.6c PR-d)

**Status:** accepted + SHIPPED (Epic 1.6c, 2026-06-19, human-signed-off; env-gated
`KEEL_COMPACTION` **default-OFF**). Two independent 7-lens adversarial QC rounds (guards mutation-tested),
no must-fix.
**Date:** 2026-06-19
**Relates to:** ADR-0045 (content-aware compression + `ContextCompressionEvent`); ADR-0046 (cache-aware
reduction); ADR-0025 (compaction); ADR-0035 (session ledger round-trip / ER-015); `MASTER_SPEC.md` §4.7;
ER-021 (resolved by this work); ER-042 (the gated runway/ablation follow-up); and the public
compaction tests.

## Context

ADR-0025/0045/0046 defined the compaction architecture and the cache-aware reduction policy; the engine
(`compact()`, the deterministic tier, the `retrieve` tool) was built and merged (the earlier compaction slices) but **not
wired into a real `keel run`** (ER-021). Production wiring forced four decisions that the design docs
left open, each with a real trade-off worth recording so a fork inherits the reasoning, not just the code.

## Decision

1. **Resume bound = 4b (in-memory), not 4a (faithful replay).** A steering re-drive / fresh-process
   resume must not re-expand the full history and re-fold every cycle (cache thrash). We chose the
   **in-memory bound**: the loop surfaces its final working set (`onFinalMessages`), and the runner
   re-drives from `closeOpenToolCalls(loopFinal)` + steering instead of `rebuild`-from-full. We
   **rejected 4a** (re-apply the deterministic pass + replay the model fold from a stored summary)
   because it requires a **frozen-schema change** to `CompactionEvent` (storing the rendered summary) →
   an ADR + stop-and-ask + re-proving the ADR-0035 round-trip keystone — disproportionate to the benefit
   (it would save one bounded re-compaction on a cold fresh-process resume). **Consequence:** `rebuild`
   and the round-trip keystone are **unchanged** (compaction stays audit metadata, the full ledger
   canonical); a fresh-process resume accepts ONE bounded re-compaction. 4a stays a tracked follow-up if
   the cold-resume cost is ever measured to matter.

2. **OQ-10 compactor-model seam defaults to a deterministic, model-free `facts→TaskState` summarizer.**
   The fold's summary is built from `deriveTaskFacts` (files read/modified, command outcomes) with
   `taskGoal` recovered from the first user message — **no extra model call**. We chose this over a
   provider-prose summarizer because it is **honest by construction** (every field traces to the ledger;
   `validateTaskState` drops anything invented — zero laundering surface), **zero extra cost**, and
   **reproducible**. **Consequence / known limit:** it emits EMPTY `plan`/`nextSteps`/`decisions`/
   `failedAttempts`/`testState` — a model's un-externalized mid-reasoning is dropped at a fold (the
   recent-verbatim tail + the pinned plan-tool ledger only partially cover this). The model-prose
   summarizer is the **gated alternative**, to be wired **only if** the ablation shows the deterministic
   floor regresses resolve (ER-042) — measure, don't assume.

3. **Rollout = env-gated `KEEL_COMPACTION`, DEFAULT-OFF.** The capability ships behind a flag whose unset
   value is byte-identical to pre-1.6c (no events, unchanged tool set — `retrieve` is advertised only
   when compaction is on). We chose default-OFF because the **runway benefit is unproven** until the
   paid OFF-vs-ON ablation measures it (claiming an unmeasured benefit would violate ground-rule 4).
   **Consequence:** turning it on by default is a separate, ablation-gated decision (ER-042); until then
   compaction is opt-in and zero-risk to existing behavior.

4. **One compaction path.** The legacy re-drive-boundary `compact()` block in the runner (Epic 1.6b
   slice 6, never wired in production) was **removed** in favor of the single in-loop compactor, so a
   forker sees one mechanism, not two with duplicated trigger constants.

The in-loop trigger is **RUNWAY-primary** (gross tokens vs `KEEL_MAX_GROSS_TOKENS`) with the ADR-0046
cache net-gain guard as the cost guardrail; the deterministic tier precedes the model fold; the
`retrieve(ref)` tool is the expand path and the elision marker cites the ref.

## Consequences

- **+** §4.7 is realized + shipping with no frozen-schema change and no new security claim; the
  round-trip keystone is preserved; the flip is reversible (default-OFF) and honest.
- **+** The summary path has **no model in the laundering loop** (the strongest anti-laundering posture).
- **−** The deterministic summary is lossier than the §4.7.5/§4.7.7 typed summary (see decision 2's
  known limit) — its resolve impact is exactly what the ablation must measure before default-ON.
- **−** A window-only run (no `KEEL_MAX_GROSS_TOKENS`) has no hard per-request overflow backstop —
  fail-loud (provider rejects an over-window request), turn-bounded, documented in the README.
- **−** Idempotence keys on a content substring (`LEDGER_NOTE_MARKER`), so a hostile tool body containing
  the marker evades compression of THAT body — **runway-value degradation only**, not a SEC-023/trust
  breach (documented known-limit in `pass.ts`; structural fix is a tracked follow-up, ER-042).

## Alternatives considered

- **4a faithful replay** (rejected — frozen-schema change disproportionate to the cold-resume benefit).
- **Provider-prose summarizer as the default** (rejected for now — laundering surface + extra cost +
  non-reproducibility; gated on the ablation).
- **Default-ON at merge** (rejected — would assert an unmeasured runway benefit).
- **Keep the legacy boundary block as belt-and-suspenders** (rejected — dead-in-production duplication /
  forker trap).
