#!/usr/bin/env node

// SEC-012 / ADR-0038 regression probe for the COMPILED binary: a workspace-local `.env` (or
// `.env.local`) must NOT be honored before workspace trust.
//
// Bun's runtime autoloads `.env` from the cwd into `process.env` at process init — BEFORE any keel
// code runs and before trust is granted. That silently makes a project-local file supply keel's
// provider key AND every `KEEL_*` control var (a trust-before-parse violation plus arbitrary env
// injection into keel, its children, and the warden). The packaged binary disables that autoload
// (`packaging/build.ts` → `compile.autoloadDotenv`/`autoloadBunfig` = false); this probe proves it.
//
// A unit test CANNOT catch this: vitest runs under Node, which never autoloads `.env`, so the bug is
// invisible in-process. Only a compiled-binary probe exercises the real runtime. Usage:
//   node packaging/smoke-dotenv-isolation.mjs <path-to-compiled-keel-binary>

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv[2]) {
  console.error("usage: smoke-dotenv-isolation.mjs <keel-binary>");
  process.exit(2);
}
// Resolve to an ABSOLUTE path: the probe launches keel with `cwd` set to the hostile workspace, so a
// relative binary path would resolve against that temp dir and fail to spawn.
const bin = resolve(process.argv[2]);

// Launch the binary FROM a hostile workspace, with a cleared environment (so the ONLY possible
// source of the injected values is the workspace files) and a fresh empty KEEL_HOME (no stored key).
// When the `.env` is correctly ignored, the provider stays the default `anthropic` and the key is
// absent, so keel fails closed with the honest "no anthropic API key found" — the same behavior as
// the Node/tsx dev path (which never autoloads `.env`). That message is the unambiguous PASS signal.
function runInHostileWorkspace(files) {
  const ws = mkdtempSync(join(tmpdir(), "keel-dotenv-probe-"));
  const keelHome = mkdtempSync(join(tmpdir(), "keel-dotenv-home-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(ws, name), body);
  const res = spawnSync(bin, ["run", "-p", "hi"], {
    cwd: ws,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: keelHome, KEEL_HOME: keelHome },
    encoding: "utf8",
    timeout: 60_000,
  });
  rmSync(ws, { recursive: true, force: true });
  rmSync(keelHome, { recursive: true, force: true });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

const failedClosedOnAnthropicKey = (out) => /no anthropic api key (?:was )?found/i.test(out);
const failures = [];

// (1) Credential vector: a `.env`/`.env.local` supplying the Anthropic key must not be honored — keel
//     must still report no key. A leak instead proceeds into a turn (no "no key" message).
const keyOut = runInHostileWorkspace({
  ".env": "ANTHROPIC_API_KEY=sk-ant-should-not-load-from-workspace\n",
  ".env.local": "ANTHROPIC_API_KEY=sk-ant-should-not-load-from-local\n",
});
if (!failedClosedOnAnthropicKey(keyOut)) {
  failures.push(`credential vector: .env key was honored before trust\n${keyOut.slice(0, 800)}`);
}

// (2) Config-injection vector: a `.env` flipping `KEEL_PROVIDER` must not be honored — the provider
//     must stay the default `anthropic` (→ "no anthropic API key found"). A leak instead selects
//     `google` (→ "…provider \"google\"" / "no google API key found").
const cfgOut = runInHostileWorkspace({ ".env": "KEEL_PROVIDER=google\n" });
if (!failedClosedOnAnthropicKey(cfgOut) || /google/i.test(cfgOut)) {
  failures.push(
    `config vector: .env KEEL_PROVIDER was honored before trust\n${cfgOut.slice(0, 800)}`,
  );
}

if (failures.length === 0) {
  console.log("dotenv-isolation OK: workspace .env/.env.local not honored before trust");
  process.exit(0);
}
console.error("dotenv-isolation FAIL: a workspace .env influenced the compiled binary");
for (const f of failures) console.error(`- ${f}`);
process.exit(1);
