# ADR-0004 policy-engine spike — opa-wasm (measured)

An **isolated** spike (its own `package.json` + `node_modules`, **not** part of the pnpm workspace, so it
never touches the root lockfile or a concurrent session). It measures the two decisive axes for keel's
**actual** policy needs: (1) the WASM **built-in gap** and (2) **eval latency p50/p99** against the
`< 5 ms` budget. It feeds **ADR-0004**.

## What it measures, and why

- **Built-in gap (the dominant opa-wasm risk per the research):** OPA's WASM target does not compile every
  Rego built-in; missing ones must be supplied as JS host callbacks, and a *missing* one is a **hard throw
  at eval**. `bench.mjs` discovers the host-callback set empirically — it evaluates, catches the SDK's
  `not implemented: built-in function …` throw, stubs that builtin, and reloads until eval succeeds. The
  accumulated set IS the gap for keel's pack.
- **Latency:** instantiate once (OPA's prescribed reuse pattern), warm up, then time 20,000 evals over
  varied `PolicyInput` documents; report p50/p95/p99/p99.9/max.
- The pack (`keel-default.rego`) is **representative, not final** — it deliberately exercises the built-ins
  a real keel pack needs (`sprintf`, `startswith`, `glob.match`, `count`, `in`/set-iteration) so the gap is
  observable. `glob.match` is the canary the research flagged as only partially WASM-supported.

## Reproduce

```bash
# from this directory. OPA is PINNED to v1.17.1 (the measured version) for reproducibility.
# macOS arm64 shown; for Linux CI (the bun --compile smoke-test home) use opa_linux_amd64_static.
OPA_VER=v1.17.1
OPA_SHA256=9d43153a802b5befd3f1c4f76b301d135aaf8e2153a4de921a9426e0ccc00eb8
curl -fsSL -o opa "https://github.com/open-policy-agent/opa/releases/download/$OPA_VER/opa_darwin_arm64_static"
printf "%s  opa\n" "$OPA_SHA256" | shasum -a 256 -c -
chmod +x opa
npm ci --ignore-scripts
./opa build -t wasm -e keel/default/verdict -e keel/default/explain -o bundle.tar.gz keel-default.rego
tar -xzf bundle.tar.gz /policy.wasm             # extract only policy.wasm; whole-bundle extraction overwrites keel-default.rego
PATH="$PWD:$PATH" node bench.mjs                 # PATH so the harness can read `opa version`
```

## Results (2026-06-23, Apple Silicon arm64) — see `results.json`

| Axis | Measured | Verdict |
|---|---|---|
| **Host-callback built-ins required** | **`[]` (none)** — `startswith`, `glob.match`, `count`, set-ops all compiled into WASM | The feared gap does NOT bite keel's rule shapes |
| **p99 eval latency** | **0.093 ms** (p50 0.012 / p95 0.025 / p99.9 0.283 / max 3.647) | ✅ ~54× under the 5 ms p99 budget |
| instantiate (one-time) | 20.2 ms | one-time at warden start; off the hot path |
| compiled `policy.wasm` | 346 KB | + ~950 KB SDK runtime (unpacked) |
| node / opa / sdk | v20.14.0 / 1.17.1 / opa-wasm 1.10.0 | — |

### The one measured caveat — `sprintf` host-divergence

`sprintf` IS provided by the SDK (via `sprintf-js`), but **`sprintf-js` is not Go-`fmt`-compatible**: a
pack using Rego's idiomatic `%q` or `%v` verbs **throws** `[sprintf] unexpected placeholder` under
opa-wasm, while native `opa eval` accepts them. This is the host-callback *semantic-divergence* risk made
concrete. **Mitigation:** lint packs to portable verbs (`%s`/`%d`), or register a Go-`fmt`-compatible
custom `sprintf` builtin in the warden's loader. (The pack here was switched to `%s` to proceed.)

### `bun --compile` standalone-binary embedding — RUN + PASSED (2026-06-23; Gate R2)

The one hard requirement common to BOTH engines (ADR-0009). **PASS** on macOS arm64, bun 1.3.14:
`smoke.ts` embeds `policy.wasm` via `import wasmPath from './policy.wasm' with { type: 'file' }`, loads it
with `loadPolicy(bytes)`, and evaluates two inputs; the compiled binary — **copied to `/tmp` and run with
NO sibling `.wasm`** — returned the correct verdicts (secret read → `deny`, benign read → `allow`).

```bash
# after the Reproduce steps above (opa + policy.wasm + npm ci):
PATH="$HOME/.bun/bin:$PATH" bun build ./smoke.ts --compile --outfile smoke-bin
cp smoke-bin /tmp/ && (cd /tmp && ./smoke-bin)   # SMOKE_OK from a dir with no policy.wasm
```

### NOT run here (honest scope)

- **regorus measurement** — per the approved "front-runner measured" scope, regorus was researched (no npm
  package; Rust+wasm-pack self-build; `bun --compile` risk) but not built/benchmarked here. It is the
  documented fallback.
