#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { terminateProcessGroup } from "./process-group-cleanup.mjs";
import { spawnControlledTarget } from "./process-group-controller.mjs";

const SELF_TEST = "--self-test";

export function createCanonicalTemporaryRoot() {
  const requestedRoot = join(tmpdir(), `keel-compiled-warden-${process.pid}-${randomUUID()}`);
  mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  return realpathSync(requestedRoot);
}

export function assertCompiledWardenEvidence({
  status,
  allowed,
  sandboxProbe,
  denied,
  sandboxTargetExists,
  deniedTargetExists,
  workspace,
  auditRecords,
}) {
  if (status.enforcementTier !== "sandbox:srt" || status.sandboxBackend !== "srt:vendored") {
    throw new Error(`compiled warden is not enforcing SRT: ${JSON.stringify(status)}`);
  }
  if (allowed.verdict !== "allow") {
    throw new Error(
      `compiled warden did not allow the contained probe: ${JSON.stringify(allowed)}`,
    );
  }
  if (
    allowed.result === null ||
    typeof allowed.result !== "object" ||
    allowed.result.exitCode !== 0 ||
    allowed.result.stdout !== `${workspace}\n`
  ) {
    throw new Error(`contained probe failed: ${JSON.stringify(allowed)}`);
  }
  if (
    sandboxProbe.verdict !== "allow" ||
    sandboxProbe.result === null ||
    typeof sandboxProbe.result !== "object" ||
    !Number.isInteger(sandboxProbe.result.exitCode) ||
    sandboxProbe.result.exitCode === 0 ||
    sandboxTargetExists
  ) {
    throw new Error(`compiled SRT allowed a symlink write escape: ${JSON.stringify(sandboxProbe)}`);
  }
  if (
    denied.verdict !== "deny" ||
    typeof denied.guidance !== "string" ||
    !denied.guidance.includes("POL-002")
  ) {
    throw new Error(`compiled warden did not deny the outside write: ${JSON.stringify(denied)}`);
  }
  const sequences = [allowed.auditSeq, sandboxProbe.auditSeq, denied.auditSeq];
  if (
    sequences.some((sequence) => !Number.isInteger(sequence)) ||
    !(sequences[0] < sequences[1] && sequences[1] < sequences[2])
  ) {
    throw new Error(`compiled warden audit sequence did not advance: ${JSON.stringify(sequences)}`);
  }
  if (deniedTargetExists) throw new Error("compiled warden created the denied target");
  const expectedAudit = [
    [allowed.auditSeq, "tc_allow", "bash", "tool.execute"],
    [sandboxProbe.auditSeq, "tc_sandbox", "bash", "tool.execute"],
    [denied.auditSeq, "tc_deny", "write", "tool.deny"],
  ];
  for (const [sequence, toolCallId, toolName, eventType] of expectedAudit) {
    const record = auditRecords.find((candidate) => candidate.seq === sequence);
    if (
      record?.eventType !== eventType ||
      record.payload?.toolCallId !== toolCallId ||
      record.payload?.toolName !== toolName
    ) {
      throw new Error(
        `compiled warden audit attribution mismatch: ${JSON.stringify({ sequence, toolCallId, toolName, eventType, record })}`,
      );
    }
  }
}

export function assertCleanShutdown(exit) {
  if (exit?.code !== 0 || exit.signal !== null) {
    throw new Error(`compiled warden did not shut down cleanly: ${JSON.stringify(exit)}`);
  }
}

export function rejectPendingOnExit(pending, exit) {
  const error = new Error(`compiled warden exited early: ${exit.code ?? exit.signal}`);
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}

export function appendReadinessOutput(buffer, chunk) {
  const next = `${buffer}${String(chunk)}`.slice(-4_096);
  return { buffer: next, ready: /(?:^|\n)ready(?:\r?\n|$)/u.test(next) };
}

