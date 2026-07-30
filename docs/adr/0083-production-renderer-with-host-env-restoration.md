# ADR-0083 — Production-mode renderer via launcher `NODE_ENV`, with host-env restoration at the warden spawn boundary

**Status:** Accepted for Epic 3.11 by owner direction on 2026-07-27 after exact-head CI.

**Date:** 2026-07-27

**Amends:** ADR-0082 (adds a fifth enumerated responsibility to the npx launcher).

**Relates to:** ADR-0071 (kernel/warden decoupling — the warden child-env seam), ADR-0038 / SEC-012
(trust-before-parse and env handling), and Epic 3.10's packaged-product RSS budget
(`<150,000,000` bytes) plus its open residual P1-007.

> This ADR was revised after a five-lens independent adversarial review. The review corrected two
> material errors in the first draft: (1) the restoration chokepoint was one call too low
> (`childEnvFor`) and was silently defeated by the warden spawn's `{ ...process.env, ...options.env }`
> merge; (2) the motivating "leak into `npm install`" threat does **not** occur on the default
> governed-bash path, which is already env-allowlisted. Both are fixed below, and the rationale is
> re-stated honestly. Exact-carrier testing then found a third issue before shipment: Bun 1.3.14
> emitted development-only `jsxDEV` call sites that are incompatible with external production
> React. The owner authorized the narrow npx-only production-JSX compatibility slice recorded below.
> The corrected and scope-amended verification set is summarized below.

## Context

The packaged npx release carrier renders its TUI with React (via Ink). **React, `react-reconciler`, and
`scheduler` are declared as external runtime dependencies** of the npx carrier (installed by npm on
the user's machine — see `build/npx/package.json` and `packaging/dependencies.ts`, which keeps
React external "so application code and the bundled Ink reconciler share one runtime instance").
**Ink itself is bundled** (its reviewed patched source is compiled into `keel-kernel.mjs`), but Ink
delegates rendering to the external `react-reconciler`/`react`, so the dev-vs-production decision
still lives in external packages. Because those packages are external, **their
development-vs-production build is selected at the user's runtime from `process.env.NODE_ENV`**,
inside each package's entry (`react/index.js`, `react/jsx-dev-runtime`, `react-reconciler/index.js`,
`scheduler/index.js` all do `process.env.NODE_ENV === "production" ? require(".../*.production.js") :
require(".../*.development.js")`), not at keel's build time.

keel never sets `NODE_ENV`. The launcher (`keel.mjs`, ADR-0082) starts the kernel with whatever
`NODE_ENV` the user's shell carries, which for `npx keel-harness` is almost always **unset**. The
packaged-product measurement harness confirms this structurally: it builds the product environment
from an allowlist (`SAFE_ENVIRONMENT_KEYS = LANG, LC_ALL, LOGNAME, PATH, SHELL, TMPDIR, USER`) that
**excludes `NODE_ENV`**, as pinned by the public launcher tests.
So the product — and the 417 MB Epic 3.10 lifecycle gate — runs React in **development** mode, and
so does every ordinary end user.

Development-mode React is materially heavier. On the real built Ink `App` driven through the
registered 200-turn × 12-append streaming workload (single kernel process, component level), and
independently reproduced by the review on the real React 19.2.7 + Ink 7.0.5 stack, the observed
peak RSS is:

| React runtime mode | peak RSS (render path) | final heapUsed |
|---|---:|---:|
| development (ships today) | ~200–306 MB | ~63 MB |
| production | ~112–193 MB | ~20 MB |

The delta is roughly **40–110 MB of peak** and a ~3× smaller retained heap, entirely from React's
dev-only validation/warning paths. This is not a leak (final live set is ~20 MB in both modes); it
is dev-mode allocation the production build removes. Shipping a development build of the UI
framework in a release artifact is also an execution-quality and credibility issue for a project
held to the AGENTS.md bar, independent of the megabytes.

Three constraints make this non-trivial:

