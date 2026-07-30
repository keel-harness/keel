/* global console, process, URL */
// ADR-0004 opa-wasm measured spike harness.
// Measures (1) the WASM built-in GAP for keel's representative pack — which built-ins the host must
// supply as JS callbacks (a missing one is a HARD THROW at eval, per the research) — and (2) eval
// latency p50/p95/p99 with the instantiate-once/reuse pattern OPA prescribes. Honest by construction:
// it prints exactly what it measured (node + opa versions, the discovered host-builtins, the percentiles).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const opa = require("@open-policy-agent/opa-wasm");
const loadPolicy = opa.loadPolicy ?? opa.default ?? opa;

const wasmBytes = readFileSync(new URL("./policy.wasm", import.meta.url));

const KINDS = [["fs_read"], ["fs_write"], ["network_write"], ["process_exec"], ["fs_read", "network_write"]];
const SCOPES = [["workspace"], ["home"], ["external_service"], ["system"], ["temp"]];
const SENS = ["public", "internal", "secret", "unknown"];
const CONF = ["exact", "conservative", "ambiguous", "obfuscated", "unknown"];

function input(i) {
  const k = KINDS[i % KINDS.length];
  const s = SCOPES[i % SCOPES.length];
  return {
    tool: { name: "bash", args: { command: "x" } },
    normalized: { argv: ["x"], decodedLayers: [] },
    workspace: { path: "/repo", trusted: true },
    provenance: { inputTags: ["workspace"] },
    egress: { isEgress: false, domain: null, gitRemote: null },
    session: { id: "ses_x", mode: "enforced", promptCountThisSession: 0 },
    principal: { osUser: "u" },
    sideEffect: {
      taxonomyVersion: "side-effect-taxonomy/v1",
      staticCapability: { toolName: "bash", effectEnvelope: ["fs_read", "fs_write", "process_exec", "network_read", "network_write"], broad: true },
      dynamic: {
        effectKinds: k,
        scopes: s,
        targets: [{ kind: i % 6 === 0 ? "package" : "path", value: `pkg${i}`, normalized: i % 3 === 0 ? "/etc/passwd" : `/repo/f${i}`, sensitivity: SENS[i % SENS.length] }],
        modifiers: i % 7 === 0 ? ["irreversible"] : [],
        composition: { kind: "atomic", segments: [{ effectKinds: k, scopes: s, targets: [], modifiers: [] }], edges: [] },
        classifier: { name: "c", version: "1", confidence: CONF[i % CONF.length], reasons: [] },
      },
    },
  };
}

function stub(name) {
  // discovery/perf stub — correctness is irrelevant to the GAP + latency measurement
  if (name.startsWith("glob")) return (..._a) => false;
  if (name.startsWith("regex")) return (..._a) => false;
  if (name === "sprintf") return (..._a) => "";
  return (..._a) => null;
}

// Discover the host-callback builtins keel's pack requires by catching the SDK's not-implemented throw
// and supplying a stub, reloading until eval succeeds. The accumulated set IS the WASM gap.
async function loadWithGapDiscovery() {
  const host = new Set();
  for (let attempt = 0; attempt < 50; attempt++) {
    const custom = {};
    for (const name of host) custom[name] = stub(name);
    const policy = await loadPolicy(wasmBytes, undefined, custom);
    if (typeof policy.setData === "function") policy.setData({ config: { tmpRoots: ["/tmp"] } });
    try {
      policy.evaluate(input(0));
      return { policy, host: [...host] };
    } catch (e) {
      const m = /not implemented: built-in function \S+: (\S+)/.exec(e?.message || String(e));
      if (m) { host.add(m[1]); continue; }
      throw e;
    }
  }
  throw new Error("gap discovery did not converge");
}

function opaVersion() {
  try { return execSync("opa version", { encoding: "utf8" }).split("\n")[0]; } catch { return "unknown"; }
}

const tInstStart = performance.now();
const { policy, host } = await loadWithGapDiscovery();
const instantiateMs = performance.now() - tInstStart;

const inputs = Array.from({ length: 2000 }, (_, i) => input(i));
for (let i = 0; i < 500; i++) policy.evaluate(inputs[i % inputs.length]); // warmup

const N = 20000;
const samples = new Array(N);
for (let i = 0; i < N; i++) {
  const a = performance.now();
  policy.evaluate(inputs[i % inputs.length]);
  samples[i] = performance.now() - a;
}
samples.sort((a, b) => a - b);
const pct = (p) => samples[Math.min(N - 1, Math.floor((N * p) / 100))];
const mean = samples.reduce((a, b) => a + b, 0) / N;

console.log(JSON.stringify({
  node: process.version,
  opa: opaVersion(),
  sdk: "@open-policy-agent/opa-wasm@" + JSON.parse(readFileSync(new URL("./node_modules/@open-policy-agent/opa-wasm/package.json", import.meta.url), "utf8")).version,
  wasmBytes: wasmBytes.length,
  hostCallbackBuiltinsRequired: host,   // [] == every built-in keel's pack uses is compiled into WASM
  instantiateMs: +instantiateMs.toFixed(3),
  evalCount: N,
  mean_ms: +mean.toFixed(5),
  p50_ms: +pct(50).toFixed(5),
  p95_ms: +pct(95).toFixed(5),
  p99_ms: +pct(99).toFixed(5),
  p999_ms: +pct(99.9).toFixed(5),
  max_ms: +samples[N - 1].toFixed(5),
}, null, 2));
