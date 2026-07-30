#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { createBoundedOutputCapture } from "./bounded-output-capture.mjs";
import { terminateProcessGroup } from "./process-group-cleanup.mjs";
import { spawnControlledTarget } from "./process-group-controller.mjs";

const SELF_TEST = "--self-test";
const FINAL_TEXT =
  "Both outside writes were blocked and were not performed. Use a workspace-contained path instead.";
const DIAGNOSTIC_TEXT_LIMIT = 2_000;

function countText(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function assistantToolCalls(records) {
  return records.flatMap((record) =>
    record.type === "assistant" && Array.isArray(record.toolCalls) ? record.toolCalls : [],
  );
}

function auditRecordFor(records, toolCallId) {
  return records.find((record) => record.payload?.toolCallId === toolCallId);
}

function redactDiagnostic(value, sensitivePaths) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = "[unserializable evidence]";
    }
  }
  if (text === undefined) {
    text = String(value);
  }
  const paths = [...new Set(sensitivePaths)]
    .filter((path) => typeof path === "string" && path.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const path of paths) {
    text = text.split(path).join("[redacted-path]");
  }
  return text.slice(-DIAGNOSTIC_TEXT_LIMIT);
}

function evidenceError(message, detail, sensitivePaths) {
  const suffix = detail === undefined ? "" : `: ${redactDiagnostic(detail, sensitivePaths)}`;
  return new Error(`${message}${suffix}`);
}

function hasExactCallShape(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (entry, index) => entry[0] === expected[index]?.[0] && entry[1] === expected[index]?.[1],
    )
  );
}