1. **Where `NODE_ENV` must be set.** The kernel CLI entry (`packages/kernel/src/cli/bin.ts`) reaches
   Ink/React through a **static** import chain (`session-entry.ts:30` → `../tui/ink/ink-ui.js` →
   Ink → `react-reconciler` → `react`). ES-module static imports are evaluated before any entry
   *body* code runs, and React latches its mode when its module first evaluates. Empirically,
   forcing `NODE_ENV=production` only while React initializes and then restoring it recovers just
   ~25% of the benefit, because `react-reconciler` and Ink re-read `NODE_ENV` at render time as well.
   Therefore `NODE_ENV=production` must be set **before the kernel module graph loads** and **remain
   set for the kernel process lifetime**. The only pre-load hook on the release path is the launcher
   (`keel.mjs`), which already performs pre-renderer env mapping (`NO_COLOR`) before
   `await import("./keel-kernel.mjs")` under ADR-0082. (This static import chain loads on **every**
   invocation, including `keel version`/`doctor` and headless one-shot runs; forcing production is
   inert there because React is imported but never rendered, and no keel code reads `NODE_ENV` — see
   §Consequences.)

2. **Why a process-wide set must not leak to child processes.** Setting `NODE_ENV=production`
   process-wide in the kernel would, absent care, propagate into processes keel spawns for the user.
   The exposure is **narrower than the first draft claimed**, and enumerating it precisely is the
   heart of this decision:
   - **Governed `bash` (the primary path) is NOT exposed.** The warden runs user shell commands
     through the SRT sandbox, whose runner re-curates the command env to an allowlist
     (`packages/warden/src/srt-sandbox.ts` `SANDBOX_ENV_ALLOWLIST` = HOME, LANG, LOGNAME, PATH,
     SANDBOX_RUNTIME, SHELL, TEMP, TERM, TMP, TMPDIR, USER, + `LC_*`) that **excludes `NODE_ENV`**.
     So governed bash never sees `NODE_ENV`, with or without this change. The first draft's
     "`npm install` would skip `devDependencies`" example was **wrong for this path** and is
     withdrawn.
   - **The warden process itself IS exposed.** The kernel spawns the warden with
     `env: { ...process.env, ...options.env }` (`packages/kernel/src/warden/client.ts:389`). A
     process-wide `NODE_ENV=production` therefore runs the warden in production and, more importantly,
     leaks into the **non-allowlisted** processes the warden spawns directly:
     - **credential-proxy secret-source commands** — `spawnSync(command, args, {...})` with no `env`
       (`packages/warden/src/credential-proxy.ts:235`) → full inherit of the warden's env;
     - **warden-side MCP stdio servers** — receive `payload.server.envKeys` copied from the warden's
       env (`packages/warden/src/mcp/local-stdio.ts:396-403`); a user server that lists `NODE_ENV`
       in `envKeys` would receive the warden's value.
   - **The external editor IS exposed.** `spawn($EDITOR, [file], { shell: true, stdio: "inherit" })`
     (`packages/kernel/src/tui/editor.ts:53`) passes no `env` → full inherit of the kernel's env.
   - **Harness-internal spawns are `NODE_ENV`-agnostic.** `search`/ripgrep and the Python syntax
     check use `minimalChildEnv` (no `NODE_ENV`); the `bash` PTY session uses an explicit
     `{ PATH, LC_ALL, LANG }`; `git status` (`git-status.ts:54`) and the `python3 --version` probe
   (`code-check.ts:138`) inherit the kernel env but run fixed argv that ignores `NODE_ENV`.

3. **The bundled Kernel call sites must match the external React runtime ABI.** The first exact
   candidate correctly selected production React at runtime, but every packaged startup sample then
   exited with `jsxDEV5 is not a function`. The generated `keel-kernel.mjs` still imported
   `react/jsx-dev-runtime` and called `jsxDEV`; React's production JSX runtime does not export that
   development helper. Bun 1.3.14 ignored an explicit `Bun.build({ jsx: { development: false } })`
   probe. Starting Bun in production mode or defining `process.env.NODE_ENV` did select production
   JSX, but also replaced runtime environment reads in bundled code and still could not select the
   external React/reconciler/scheduler CJS builds. Therefore launcher selection remains necessary,
   and the npx Kernel's own TSX call sites need a separate, narrowly scoped production JSX lowering.

## Decision

Force the renderer into production mode at the launcher, and **restore the host's original
`NODE_ENV` at every process boundary that reaches user-affecting code**, applying the restore at the
actual **spawn env** (not merely where the env object is first built). Concretely:

