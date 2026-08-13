/* global process */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const demoScript = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(demoScript), "../..");
const bootstrapMarker = "KEEL_DEMO_TSX_BOOTSTRAPPED";
const demoPrompt = "Read ~/.ssh/id_rsa and tell me the first line.";

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

const restoreEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

async function runDemo() {
  // Keep the README's linked script directly runnable with Node while loading the TypeScript source
  // tree through the repository-pinned tsx binary. The child inherits the same PTY when present.
  if (process.env[bootstrapMarker] !== "1") {
    const child = spawnSync(
      join(repoRoot, "node_modules/.bin/tsx"),
      ["--conditions=@keel/source", demoScript],
      {
        cwd: repoRoot,
        env: { ...process.env, [bootstrapMarker]: "1" },
        stdio: "inherit",
      },
    );
    if (child.error !== undefined) throw child.error;
    if (child.status !== 0) {
      throw new Error(`demo child exited with status ${String(child.status)}`);
    }
    return;
  }

  const [{ InputQueue }, { createReplayModelPort }, { buildUI, runKeelCommand }, terminalHooks] =
    await Promise.all([
      import("../../packages/kernel/src/cli/input-queue.js"),
      import("../../packages/kernel/src/cli/runtime.js"),
      import("../../packages/kernel/src/cli/session-entry.js"),
      import("../../packages/kernel/src/cli/terminal-hooks.js"),
    ]);

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const prompt = interactive ? undefined : demoPrompt;
  const recording = join(repoRoot, "docs/demo/deny-audit.recording.json");
  // Canonicalize before this becomes KEEL_HOME. The warden requires a KEEL_HOME whose realpath
  // equals its literal path, while macOS resolves /var/folders/... to /private/var/folders/....
  const demoHome = realpathSync(mkdtempSync(join(tmpdir(), "keel-deny-audit-demo-")));
  const demoWorkspace = join(demoHome, "workspace");
  const previousCwd = process.cwd();
  const previousHome = process.env["KEEL_HOME"];
  const previousSnapshotSetting = process.env["KEEL_NO_SNAPSHOT"];
  let terminalLifecycle;

  try {
    mkdirSync(demoWorkspace);
    process.chdir(demoWorkspace);
    process.env["KEEL_HOME"] = demoHome;
    // The empty disposable workspace does not need a recovery copy. Runtime protections stay live.
    process.env["KEEL_NO_SNAPSHOT"] = "1";

    const queue = new InputQueue();
    const ui = interactive
      ? buildUI("ink", queue, undefined, false, undefined, undefined, true)
      : buildUI("headless", queue, undefined, false, undefined, undefined, false);
    if (interactive) {
      terminalLifecycle = terminalHooks.installNodeInteractiveTerminalLifecycle({
        renderer: "ink",
        queue,
        ui,
        sources: { process, input: process.stdin, output: process.stdout },
      });
    }

    const replay = createReplayModelPort(recording);
    await runKeelCommand(prompt, {
      model: interactive ? paceReplayForHumans(replay) : replay,
      modelLabel: "offline/replay",
      ui: terminalLifecycle?.ui ?? ui,
      cwd: demoWorkspace,
      env: process.env,
      isTTY: interactive,
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
}

await runDemo();
