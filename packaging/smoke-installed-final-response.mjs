#!/usr/bin/env node

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

import { createBoundedOutputCapture } from "./bounded-output-capture.mjs";
import { terminateProcessGroup } from "./process-group-cleanup.mjs";
import { spawnControlledTarget } from "./process-group-controller.mjs";

const SELF_TEST = "--self-test";
const FINAL_TEXT =
  "Updated goal.txt from KFINAL_GOAL_PENDING to KFINAL_GOAL_DONE. The registered node goal-check.mjs command exited 0.";
const PENDING = "KFINAL_GOAL_PENDING\n";
const DONE = "KFINAL_GOAL_DONE\n";
const DIAGNOSTIC_TEXT_LIMIT = 2_000;
const EXPECTED_CALLS = [
  ["installed-final-response-read", "read", { path: "goal.txt" }],
  [
    "installed-final-response-edit",
    "edit",
    {
      path: "goal.txt",
      oldString: "KFINAL_GOAL_PENDING",
      newString: "KFINAL_GOAL_DONE",
    },
  ],
  ["installed-final-response-check", "bash", { command: "node goal-check.mjs" }],
];

function countText(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function boundedDetail(value) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = "[unserializable evidence]";
  }
  return String(text).slice(-DIAGNOSTIC_TEXT_LIMIT);
}

function evidenceError(message, detail) {
  return new Error(`${message}: ${boundedDetail(detail)}`);
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readRecords(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readJsonLines(join(directory, name)));
}

function assistantToolCalls(records) {
  return records.flatMap((record) =>
    record.type === "assistant" && Array.isArray(record.toolCalls) ? record.toolCalls : [],
  );
}

function auditRecordFor(records, toolCallId) {
  const matches = records.filter(
    (record) =>
      record.payload?.toolCallId === toolCallId &&
      record.eventType === "tool.execute" &&
      record.payload?.execution !== "requested",
  );
  if (matches.length !== 1) {
    throw evidenceError(`expected one audit record for ${toolCallId}`, matches);
  }
  return matches[0];
}

function exactCallShape(calls) {
  return (
    calls.length === EXPECTED_CALLS.length &&
    calls.every(
      (call, index) =>
        call.id === EXPECTED_CALLS[index]?.[0] &&
        call.name === EXPECTED_CALLS[index]?.[1] &&
        JSON.stringify(call.args) === JSON.stringify(EXPECTED_CALLS[index]?.[2]),
    )
  );
}

function exactToolResultShape(records) {
  const results = records.filter((record) => record.type === "tool_result");
  return (
    results.length === EXPECTED_CALLS.length &&
    results.every(
      (record, index) =>
        record.toolCallId === EXPECTED_CALLS[index]?.[0] &&
        record.name === EXPECTED_CALLS[index]?.[1],
    )
  );
}

function parsedBashResult(records) {
  const record = records.find(
    (candidate) =>
      candidate.type === "tool_result" && candidate.toolCallId === "installed-final-response-check",
  );
  try {
    return JSON.parse(String(record?.output ?? ""));
  } catch {
    return undefined;
  }
}