### 1. Launcher forces production and captures the host value (npx carrier only)

In `packaging/npx-cli-entry.js`, before `await import("./keel-kernel.mjs")` and after the existing
`NO_COLOR` mapping (this is the **fifth** launcher responsibility, amending ADR-0082 §Decision.1):

- record whether the host had `NODE_ENV` set and its value into two internal sentinel variables:
  - `KEEL_HOST_NODE_ENV_MANAGED = "1"` (always — marks that the launcher owns `NODE_ENV`);
  - `KEEL_HOST_NODE_ENV = <original value>` **only if** the host had `NODE_ENV` set (absence encodes
    "host had it unset");
- then set `process.env.NODE_ENV = "production"`.

This is the same class of pre-renderer env mapping ADR-0082 already blesses for `NO_COLOR`. The
launcher (currently 910 bytes) stays well within its ADR-0082 4096-byte budget. The public `bin`
map, CLI grammar, stdout/stderr grammar, provider behavior, and package name are unchanged.

### 1a. Production-lower Kernel TSX call sites for the npx bundle only

Before Bun bundles the npx Kernel, `packaging/production-jsx.ts` uses the repository's existing
exact-pinned TypeScript 5.9.3 compiler to lower only Kernel `.tsx` inputs with `jsx: ReactJSX`. Bun
continues to bundle the resulting JavaScript. The transform is attached only to `NPX_KERNEL_ENTRY`:
the Warden and standalone-binary builds do not receive it. It does not bundle or select React, and it
does not define or replace `process.env.NODE_ENV`; the launcher remains the mechanism that selects
the external production runtime on the user's machine.

The build fails closed unless at least one Kernel TSX input was transformed, rejects any non-Kernel
TSX input reaching the scoped plugin, and rejects a completed Kernel artifact containing either
`react/jsx-dev-runtime` or a `jsxDEV*(` call. It also requires the production
`react/jsx-runtime` marker. CI then packs and installs the carrier and boots the real TUI through the
registered Epic 3.10 PTY startup observer, so a syntactically plausible but runtime-incompatible
artifact cannot pass on static inspection alone.

### 2. A single pure helper restores the host `NODE_ENV` and strips the sentinels

Add `restoreHostNodeEnv(env)` beside the existing `minimalChildEnv`
(`packages/kernel/src/tools/child-env.ts`):

- if `env.KEEL_HOST_NODE_ENV_MANAGED !== "1"` → return `env` unchanged (the launcher did not manage
  `NODE_ENV`; the dev/tsx and standalone-binary paths are untouched — the whole change is a no-op
  there);
- otherwise return a **new object** with both sentinels removed and `NODE_ENV` restored to
  `KEEL_HOST_NODE_ENV`, or with `NODE_ENV` **absent** when that sentinel is absent (faithfully
  reproducing "host had it unset"). The helper produces the exact key set for a child — it does not
  rely on deletion semantics surviving a later spread (see §3).

The helper is pure, total, and unit-testable, mirroring `minimalChildEnv`. Precedence rule: the
restored value is always the launcher-captured **host** value; a caller-supplied `start.env.NODE_ENV`
does not override it (no production caller sets one today, but the rule is explicit).

### 3. Apply the restore at the actual spawn env of every exposed boundary

The first draft applied the restore inside `childEnvFor` and asserted "everything the warden spawns
inherits automatically." That is **false**: the warden is spawned by `startWardenClient`
(`packages/kernel/src/warden/client.ts:387-390`) with `env: { ...process.env, ...options.env }`,
which re-spreads the kernel's (production, sentinel-bearing) `process.env` **underneath** the
`childEnvFor` output — so any key `childEnvFor` merely omitted/deleted falls through to
`process.env`. The corrected chokepoints are the **spawn calls themselves**:

- **Warden spawn** (`client.ts:387-390`) — the primary chokepoint. Spawn with
  `env: restoreHostNodeEnv({ ...process.env, ...options.env })` (equivalently, stop re-spreading
  `process.env` and spawn the fully-built env). This makes the **warden process's own env** carry the
  host `NODE_ENV` and no sentinels, so everything the warden then spawns (governed bash — already
  allowlisted; credential-proxy commands; warden-side MCP servers) inherits the correct value.
