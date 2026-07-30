# 0036 — TUI architecture (UIPort · reducer/dumb-renderer split · honest-posture HUD)

**Status:** accepted; runtime-posture vocabulary amended by ADR-0080
**Date:** 2026-06-14
**Relates to:** ADR-0003 (Ink behind `UIPort`; headless renderer; render components coverage-exempt
but snapshot-tested; strings in one place), ADR-0033 (autonomy modes as postures), ADR-0034 (mid-run
steering), ADR-0008/0035 (session ledger), MASTER_SPEC §8.6 (Kernel DX contract), §4.9.1 (status-line
honesty invariant), §4.10 (mid-run steering), and `docs/design/tui-principles.md` (TUI principles ·
visual language · joy checklist)

## Context

Epic 1.5 builds keel's interactive terminal UI — the conversation, delta-grade diffs, an honest
trust HUD, a discoverability layer (hint footer · `/` palette · `?` help), live mid-run steering,
and a headless renderer for `keel run -p` / CI / goldens — behind a new `UIPort`, proven end-to-end
against the simulator-driven loop (the 1.4 discipline: no real provider needed to build or test).
Several shape decisions needed a durable record; this ADR and the linked public tests are the
architecture of record.

## Decisions

**1. `UIPort` is the kernel↔renderer seam; the kernel never imports Ink.** `UIPort` (in
`@keel/shared`, types-only so the 100% gate is unaffected) is `render(view) · inputs() · close()`.
The kernel builds a `ViewModel` (*what* to show) and hands it to a `UIPort` (*how*). An Ink renderer
draws it interactively; a headless renderer serializes it to deterministic plain text. New
interaction patterns extend these types — never a direct Ink import in the kernel. *Rejected:* an
Ink-coupled kernel — it would make the view logic untestable without a terminal and lock out a
re-skin or an alternate renderer.

**2. A pure reducer is the single source of "what to show"; renderers are dumb maps.**
`tui/view-model.ts` `reduce(view, KernelEvent | UiInputEvent) → view` holds *all* branching — text
streaming, interleaved tool activity, edit diff preview, honest posture, the `… input:N queued`
indicator, the injected-steering and interrupt notes. The headless renderer and the Ink components
are thin maps over the resulting `ViewModel`. This makes behavior fully unit-testable without a
terminal, lets both renderers share one truth, and keeps the Ink components trivial. It is the UI
analogue of the 1.4 fold/rebuild discipline.

**3. Coverage-exemption boundary: only true render components are exempt.** `tui/ink/**` is
coverage-exempt (ADR-0003) and snapshot-tested via **ink-testing-library** (not pty — see ADR-0037);
everything else (`view-model · headless · diff · runner · hints · commands · input · cli/*`) is held
to the per-file ≥90 gate, and `@keel/shared` stays 100%. The exempt globs are kept tight: any logic
that can live in the gated layer does (e.g. the input state machine `tui/input.ts`, the diff
builder, the renderer-selection + arg parsing). The Ink files are thin enough that a forker can
re-skin them without touching tested logic.

**4. The status line is honest by construction (§4.9.1; amended by ADR-0080).** The trust HUD renders
`●` only when a guarantee is *actually enforced*. ADR-0080 replaces this ADR's historical Phase-1
output example with controller-owned lifecycle and route state: starting, governed, deliberately
unenforced, unavailable/fail-closed, or unreported. Guided/Autopilot terms require a governed route;
individual guarantee facts remain literal. The honesty invariant is encoded in covered view planning
and golden-tested. The HUD and the receipt are drawn from controller/view evidence, never model
self-report.

**5. Mid-run steering applies via re-drive, not a loop change (§4.10).** `runAgentLoop` owns its
messages (no injection seam by design). The runner consumes `ui.inputs()` concurrently with the
event stream; a queued comment is recorded pending (`recordSteering`, survives a crash) + shown in
the indicator, then at the next tool/turn boundary the run is aborted and re-driven from the rebuilt
ledger with the comment injected as a `user` message (`applySteering` — a `user` event + an applied
steering marker; `rebuild` dedups steering by `inputId` last-wins so the pending event is
superseded). Urgent (`/now` …) re-drives before the next *mutating* tool-call; interrupt aborts with
no re-drive (resumable). Boundaries are turn/tool-level; edit-specific timing + structured-task-state
application + the plan-change note mature with the Epic 1.6 task ledger (the §4.10 epic pointers).

**6. The InputBar → runner bridge is a single shared async iterator (`InputQueue`).** The
interactive InputBar emits `UserInput`s synchronously; the runner pulls them async via
`ui.inputs()`. `InputQueue`'s `[Symbol.asyncIterator]()` returns itself, so the entrypoint's
first-line pull (the seed) and the runner's subsequent steering pulls draw from one FIFO — there is
no two-iterator demux that could drop or duplicate an input.

**7. Renderer routing is honest and deterministic.** TTY → Ink; non-TTY / `CI=true` / a `keel run -p`
one-shot → the headless plain-text renderer (zero ANSI, golden-asserted). The selector is a pure
function of resolved booleans; the bin supplies them.

## Consequences

- **No new security claim.** The TUI *renders* the controller-reported route and individual posture
  facts (§4.9.1; ADR-0080); it adds no enforcement and must never display a guarantee that is not
  structurally true. Recorded as a claim-ledger honesty note, not a new claim.
- **No frozen interface/protocol/audit change.** `UIPort`/`ViewModel`/`UserInput` are new types;
  steering rides the non-frozen 1.4 session JSONL (ADR-0034/0035).
- The reducer is the load-bearing correctness unit and must stay exhaustively tested as the view
  grows; the Ink components must stay thin (a finding of real logic in `tui/ink/**` is a refactor
  back into the gated layer, not a wider exemption).
- The runner takes **injected** `ModelPort`+`ExecutorPort`; the production construction (real
  provider + Workspace + tools + compaction) and the multi-turn REPL are **Epic 1.6** — the
  injected-ports + `runKeelSession` seam is the handoff.
