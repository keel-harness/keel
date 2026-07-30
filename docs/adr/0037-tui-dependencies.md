# 0037 — TUI dependencies (ink/react · ink-testing-library, not node-pty · no markdown dep)

**Status:** accepted
**Date:** 2026-06-14
**Relates to:** ADR-0003 (Ink behind `UIPort`; render components snapshot-tested), ADR-0036 (TUI
architecture), MASTER_SPEC §5.3 (supply-chain rules), §6 (engineering standards)

## Context

Epic 1.5's interactive renderer needs a terminal UI library and a way to test it. The supply-chain
rules apply from commit one (§5.3): permissive licenses only (Apache-2.0 / MIT / BSD / ISC — never
copyleft/source-available), exact-pinned, `ignore-scripts`, minimum-release-age, committed lockfile,
assume dependencies are hostile. This ADR records the choices and one deviation from the design's
initial testing plan.

## Decisions

**1. Renderer: `ink@7.0.5` + `react@19.2.7` (runtime, MIT).** ADR-0003 already chose Ink behind
`UIPort`; this pins the versions. Ink is React-for-CLIs (flexbox layout, focus, input) — the
mainstream, well-maintained choice, and the one ADR-0003 committed to. `react` is its peer.
`react-devtools-core` (an optional Ink peer, dev-only debugging) is **not** installed — absent, not
configured away.

**2. Test harness: `ink-testing-library@4.0.0` + `@types/react@19.2.16` (dev, MIT) — NOT `node-pty`.**
The design (and ADR-0003) anticipated pty snapshot tests via `node-pty` for the Ink renderer.
**Deviation:** `node-pty` is a **native** module — it ships an install-time build step, which the
repo's mandatory `ignore-scripts` (§5.3) suppresses, leaving it unbuilt/unusable; relaxing
`ignore-scripts` for it would punch a hole in the supply-chain posture for a *test* dependency. We
use **`ink-testing-library`** instead — pure JS, MIT, the official Ink testing tool — which renders a
component to an in-memory frame and drives `stdin` synthetically. It covers exactly what we test
(frame content, the live `/` palette overlay, `onAction` outflow) without a real pty or a native
build step. *Trade-off:* it does not exercise real terminal escapes / `SIGWINCH` resize / true tty
behavior; those remain a manual / Epic-1.10-packaging concern. Given the reducer/headless layers
hold all branching logic (gated at ≥90) and the Ink components are thin maps (ADR-0036 §3), the
residual risk is low and the supply-chain win is real.

**3. Markdown / syntax highlight: a tiny in-tree mapper, no dependency (yet).** The flagship diff is
rendered by the in-tree `tui/diff.ts` + semantic Ink colors (slices 3–4); markdown is rendered
plainly in Phase 1. We deliberately did **not** pull in a markdown renderer or a syntax-highlight
engine (e.g. `marked-terminal`, `cli-highlight`, `lowlight`) — each is a non-trivial dependency
surface for polish that is not yet load-bearing. Word-level intra-line diff highlight and rich
markdown/syntax highlighting are fast-follow; if/when added they get their own license + supply-chain
review and an ADR amendment. This honors "no convenience dependencies" — prefer a small in-tree
implementation over dragging in a large one.

## Consequences

- Deps added: `ink@7.0.5`, `react@19.2.7` (kernel runtime); `ink-testing-library@4.0.0`,
  `@types/react@19.2.16` (kernel dev). All **MIT**, exact-pinned, `ignore-scripts`, ≥7-day release
  age, in the committed lockfile.
- The Ink renderer is **snapshot-tested** (ink-testing-library), not pty-tested; ADR-0003's
  "pty-snapshot-tested" wording is superseded by this ADR for the test-harness choice. Real-terminal
  behavior (resize/escape/color downgrade) is verified manually and at packaging (Epic 1.10).
- No native build step enters the tree; `ignore-scripts` stays absolute.
- A future markdown/syntax dependency is an additive decision behind the same license + supply-chain
  gate (amend this ADR).

## 2026-07-21 amendment — reviewed local Ink resize patch

Epic 3.10's real-tmux oracle proved that stock `ink@7.0.5` under-clears a live frame when narrowing
causes a previously painted logical row to occupy more physical terminal rows. A one-resize
correction was not sufficient: rapid width bursts could still leave transient live rows in native
scrollback. Upstream [issue 942](https://github.com/vadimdemedes/ink/issues/942) tracks resize
overlap and the absence of a supported full-redraw API; [issue 935](https://github.com/vadimdemedes/ink/issues/935)
also demonstrates why clearing the terminal's scrollback is not an acceptable generic workaround.

Keel therefore keeps the exact `ink@7.0.5` dependency and applies
`patches/ink@7.0.5.patch` through pnpm `patchedDependencies`. The patch:

- counts the old frame's reflowed physical rows using Ink's existing `string-width` and `wrap-ansi`
  dependencies;
- treats a resize burst as one 300 ms quiet-window gesture; while geometry is unsettled it buffers
  newly promoted Static bytes instead of clearing or publishing them at an intermediate width, then
  clears once at the settled geometry, writes the buffered Static bytes exactly once, and paints one
  final-width live frame;
- flushes on explicit render waits and unmount so no timer can write after teardown;
- leaves screen-reader, debug, non-interactive, and alternate-screen modes on their immediate paths.

Because the patched JavaScript no longer corresponds to Ink's published source maps, the patch
removes the two affected `sourceMappingURL` trailers instead of shipping misleading stack locations.
The npx artifact bundles these reviewed Ink bytes plus exact `cli-truncate@6.0.0`,
`slice-ansi@9.0.0`, and `cli-boxes@4.0.1` bytes, asserts the resize marker is present, and verifies
all four are present in a broader exact-Bun-graph component inventory. The first two share Ink 7's Node >=22 package-engine declaration;
cli-boxes narrows Node 20 to >=20.10. Bundling the exercised code preserves Keel's existing Node 20
npx carrier without publishing incompatible engine constraints. The bundled set's remaining direct
dependency boundary (including React) stays
external, is generated from the reviewed installation as exact pins, and therefore retains its
normal npm package manifests and licenses. Mechanically, native binaries bundle dependency bytes,
but ADR-0040's release-licensing hold controls whether those binaries may be redistributed.
The npx license/notice closure is not hard-coded to those four packages: versioned redistribution
artifacts and `components.json` are derived from the complete Bun metafile input graph, including
vendored sandbox-runtime bytes only when exercised by that graph. Missing or unsupported license
evidence fails closed. This distinction prevents the runtime-externalization allowlist from being
mistaken for the legal redistribution inventory.
Externalizing `ink` from the npx artifact is prohibited while this patch is required, because a
fresh npm install would otherwise replace the tested renderer with the unpatched upstream package.

This amendment adds no dependency, install script, native code, network behavior, public interface,
or security claim. The patch is release code and must pass the same exact-pin, lockfile, package,
unit and cross-platform package CI gates as Ink itself, plus the candidate-bound local real-PTY gate
recorded by Epic 3.10 (the generic CI PTY placeholder remains disabled and is not claimed green).
Remove it only when a reviewed upstream
version passes Epic 3.10's physical-row, burst-resize, Static-during-resize, failure, cancellation,
unmount, screen-reader, alternate-screen, and real-PTY regressions without weakening their oracle.