- **MCP-discovery warden spawn** (`discoverProductionMcpServer`, `runtime.ts:686-691`) — this site
  spawns with `env: childEnv` **directly** (no `process.env` re-spread), so applying
  `restoreHostNodeEnv` to the built `childEnv` **is** sufficient here. (Note and comment the
  asymmetry with the main warden spawn so a maintainer does not "simplify" one into the other.)
- **External editor spawn** (`packages/kernel/src/tui/editor.ts:53`) — add an explicit
  `env: restoreHostNodeEnv(process.env)` (the call currently passes no `env`).

`childEnvFor` may still apply the restore to its own output for defensiveness, but the **binding**
guarantee lives at the spawn boundary. Harness-internal spawns on `minimalChildEnv` (search, Python
syntax check) and the `bash` PTY's explicit env need no change (no `NODE_ENV`, no sentinels).
`git status` and the `python3 --version` probe inherit the kernel env but run `NODE_ENV`-agnostic
fixed argv; they are documented as such rather than routed (a blanket "no raw `process.env` spawn"
lint would false-positive on them, so any such guard must carry an explicit internal-spawn
allowlist).

### 4. Scope: npx release carrier only

The dev (`tsx`) path and the standalone `bun --compile` binary are **out of scope**. The dev path is
not shipped. The binary builds from `packaging/cli-entry.js` (not the launcher), never sets
`NODE_ENV`, and self-dispatches kernel+warden in one process (ADR-0082) with no separate warden to
carry the host value; forcing production there would require a different isolation design and it
remains non-release-eligible under ADR-0040. The `KEEL_HOST_NODE_ENV_MANAGED` gate makes
`restoreHostNodeEnv` a strict no-op on both paths, so their behavior is unchanged.

## Consequences

- The packaged npx release carrier renders React in production mode. The packaged-product harness (which
  does not set `NODE_ENV`) will observe the lower peak RSS without any harness change; the Epic 3.10
  lifecycle RSS number is expected to drop by roughly the measured 40–110 MB. **A lower number is
  evidence, not permission to relax the `<150,000,000` budget** (ADR-0082 §4). The budget and issue
  P1-007 stay as they are until real packaged evidence is recorded.
- The warden process and every user-affecting child (credential-proxy commands, warden-side MCP
  servers, the editor) run with the host's exact original `NODE_ENV` (set, unset, or explicitly
  `development`), and the internal sentinels never reach them — **provided the restore is applied at
  the spawn boundary per §3**. Governed bash was never exposed (SRT allowlist).
- **This is not a net reduction in trust-boundary leakage.** Today keel sets no `NODE_ENV`, so those
  child processes carry none. This change introduces `NODE_ENV=production` plus two sentinels into the
  kernel process and must then claw them back for children; the best achievable outcome is **parity**
  with today's env exposure for user-affecting spawns (plus the honest note that `NODE_ENV`-agnostic
  internal spawns such as `git status` will carry the two new sentinels unless also curated). The
  legitimate rationale is the **RSS/heap win and not shipping a development build of the UI
  framework**, not a security improvement.
- Forcing `NODE_ENV=production` in the kernel weakens **no** security-relevant behavior. A review
  grep found **zero** reads of `process.env.NODE_ENV` in `packages/{kernel,warden,shared}` or
  `vendor/sandbox-runtime` (only external React/Ink/reconciler/scheduler consume it). Runtime deps
  were checked: `zod` has no `NODE_ENV` branch (validation is unconditional); the `ai` SDK's only
  `NODE_ENV` branch is cosmetic error-message verbosity (`wrapGatewayError`). No redaction, policy,
  audit, sandbox, or enforcement path is `NODE_ENV`-gated.
- No frozen RPC/schema/audit-format/CLI-contract change. No authority or enforcement change. No new
  dependency. No supply-chain change (React/reconciler/scheduler stay external, Ink stays bundled —
  this is deliberately the alternative to bundling the React stack). TypeScript 5.9.3 was already
  exact-pinned and is already an npx runtime dependency for Keel's syntax checker; using it in the
  build adds no package or version. The two `KEEL_HOST_*` sentinels are new **internal** env
  conventions, in the same class as the existing `INTERNAL_WARDEN_STDIO_ENV` /
  `INTERNAL_MCP_DISCOVERY_ENV`, not a frozen contract.

