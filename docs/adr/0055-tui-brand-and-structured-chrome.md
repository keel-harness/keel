# 0055 — TUI brand identity + structured chrome (evolving "color = state, not decoration")

**Status:** ACCEPTED — owner decision (2026-06-22 design review). Implemented across Epic 1.24 (TUI visual polish).
**Date:** 2026-06-22
**Relates to:** ADR-0036 (TUI architecture — pure reducer + dumb renderers), ADR-0037 (TUI dependencies), `docs/design/tui-principles.md` (the principle this evolves), §4.9.1 (posture-honesty invariant, gated), §8.6 (kernel DX contract).

## Context

The Epic 1.5 TUI principles fixed the aesthetic as *"calm / minimal, color encodes **state**, not decoration; the craft is in hierarchy, not chrome"* (`theme.ts`, `tui-principles.md` §0). Taken literally that rule **forbids** brand color and structural chrome (boxes, panels) — so the interactive first screen renders as near-monochrome dim text with a single cyan accent. The early compact wordmark honored the old principle and, by design, undershot the desired visual hierarchy and discoverability.

The product bar (AGENTS.md "Usability & DX — Netflix-grade polish": *fast and beautiful · microcopy is a product surface*) wants the opposite of flat. The tension is real: the calm/minimal rule was protecting **honesty** (no chrome that implies enforcement we don't have) and **legibility** (hierarchy over noise) — both still sacred. But "no decoration" had hardened into "no identity," which is not what the trust thesis requires.

## Decision

Evolve the visual principle from **"color encodes state, not decoration"** to:

> **Structure and a restrained brand palette encode _hierarchy and identity_; color still encodes _state_; neither is ever decoration for its own sake, and neither may imply enforcement that is not active.**

Concretely:

1. **A signature brand color — "ocean teal"** (nautical: a *keel* is a ship's backbone; distinct from Claude Code's warm tan). Used for the wordmark/logo, panel titles, and primary accents. It is a **new role in the `theme.ts` token map** (`brand`), separate from the existing semantic state tokens.
2. **State colors stay reserved for state.** `success`/`warning`/`danger` (green/yellow/red) keep meaning *only* status — a brand accent never borrows them, so a green never reads as "passed/secure" by accident.
3. **A deliberate hierarchy scale**, applied via tokens, not ad hoc: `brand` (logo/titles) › normal/bold (primary content) › `dim` (secondary/meta) › semantic (state). The flatness was the absence of this scale.
4. **Structured chrome is allowed where it aids legibility** — bordered hero/panels (Ink `borderStyle`, already used for overlays), split panes, alignment — never as empty ornament.
5. **Honesty is unchanged and non-negotiable (§4.9.1).** The posture line stays literal (`○ … no enforcement · phase 1`); `/yolo` stays flagged danger; no box, color, or panel may render a guarantee the warden does not back. The status line and receipt remain honest-by-construction (ledger-drawn). Pretty must never become pretending.
6. **Headless stays mono** (ADR-0036): color/chrome is an Ink-renderer concern; the headless surface emits plain text with no ANSI, and every signal still carries a glyph/label so nothing depends on color alone (accessibility + `NO_COLOR`).

## Consequences

- `tui-principles.md` §0/§1 and the `theme.ts` header comment are updated to state the evolved principle (this ADR is the rationale a forker inherits).
- `theme.ts` gains a `brand` token (ocean teal) and the hierarchy roles; renderers map them. No behavior in the gated reducer changes — this is presentation, per ADR-0036.
- The interactive welcome becomes a bordered, branded hero (logo + identity + getting-started + recent sessions); see the Epic 1.24 plan. The honest posture line is part of it, never replaced by it.
- `NO_COLOR` / non-TTY / headless paths are unaffected (mono by construction).

## Alternatives considered

- **Keep the minimal principle.** Rejected: it is the direct cause of the flatness; "Netflix-grade polish" is a stated launch bar, and a branded-but-honest UI does not weaken the trust model — it strengthens legibility of it.
- **Match Claude Code's palette (warm tan).** Rejected as identity: keel should own a distinct color; ocean teal fits the name and reads distinct.
- **Color the posture indicators (e.g. green dots when "ok").** Rejected hard: that is exactly the §4.9.1 violation — coloring posture would imply enforcement state. Posture glyphs stay neutral.