async function terminateSpawnedChild(processGroupLease, child, guardianExit) {
  if (processGroupLease === undefined) {
    if (child.exitCode === null && child.pid !== undefined) child.kill("SIGTERM");
    await Promise.race([
      guardianExit,
      new Promise((resolveExit) => setTimeout(resolveExit, 1_000)),
    ]);
    if (child.exitCode === null && child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    return;
  }
  await terminateProcessGroup(processGroupLease, guardianExit);
}

async function assertProcessGroupCleanup() {
  if (process.platform === "win32") return "process-group-reaped:not-applicable-windows";
  const descendantScript = [
    'process.on("SIGTERM", () => {})',
    'process.stdout.write("resistant-ready\\n")',
    "setInterval(() => {}, 1000)",
  ].join(";");
  const leaderScript = [
    'const { spawn } = require("node:child_process")',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", "pipe", "ignore"] })`,
    'descendant.stdout.setEncoding("utf8")',
    'let descendantReadiness = ""',
    'const onDescendantData = chunk => { descendantReadiness = (descendantReadiness + String(chunk)).slice(-256); if (!descendantReadiness.includes("resistant-ready\\n")) return; descendant.stdout.off("data", onDescendantData); process.stdout.write("ready\\n") }',
    'descendant.stdout.on("data", onDescendantData)',
    "setInterval(() => {}, 1000)",
  ].join(";");
  const { child, guardianExit, processGroupLease } = spawnControlledTarget(
    process.execPath,
    ["-e", leaderScript],
    {},
  );
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error("process-group cleanup self-test did not become ready")),
      1_000,
    );
    child.stdout.setEncoding("utf8");
    let readiness = { buffer: "", ready: false };
    const onData = (chunk) => {
      readiness = appendReadinessOutput(readiness.buffer, chunk);
      if (!readiness.ready) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolveReady();
    };
    child.stdout.on("data", onData);
  });
  try {
    await ready;
    await terminateProcessGroup(processGroupLease, guardianExit);
    if (processGroupLease.state !== "reaped")
      throw new Error("process-group guardian was not reaped");
    return "process-group-reaped";
  } finally {
    await terminateProcessGroup(processGroupLease, guardianExit);
  }
}

