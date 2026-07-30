# ADR-0082 — Process-specific npx entrypoints

**Status:** Accepted for Epic 3.10 Slice 10C by delegated owner decision on 2026-07-24.

**Date:** 2026-07-24

**Amends:** ADR-0040 and ADR-0071

**Relates to:** ADR-0009, Epic 3.10 Slice 10B's packaged-product protocol, and the
ADR-0040 standalone-binary release hold.

## Context

The release-eligible npx package currently exposes one 2.90 MB generated entrypoint. Before that
entrypoint can execute its early-paint statement, Node parses a bundle containing the complete
Kernel, Ink/provider stack, Warden enforcement host, and vendored sandbox runtime. The Kernel then
spawns the same entrypoint in hidden-Warden mode, so both long-lived processes load the same
monolith.

The immutable Slice 10B product protocol measured the consequence on the exact installed carrier:
first-paint p95 is 713.893 ms against `<200 ms`, governed acknowledgement p95 is 1,793.968 ms against
`<750 ms`, and aggregate Kernel+Warden RSS peaks at 414,810,112 bytes against `<150,000,000`.
Lifecycle stability itself is sound: idle bytes/CPU, process and FD identity, public exit, and
product/fixture cleanup all pass. The failure is therefore a release packaging/load-boundary
problem before it is a renderer-behavior problem.

ADR-0040 defines the public npx command and the separate compiled-binary carrier, but does not
require one generated JavaScript file. ADR-0071 explicitly records the Warden host import and
self-dispatch as packaging residuals. The npx carrier can remove those residuals without changing
the RPC seam; the compiled binary still needs its current self-dispatch because it is one file.

## Options considered

1. **Keep one bundle and tune the TUI.** Rejected. It cannot make Node parse less enforcement and
   sandbox code before the first product statement, and it would distort product behavior to chase
   a packaging measurement.
2. **Use Bun code splitting with shared chunks.** Rejected for this slice. It makes the installed
   runtime graph and entry ownership less explicit, risks eager shared-chunk loading, and couples
   Kernel/Warden startup to bundler chunk naming.
3. **Lazy-import the Warden inside the same public bundle.** Rejected. The Warden bytes remain in the
   public process artifact, self-dispatch remains implicit, and bundler reachability can still pull
   those bytes into the Kernel path.
4. **Ship process-specific npx entries behind the unchanged public command.** Chosen. It creates an
   explicit release boundary while leaving source, dist, and compiled-binary behavior intact.

## Decision

### 1. Preserve the public command; split the private installed entries

The generated npm manifest continues to expose exactly `keel: ./bin/keel.mjs`. That file becomes a
small, reviewed launcher which:

- maps `NO_COLOR` before renderer code can load;
- applies the existing interactive-flag predicate;
- writes the same `keel · starting` bootstrap paint and installs the same one-shot clear callback;
- imports the private sibling `./keel-kernel.mjs`.

The package also carries two non-public sibling files:

- `keel-kernel.mjs`, built from the Kernel CLI entry and containing no Warden host or vendored SRT
  runtime; and
- `keel-warden.mjs`, built from a packaging-owned Warden entry which installs the bundled vendored
  SRT runtime and then starts the existing Warden bin entry.

The public npm `bin` map, CLI arguments, stdout/stderr grammar, provider behavior, and package name
do not change. The private entries are implementation details and are not additional commands.

### 2. Make process selection explicit and fail closed

Source mode continues to spawn the absolute source Warden entry with the resolved `tsx` loader.
Dist mode continues to spawn the absolute built Warden entry. A packaged `keel-kernel.mjs` resolves
only its exact `keel-warden.mjs` sibling and launches it with `process.execPath`; it never consults
`PATH`, an environment-selected script, or a project-relative path. If the sibling is absent, the
packaged Kernel fails closed instead of re-executing itself in a mode it no longer contains.

The standalone `bun --compile` carrier keeps the existing hidden-Warden self-dispatch. Its
packaging entry, rather than Kernel `bin.ts`, owns that dispatch and bundled-SRT installation. This
carrier remains non-release-eligible under ADR-0040; preserving it is compatibility and evaluation
proof, not publication authorization.

Unknown Node bundle shapes with neither a source/dist Warden nor the exact packaged sibling fail
closed. They do not silently reuse the compiled-binary fallback.

### 3. Keep graphs and redistribution evidence complete

Kernel and Warden are separate Bun builds, not shared-chunk outputs. The generated component and
license inventory is derived from the union of both exact metafile input graphs, so splitting cannot
erase a byte-contributing dependency from redistribution evidence. Builder-path, forbidden-loader,
reviewed-runtime, shebang, component, package-tree, and repeatability checks bind all three installed
entries. The product observer records their individual identities as well as the full installed-tree
digest.

### 4. Prove compatibility before measuring improvement

Behavior starts red-first. Tests must prove:

- the public launcher is small, paints before its Kernel import, and preserves all supported
  interactive spellings and `NO_COLOR` ordering;
- Kernel and Warden bundle marker sets are disjoint at the intended host boundary;
- exact-sibling selection, missing-sibling failure, source/dist selection, and compiled self-dispatch;
- unchanged version, doctor, replay, interactive fixture, Warden hello/execute/resolve/shutdown,
  native compiled-Warden, and package install behavior;
- no producer/model/audit/session/eval, frozen RPC, authority, or security-claim change.

Only after structural and behavior gates pass may the same reduced and normative Slice 10B protocol
measure the candidate. A lower number is evidence, not permission to alter a budget. A remaining
failure remains a product failure and triggers a new bounded root-cause decision; it does not justify
TUI degradation or threshold relaxation.

## Consequences

- First paint no longer waits for Kernel, Warden, or sandbox parsing. The Kernel and Warden load only
  the code needed by their process, subject to the documented ADR-0071 grant/proxy residuals.
- `runWardenFromEnv` is removed from Kernel `bin.ts`; the compiled packaging entry owns the one-file
  exception. This narrows ADR-0071's production import allowlist without claiming the grant/proxy
  decoupling is complete.
- The npx package contains more files and may duplicate small shared modules on disk. Disk size is a
  secondary trade-off to process isolation, startup latency, and explicit reviewability.
- No new dependency, public CLI/frozen protocol/durable-format change, authority change, or security
  claim is introduced. No ADR-0040 budget or binary-publication decision is changed.
- The split is expected to improve startup and aggregate RSS but does not assert that the existing
  budgets will pass. Normative evidence decides that question.