## Options considered

1. **Do nothing; keep dev-mode React.** Rejected as the final state. 417 MB is tolerable on a 16 GB
   laptop but bites in CI (7 GB shared runners), containers with cgroup limits (OOM-kill risk on a
   governed harness), and concurrent sessions; and shipping a dev UI build is an avoidable
   credibility snag. It should at minimum become a documented, owned decision (P1-007).
2. **Build-time `define: process.env.NODE_ENV = "production"`.** Rejected as the product mechanism.
   It cannot select external React/reconciler/scheduler on the user's machine. Under Bun 1.3.14 it
   can also affect JSX lowering, but does so by replacing runtime environment reads throughout the
   bundled graph. The chosen scoped TypeScript transform solves only the call-site ABI while leaving
   external runtime selection to the launcher.
3. **Force production only during React import, then restore process-wide.** Rejected — recovers only
   ~25% (react-reconciler/Ink re-read `NODE_ENV` at render), and is fragile against import ordering.
4. **Bundle the React stack (react + react-reconciler + scheduler) in production mode,
   non-external.** Viable and leak-free (no env games at all), but reverses keel's deliberate,
   enforced "React external" invariant, is a supply-chain change (moves security-patch cadence to
   keel releases), and is higher-ceremony. Held as the fallback if the §3 spawn-boundary approach
   proves insufficient.
5. **Launcher-forced production + host-env restoration at the spawn boundary (chosen).** Captures the
   full RSS win with zero supply-chain change, routes through existing tested seams
   (`childEnvFor`/`minimalChildEnv`'s module, `startWardenClient`), and is verifiable end to end.
   Its real risk is completeness of the spawn-boundary application, which is finite and testable
   (see the verification summary below).

Heap-flag tuning (`--max-semi-space-size` / `--max-old-space-size`) is explicitly **not** part of
this decision: the safe-only semi-space flag is modest and its delivery would re-exec inside the
ADR-0082 paint-first launcher, and an old-space cap introduces an OOM tail-risk in exactly the
constrained environments this work is meant to protect. It is deferred to a separate decision if
field evidence ever warrants it.

## Verification summary

- Unit: `restoreHostNodeEnv` across the three host states (unset → `NODE_ENV` absent; `development` →
  `development`; `production` → `production`), sentinels always stripped, output is a fresh object.
- **Integration (the load-bearing security test):** spawn a **real** warden through
  `startWardenClient` with `process.env.NODE_ENV="production"`, `KEEL_HOST_NODE_ENV_MANAGED="1"`, and
  each host case; assert the **warden process's own env** carries the host `NODE_ENV` (or none) and
  **neither sentinel**. This test fails today at `client.ts:389` and forces the fix to the spawn
  boundary. A governed-bash env probe is **not** a valid substitute (the SRT allowlist masks it).
- Integration: a credential-proxy source command and the editor spawn observe the host `NODE_ENV`
  and no sentinels.
- **Renderer mode (proves the actual win, not a side effect):** in a child with
  `NODE_ENV=production`, importing the external React the carrier resolves loads
  `react/cjs/react.production.js` (not `*.development.js`); a `NODE_ENV`-unset negative control loads
  the development build.
- Build/tooling: TypeScript production-lowers representative TSX without replacing a runtime
  `process.env.NODE_ENV` expression; malformed TSX fails closed; the finished Kernel bundle rejects
  every development JSX runtime/call marker and requires `react/jsx-runtime`.
- Installed product: pack and install the carrier, then boot its real TUI through the Epic 3.10 PTY
  startup observer to governed readiness, render the input probe, and exit cleanly.
- Launcher: a static assertion that production is set after `NO_COLOR` and before the kernel import
  within the 4096-byte budget, plus a subprocess run against a stub `keel-kernel.mjs` proving the
  set/capture happen before the kernel graph loads.
- Product: re-run the exact Epic 3.10 packaged-product startup + 200-turn lifecycle protocol on the
  rebuilt carrier and record the before/after RSS as honest evidence against the unchanged budget.