async function runSelfTest() {
  const canonicalRoot = createCanonicalTemporaryRoot();
  try {
    if (canonicalRoot !== realpathSync(canonicalRoot)) {
      throw new Error(`compiled warden temporary root is not canonical: ${canonicalRoot}`);
    }
  } finally {
    rmSync(canonicalRoot, { recursive: true, force: true });
  }
  const partialReadiness = appendReadinessOutput("", "re");
  const completeReadiness = appendReadinessOutput(partialReadiness.buffer, "ady\n");
  if (partialReadiness.ready || !completeReadiness.ready) {
    throw new Error("process-group readiness framing self-test failed");
  }
  const valid = {
    status: { enforcementTier: "sandbox:srt", sandboxBackend: "srt:vendored" },
    allowed: { verdict: "allow", auditSeq: 1, result: { exitCode: 0, stdout: "/workspace\n" } },
    sandboxProbe: { verdict: "allow", auditSeq: 2, result: { exitCode: 1, stdout: "" } },
    denied: { verdict: "deny", auditSeq: 3, guidance: "POL-002 deny" },
    sandboxTargetExists: false,
    deniedTargetExists: false,
    workspace: "/workspace",
    auditRecords: [
      { seq: 1, eventType: "tool.execute", payload: { toolCallId: "tc_allow", toolName: "bash" } },
      {
        seq: 2,
        eventType: "tool.execute",
        payload: { toolCallId: "tc_sandbox", toolName: "bash" },
      },
      { seq: 3, eventType: "tool.deny", payload: { toolCallId: "tc_deny", toolName: "write" } },
    ],
  };
  assertCompiledWardenEvidence(valid);
  const withAuditField = (index, field, value) => ({
    ...valid,
    auditRecords: valid.auditRecords.map((record, candidateIndex) =>
      candidateIndex !== index
        ? record
        : field === "eventType"
          ? { ...record, eventType: value }
          : { ...record, payload: { ...record.payload, [field]: value } },
    ),
  });
  const rejected = [
    ["status.enforcementTier", { ...valid, status: { ...valid.status, enforcementTier: "none" } }],
    ["status.sandboxBackend", { ...valid, status: { ...valid.status, sandboxBackend: "none" } }],
    ["allowed.verdict", { ...valid, allowed: { ...valid.allowed, verdict: "review" } }],
    ["allowed.result", { ...valid, allowed: { ...valid.allowed, result: null } }],
    [
      "allowed.result.exitCode",
      { ...valid, allowed: { ...valid.allowed, result: { ...valid.allowed.result, exitCode: 1 } } },
    ],
    [
      "allowed.result.stdout",
      {
        ...valid,
        allowed: { ...valid.allowed, result: { ...valid.allowed.result, stdout: "/wrong\n" } },
      },
    ],
    [
      "sandboxProbe.verdict",
      { ...valid, sandboxProbe: { ...valid.sandboxProbe, verdict: "deny" } },
    ],
    ["sandboxProbe.result", { ...valid, sandboxProbe: { ...valid.sandboxProbe, result: null } }],
    [
      "sandboxProbe.result.exitCode.type",
      {
        ...valid,
        sandboxProbe: {
          ...valid.sandboxProbe,
          result: { ...valid.sandboxProbe.result, exitCode: "1" },
        },
      },
    ],
    [
      "sandboxProbe.result.exitCode.zero",
      {
        ...valid,
        sandboxProbe: {
          ...valid.sandboxProbe,
          result: { ...valid.sandboxProbe.result, exitCode: 0 },
        },
      },
    ],
    ["denied.verdict", { ...valid, denied: { ...valid.denied, verdict: "review" } }],
    ["denied.guidance.missing", { ...valid, denied: { ...valid.denied, guidance: undefined } }],
    ["denied.guidance.policy", { ...valid, denied: { ...valid.denied, guidance: "POL-999" } }],
    ["allowed.auditSeq", { ...valid, allowed: { ...valid.allowed, auditSeq: "1" } }],
    ["sandboxProbe.auditSeq", { ...valid, sandboxProbe: { ...valid.sandboxProbe, auditSeq: 1 } }],
    ["denied.auditSeq", { ...valid, denied: { ...valid.denied, auditSeq: 2 } }],
    ["sandboxTargetExists", { ...valid, sandboxTargetExists: true }],
    ["deniedTargetExists", { ...valid, deniedTargetExists: true }],
    ["audit.record.missing", { ...valid, auditRecords: valid.auditRecords.slice(0, 2) }],
    ["audit.allowed.eventType", withAuditField(0, "eventType", "tool.deny")],
    ["audit.allowed.toolCallId", withAuditField(0, "toolCallId", "tc_wrong")],
    ["audit.allowed.toolName", withAuditField(0, "toolName", "write")],
    ["audit.sandbox.eventType", withAuditField(1, "eventType", "tool.deny")],
    ["audit.sandbox.toolCallId", withAuditField(1, "toolCallId", "tc_wrong")],
    ["audit.sandbox.toolName", withAuditField(1, "toolName", "write")],
    ["audit.denied.eventType", withAuditField(2, "eventType", "tool.execute")],
    ["audit.denied.toolCallId", withAuditField(2, "toolCallId", "tc_wrong")],
    ["audit.denied.toolName", withAuditField(2, "toolName", "bash")],
  ];
  const rejectedLabels = [];
  for (const [label, fixture] of rejected) {
    let failed = false;
    try {
      assertCompiledWardenEvidence(fixture);
    } catch {
      failed = true;
    }
    if (!failed)
      throw new Error(
        `compiled-writer self-test accepted invalid ${label}: ${JSON.stringify(fixture)}`,
      );
    rejectedLabels.push(`rejected:${label}`);
  }
  for (const exit of [
    { code: 1, signal: null },
    { code: null, signal: "SIGTERM" },
  ]) {
    let failed = false;
    try {
      assertCleanShutdown(exit);
    } catch {
      failed = true;
    }
    if (!failed)
      throw new Error(`shutdown self-test accepted invalid exit: ${JSON.stringify(exit)}`);
  }
  assertCleanShutdown({ code: 0, signal: null });
  let pendingRejected = false;
  const pending = new Map([
    [
      "request",
      {
        reject: () => {
          pendingRejected = true;
        },
      },
    ],
  ]);
  rejectPendingOnExit(pending, { code: 9, signal: null });
  if (!pendingRejected || pending.size !== 0) {
    throw new Error("pending-request exit self-test did not reject and clear waiters");
  }
  const processGroupEvidence = await assertProcessGroupCleanup();
  console.log(
    `compiled warden evidence and lifecycle self-test passed canonical-temp-root ${processGroupEvidence} ${rejectedLabels.join(" ")}`,
  );
}

