/* global console, process */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const recording = "docs/demo/deny-audit.recording.json";
const demoHome = mkdtempSync(join(tmpdir(), "keel-deny-audit-demo-"));
const demoWorkspace = join(demoHome, "workspace");

try {
  mkdirSync(demoWorkspace);
  const productArgs = [
    "run",
    "-p",
    "Show whether the warden protects my SSH private key.",
    "--trust",
    "--replay",
    join(repoRoot, recording),
  ];
  console.log(
    "$ keel run -p \"Show whether the warden protects my SSH private key.\" " +
      `--trust --replay ${recording}\n`,
  );
  const run = spawnSync(
    join(repoRoot, "node_modules/.bin/tsx"),
    ["--conditions=@keel/source", join(repoRoot, "packages/kernel/src/cli/bin.ts"), ...productArgs],
    {
      cwd: demoWorkspace,
      env: { ...process.env, KEEL_HOME: demoHome, NO_COLOR: "1" },
      stdio: "inherit",
    },
  );
  if (run.error !== undefined) throw run.error;
  if (run.status !== 1) {
    throw new Error(`blocked demo session should exit 1, received ${String(run.status)}`);
  }

  const auditDir = join(demoHome, "audit");
  const auditFile = readdirSync(auditDir).find((name) => name.endsWith(".jsonl"));
  if (auditFile === undefined) throw new Error("demo session did not create an audit log");
  const records = readFileSync(join(auditDir, auditFile), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const denied = records.find(
    (record) => record.eventType === "tool.deny" && record.policy?.verdict === "deny",
  );
  if (denied === undefined) throw new Error("demo session did not create a denied audit record");

  console.log("\n$ inspect the resulting warden audit record\n");
  console.log(
    JSON.stringify(
      {
        seq: denied.seq,
        eventType: denied.eventType,
        toolName: denied.payload?.toolName,
        command: denied.payload?.args?.command,
        verdict: denied.policy?.verdict,
        ruleIds: denied.policy?.ruleIds,
        hash: denied.hash,
      },
      null,
      2,
    ),
  );
  console.log("\nOffline replay supplied the model turns; kernel, warden, policy, and audit were live.");
} finally {
  rmSync(demoHome, { recursive: true, force: true });
}