export function assertBashSymlinkDenyEvidence({
  exit,
  stdout,
  stderr,
  workspace,
  outside,
  typedTarget,
  bashTarget,
  typedTargetExists,
  bashTargetExists,
  sessionRecords,
  auditRecords,
  processGroupState,
}) {
  const sensitivePaths = [outside, workspace, typedTarget, bashTarget];
  // BLOCKED_AFTER_SYNTHESIS is a truthful needs-attention completion. The public CLI contract
  // deliberately maps that model-stop detail to exit 1 for scripts; signal-null + exact process-
  // group reap prove clean settlement without misreporting the blocked run as success.
  if (exit?.code !== 1 || exit.signal !== null) {
    throw evidenceError(
      "installed Keel returned the wrong needs-attention exit",
      exit,
      sensitivePaths,
    );
  }
  if (processGroupState !== "reaped") {
    throw new Error(`installed Keel process group was not reaped: ${String(processGroupState)}`);
  }
  if (typedTargetExists || bashTargetExists) {
    throw new Error("an installed-carrier outside-write canary was created");
  }
  if (countText(stdout, FINAL_TEXT) !== 1) {
    throw evidenceError(
      `installed carrier did not render exactly one truthful final response (count=${String(countText(stdout, FINAL_TEXT))})`,
      {
        stdoutTail: stdout.slice(-DIAGNOSTIC_TEXT_LIMIT),
        stderrTail: stderr.slice(-DIAGNOSTIC_TEXT_LIMIT),
      },
      sensitivePaths,
    );
  }
  if (stdout.includes(outside) || stderr.includes(outside)) {
    throw new Error("installed carrier disclosed the physical outside path in public output");
  }

  const calls = assistantToolCalls(sessionRecords);
  const callShape = calls.map((call) => [call.id, call.name]);
  const expectedCallShape = [
    ["symlink-deny-typed-write", "write"],
    ["symlink-deny-bash-touch", "bash"],
  ];
  if (!hasExactCallShape(callShape, expectedCallShape)) {
    throw evidenceError("installed carrier tool-call shape drifted", callShape, sensitivePaths);
  }
  const toolResults = sessionRecords.filter((record) => record.type === "tool_result");
  const resultShape = toolResults.map((record) => [record.toolCallId, record.name]);
  if (!hasExactCallShape(resultShape, expectedCallShape)) {
    throw evidenceError("installed carrier tool-result shape drifted", resultShape, sensitivePaths);
  }
  for (const record of toolResults) {
    const output = String(record.output ?? "");
    if (!/blocked|denied/u.test(output) || !/not executed|was not performed/u.test(output)) {
      throw evidenceError(
        "installed carrier tool result was not a terminal denial",
        output,
        sensitivePaths,
      );
    }
    if (/review required|review_[A-Za-z0-9]/u.test(output)) {
      throw evidenceError(
        "installed carrier exposed a review route for an outside write",
        output,
        sensitivePaths,
      );
    }
    if (output.includes(outside)) {
      throw evidenceError(
        `installed carrier tool result disclosed the physical outside path (${String(record.name)} ${String(record.toolCallId)})`,
        output,
        sensitivePaths,
      );
    }
  }
  const bashResult = toolResults.find((record) => record.toolCallId === "symlink-deny-bash-touch");
  if (!String(bashResult?.output ?? "").includes("POL-002")) {
    throw new Error("installed carrier Bash result omitted POL-002 guidance");
  }
  const finals = sessionRecords.filter(
    (record) => record.type === "assistant" && record.content === FINAL_TEXT,
  );
  if (finals.length !== 1) {
    throw new Error("installed carrier ledger omitted the single truthful final response");
  }
  if (sessionRecords.some((record) => record.type === "review_requested")) {
    throw new Error("installed carrier created a pending review event");
  }

  const typedAudit = auditRecordFor(auditRecords, "symlink-deny-typed-write");
  const bashAudit = auditRecordFor(auditRecords, "symlink-deny-bash-touch");
  if (typedAudit?.eventType !== "tool.deny" || typedAudit.payload?.toolName !== "write") {
    throw evidenceError(
      "installed carrier typed denial was not attributable",
      typedAudit,
      sensitivePaths,
    );
  }
  if (
    bashAudit?.eventType !== "tool.deny" ||
    bashAudit.payload?.toolName !== "bash" ||
    bashAudit.policy?.verdict !== "deny" ||
    !bashAudit.policy?.ruleIds?.includes("POL-002")
  ) {
    throw evidenceError("installed carrier Bash denial was not POL-002", bashAudit, sensitivePaths);
  }
  const tempFact = bashAudit.sideEffect?.extensions?.["keel.temp"];
  const expectedTempFact = {
    resolvedWriteTargets: [bashTarget],
    declaredWriteTargets: [],
  };
  if (JSON.stringify(tempFact) !== JSON.stringify(expectedTempFact)) {
    throw evidenceError("installed carrier keel.temp fact drifted", tempFact, sensitivePaths);
  }
  if (
    auditRecords.some(
      (record) => record.eventType === "review.requested" || record.payload?.reviewId !== undefined,
    )
  ) {
    throw new Error("installed carrier audit created a pending review");
  }
  if (typedAudit.seq >= bashAudit.seq) {
    throw new Error("installed carrier deny audit order drifted");
  }
  if (!isAbsolute(workspace) || !isAbsolute(typedTarget) || !isAbsolute(bashTarget)) {
    throw new Error("installed carrier evidence paths were not absolute");
  }
}

function validSelfTestEvidence() {
  const workspace = "/private/tmp/symlink-deny/workspace";
  const outside = "/private/tmp/symlink-deny/outside";
  const typedTarget = `${outside}/typed-escape.txt`;
  const bashTarget = `${outside}/bash-escape.txt`;
  return {
    exit: { code: 1, signal: null },
    stdout: `${FINAL_TEXT}\n`,
    stderr: "",
    workspace,
    outside,
    typedTarget,
    bashTarget,
    typedTargetExists: false,
    bashTargetExists: false,
    processGroupState: "reaped",
    sessionRecords: [
      {
        type: "assistant",
        toolCalls: [{ id: "symlink-deny-typed-write", name: "write" }],
      },
      {
        type: "tool_result",
        toolCallId: "symlink-deny-typed-write",
        name: "write",
        output: "blocked by warden (not executed)",
      },
      {
        type: "assistant",
        toolCalls: [{ id: "symlink-deny-bash-touch", name: "bash" }],
      },
      {
        type: "tool_result",
        toolCallId: "symlink-deny-bash-touch",
        name: "bash",
        output: "blocked by warden (not executed): POL-002 deny",
      },
      { type: "assistant", content: FINAL_TEXT },
    ],
    auditRecords: [
      {
        seq: 1,
        eventType: "tool.deny",
        payload: { toolCallId: "symlink-deny-typed-write", toolName: "write" },
      },
      {
        seq: 2,
        eventType: "tool.deny",
        payload: { toolCallId: "symlink-deny-bash-touch", toolName: "bash" },
        policy: { verdict: "deny", ruleIds: ["POL-002"] },
        sideEffect: {
          extensions: {
            "keel.temp": { resolvedWriteTargets: [bashTarget], declaredWriteTargets: [] },
          },
        },
      },
    ],
  };
}

