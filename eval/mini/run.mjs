#!/usr/bin/env node
/**
 * keel mini-eval — a MANUAL, LIVE quality probe (NOT CI). For each task under `tasks/`, it copies the
 * starting `workspace/` into a fresh temp dir, runs the built `keel run -p "<prompt>"` against the
 * real model, then copies in a HELD-OUT verifier (`verify/`, which the agent never sees) and runs it.
 * A task passes iff the held-out `check.mjs` exits 0 — so an agent that games the visible tests still
 * fails. Reports a resolve rate + per-task pass/fail/duration/tokens.
 *
 * This is an internal signal + regression baseline until the real Terminal-Bench harness (Epic 1.11);
 * it is NOT a leaderboard-comparable score. Needs ANTHROPIC_API_KEY (e.g. `source .env`) + network.
 *
 *   corepack pnpm build && set -a && . ./.env && set +a && node eval/mini/run.mjs
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const bin = join(repoRoot, "packages/kernel/dist/cli/bin.js");
const TASK_TIMEOUT_MS = 240_000;

if (!existsSync(bin)) {
  console.error(`keel bin not built: ${bin}\nrun: corepack pnpm build`);
  process.exit(2);
}
if (process.env.ANTHROPIC_API_KEY === undefined && process.env.KEEL_PROVIDER === undefined) {
  console.error("set ANTHROPIC_API_KEY (e.g. `set -a && . ./.env && set +a`) before running the live eval");
  process.exit(2);
}

const tasksDir = join(here, "tasks");
const taskIds = readdirSync(tasksDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const onlyId = process.argv[2]; // optional: run a single task by id
const results = [];

for (const id of taskIds) {
  if (onlyId !== undefined && id !== onlyId) continue;
  const taskDir = join(tasksDir, id);
  const prompt = readFileSync(join(taskDir, "prompt.txt"), "utf8").trim();
  const run = mkdtempSync(join(tmpdir(), `keel-eval-${id}-`));
  cpSync(join(taskDir, "workspace"), run, { recursive: true });

  const t0 = Date.now();
  const r = spawnSync("node", [bin, "run", "-p", prompt], {
    cwd: run,
    env: { ...process.env, KEEL_HOME: join(run, ".keel") },
    encoding: "utf8",
    timeout: TASK_TIMEOUT_MS,
  });
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const tokens = (r.stdout?.match(/([\d.]+k?) tok/) ?? [])[1] ?? "?";

  // held-out verifier: copied in AFTER the agent finished, so it could not have been gamed
  cpSync(join(taskDir, "verify"), run, { recursive: true });
  const v = spawnSync("node", ["check.mjs"], { cwd: run, encoding: "utf8", timeout: 30_000 });
  const pass = v.status === 0;

  results.push({ id, pass, seconds, tokens, run, detail: `${v.stdout ?? ""}${v.stderr ?? ""}`.trim() });
  console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${id.padEnd(22)} ${seconds}s  ${String(tokens).padStart(6)}`);
  if (!pass) {
    const last = results.at(-1).detail.split("\n").filter(Boolean).at(-1) ?? "(no verifier output)";
    console.log(`         ↳ ${last}   [workspace: ${run}]`);
  }
}

const passed = results.filter((x) => x.pass).length;
const total = results.length;
console.log(`\nresolve rate: ${passed}/${total}  (${total ? Math.round((100 * passed) / total) : 0}%)`);
process.exit(passed === total ? 0 : 1);
