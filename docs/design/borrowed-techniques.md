# Borrowed techniques — prior-art scaffold study (Epic 0.5)

**Status:** historical design study; reviewed techniques were either adopted through the named ADRs
and implementation slices below or left unselected.
**Date:** 2026-06-13.

## Purpose

Before keel writes any agent-loop code (Phase 1), study the two public top-scoring open scaffolds on
Terminal-Bench 2.0 and record, for each harness-engineering technique: **is it real, does it
generalize, does keel adopt it, in which Phase-1 epic, and what are the license/attribution
obligations.** This is the checklist Epics 1.1–1.6 implement. The §2.3 thesis: same-model harness
spread is enormous (58% → 76% on TB-2 with Opus 4.6 fixed), so harness hygiene — not model — is the
lever. We adopt *techniques* (ideas), implemented independently; we do not vendor these scaffolds.

## Sources studied (actual code read, not just READMEs)

| Scaffold | Score (TB-2, Opus 4.6) | License | Reuse posture |
|---|---|---|---|
| `krafton-ai/KIRA` (Terminus-KIRA) | 74.7% | **Apache-2.0** (full text in `LICENSE`; GitHub mis-classifies it as "no license") — permissive, no NOTICE file | Code reusable with attribution; keel still re-implements ideas independently (no vendoring needed for these techniques). |
| `stanford-iris-lab/meta-harness-tbench2-artifact` (Meta-Harness) | 76.4% | **No license file → all-rights-reserved** | **Ideas only — keel must NOT copy this code.** Credits the KIRA + Harbor/Terminus-2 lineage. Its one substantive delta (environment bootstrapping) is an idea keel re-implements from the documented mechanism. |

> **License gate (charter §0.1 / research rule):** KIRA is Apache-2.0 (in the permissive allowlist).
> Meta-Harness is unlicensed; we take only the *idea* of its env-snapshot and re-implement it. No
> code from either repo enters keel. Both are built on Harbor's Terminus-2 (`laude-institute`), which
> is the substrate for TB-2 itself, not part of keel.

## Headline empirical finding

The four **agent-computer-interface (ACI)** items the spec flagged for empirical evaluation —
*agent-optimized repo/code map*, *structured test-result parsing*, *task-ledger/progress-artifact
prompting*, *initializer/scaffolding-first pass* — **are present in NEITHER top scaffold.** Both top
scaffolds reach 74–76% with **raw `bash` exploration** + (Meta-Harness) a one-shot env snapshot, and
**no** code-map, no structured test parser, no in-prompt task ledger, no initializer pass. So these
ACI niceties have **no frontier evidence** behind them and are **not prioritized for keel v1** — the
spec's "adopt only if they generalize" gate resolves to *not yet*. (keel keeps a *trajectory*-side
structured-results capability in `@keel/eval` for its own §8.2 metrics, and an in-session task ledger
remains a keel design choice in Epic 1.6 — but neither is "borrowed", and neither gates parity.)

## Technique register

Legend — Observed: KIRA / MH (Meta-Harness) / both / neither. Adopt: ✅ adopt · ⚠️ adopt-the-idea-not-the-impl · ❌ don't · 🔁 keel-independent (not borrowed).