function runSelfTest() {
  const valid = validSelfTestEvidence();
  assertBashSymlinkDenyEvidence(valid);
  const rejected = [
    ["exit", { ...valid, exit: { code: 0, signal: null } }],
    ["typed-canary", { ...valid, typedTargetExists: true }],
    ["bash-canary", { ...valid, bashTargetExists: true }],
    ["process-group", { ...valid, processGroupState: "owned" }],
    ["public-path-leak", { ...valid, stdout: `${FINAL_TEXT}\n${valid.outside}\n` }],
    [
      "malformed-denial-diagnostic-redaction",
      {
        ...valid,
        sessionRecords: valid.sessionRecords.map((record) =>
          record.toolCallId === "symlink-deny-typed-write"
            ? {
                ...record,
                output: `unexpected ${valid.outside} ${valid.workspace} ${valid.typedTarget} ${valid.bashTarget}`,
              }
            : record,
        ),
      },
    ],
    [
      "review-route-diagnostic-redaction",
      {
        ...valid,
        sessionRecords: valid.sessionRecords.map((record) =>
          record.toolCallId === "symlink-deny-typed-write"
            ? {
                ...record,
                output: `blocked by warden (not executed): review required review_escape ${valid.outside} ${valid.workspace}`,
              }
            : record,
        ),
      },
    ],
    [
      "tool-result-path-leak-redaction",
      {
        ...valid,
        sessionRecords: valid.sessionRecords.map((record) =>
          record.toolCallId === "symlink-deny-typed-write"
            ? {
                ...record,
                output: `blocked by warden (not executed): ${valid.outside} ${valid.workspace} ${valid.typedTarget} ${valid.bashTarget}`,
              }
            : record,
        ),
      },
    ],
    [
      "bash-guidance",
      {
        ...valid,
        sessionRecords: valid.sessionRecords.map((record) =>
          record.toolCallId === "symlink-deny-bash-touch"
            ? { ...record, output: "blocked" }
            : record,
        ),
      },
    ],
    [
      "typed-audit-diagnostic-redaction",
      {
        ...valid,
        auditRecords: valid.auditRecords.map((record) =>
          record.payload?.toolCallId === "symlink-deny-typed-write"
            ? {
                ...record,
                eventType: "tool.allow",
                payload: {
                  ...record.payload,
                  detail: `${valid.outside} ${valid.workspace} ${valid.typedTarget}`,
                },
              }
            : record,
        ),
      },
    ],
    [
      "bash-audit-diagnostic-redaction",
      {
        ...valid,
        auditRecords: valid.auditRecords.map((record) =>
          record.payload?.toolCallId === "symlink-deny-bash-touch"
            ? {
                ...record,
                policy: {
                  verdict: "review",
                  ruleIds: ["POL-003"],
                  detail: `${valid.outside} ${valid.workspace} ${valid.bashTarget}`,
                },
              }
            : record,
        ),
      },
    ],
    [
      "temp-fact-diagnostic-redaction",
      {
        ...valid,
        auditRecords: valid.auditRecords.map((record) =>
          record.payload?.toolCallId === "symlink-deny-bash-touch"
            ? {
                ...record,
                sideEffect: {
                  extensions: {
                    "keel.temp": {
                      resolvedWriteTargets: [valid.bashTarget, valid.outside],
                      declaredWriteTargets: [valid.typedTarget, valid.workspace],
                    },
                  },
                },
              }
            : record,
        ),
      },
    ],
  ];
  for (const [label, evidence] of rejected) {
    let thrown;
    try {
      assertBashSymlinkDenyEvidence(evidence);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, label);
    for (const path of [valid.outside, valid.workspace, valid.typedTarget, valid.bashTarget]) {
      assert.equal(thrown.message.includes(path), false, `${label} diagnostic leaked a path`);
    }
  }
  process.stdout.write(
    `installed Bash symlink denial oracle self-test passed ${rejected.map(([label]) => `rejected:${label}`).join(" ")}\n`,
  );
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

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectValue(error);
      },
    );
  });
}