export function assertInstalledFinalResponseEvidence({
  exit,
  stdout,
  stderr,
  outputOverflow,
  goalContent,
  workspaceEntries,
  sessionId,
  sessionRecords,
  auditRecords,
  bundleManifest,
  bundleAuditRecords,
  chainVerified,
  bundleVerified,
  offlineVerified,
  processGroupState,
}) {
  if (outputOverflow) throw new Error("installed carrier diagnostic/output overflowed");
  if (exit?.code !== 0 || exit.signal !== null) {
    throw evidenceError("installed Keel returned the wrong exit", exit);
  }
  if (processGroupState !== "reaped") {
    throw new Error(`installed Keel process group was not reaped: ${String(processGroupState)}`);
  }
  if (goalContent !== DONE) {
    throw evidenceError("installed carrier goal postimage drifted", goalContent);
  }
  if (JSON.stringify(workspaceEntries) !== JSON.stringify(["goal-check.mjs", "goal.txt"])) {
    throw evidenceError(
      "installed carrier changed an unexpected workspace entry",
      workspaceEntries,
    );
  }
  if (stderr !== "") {
    throw evidenceError("installed carrier emitted unexpected diagnostic residue", stderr);
  }
  if (countText(stdout, FINAL_TEXT) !== 1) {
    throw evidenceError("installed carrier did not render the exact final exactly once", {
      stdout,
      stderr,
    });
  }
  if (
    /accepted|acceptance|security (?:is )?proven|verified the whole task|all requirements/iu.test(
      FINAL_TEXT,
    )
  ) {
    throw new Error("registered final text overclaims acceptance or security");
  }
  const assistants = sessionRecords.filter((record) => record.type === "assistant");
  if (assistants.length !== 4) {
    throw evidenceError("installed carrier replay/model request count drifted", assistants.length);
  }
  const calls = assistantToolCalls(sessionRecords);
  if (!exactCallShape(calls)) {
    throw evidenceError("installed carrier tool-call shape drifted", calls);
  }
  if (!exactToolResultShape(sessionRecords)) {
    throw evidenceError("installed carrier tool-result shape drifted", sessionRecords);
  }
  const finals = assistants.filter((record) => record.content === FINAL_TEXT);
  if (finals.length !== 1 || assistants.at(-1)?.content !== FINAL_TEXT) {
    throw evidenceError("installed carrier ledger final bytes drifted", assistants);
  }
  const bashResult = parsedBashResult(sessionRecords);
  if (
    bashResult?.exitCode !== 0 ||
    bashResult.signal !== null ||
    bashResult.stdout !== "" ||
    bashResult.stderr !== ""
  ) {
    throw evidenceError("installed carrier Bash check did not settle silent exit-zero", bashResult);
  }
  if (
    sessionRecords.some((record) => record.type === "warden_auto_resolved") ||
    auditRecords.some(
      (record) => record.eventType === "review.requested" || record.eventType === "review.resolved",
    )
  ) {
    throw new Error("installed carrier created a review or retry state");
  }
  if (
    /HONEST-YOLO|NO ENFORCEMENT|sandbox:none|local fallback|SRT fallback/iu.test(
      `${stdout}\n${stderr}`,
    )
  ) {
    throw new Error("installed carrier disclosed YOLO or sandbox fallback");
  }

  const audits = EXPECTED_CALLS.map(([id]) => auditRecordFor(auditRecords, id));
  if (
    audits.some((record, index) => {
      const expected = EXPECTED_CALLS[index];
      return (
        record.eventType !== "tool.execute" ||
        record.payload?.toolName !== expected?.[1] ||
        record.policy?.verdict !== "allow"
      );
    })
  ) {
    throw evidenceError("installed carrier allowed-tool audit shape drifted", audits);
  }
  if (!(audits[0].seq < audits[1].seq && audits[1].seq < audits[2].seq)) {
    throw evidenceError(
      "installed carrier audit order drifted",
      audits.map((record) => record.seq),
    );
  }
  const sandbox = audits[2].sideEffect?.extensions?.["keel.sandbox"];
  if (
    sandbox?.containedArbitraryCode !== true ||
    sandbox.backend !== "srt:vendored" ||
    sandbox.enforcementTier !== "sandbox:srt"
  ) {
    throw evidenceError("installed carrier lacked audit-owned real-SRT evidence", sandbox);
  }
  if (!chainVerified) throw new Error("installed carrier audit chain was not verified");
  if (!bundleVerified) throw new Error("installed carrier bundle was not verified by Keel");
  if (!offlineVerified) throw new Error("installed carrier bundle failed the vendored verifier");
  if (bundleManifest?.sessionId !== sessionId) {
    throw evidenceError("installed carrier bundle session drifted", bundleManifest);
  }
  for (const [id, name] of EXPECTED_CALLS) {
    const record = bundleAuditRecords.find(
      (candidate) =>
        candidate.payload?.toolCallId === id &&
        candidate.eventType === "tool.execute" &&
        candidate.payload?.execution !== "requested",
    );
    if (record?.payload?.toolName !== name || record.sessionId !== sessionId) {
      throw evidenceError(`installed carrier bundle omitted ${id}`, record);
    }
  }
}

