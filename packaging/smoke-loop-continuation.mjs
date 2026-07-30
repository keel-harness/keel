import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CONTROLLER_PREFIX = "Keel loop controller · exit check failed";
const keelArg = process.argv[2];
assert.ok(keelArg, "usage: node smoke-loop-continuation.mjs <absolute-keel-bin>");
const keelBin = resolve(keelArg);
assert.ok(isAbsolute(keelBin), "installed keel bin must resolve to an absolute path");
assert.ok(existsSync(keelBin), `installed keel bin is missing: ${keelBin}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-npx-loop-continuation-")));
const workspace = join(root, "workspace");
const keelHome = join(root, "keel-home");
const recording = join(root, "recording.json");
const checker = join(workspace, "loop-check.mjs");
const counter = join(workspace, "counter.txt");

function fail(result) {
  throw new Error(
    [
      "packaged loop continuation smoke failed",
      `status: ${String(result.status)}`,
      `signal: ${String(result.signal)}`,
      `error: ${String(result.error ?? "(none)")}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join("\n"),
  );
}

try {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    recording,
    `${JSON.stringify(
      {
        version: 1,
        provider: "replay",
        model: "keel-loop-continuation-smoke",
        turns: [
          {
            chunks: [
              { type: "text-delta", text: "Completed bounded iteration one." },
              {
                type: "finish",
                reason: "stop",
                usage: { inputTokens: 8, outputTokens: 5 },
              },
            ],
          },
          {
            chunks: [
              { type: "text-delta", text: "Completed bounded iteration two." },
              {
                type: "finish",
                reason: "stop",
                usage: { inputTokens: 12, outputTokens: 5 },
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    checker,
    `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      const path = ${JSON.stringify(counter)};
      const previous = existsSync(path) ? Number.parseInt(readFileSync(path, "utf8"), 10) : 0;
      const next = previous + 1;
      writeFileSync(path, String(next) + "\\n", { mode: 0o600 });
      process.stdout.write("counter=" + String(next) + "\\n");
      process.exit(next >= 2 ? 0 : 1);
    `,
    { mode: 0o600 },
  );

  const result = spawnSync(
    keelBin,
    [
      "run",
      "-p",
      "advance the registered counter until its check passes",
      "--trust",
      "--verbose",
      "--replay",
      recording,
      "--loop-until",
      "node loop-check.mjs",
      "--loop-max-iterations",
      "3",
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        KEEL_HOME: keelHome,
        KEEL_WARDEN_SANDBOX: "srt",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_048_576,
    },
  );
  if (result.error !== undefined || result.status !== 0) fail(result);

  assert.equal(readFileSync(counter, "utf8"), "2\n", "the executor-owned check must run twice");
  assert.match(result.stdout, /loop succeeded/u);
  assert.match(result.stdout, /iterations · 2\/3/u);
  assert.match(result.stdout, /note\n\s+Keel loop controller · exit check failed/u);
  assert.doesNotMatch(result.stdout, /you\s+Keel loop controller · exit check failed/u);

  const sessionsDir = join(keelHome, "sessions");
  const ledgers = readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(ledgers.length, 1, "the smoke must create exactly one durable session");
  const events = readFileSync(join(sessionsDir, ledgers[0]), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const iterations = events.filter((event) => event.type === "loop_iteration");
  assert.deepEqual(
    iterations.map((event) => [event.iteration, event.status]),
    [
      [1, "running"],
      [1, "exit-check-failed"],
      [2, "running"],
      [2, "exit-check-passed"],
    ],
  );
  assert.equal(
    events.some(
      (event) =>
        (event.type === "system" || event.type === "user") &&
        typeof event.content === "string" &&
        event.content.startsWith(CONTROLLER_PREFIX),
    ),
    false,
    "controller provenance must stay in structured loop events, not a fake system/user ledger turn",
  );

  process.stdout.write("packaged loop continuation smoke passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
