# 0004 — Policy engine: regorus-js vs opa-wasm

**Status:** **Accepted** — `@open-policy-agent/opa-wasm` (regorus is the documented fallback). The spike is
DONE (2026-06-22; rebuilt 2026-06-23) **and the gating `bun --compile` standalone-binary smoke test PASSED
(2026-06-23) — Gate R2 cleared.** Supersedes the original "spike pending" status.
**Date:** 2026-06-11 (original) · 2026-06-22 (spike + decision) · 2026-06-23 (QC rebuild).
**Relates to:** ADR-0024 (the policy input it evaluates), ADR-0056 (capability manifest — generates the
pack), ADR-0009 (`bun --compile` packaging — the hard constraint), ADR-0005 (`SandboxPort` — the
independent backstop), MASTER_SPEC §7 Epic 2.4 (the policy gate this blocks), Appendix D.
**Spike:** `docs/research/policy-engine-spike/` (reproducible harness + `results.json`).

## Context

The warden evaluates Rego policy documents to produce per-tool-call verdicts
(allow/deny/modify/review/warn). The engine must (a) embed in a Node.js process, (b) cover the Rego
built-ins keel's packs need (Appendix D), (c) deliver **p99 < 5 ms** on representative inputs (not the
tool-dispatch bottleneck), (d) survive **`bun --compile`** into a single-file standalone binary
(ADR-0009), and (e) clear the **permissive-license** gate. Candidates: **regorus** (Rust Rego
interpreter + a WASM binding) and **`@open-policy-agent/opa-wasm`** (OPA's official WASM build).

## Options (research + measured spike)

Both clear the **license gate** (verified): regorus is MIT/Apache-2.0/BSD-3 (the WASM binding crate);
opa-wasm is Apache-2.0 (CNCF graduated). A custom evaluator is out of scope (Rego is a Datalog variant
with a large stdlib). The real differentiators, with the spike evidence:

| Criterion | **opa-wasm** (MEASURED, keel pack) | **regorus** (researched only) |
|---|---|---|
| npm availability | ✅ `@open-policy-agent/opa-wasm@1.10.0` | ❌ **no npm package** — self-build via Rust + `wasm-pack` |
| Built-in coverage for keel's pack | ✅ **`[]` host callbacks needed** — `startswith`/`glob.match`/`count`/set-ops all compiled into WASM | from-scratch Rust impl; `crypto.*`/`jwt`/`jsonpatch` unsupported *by design* (keel's pack needs none) |
| p99 eval latency | ✅ **0.093 ms** (p50 0.012, max 3.647) — ~54× under the 5 ms p99 budget | only a native (non-WASM) single-policy ~4.6 ms self-benchmark; WASM/JS p99 unmeasured |
| instantiate (one-time) | 20.2 ms | unmeasured |
| `policy.wasm` size | 346 KB (+ ~950 KB SDK) | unmeasured (no published size) |
| `bun --compile` | ✅ **PASS (2026-06-23)** — `policy.wasm` embedded via `import … with { type: "file" }`, loaded with `loadPolicy(bytes)`, evaluated correctly from a binary run in `/tmp` with NO sibling `.wasm` | ⚠️ **HIGH risk** — stock `--target nodejs` loads `.wasm` by sibling path (Bun issue 6567 failure shape) |
| CI build dependency | needs the **Go `opa` CLI** to compile packs to WASM | needs **Rust + wasm-pack** to build the binding |
| maintenance / backing | CNCF graduated; low release velocity (last release 2024-11); tiny clean dep tree | Microsoft; active; pre-1.0; small/bus-factor |
| measured caveat | ⚠️ `sprintf` host-impl (`sprintf-js`) is **not Go-`fmt`-compatible** — `%q`/`%v` throw | crypto-by-omission (irrelevant to keel's pack) |

## Decision

**Adopt `@open-policy-agent/opa-wasm`** — the gating `bun --compile` smoke test has now **PASSED** — with
**regorus as the documented fallback**. Rationale, grounded in the measured spike:

1. **It clears the two axes the original ADR named as the deciders** — built-in coverage (zero host
   callbacks needed for keel's representative pack; the feared WASM gap does not bite keel's rule shapes)
   and **p99 = 93 µs**, ~54× under the 5 ms p99 budget. These were *measured*, not assumed.
2. **It is the lower-risk supply-chain path today:** npm-published, Apache-2.0, CNCF-graduated, a 3-package
   dep tree with a clean advisory record — versus regorus's *no-npm, self-build-the-WASM-binding* reality,
   which puts keel on the hook for a Rust+wasm-pack publish pipeline with no Dependabot coverage.
3. **The Rego source stays engine-agnostic behind `PolicyPort`** (unchanged), so the fallback to regorus
   is a contained swap if a gate below flips.

**The gating smoke test — PASSED (2026-06-23, macOS arm64, bun 1.3.14):** `policy.wasm` (354 KB) loads and
evaluates **inside a `bun --compile` standalone binary** (the ADR-0009 hard constraint). The harness
(`docs/research/policy-engine-spike/smoke.ts`) embeds the wasm via `import … with { type: "file" }`, loads
it with `loadPolicy(bytes)`, and evaluates two inputs; the **compiled binary, copied to `/tmp` and run with
no sibling `.wasm`**, returned the correct verdicts (secret read → `deny`, benign read → `allow`). This was
the one remaining hard requirement; opa-wasm's raw-bytes `loadPolicy` API made embedding clean. (Node SEA
`sea.getAsset` remains an alternative embed path if a future build targets Node instead of Bun.)

**Two recorded mitigations:**
- **`sprintf` divergence** (measured): the SDK's `sprintf-js` host-impl rejects Go verbs (`%q`/`%v`).
  Mitigate by (a) a pack lint forbidding non-portable verbs, and/or (b) registering a Go-`fmt`-compatible
  custom `sprintf` builtin in the warden's loader. Tracked as a policy-author guardrail.
- **Go `opa` CLI build-dependency:** CI obtains the static `opa` binary (download / `go install` / Docker
  `openpolicyagent/opa`) to compile packs to WASM. Self-contained (no extra C toolchain); pinned + hashed.

## Consequences

- **Unblocks Epic 2.4** with a measured engine choice; `PolicyPort` + Rego source remain the swap seam.
- **CI gains a Go build-time dependency** (the `opa` compiler) and a **`bun --compile` policy-eval smoke
  test** as a gating job. Packs are compiled to WASM in CI, hash-pinned (SEC-019), and shipped as the
  artifact the warden loads; the `.rego` source is authoritative.
- **`sprintf` guardrail** lands with the policy pack (lint or custom builtin).
- **Honest scope:** the `bun --compile` embedding test is now **run and passing** (reproducible via
  `smoke.ts`); the regorus head-to-head remains unmeasured (regorus is the documented fallback, not the
  chosen engine). The "works in the binary" claim is now backed by an executable test, not asserted.

## What would change the decision

- ~~opa-wasm **fails the `bun --compile` smoke test**~~ — **RESOLVED: it PASSED (2026-06-23).** Only a
  future regression in the embed path (or a Bun change) would re-open this; the smoke test guards it.
- A future keel pack needs a built-in opa-wasm leaves as an *unprovided* host callback (e.g. `time.*`,
  `crypto.*`) that is painful to supply → re-evaluate (regorus has many compiled-in; or supply the callback).
- The Go `opa` CLI build-dependency proves unacceptable for the hermetic/air-gapped build story → regorus
  (pure Rust/WASM, no Go) becomes more attractive despite the no-npm cost.