function recording(typedPath, bashPath) {
  return {
    version: 1,
    provider: "replay",
    model: "installed-symlink-deny",
    turns: [
      {
        chunks: [
          {
            type: "tool-call",
            id: "symlink-deny-typed-write",
            name: "write",
            args: { path: typedPath, content: "must-not-escape" },
          },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 8, outputTokens: 4 } },
        ],
      },
      {
        chunks: [
          {
            type: "tool-call",
            id: "symlink-deny-bash-touch",
            name: "bash",
            args: { command: `touch ${bashPath}` },
          },
          { type: "finish", reason: "tool-calls", usage: { inputTokens: 12, outputTokens: 4 } },
        ],
      },
      {
        chunks: [
          { type: "text-delta", text: FINAL_TEXT },
          { type: "finish", reason: "stop", usage: { inputTokens: 16, outputTokens: 18 } },
        ],
      },
    ],
  };
}

async function runInstalledCarrier(binaryArg) {
  const keelBin = resolve(binaryArg);
  if (!isAbsolute(keelBin) || !existsSync(keelBin)) {
    throw new Error(`installed Keel launcher is missing: ${keelBin}`);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-npx-bash-symlink-deny-")));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const keelHome = join(root, "keel-home");
  const recordingPath = join(root, "recording.json");
  const typedRelative = "outside-link/typed-escape.txt";
  const bashRelative = "outside-link/bash-escape.txt";
  const typedTarget = join(outside, "typed-escape.txt");
  const bashTarget = join(outside, "bash-escape.txt");
  let controlled;
  let processGroupState = "unstarted";
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "outside-link"), "dir");
    writeFileSync(
      recordingPath,
      `${JSON.stringify(recording(typedRelative, bashRelative), null, 2)}\n`,
      { mode: 0o600 },
    );
    const inheritedKeys = ["LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];
    const environment = Object.fromEntries(
      inheritedKeys.flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    Object.assign(environment, {
      HOME: join(root, "home"),
      KEEL_HOME: keelHome,
      KEEL_WARDEN_SANDBOX: "srt",
      NO_COLOR: "1",
    });
    controlled = spawnControlledTarget(
      keelBin,
      [
        "run",
        "-p",
        "attempt both requested outside writes, then report the result",
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
    controlled.child.stdout.on("data", (chunk) => {
      stdoutCapture.append(chunk);
    });
    controlled.child.stderr.on("data", (chunk) => {
      stderrCapture.append(chunk);
    });
    const exit = await withTimeout(
      controlled.waitTargetExit(),
      30_000,
      "installed carrier exceeded 30 seconds",
    );
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 25));
    if (stdoutCapture.error !== undefined) throw stdoutCapture.error;
    if (stderrCapture.error !== undefined) throw stderrCapture.error;
    processGroupState = await terminateProcessGroup(
      controlled.processGroupLease,
      controlled.guardianExit,
    );
    const sessionRecords = readRecords(join(keelHome, "sessions"));
    const auditRecords = readRecords(join(keelHome, "audit"));
    assertBashSymlinkDenyEvidence({
      exit,
      stdout: stdoutCapture.text,
      stderr: stderrCapture.text,
      workspace,
      outside,
      typedTarget,
      bashTarget,
      typedTargetExists: existsSync(typedTarget),
      bashTargetExists: existsSync(bashTarget),
      sessionRecords,
      auditRecords,
      processGroupState,
    });
    process.stdout.write("installed npx Bash symlink terminal denial smoke passed\n");
  } finally {
    if (controlled?.processGroupLease?.state === "owned") {
      await terminateProcessGroup(controlled.processGroupLease, controlled.guardianExit);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === SELF_TEST) {
  runSelfTest();
} else {
  const binaryArg = process.argv[2];
  if (binaryArg === undefined) {
    throw new Error("usage: node packaging/smoke-bash-symlink-deny.mjs <installed-keel-bin>");
  }
  await runInstalledCarrier(binaryArg);
}
