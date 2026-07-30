# 0003 — TUI via Ink behind UIPort

**Status:** accepted; string-ownership rule amended by ADR-0080
**Date:** 2026-06-11

## Context
KEEL needs a terminal UI for the interactive coding-harness experience: streaming output, tool-call progress, approval prompts, policy-failure explanations. CLI UIs are often built directly against raw `process.stdout`, which makes them impossible to test in CI without a real terminal. The TUI must support a headless mode so integration and e2e tests can drive it without a PTY, and so CI can run without display dependencies.

## Options
1. **Ink (React for CLIs) behind a `UIPort` interface** — declarative component model, first-class headless/test renderer, rich ecosystem of widgets.
2. **Blessed / Blessed-contrib** — imperative ncurses-style API; harder to test; ecosystem stagnant.
3. **Plain stdout + ANSI escape sequences** — simplest possible approach, but untestable and loses the component model needed for approval prompts and streaming diffs.

## Decision
Adopt Ink as the TUI renderer, accessed exclusively through a `UIPort` interface in `@keel/shared`. The `UIPort` abstraction enables a headless renderer for use in integration tests (vitest) and CI, and a real Ink renderer for the interactive CLI. TUI render components are exempted from line/branch coverage thresholds but are covered by e2e snapshot tests using `node-pty`.

## Consequences
Microcopy is a product surface. ADR-0080 replaces the unimplemented literal “one `strings.ts` per
package” rule with catalog ownership at the smallest coherent subsystem boundary: cross-surface TUI
truth vocabulary lives in `tui/strings.ts`, while one-off copy stays beside covered pure planners.
The `UIPort` interface is frozen before Phase 1 e2e test work begins; ADR-0073 later supersedes the
requirement for a new method per interaction while retaining the three-method renderer seam. The Ink
+ React dependency pair is added in Phase 1 when the TUI is first implemented; Phase 0 only defines
the interface skeleton.