| # | Technique | Observed | Adopt | keel epic | Note (mechanism → keel re-implementation) |
|---|---|---|---|---|---|
| 1 | **Pre-completion verification interceptor** (two-phase `task_complete`: first call → inject checklist, require a second call to exit) | both | ✅ | **1.1** | KIRA `terminus_kira.py` `_pending_completion` one-shot gate + `_get_completion_confirmation_message`. Highest-evidence single technique. keel: first completion attempt injects a verification turn vs the *original task spec*; second attempt exits. Spec already mandates this in Epic 1.1. |
| 2 | **Completion checklist** (re-state original instruction + multi-role QA) | both | ⚠️ | **1.1** | Adopt the *structure* (re-stated task + requirements/robustness/edge-cases + multi-perspective). **Do not copy KIRA's exact wording** ("numeric values, array sizes…") — that's TB-2-task-shaped. Use a general rubric. |
| 3 | **Environment bootstrapping** (one-shot env snapshot into the initial prompt) | MH | ⚠️ | **1.5** (+1.1) | MH `agent.py` `_gather_env_snapshot`: ONE sentinel-delimited `exec` (cwd · `ls` · language/runtime versions · package managers · `free -h`), parsed into an `[Environment Snapshot]` block prepended to the first turn; saves 2–5 exploration turns. keel: same idea, but **parameterize the path** (MH hardcodes `/app/`), **add a token-budget guard** (MH only caps `ls` at 25 entries), and run it post-trust. |
| 4 | **Marker-based bash completion detection** (echo a unique sentinel after a command; poll; early-exit; strip marker) | both | ✅ | **1.2** | KIRA/MH `_execute_commands`: send `echo '__CMDEND_<seq>__'`, poll the pane every 0.5s, break early on the marker, filter marker lines from the observation. Pure timing win, zero task coupling. keel: per-bash sentinel behind `ExecutorPort`; 0.5s poll. |
| 5 | **Native tool calling** (provider's structured tool API; never text-parse tool calls) | both | ✅ | **1.3** | Both bypass text/JSON parsing and call with `tools=` , parsing `tool_calls`. Confirms keel's §4.5 native-tool-calling invariant. keel: Anthropic `tools` / `tool_use` blocks; text-parse fallback only for providers without native support (flagged in the scoreboard). |
| 6 | **Prompt-cache discipline** | both | ⚠️ | **1.3** | Both: `add_anthropic_caching` stamps `cache_control: ephemeral` on the **last 3 messages** (rolling tail), model-name-gated, deep-copy before mutate. Adopt the discipline but **improve it**: cache the *stable system prefix* explicitly (tiered stable/contextual/volatile, pi-ai pattern) rather than only a fixed last-3 window — long contexts benefit far more from a cached stable prefix. |
| 7 | **Output limiting / truncation** (cap terminal output to curb context bloat) | both (KIRA 30 KB) | ✅ | **1.2** | keel: configurable cap (not a hard-coded 30 KB); head+tail preservation per spec §7 Epic 1.2. |
| 8 | **Loop detection** (n-gram repetition + per-file edit counters) | neither | 🔁 | **1.1** | Absent in both scaffolds; keel implements per its own spec (the better-evidenced per-file-edit-counter signal). Not borrowed. |
| 9 | **Time/budget-awareness injection** (remaining-budget warnings) | neither | 🔁 | **1.1** | Absent in both; keel-independent per spec. |
| 10 | **Reasoning-effort modulation** ("reasoning sandwich") | partial (KIRA) | ⚠️ | **1.3**/1.1 | KIRA passes a *uniform* `reasoning_effort` (no sandwich) and force-sets `temperature=1` when it's active. keel: adopt the temp=1 enforcement now; implement the high-plan/low-execute/high-verify sandwich ourselves (provider-dependent, behind `ModelPort`). |
| 11 | **Agent-optimized repo/code map** | neither | ❌ (revisit) | — | No frontier evidence; both rely on `bash`. Not v1. |
| 12 | **Structured test-result parsing** | neither | 🔁 | (eval) | Not used by either scaffold for the *agent*; keel already has structured `BenchmarkResult` in `@keel/eval` for §8.2 metrics. Not a borrowed agent technique. |
| 13 | **Task-ledger / progress-artifact prompting** | neither | 🔁 | **1.6** | Absent in both; keel's in-session ledger (Epic 1.6) is an independent design choice, not parity-evidenced. |
| 14 | **Initializer / scaffolding-first pass** | neither | ❌ (revisit) | — | No frontier evidence; not v1. |

## Additional high-leverage techniques found (not on the spec checklist)

| Technique | Source | Adopt | keel epic | Note |
|---|---|---|---|---|
| **A. Structured `analysis`+`plan` fields inside the tool call** (scratchpad-in-the-API) | KIRA/MH | ✅ | **1.2**/1.11 | `execute_commands` requires `analysis` + `plan` + `commands[]`, forcing explicit CoT before execution and capturing it in the trajectory separately from raw output. Cheap, high-value; also enriches the §8.2 trajectory. |
| **B. Per-command duration hint** (model supplies an adaptive timeout; "poll, don't over-wait") | KIRA/MH | ✅ | **1.2** | Each command carries a `duration_sec` hint (0.1s immediate → ≤60s), pairing naturally with the marker-based early-exit (technique 4). |
| **C. Context-overflow → summarization fallback** (graceful compaction on `ContextLengthExceeded`) | KIRA | ✅ | **1.5** | Unwind to a token headroom, LLM-summarize, re-inject as a fresh first turn; final fallback = original instruction + last 1 KB. Aligns with keel's compaction-at-task-boundaries design. |
| **D. Block-timeout infra guard** (deadline-wrap every external I/O; typed infra error) | KIRA | ✅ | **1.1** | `_with_block_timeout` (600s) on tmux/exec/summarize, raising a distinct `BlockError` so infra hangs are separable from model errors. keel: wrap `ExecutorPort`/`ModelPort` calls with a deadline → typed `InfraError`; record infra-aborts distinctly (§8.2). |
| **E. `temperature=1` enforcement under reasoning-effort** (Anthropic API constraint) | KIRA/MH | ✅ | **1.3** | Easy-to-miss: the API rejects any temperature ≠ 1 when reasoning effort is set. Handle in the adapter automatically. |
| **F. Minimal-footprint completion instruction** (enumerate the minimum files to create/modify; confirm no stray state before completing) | MH prompt | ✅ | **1.1** | A general anti-sprawl prompt line that fits keel's "verify before done" ethos. |

## Deliberately NOT adopted

- **`image_read` tool** (KIRA/MH): TB-2-specific (terminal screenshots/diagrams). Not in keel v1; revisit only if keel targets visual-file tasks.
- **KIRA's exact checklist wording / `{terminal_state}` tmux-coupled prompt shape / hard-coded `/app/` and 30 KB constant**: benchmark/substrate-coupled — generalize, don't copy.
- **Automatic LLM-call retry via `tenacity`** (MH, 5 attempts w/ backoff): keel's no-auto-retry rule (§4.3/§6.4) is about **tool-call** retries (recovery is model-driven, to keep the audit narrative faithful and avoid repeating irreversible side effects). Retrying a **transient provider/API** call (5xx/network) is a different, compatible concern — keel may retry the *provider transport* but must **never** auto-retry a *tool execution*. Keep this distinction explicit when Epic 1.3 lands provider retry.

## Phase-1 task mapping (the checklist Epics 1.1–1.6 implement)

Every **adopted** technique maps to a named Phase-1 task (exit-criterion requirement):

- **Epic 1.1 (ReAct loop):** technique 1 verification interceptor, technique 2 checklist (general rubric), technique 8 loop detection (keel-independent), technique 9 budget injection (keel-independent), D infra block-timeout, F minimal-footprint completion line. *(env-snapshot technique 3 runs at loop iteration 0.)*
- **Epic 1.2 (tools):** technique 4 marker-based bash completion, technique 7 output limiting (configurable), A analysis+plan tool fields, B per-command duration hint.
- **Epic 1.3 (provider adapters):** technique 5 native tool calling (invariant), technique 6 prompt-cache discipline (improved: stable-prefix tiered), technique 10 reasoning sandwich, E temperature=1 enforcement, and the provider-transport-retry-but-never-tool-retry distinction.
- **Epic 1.5 (context discipline):** technique 3 environment bootstrapping (parameterized + token-budgeted), C overflow→summarization compaction.
- **Epic 1.6 (task ledger):** technique 13 keel-independent in-session ledger.
- **`@keel/eval` (already built):** technique 12 structured results live in `BenchmarkResult`.

## Honest read

The frontier (74–76%) is reached with a *small* set of disciplined techniques: **native tool calling, a verification/completion gate, marker-based command polling, a cheap env snapshot, prompt-cache discipline, output limiting, and graceful compaction** — plus robustness plumbing (infra timeouts, temp=1). keel's Phase-1 spec already encodes most of these; this study (a) confirms them against real top scaffolds, (b) surfaces six additional plumbing techniques (A–F), and (c) **empirically retires four speculative ACI items** that no top scaffold uses. The parity gate (§2.2) is still reached by the §2.3 iteration *loop*, not by this checklist alone — but this is the right starting set.
