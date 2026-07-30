// ADR-0004 R2 gating smoke test: prove `policy.wasm` LOADS and EVALUATES from inside a `bun --compile`
// standalone binary (the ADR-0009 hard constraint). policy.wasm is EMBEDDED via the import attribute
// `with { type: "file" }` (Bun bundles the bytes into the binary; Bun.file reads them at runtime even
// when there is no sibling .wasm on disk) — the raw-bytes loadPolicy API the ADR called favorable.
import opa from "@open-policy-agent/opa-wasm";
// @ts-expect-error — Bun embeds the file and yields a runtime-readable path
import wasmPath from "./policy.wasm" with { type: "file" };

const loadPolicy = (opa as any).loadPolicy ?? (opa as any).default ?? opa;

const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
const policy = await loadPolicy(wasmBytes);
if (typeof policy.setData === "function") policy.setData({ config: { tmpRoots: ["/tmp"] } });

// A secret read → POL-001 must deny (exercises real rule evaluation, not just instantiation).
const secretRead = {
  workspace: { path: "/repo", trusted: true },
  sideEffect: {
    taxonomyVersion: "side-effect-taxonomy/v1",
    dynamic: {
      effectKinds: ["fs_read"],
      scopes: ["workspace"],
      targets: [{ kind: "path", value: ".env", normalized: "/repo/.env", sensitivity: "secret" }],
      modifiers: [],
      composition: { kind: "atomic", segments: [], edges: [] },
      classifier: { name: "c", version: "1", confidence: "exact", reasons: [] },
    },
  },
};
// A benign in-workspace read → allow (the negative control).
const benignRead = JSON.parse(JSON.stringify(secretRead));
benignRead.sideEffect.dynamic.targets[0] = {
  kind: "path",
  value: "src/index.ts",
  normalized: "/repo/src/index.ts",
  sensitivity: "internal",
};

function verdict(input: unknown): unknown {
  const res = policy.evaluate(input) as Array<{ result: unknown }>;
  return res?.[0]?.result;
}

const denyV = verdict(secretRead);
const allowV = verdict(benignRead);
console.log(JSON.stringify({ runtime: "bun", bun: Bun.version, wasmBytes: wasmBytes.byteLength, secretReadVerdict: denyV, benignReadVerdict: allowV }));

if (denyV !== "deny") {
  console.error(`FAIL: expected "deny" for the secret read, got ${JSON.stringify(denyV)}`);
  process.exit(1);
}
if (allowV !== "allow") {
  console.error(`FAIL: expected "allow" for the benign read, got ${JSON.stringify(allowV)}`);
  process.exit(1);
}
console.log("SMOKE_OK: policy.wasm embedded, loaded, and evaluated correctly inside the binary");