function validSelfTestEvidence() {
  const sessionId = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const sessionRecords = [
    {
      type: "assistant",
      toolCalls: [
        { id: "installed-final-response-read", name: "read", args: { path: "goal.txt" } },
      ],
    },
    {
      type: "tool_result",
      toolCallId: "installed-final-response-read",
      name: "read",
      output: PENDING,
    },
    {
      type: "assistant",
      toolCalls: [
        {
          id: "installed-final-response-edit",
          name: "edit",
          args: {
            path: "goal.txt",
            oldString: "KFINAL_GOAL_PENDING",
            newString: "KFINAL_GOAL_DONE",
          },
        },
      ],
    },
    {
      type: "tool_result",
      toolCallId: "installed-final-response-edit",
      name: "edit",
      output: "edited goal.txt",
    },
    {
      type: "assistant",
      toolCalls: [
        {
          id: "installed-final-response-check",
          name: "bash",
          args: { command: "node goal-check.mjs" },
        },
      ],
    },
    {
      type: "tool_result",
      toolCallId: "installed-final-response-check",
      name: "bash",
      output: JSON.stringify({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    },
    { type: "assistant", content: FINAL_TEXT },
  ];
  const auditRecords = EXPECTED_CALLS.map(([id, name], index) => ({
    seq: index + 1,
    sessionId,
    eventType: "tool.execute",
    payload: { toolCallId: id, toolName: name },
    policy: { verdict: "allow" },
    ...(id === "installed-final-response-check"
      ? {
          sideEffect: {
            extensions: {
              "keel.sandbox": {
                containedArbitraryCode: true,
                backend: "srt:vendored",
                enforcementTier: "sandbox:srt",
              },
            },
          },
        }
      : {}),
  }));
  return {
    exit: { code: 0, signal: null },
    stdout: `${FINAL_TEXT}\n`,
    stderr: "",
    outputOverflow: false,
    goalContent: DONE,
    workspaceEntries: ["goal-check.mjs", "goal.txt"],
    sessionId,
    sessionRecords,
    auditRecords,
    bundleManifest: { sessionId },
    bundleAuditRecords: structuredClone(auditRecords),
    chainVerified: true,
    bundleVerified: true,
    offlineVerified: true,
    processGroupState: "reaped",
  };
}

function runSelfTest() {
  const valid = validSelfTestEvidence();
  assertInstalledFinalResponseEvidence(valid);
  const mutations = [
    [
      "missing-final",
      (copy) => {
        copy.stdout = "";
        copy.sessionRecords = copy.sessionRecords.filter(
          (record) => !(record.type === "assistant" && record.content === FINAL_TEXT),
        );
      },
    ],
    [
      "duplicate-final",
      (copy) => {
        copy.stdout += `${FINAL_TEXT}\n`;
        copy.sessionRecords.push({ type: "assistant", content: FINAL_TEXT });
      },
    ],
    [
      "changed-final",
      (copy) => {
        copy.stdout = "Changed final.\n";
        copy.sessionRecords.at(-1).content = "Changed final.";
      },
    ],
    [
      "overclaim-final",
      (copy) => {
        const text = "The entire task is accepted and security is proven.";
        copy.stdout = `${text}\n`;
        copy.sessionRecords.at(-1).content = text;
      },
    ],
    [
      "fourth-tool",
      (copy) => {
        copy.sessionRecords.splice(-1, 0, {
          type: "assistant",
          toolCalls: [
            { id: "installed-final-response-extra", name: "bash", args: { command: "pwd" } },
          ],
        });
      },
    ],
    [
      "wrong-command",
      (copy) => {
        copy.sessionRecords[4].toolCalls[0].args.command = "node app.mjs";
      },
    ],
    [
      "failed-check",
      (copy) => {
        copy.sessionRecords[5].output = JSON.stringify({
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "not done",
        });
      },
    ],
    ["wrong-postimage", (copy) => (copy.goalContent = PENDING)],
    ["missing-audit", (copy) => (copy.auditRecords = copy.auditRecords.slice(0, 2))],
    ["invalid-chain", (copy) => (copy.chainVerified = false)],
    ["unverified-bundle", (copy) => (copy.bundleVerified = false)],
    [
      "review-pending",
      (copy) =>
        copy.sessionRecords.push({
          type: "warden_auto_resolved",
          reviewId: "review_installed-final-response",
        }),
    ],
    ["wrong-exit", (copy) => (copy.exit = { code: 1, signal: null })],
    ["process-survivor", (copy) => (copy.processGroupState = "owned")],
    ["diagnostic-residue", (copy) => (copy.stderr = "fatal diagnostic residue\n")],
    ["diagnostic-overflow", (copy) => (copy.outputOverflow = true)],
  ];

  for (const [label, mutate] of mutations) {
    const copy = structuredClone(valid);
    mutate(copy);
    let thrown;
    try {
      assertInstalledFinalResponseEvidence(copy);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, label);
  }
  process.stdout.write(
    `installed final-response oracle self-test passed ${mutations.map(([label]) => `rejected:${label}`).join(" ")}\n`,
  );
}

function recording() {
  return {
    version: 1,
    provider: "replay",
    model: "installed-final-response",
    turns: [
      {
        chunks: [
          {
            type: "tool-call",
            id: "installed-final-response-read",
            name: "read",
            args: { path: "goal.txt" },
          },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 8, outputTokens: 4 } },
        ],
      },
      {
        chunks: [
          {
            type: "tool-call",
            id: "installed-final-response-edit",
            name: "edit",
            args: {
              path: "goal.txt",
              oldString: "KFINAL_GOAL_PENDING",
              newString: "KFINAL_GOAL_DONE",
            },
          },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 12, outputTokens: 4 } },
        ],
      },
      {
        chunks: [
          {
            type: "tool-call",
            id: "installed-final-response-check",
            name: "bash",
            args: { command: "node goal-check.mjs" },
          },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 16, outputTokens: 4 } },
        ],
      },
      {
        chunks: [
          { type: "text-delta", text: FINAL_TEXT },
          { type: "finish", reason: "stop", usage: { inputTokens: 20, outputTokens: 24 } },
        ],
      },
    ],
  };
}