async function run(binaryArg) {
  const binary = isAbsolute(binaryArg) ? binaryArg : resolve(process.cwd(), binaryArg);
  if (!existsSync(binary)) throw new Error(`native keel binary does not exist: ${binary}`);

  const root = createCanonicalTemporaryRoot();
  const workspacePath = join(root, "workspace");
  const keelHome = join(root, "keel-home");
  const sandboxTarget = join(root, "sandbox-escape.txt");
  const deniedTarget = join(
    homedir(),
    `.keel-compiled-warden-denied-${process.pid}-${randomUUID()}.txt`,
  );
  mkdirSync(workspacePath, { recursive: true });
  const workspace = realpathSync(workspacePath);
  symlinkSync(sandboxTarget, join(workspace, "escape-link"));
  if (existsSync(sandboxTarget)) throw new Error(`sandbox target already exists: ${sandboxTarget}`);
  if (existsSync(deniedTarget)) throw new Error(`denied target already exists: ${deniedTarget}`);
  const escapeCommand = "printf must-not-escape > escape-link";
  const positiveControl = spawnSync("sh", ["-c", escapeCommand], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (positiveControl.status !== 0 || readFileSync(sandboxTarget, "utf8") !== "must-not-escape") {
    throw new Error(
      `unsandboxed symlink-write control failed: ${JSON.stringify({ status: positiveControl.status, signal: positiveControl.signal, stderr: positiveControl.stderr })}`,
    );
  }
  rmSync(sandboxTarget);
  writeFileSync(deniedTarget, "host-write-positive-control");
  if (!existsSync(deniedTarget))
    throw new Error(`host denied-target control failed: ${deniedTarget}`);
  rmSync(deniedTarget);

  const inheritedKeys = ["LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER"];
  const environment = Object.fromEntries(
    inheritedKeys.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );
  Object.assign(environment, {
    HOME: keelHome,
    KEEL_HOME: keelHome,
    KEEL_INTERNAL_WARDEN_STDIO: "1",
    KEEL_WARDEN_AUDIT_DIR: join(keelHome, "audit"),
    KEEL_WARDEN_SANDBOX: "srt",
    KEEL_WARDEN_WORKSPACE_ROOT: workspace,
    KEEL_WARDEN_WORKSPACE_TRUSTED: "1",
  });

  const { child, guardianExit, waitTargetExit, processGroupLease } = spawnControlledTarget(
    binary,
    [],
    {
      cwd: workspace,
      env: environment,
    },
  );
  const targetExit = waitTargetExit();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8_192);
  });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(response.id);
    if (waiter !== undefined) {
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });
  void targetExit.then(
    (exit) => rejectPendingOnExit(pending, exit),
    (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    },
  );

  function request(id, method, params) {
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`timed out waiting for ${method}`));
      }, 20_000);
      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolveRequest(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectRequest(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      );
    });
  }

  function resultOf(response, label) {
    if (response === null || typeof response !== "object" || !("result" in response)) {
      throw new Error(`${label} failed: ${JSON.stringify(response)}`);
    }
    return response.result;
  }

  try {
    resultOf(
      await request("hello", "warden.hello", {
        kernelVersion: "0.0.0",
        protocolVersion: "1.0.0",
      }),
      "warden.hello",
    );
    const status = resultOf(await request("status", "warden.status"), "warden.status");
    const sessionId = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const allowed = resultOf(
      await request("allow", "warden.execute", {
        sessionId,
        toolCall: { id: "tc_allow", name: "bash", args: { command: "pwd" } },
        provenanceContext: { inputTags: ["workspace"] },
      }),
      "allowed warden.execute",
    );
    if (allowed.result?.stdout.trim() !== workspace) {
      throw new Error(`contained probe returned unexpected evidence: ${JSON.stringify(allowed)}`);
    }
    const sandboxProbe = resultOf(
      await request("sandbox-deny-write", "warden.execute", {
        sessionId,
        toolCall: {
          id: "tc_sandbox",
          name: "bash",
          args: { command: escapeCommand },
        },
        provenanceContext: { inputTags: ["workspace"] },
      }),
      "sandbox denied-write warden.execute",
    );
    const denied = resultOf(
      await request("policy-deny", "warden.execute", {
        sessionId,
        toolCall: {
          id: "tc_deny",
          name: "write",
          args: { path: deniedTarget, content: "must-not-write" },
        },
        provenanceContext: { inputTags: ["user"] },
      }),
      "policy denied warden.execute",
    );
    const auditPath = join(keelHome, "audit", `${sessionId}.jsonl`);
    const auditRecords = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assertCompiledWardenEvidence({
      status,
      allowed,
      sandboxProbe,
      denied,
      sandboxTargetExists: existsSync(sandboxTarget),
      deniedTargetExists: existsSync(deniedTarget),
      workspace,
      auditRecords,
    });
    resultOf(await request("shutdown", "warden.shutdown", {}), "warden.shutdown");
    const exit = await Promise.race([
      targetExit,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("compiled warden did not exit after shutdown")), 2_000),
      ),
    ]);
    assertCleanShutdown(exit);
    console.log(
      `compiled warden enforcement smoke passed: ${basename(binary)} · sandbox:srt · symlink escape denied + POL-002 deny`,
    );
  } catch (error) {
    if (stderr) process.stderr.write(`compiled warden stderr:\n${stderr}\n`);
    throw error;
  } finally {
    lines.close();
    child.stdin.end();
    await terminateSpawnedChild(processGroupLease, child, guardianExit);
    rmSync(root, { recursive: true, force: true });
    rmSync(deniedTarget, { force: true });
  }
}

if (process.argv[2] === SELF_TEST) {
  await runSelfTest();
} else {
  const binaryArg = process.argv[2];
  if (binaryArg === undefined) {
    throw new Error("usage: node packaging/smoke-compiled-warden.mjs <native-keel-binary>");
  }
  await run(binaryArg);
}
