# 0022 — OQ-3 / OQ-4: pinned reference model, cost caps, and reference harness

**Status:** accepted
**Date:** 2026-06-13

## Context
Phase 1's parity gate (§2.2 kill criterion, §2.3) compares keel against a reference harness on a
pinned model and pinned infra. The spec flags two human decisions that must be set at Phase 1 start
and changed only by ADR: **OQ-3** (the pinned reference model + benchmark cost caps) and **OQ-4** (the
pinned reference harness). §2.3 is explicit that harness tuning is model-specific, so the model choice
shapes every later tuning decision; and the reference harness must be measured *by us* on identical
infra (never a leaderboard number — §8.2).

## Options
- **Model (OQ-3):** Claude Sonnet 4.6 vs Opus 4.8 vs Haiku 4.5. Sonnet 4.6 — strong coding at much
  lower $/run for the 2–3 full iteration loops Phase 1 needs; Opus is top-capability but costly per
  run; Haiku likely below the parity-target capability.
- **Reference harness (OQ-4):** researched the maintained field (verified June 2026). Terminus-2 (TB-2's
  own thin reference agent, via Harbor), mini-swe-agent, Goose, OpenHands all cluster at ~42.5–43.1% on
  Sonnet 4.5 (inside one 5-point band). Avoided: Claude Code (proprietary — fails the license gate),
  Codex CLI (cannot run Claude natively → confounds parity), Stanford meta-harness (no license,
  unmaintained), Cline (no Harbor adapter / no TB-2 anchor), Aider (no anchor, slowed cadence).

## Decision
- **OQ-3:** pin `provider: "anthropic", id: "claude-sonnet-4-6"` (`pinnedAt: 2026-06-13`); cost caps
  `costCapUSD: { perRun: 25, perMonth: 300 }` (the Epic 0.4 guard refuses 0/unset). **Update (Epic
  1.11):** both `perRun` and `perMonth` **guards** exist + are unit-tested (`cost-cap.ts`); the
  cross-run **spend ledger** (`spend-ledger.ts`: durable append, UTC month-to-date) + the **single
  spending chokepoint** `guardedRun` (guards both caps on the estimate BEFORE any spend, records the
  actual after) now exist + are tested (slice 3). What remains is the **live benchmark runner** that
  calls `guardedRun` with a real model spend — Phase B (B1). **Budget note (QC):** the
  `$25/run` figure is a *cap*, not the expected per-run cost; a 3-run-median campaign (reference
  baseline + keel + ≥2 loops) can approach/exceed `$300/mo` at the ceiling, so the real per-task cost
  must be measured on the B1 smoke and the campaign budget re-confirmed (possibly spanning >1 month or
  adjusting run counts) before bounded live Harbor validation — see the Epic 1.11 plan.
- **OQ-4:** pin **Terminus-2 via Harbor**, `referenceHarness.version: "harbor@v0.13.2"`, run as
  `harbor run -d terminal-bench@2.0 --agent terminus-2 -m anthropic/claude-sonnet-4-6`. Keep
  mini-swe-agent `v2.4.1` as a documented cross-check. `referenceHarness.score` stays `null` until WE
  measure it on identical infra + model.
- Recorded in `packages/eval/src/config.default.ts` (Appendix F); a guard test asserts the values are
  not placeholders. Changing either requires a new ADR + a fresh reference measurement.

## Consequences
- Phase-1 harness tuning is now anchored to Sonnet 4.6; re-pinning (e.g. an Opus headline number) resets
  part of the tuning work and needs a new ADR (§2.3).
- All published anchors are Sonnet **4.5** (~42.8%); the Sonnet-4.6 parity number is one we generate —
  the 4.5 figures are wiring-validation anchors, not the target.
- **TB-2.0 vs 2.1 — RESOLVED (ADR-0042, 2026-06-16):** the dataset pin is switched to **TB-2.1**
  (`terminal-bench/terminal-bench-2-1` — the verified set; same 89 task ids, so `keel-tb2-25` is
  preserved). The OQ-4 reference harness (Terminus-2 via Harbor) is unchanged; it now runs against 2.1.
- Open follow-up before a real run: confirm whether a dated `claude-sonnet-4-6-YYYYMMDD` snapshot is
  needed for byte-reproducibility.