function minimalEnvironment(root, keelHome) {
  const inheritedKeys = ["LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];
  const environment = Object.fromEntries(
    inheritedKeys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  return {
    ...environment,
    HOME: join(root, "home"),
    KEEL_HOME: keelHome,
    KEEL_WARDEN_SANDBOX: "srt",
    KEEL_MAX_TURNS: "3",
    KEEL_MAX_FINALIZE_TURNS: "1",
    NO_COLOR: "1",
  };
}

function runBounded(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2_097_152,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw evidenceError(`installed command failed: ${args.join(" ")}`, result);
  }
  return result.stdout;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runInstalledCarrier(binaryArg) {
  const keelBin = resolve(binaryArg);
  if (!isAbsolute(keelBin) || !existsSync(keelBin)) {
    throw new Error(`installed Keel launcher is missing: ${keelBin}`);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-npx-final-response-")));
  const workspace = join(root, "workspace");
  const keelHome = join(root, "keel-home");
  const recordingPath = join(root, "recording.json");
  const bundleRoot = join(root, "bundles");
  const environment = minimalEnvironment(root, keelHome);
  let controlled;
  let processGroupState = "unstarted";
  let completed = false;
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "goal.txt"), PENDING, { mode: 0o600 });
    writeFileSync(
      join(workspace, "goal-check.mjs"),
      `import { readFileSync } from "node:fs";\nconst value = readFileSync("goal.txt", "utf8");\nprocess.exit(value === ${JSON.stringify(DONE)} ? 0 : 1);\n`,
      { mode: 0o400 },
    );
    writeFileSync(recordingPath, `${JSON.stringify(recording(), null, 2)}\n`, { mode: 0o600 });

    controlled = spawnControlledTarget(
      keelBin,
      [
        "run",
        "-p",
        "read goal.txt, change only the registered marker, run node goal-check.mjs, then report",
        "--trust",
        "--verbose",
        "--replay",
        recordingPath,
      ],
      { cwd: workspace, env: environment },
    );
    controlled.child.stdin.end();
    const stdoutCapture = createBoundedOutputCapture("stdout");
    const stderrCapture = createBoundedOutputCapture("stderr");
    controlled.child.stdout.setEncoding("utf8");
    controlled.child.stderr.setEncoding("utf8");
    controlled.child.stdout.on("data", (chunk) => stdoutCapture.append(chunk));
    controlled.child.stderr.on("data", (chunk) => stderrCapture.append(chunk));
    const exit = await withTimeout(
      controlled.waitTargetExit(),
      30_000,
      "installed final-response carrier exceeded 30 seconds",
    );
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 25));
    processGroupState = await terminateProcessGroup(
      controlled.processGroupLease,
      controlled.guardianExit,
    );
    if (
      exit.code !== 0 ||
      exit.signal !== null ||
      stdoutCapture.error !== undefined ||
      stderrCapture.error !== undefined
    ) {
      throw evidenceError("installed final-response run failed before audit evidence", {
        exit,
        stdout: stdoutCapture.text,
        stderr: stderrCapture.text,
        stdoutError: stdoutCapture.error?.message,
        stderrError: stderrCapture.error?.message,
      });
    }

    const auditFiles = readdirSync(join(keelHome, "audit"))
      .filter((name) => name.startsWith("ses_") && name.endsWith(".jsonl"))
      .sort();
    if (auditFiles.length !== 1) throw evidenceError("expected one audit session", auditFiles);
    const sessionId = auditFiles[0].slice(0, -".jsonl".length);
    const sessionRecords = readRecords(join(keelHome, "sessions"));
    const auditRecords = readJsonLines(join(keelHome, "audit", auditFiles[0]));

    const exportOutput = runBounded(keelBin, ["audit", "export", sessionId, "--out", bundleRoot], {
      cwd: workspace,
      env: environment,
    });
    const bundlePath = join(bundleRoot, `bundle_${sessionId}`);
    const verifyOutput = runBounded(keelBin, ["audit", "verify", bundlePath], {
      cwd: workspace,
      env: environment,
    });
    const offlineOutput = runBounded(
      process.execPath,
      [join(bundlePath, "verify", "verify-bundle.mjs"), bundlePath],
      { cwd: workspace, env: environment },
    );
    const bundleManifest = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8"));
    const bundleAuditRecords = readJsonLines(join(bundlePath, "audit.jsonl"));

    assertInstalledFinalResponseEvidence({
      exit,
      stdout: stdoutCapture.text,
      stderr: stderrCapture.text,
      outputOverflow: stdoutCapture.error !== undefined || stderrCapture.error !== undefined,
      goalContent: readFileSync(join(workspace, "goal.txt"), "utf8"),
      workspaceEntries: readdirSync(workspace).sort(),
      sessionId,
      sessionRecords,
      auditRecords,
      bundleManifest,
      bundleAuditRecords,
      chainVerified: verifyOutput.includes("verified audit bundle:"),
      bundleVerified:
        exportOutput.includes("exported audit bundle:") &&
        verifyOutput.includes("verified audit bundle:"),
      offlineVerified: offlineOutput.includes("OK sha256:"),
      processGroupState,
    });
    completed = true;
  } finally {
    if (controlled?.processGroupLease?.state === "owned") {
      await terminateProcessGroup(controlled.processGroupLease, controlled.guardianExit);
    }
    rmSync(root, { recursive: true, force: true });
  }
  if (existsSync(root))
    throw new Error("installed final-response carrier fixture survived cleanup");
  if (completed) process.stdout.write("installed npx final-response smoke passed\n");
}

if (process.argv[2] === SELF_TEST) {
  runSelfTest();
} else {
  const binaryArg = process.argv[2];
  if (binaryArg === undefined) {
    throw new Error(
      "usage: node packaging/smoke-installed-final-response.mjs <installed-keel-bin>",
    );
  }
  await runInstalledCarrier(binaryArg);
}
