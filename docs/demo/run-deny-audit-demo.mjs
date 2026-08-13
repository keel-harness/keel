/* global process */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { InputQueue } from "../../packages/kernel/src/cli/input-queue.js";
import { createReplayModelPort } from "../../packages/kernel/src/cli/runtime.js";
import { buildUI, runKeelCommand } from "../../packages/kernel/src/cli/session-entry.js";
import { installNodeInteractiveTerminalLifecycle } from "../../packages/kernel/src/cli/terminal-hooks.js";

if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  throw new Error("demo requires an interactive terminal");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const recording = join(repoRoot, "docs/demo/deny-audit.recording.json");
// Canonicalize before this becomes KEEL_HOME. The warden requires a KEEL_HOME whose realpath equals
// its literal path (ADR-0086), while macOS resolves /var/folders/... to /private/var/folders/....
const demoHome = realpathSync(mkdtempSync(join(tmpdir(), "keel-deny-audit-demo-")));
const demoWorkspace = join(demoHome, "workspace");
const previousCwd = process.cwd();
const previousHome = process.env["KEEL_HOME"];
const previousSnapshotSetting = process.env["KEEL_NO_SNAPSHOT"];

const restoreEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const paceReplayForHumans = (replay) => {
  let turn = 0;
  return {
    async *stream(input) {
      turn += 1;
      for await (const chunk of replay.stream(input)) {
        const waitMs =
          chunk.type === "tool-call" ? 800 : chunk.type === "text-delta" ? (turn === 1 ? 450 : 900) : 0;
        if (waitMs > 0) await delay(waitMs);
        yield chunk;
      }
    },
  };
};

let terminalLifecycle;
try {
  mkdirSync(demoWorkspace);
  process.chdir(demoWorkspace);
  process.env["KEEL_HOME"] = demoHome;
  // The empty disposable workspace does not need a recovery copy. All runtime protections remain live.
  process.env["KEEL_NO_SNAPSHOT"] = "1";

  const queue = new InputQueue();
  const ui = buildUI("ink", queue, undefined, false, undefined, undefined, true);
  terminalLifecycle = installNodeInteractiveTerminalLifecycle({
    renderer: "ink",
    queue,
    ui,
    sources: { process, input: process.stdin, output: process.stdout },
  });

  await runKeelCommand(undefined, {
    model: paceReplayForHumans(createReplayModelPort(recording)),
    modelLabel: "offline/replay",
    ui: terminalLifecycle?.ui ?? ui,
    cwd: demoWorkspace,
    env: process.env,
    isTTY: true,
    trustFlag: true,
  });

  const auditDir = join(demoHome, "audit");
  const auditFile = readdirSync(auditDir).find((name) => name.endsWith(".jsonl"));
  if (auditFile === undefined) throw new Error("demo session did not create an audit log");
  const records = readFileSync(join(auditDir, auditFile), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const denied = records.find(
    (record) =>
      record.eventType === "tool.deny" &&
      record.policy?.verdict === "deny" &&
      record.payload?.args?.command === "cat ~/.ssh/id_rsa",
  );
  if (denied === undefined || !denied.policy?.ruleIds?.includes("POL-001")) {
    throw new Error("demo session did not create the expected POL-001 denied audit record");
  }

  const exitCode = terminalLifecycle?.exitCode();
  if (exitCode !== undefined && exitCode !== 0) {
    throw new Error(`interactive demo exited with status ${String(exitCode)}`);
  }
} finally {
  terminalLifecycle?.dispose();
  process.chdir(previousCwd);
  restoreEnv("KEEL_HOME", previousHome);
  restoreEnv("KEEL_NO_SNAPSHOT", previousSnapshotSetting);
  rmSync(demoHome, { recursive: true, force: true });
}
