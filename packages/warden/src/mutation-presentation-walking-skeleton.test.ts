import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  JsonRpcSuccessResponse,
  MutationPresentationV1,
  PROTOCOL_VERSION,
  type MutationPresentationV1T,
} from "@keel/shared";
import { describe, expect, it, vi } from "vitest";
import { AuditChainWriter } from "./audit/writer.js";
import { constructMutationPresentationArtifact } from "./mutation-presentation-constructor.js";
import { createMutationPresentationWalkingSkeletonTransport } from "./mutation-presentation-walking-skeleton.js";
import type { PolicyPort } from "./policy.js";
import { handleRpcLine, runStdioWardenServer } from "./rpc-server.js";
import type { SandboxPort } from "./sandbox.js";
import {
  createSandboxTypedMutationRunner,
  type TypedMutationRunner,
} from "./typed-mutation-runner.js";
import { createTypedToolState } from "./typed-tools.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OLD = "alpha\nOBSERVED-WARDEN-PREIMAGE\nomega\n";
const NEXT = "alpha\nVERIFIED-WARDEN-POSTIMAGE\nomega\n";

const ALLOW_POLICY: PolicyPort = {
  packRef: { name: "walking-skeleton-allow", hash: `sha256:${"1".repeat(64)}` },
  evaluate: async () => ({ verdict: "allow", matchedRules: [] }),
};

class RpcLines {
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string) => void> = [];
  #buffer = "";

  constructor(output: PassThrough) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#lines.push(line);
        else waiter(line);
      }
    });
  }

  next(): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

function request(id: string, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

function literal(text: string) {
  return { segments: [{ kind: "literal" as const, text }], redactionCount: 0 };
}

describe("Epic 3.10 Slice 2B Warden mutation-presentation walking skeleton", () => {
  it("settles constructor failure as sanitized presentation unavailability", async () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct() {
        throw new Error(`must not escape: ${OLD}`);
      },
    });
    const candidate = {
      operation: "edit" as const,
      displayPath: "example.ts",
      observedBefore: {
        content: OLD,
        sha256: `sha256:${"a".repeat(64)}`,
        bytes: Buffer.byteLength(OLD),
        mode: 0o644,
      },
      verifiedInstalledAfter: {
        content: NEXT,
        sha256: `sha256:${"b".repeat(64)}`,
        bytes: Buffer.byteLength(NEXT),
        mode: 0o644,
      },
      sessionId: SESSION_ID,
      toolCallId: "edit-construction-failure",
      auditSeq: 1,
    };

    const admission = transport.reserve(
      { sessionId: candidate.sessionId, toolCallId: candidate.toolCallId },
      {
        observedBeforeBytes: candidate.observedBefore.bytes,
        verifiedInstalledAfterBytes: candidate.verifiedInstalledAfter.bytes,
      },
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");
    expect(() =>
      transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate }),
    ).not.toThrow();
    await vi.waitFor(() => expect(transport.terminalUsage().dispositions).toBe(1));
    expect(
      transport.take({
        sessionId: candidate.sessionId,
        toolCallId: candidate.toolCallId,
        auditSeq: candidate.auditSeq,
      }),
    ).toEqual({ status: "unavailable", reason: "redaction-failed" });
  });

  it("settles a missing write constructor as sanitized presentation unavailability", async () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct() {
        throw new Error("edit constructor must not be called for a write");
      },
    });
    const installed = "bounded write\n";
    const candidate = {
      operation: "write" as const,
      displayPath: "missing-write-constructor.txt",
      observedBefore: { status: "absent-observed" as const },
      verifiedInstalledAfter: {
        content: installed,
        sha256: `sha256:${"c".repeat(64)}`,
        bytes: Buffer.byteLength(installed),
        mode: 0o644,
      },
      sessionId: SESSION_ID,
      toolCallId: "write-construction-unavailable",
      auditSeq: 2,
    };
    const admission = transport.reserve(
      { sessionId: candidate.sessionId, toolCallId: candidate.toolCallId },
      {
        observedBeforeBytes: 0,
        verifiedInstalledAfterBytes: candidate.verifiedInstalledAfter.bytes,
      },
    );
    if (admission.status !== "reserved") throw new Error("expected reservation");

    transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate });

    await vi.waitFor(() => expect(transport.terminalUsage().dispositions).toBe(1));
    expect(
      transport.take({
        sessionId: candidate.sessionId,
        toolCallId: candidate.toolCallId,
        auditSeq: candidate.auditSeq,
      }),
    ).toEqual({ status: "unavailable", reason: "redaction-failed" });
  });

  it("cannot repopulate the process-local entry after shutdown clear", async () => {
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct(candidate) {
        return MutationPresentationV1.parse({
          schemaVersion: "mutation-presentation/v1",
          producer: "warden-typed-mutation",
          operation: "edit",
          auditSeq: candidate.auditSeq,
          displayPath: literal(candidate.displayPath),
          pathIdentity: "closed-transport-path",
          observedBefore: {
            status: "file-observed",
            sha256: candidate.observedBefore.sha256,
            bytes: candidate.observedBefore.bytes,
            mode: candidate.observedBefore.mode,
            contentClass: "text",
            finalNewline: true,
          },
          verifiedInstalledAfter: {
            status: "file-observed",
            sha256: candidate.verifiedInstalledAfter.sha256,
            bytes: candidate.verifiedInstalledAfter.bytes,
            mode: candidate.verifiedInstalledAfter.mode,
            contentClass: "text",
            finalNewline: true,
          },
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
          comparison: {
            coverage: "summary-only",
            totals: {
              observedBeforeLines: "unknown",
              installedAfterLines: "unknown",
              shownLines: 0,
              hiddenLines: "unknown",
            },
            hunks: [],
            redactionCount: 0,
          },
          freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
        });
      },
    });
    const candidate = {
      operation: "edit" as const,
      displayPath: "example.ts",
      observedBefore: {
        content: OLD,
        sha256: `sha256:${"a".repeat(64)}`,
        bytes: Buffer.byteLength(OLD),
        mode: 0o644,
      },
      verifiedInstalledAfter: {
        content: NEXT,
        sha256: `sha256:${"b".repeat(64)}`,
        bytes: Buffer.byteLength(NEXT),
        mode: 0o644,
      },
      sessionId: SESSION_ID,
      toolCallId: "edit-after-clear",
      auditSeq: 2,
    };

    await transport.clear();
    expect(
      transport.reserve(
        { sessionId: candidate.sessionId, toolCallId: candidate.toolCallId },
        {
          observedBeforeBytes: candidate.observedBefore.bytes,
          verifiedInstalledAfterBytes: candidate.verifiedInstalledAfter.bytes,
        },
      ),
    ).toEqual({ status: "refused", reason: "capture-budget" });

    expect(
      transport.take({
        sessionId: candidate.sessionId,
        toolCallId: candidate.toolCallId,
        auditSeq: candidate.auditSeq,
      }),
    ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });
  });

  it("does not enable capture from a rejected protocol-major handshake", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-warden-presentation-handshake-"));
    const workspace = join(root, "workspace");
    const auditPath = join(root, "audit.jsonl");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "example.ts"), OLD, { mode: 0o644 });
    let captureRequested = false;
    const runner: TypedMutationRunner = {
      assertReady: () => undefined,
      execute: async (mutationRequest) => {
        captureRequested =
          mutationRequest.capturePresentation === true ||
          mutationRequest.mutation.presentationObservation !== undefined;
        mutationRequest.mutation.runInProcessAtomicWrite();
        return { mutation: "committed", cleanup: "complete" };
      },
      quarantine: () => ({ cleanup: "complete" }),
      close: () => ({ cleanup: "complete" }),
    };
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct() {
        throw new Error("no candidate expected");
      },
    });
    const audit = AuditChainWriter.open({
      path: auditPath,
      principal: {
        osUser: "walking-skeleton",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = new RpcLines(output);
    const server = runStdioWardenServer({
      input,
      output,
      sandbox: {
        status: () => ({
          available: true,
          backend: "handshake-fixture",
          enforcementTier: "sandbox:handshake-fixture",
        }),
        execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      },
      workspaceRoot: workspace,
      workspaceTrusted: true,
      policy: ALLOW_POLICY,
      auditWriter: audit,
      typedMutationRunner: runner,
      mutationPresentation: transport,
    });

    try {
      input.write(
        request("hello-old", "warden.hello", {
          kernelVersion: "0.0.0",
          protocolVersion: "1.0.0",
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      input.write(
        request("read-old", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: { id: "read-old", name: "read", args: { path: "example.ts" } },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      input.write(
        request("write-old", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "write-old",
            name: "write",
            args: { path: "old-peer.txt", content: "old peer write" },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(captureRequested).toBe(false);
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });

      input.write(
        request("hello-rejected", "warden.hello", {
          kernelVersion: "0.0.0",
          protocolVersion: "2.1.0",
        }),
      );
      const rejected = JSON.parse(await lines.next()) as { error?: { code?: number } };
      expect(rejected.error?.code).toBe(-32000);

      input.write(
        request("edit-after-rejected", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-after-rejected",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "OBSERVED-WARDEN-PREIMAGE",
              newString: "VERIFIED-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(captureRequested).toBe(false);
    } finally {
      await server.close();
      audit.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reserves before capture and returns capture-budget without changing a committed edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-warden-presentation-admission-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "example.ts"), OLD, { mode: 0o644 });
    let captureRequested = false;
    const runner: TypedMutationRunner = {
      assertReady: () => undefined,
      execute: async (mutationRequest) => {
        captureRequested =
          mutationRequest.capturePresentation === true ||
          mutationRequest.mutation.presentationObservation !== undefined;
        mutationRequest.mutation.runInProcessAtomicWrite();
        return { mutation: "committed", cleanup: "complete" };
      },
      quarantine: () => ({ cleanup: "complete" }),
      close: () => ({ cleanup: "complete" }),
    };
    let constructed = false;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct() {
        constructed = true;
        throw new Error("budget refusal cannot construct");
      },
    });
    const first = transport.reserve(
      { sessionId: SESSION_ID, toolCallId: "occupy-1" },
      { observedBeforeBytes: 1, verifiedInstalledAfterBytes: 1 },
    );
    const second = transport.reserve(
      { sessionId: SESSION_ID, toolCallId: "occupy-2" },
      { observedBeforeBytes: 1, verifiedInstalledAfterBytes: 1 },
    );
    expect(first.status).toBe("reserved");
    expect(second.status).toBe("reserved");

    const audit = AuditChainWriter.open({
      path: join(root, "audit.jsonl"),
      principal: {
        osUser: "walking-skeleton",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = new RpcLines(output);
    const server = runStdioWardenServer({
      input,
      output,
      sandbox: {
        status: () => ({
          available: true,
          backend: "admission-fixture",
          enforcementTier: "sandbox:admission-fixture",
        }),
        execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
      },
      workspaceRoot: workspace,
      workspaceTrusted: true,
      policy: ALLOW_POLICY,
      auditWriter: audit,
      typedMutationRunner: runner,
      mutationPresentation: transport,
    });

    try {
      input.write(
        request("hello", "warden.hello", {
          kernelVersion: "0.0.0",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      input.write(
        request("read", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: { id: "read-budget", name: "read", args: { path: "example.ts" } },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));

      input.write(
        request("edit", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-budget",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "OBSERVED-WARDEN-PREIMAGE",
              newString: "VERIFIED-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      const edit = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      const editResult = edit.result as { auditSeq: number; verdict: string };

      expect(editResult.verdict).toBe("allow");
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toBe(NEXT);
      expect(captureRequested).toBe(false);
      expect(constructed).toBe(false);
      input.write(
        request("take", "warden.presentation.take", {
          sessionId: SESSION_ID,
          toolCallId: "edit-budget",
          auditSeq: editResult.auditSeq,
        }),
      );
      const take = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(take.result).toEqual({ status: "unavailable", reason: "capture-budget" });
    } finally {
      await server.close();
      audit.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases an accepted reservation when the direct handler has no outer finalizer", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-warden-presentation-bypass-"));
    const workspace = join(root, "workspace");
    const privateRoot = join(root, "private");
    mkdirSync(workspace);
    mkdirSync(privateRoot, { mode: 0o700 });
    writeFileSync(join(workspace, "example.ts"), OLD, { mode: 0o644 });
    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "srt:bypass-fixture",
        enforcementTier: "sandbox:srt",
      }),
      execute: async (invocation) => {
        const child = spawnSync(invocation.command, invocation.argv?.slice(1) ?? [], {
          cwd: invocation.cwd,
          encoding: "utf8",
        });
        return {
          exitCode: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
        };
      },
    };
    const runner = createSandboxTypedMutationRunner({
      sandbox,
      declaredTempRoots: [],
      createPayloadRoot: () => ({
        path: privateRoot,
        assertOwned: () => undefined,
        cleanup: () => undefined,
      }),
    });
    if (runner === undefined) throw new Error("expected contained typed-mutation runner");
    let constructed = false;
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct() {
        constructed = true;
        throw new Error("direct handler cannot finalize presentation");
      },
    });
    const audit = AuditChainWriter.open({
      path: join(root, "audit.jsonl"),
      principal: {
        osUser: "walking-skeleton",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });
    let appendCount = 0;
    let failOnAppend = Number.POSITIVE_INFINITY;
    const auditSink = {
      get head() {
        return audit.head;
      },
      append: (input: Parameters<typeof audit.append>[0]) => {
        appendCount += 1;
        if (appendCount === failOnAppend) throw new Error("injected final audit failure");
        return audit.append(input);
      },
      checkpointPublicKey: () => audit.checkpointPublicKey(),
      checkpointNow: () => audit.checkpointNow(),
      close: () => audit.close(),
    };
    const options = {
      sandbox,
      workspaceRoot: workspace,
      workspaceTrusted: true,
      policy: ALLOW_POLICY,
      auditWriter: auditSink,
      typedToolState: createTypedToolState(),
      typedMutationRunner: runner,
      mutationPresentation: transport,
      mutationPresentationPeerMinor: 1,
    };

    try {
      await handleRpcLine(
        request("read-bypass", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: { id: "read-bypass", name: "read", args: { path: "example.ts" } },
          provenanceContext: { inputTags: ["workspace"] },
        }),
        options,
      );
      const edit = await handleRpcLine(
        request("edit-bypass", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-bypass",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "OBSERVED-WARDEN-PREIMAGE",
              newString: "VERIFIED-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
        options,
      );
      if (!("result" in edit)) throw new Error("expected successful edit response");
      const editResult = edit.result as { auditSeq: number; verdict: string };

      expect(editResult.verdict).toBe("allow");
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toBe(NEXT);
      expect(constructed).toBe(false);
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
      expect(
        transport.take({
          sessionId: SESSION_ID,
          toolCallId: "edit-bypass",
          auditSeq: editResult.auditSeq,
        }),
      ).toEqual({ status: "unavailable", reason: "not-found-or-consumed" });

      failOnAppend = appendCount + 2;
      const failedAudit = await handleRpcLine(
        request("edit-audit-failure", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-audit-failure",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "VERIFIED-WARDEN-POSTIMAGE",
              newString: "FINAL-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
        options,
      );
      if (!("error" in failedAudit)) throw new Error("expected final audit failure");
      expect(failedAudit.error.data?.code).toBe("AUDIT_WRITE_FAILED");
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toContain(
        "FINAL-WARDEN-POSTIMAGE",
      );
      expect(constructed).toBe(false);
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    } finally {
      audit.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("promotes one real typed edit only after the successful stdio response write", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-warden-presentation-skeleton-"));
    const workspace = join(root, "workspace");
    const privateRoot = join(root, "private");
    mkdirSync(workspace);
    mkdirSync(privateRoot, { mode: 0o700 });
    writeFileSync(join(workspace, "example.ts"), OLD, { mode: 0o644 });

    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "srt:walking-skeleton",
        enforcementTier: "sandbox:srt",
      }),
      execute: async (invocation) => {
        const child = spawnSync(invocation.command, invocation.argv?.slice(1) ?? [], {
          cwd: invocation.cwd,
          encoding: "utf8",
        });
        return {
          exitCode: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
        };
      },
    };
    const runner = createSandboxTypedMutationRunner({
      sandbox,
      declaredTempRoots: [],
      createPayloadRoot: () => ({
        path: privateRoot,
        assertOwned: () => undefined,
        cleanup: () => undefined,
      }),
    });
    if (runner === undefined) throw new Error("expected contained typed-mutation runner");

    let constructionCount = 0;
    let rejectPostcheck = false;
    let rejectPostcheckCalls = 0;
    let releaseConstruction: () => void = () => undefined;
    const constructionGate = new Promise<void>((resolve) => {
      releaseConstruction = resolve;
    });
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: () => constructionGate,
      construct(candidate): MutationPresentationV1T {
        constructionCount += 1;
        expect(candidate.operation).toBe("edit");
        expect(candidate.displayPath).toBe("example.ts");
        expect(candidate.observedBefore.content).toBe(OLD);
        expect(candidate.verifiedInstalledAfter.content).toBe(NEXT);
        return MutationPresentationV1.parse({
          schemaVersion: "mutation-presentation/v1",
          producer: "warden-typed-mutation",
          operation: "edit",
          auditSeq: candidate.auditSeq,
          displayPath: literal(candidate.displayPath),
          pathIdentity: "walking-skeleton-opaque-path",
          observedBefore: {
            status: "file-observed",
            sha256: candidate.observedBefore.sha256,
            bytes: candidate.observedBefore.bytes,
            mode: candidate.observedBefore.mode,
            contentClass: "text",
            finalNewline: true,
          },
          verifiedInstalledAfter: {
            status: "file-observed",
            sha256: candidate.verifiedInstalledAfter.sha256,
            bytes: candidate.verifiedInstalledAfter.bytes,
            mode: candidate.verifiedInstalledAfter.mode,
            contentClass: "text",
            finalNewline: true,
          },
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
          comparison: {
            coverage: "complete",
            totals: {
              observedBeforeLines: 3,
              installedAfterLines: 3,
              shownLines: 4,
              hiddenLines: 0,
            },
            hunks: [
              {
                observedBeforeStart: 1,
                observedBeforeLines: 3,
                installedAfterStart: 1,
                installedAfterLines: 3,
                lines: [
                  {
                    kind: "context",
                    observedBeforeLine: 1,
                    installedAfterLine: 1,
                    ...literal("alpha"),
                  },
                  {
                    kind: "observed-before",
                    observedBeforeLine: 2,
                    ...literal("OBSERVED-WARDEN-PREIMAGE"),
                  },
                  {
                    kind: "installed-after",
                    installedAfterLine: 2,
                    ...literal("VERIFIED-WARDEN-POSTIMAGE"),
                  },
                  {
                    kind: "context",
                    observedBeforeLine: 3,
                    installedAfterLine: 3,
                    ...literal("omega"),
                  },
                ],
              },
            ],
            redactionCount: 0,
          },
          freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
        });
      },
    });

    const audit = AuditChainWriter.open({
      path: join(root, "audit.jsonl"),
      principal: {
        osUser: "walking-skeleton",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = new RpcLines(output);
    const server = runStdioWardenServer({
      input,
      output,
      sandbox,
      workspaceRoot: workspace,
      workspaceTrusted: true,
      policy: ALLOW_POLICY,
      auditWriter: audit,
      typedMutationRunner: runner,
      mutationPresentation: transport,
      validateSandboxTempRoot: () => {
        if (!rejectPostcheck) return;
        rejectPostcheckCalls += 1;
        if (rejectPostcheckCalls === 2) throw new Error("injected postcheck drift");
      },
    });

    try {
      input.write(
        request("hello", "warden.hello", {
          kernelVersion: "0.0.0",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      const hello = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(hello.result).toMatchObject({ protocolVersion: "1.1.0" });
      expect((hello.result as { capabilities: string[] }).capabilities).toEqual(
        expect.arrayContaining(["mutation-presentation/v1"]),
      );

      input.write(
        request("read", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: { id: "read-1", name: "read", args: { path: "example.ts" } },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));

      input.write(
        request("edit", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-1",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "OBSERVED-WARDEN-PREIMAGE",
              newString: "VERIFIED-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      const edit = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      const editResult = edit.result as { auditSeq: number; verdict: string };
      expect(editResult.verdict).toBe("allow");
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toBe(NEXT);
      // The response bytes reach the reader before the Writable callback; construction must not run
      // earlier than that accepted-write boundary.
      expect(constructionCount).toBe(0);
      expect(transport.pendingUsage()).toEqual({
        candidates: 1,
        bytes: Buffer.byteLength(OLD) + Buffer.byteLength(NEXT),
      });

      input.write(
        request("take", "warden.presentation.take", {
          sessionId: SESSION_ID,
          toolCallId: "edit-1",
          auditSeq: editResult.auditSeq,
        }),
      );
      const take = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(constructionCount).toBe(0);
      expect(transport.pendingUsage()).toEqual({
        candidates: 1,
        bytes: Buffer.byteLength(OLD) + Buffer.byteLength(NEXT),
      });
      expect(take.result).toEqual({ status: "pending", retryAfterMs: 25 });

      releaseConstruction();
      await vi.waitFor(() => expect(constructionCount).toBe(1));
      input.write(
        request("take-complete", "warden.presentation.take", {
          sessionId: SESSION_ID,
          toolCallId: "edit-1",
          auditSeq: editResult.auditSeq,
        }),
      );
      const completedTake = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
      expect(completedTake.result).toMatchObject({
        status: "available",
        artifact: {
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
        },
      });

      rejectPostcheck = true;
      input.write(
        request("edit-postcheck", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-postcheck",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "VERIFIED-WARDEN-POSTIMAGE",
              newString: "FINAL-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      const rejected = JSON.parse(await lines.next()) as {
        error?: { data?: { code?: string }; message?: string };
      };
      expect(rejected.error).toMatchObject({
        message: "sandbox temporary authority changed after execution; action may have executed",
        data: { code: "SANDBOX_TEMP_ROOT_POSTCHECK_FAILED" },
      });
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toContain(
        "FINAL-WARDEN-POSTIMAGE",
      );
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
      expect(constructionCount).toBe(1);

      input.write(
        request("take-postcheck", "warden.presentation.take", {
          sessionId: SESSION_ID,
          toolCallId: "edit-postcheck",
          auditSeq: audit.head.seq,
        }),
      );
      const rejectedTake = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(rejectedTake.result).toEqual({
        status: "unavailable",
        reason: "not-found-or-consumed",
      });

      rejectPostcheck = false;
      const originalOutputWrite = output.write.bind(output) as (...args: unknown[]) => boolean;
      let failNextAcceptedWrite = true;
      output.write = ((...args: unknown[]): boolean => {
        if (!failNextAcceptedWrite) return originalOutputWrite(...args);
        failNextAcceptedWrite = false;
        const callback = [...args]
          .reverse()
          .find((value): value is (error?: Error) => void => typeof value === "function");
        queueMicrotask(() => callback?.(new Error("injected response write failure")));
        return false;
      }) as typeof output.write;

      input.write(
        request("edit-output-failure", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "edit-output-failure",
            name: "edit",
            args: {
              path: "example.ts",
              oldString: "FINAL-WARDEN-POSTIMAGE",
              newString: "OUTPUT-WARDEN-POSTIMAGE",
            },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      const outputFailure = JSON.parse(await lines.next()) as {
        error?: { data?: { code?: string; details?: string } };
      };
      expect(outputFailure.error).toMatchObject({
        data: {
          code: "INTERNAL_ERROR",
          details: "injected response write failure",
        },
      });
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toContain(
        "OUTPUT-WARDEN-POSTIMAGE",
      );
      expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
      expect(constructionCount).toBe(1);
    } finally {
      await server.close();
      audit.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries one observed write through the test-gated resolver without serializing its preimage", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-warden-write-presentation-skeleton-"));
    const workspace = join(root, "workspace");
    const privateRoot = join(root, "private");
    const auditPath = join(root, "audit.jsonl");
    const observedPreimage = "PRODUCER-ONLY-WRITE-PREIMAGE\n";
    const installedAfter = "verified write replacement\n";
    mkdirSync(workspace);
    mkdirSync(privateRoot, { mode: 0o700 });
    writeFileSync(join(workspace, "example.txt"), observedPreimage, { mode: 0o640 });

    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "srt:write-walking-skeleton",
        enforcementTier: "sandbox:srt",
      }),
      execute: async (invocation) => {
        const child = spawnSync(invocation.command, invocation.argv?.slice(1) ?? [], {
          cwd: invocation.cwd,
          encoding: "utf8",
        });
        return {
          exitCode: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
        };
      },
    };
    const runner = createSandboxTypedMutationRunner({
      sandbox,
      declaredTempRoots: [],
      createPayloadRoot: () => ({
        path: privateRoot,
        assertOwned: () => undefined,
        cleanup: () => undefined,
      }),
    });
    if (runner === undefined) throw new Error("expected contained typed-mutation runner");
    const transport = createMutationPresentationWalkingSkeletonTransport({
      construct: constructMutationPresentationArtifact,
      constructWrite: constructMutationPresentationArtifact,
    });
    const audit = AuditChainWriter.open({
      path: auditPath,
      principal: {
        osUser: "write-walking-skeleton",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = new RpcLines(output);
    const server = runStdioWardenServer({
      input,
      output,
      sandbox,
      workspaceRoot: workspace,
      workspaceTrusted: true,
      policy: ALLOW_POLICY,
      auditWriter: audit,
      typedMutationRunner: runner,
      mutationPresentation: transport,
    });

    try {
      input.write(
        request("hello-write", "warden.hello", {
          kernelVersion: "0.0.0",
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      input.write(
        request("write", "warden.execute", {
          sessionId: SESSION_ID,
          toolCall: {
            id: "write-1",
            name: "write",
            args: { path: "example.txt", content: installedAfter },
          },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      );
      const responseLine = await lines.next();
      const write = JsonRpcSuccessResponse.parse(JSON.parse(responseLine));
      const writeResult = write.result as { auditSeq: number; verdict: string };
      expect(writeResult.verdict).toBe("allow");
      expect(responseLine).not.toContain(observedPreimage.trim());
      expect(readFileSync(join(workspace, "example.txt"), "utf8")).toBe(installedAfter);

      await vi.waitFor(() => expect(transport.terminalUsage().artifacts).toBe(1));
      input.write(
        request("take-write", "warden.presentation.take", {
          sessionId: SESSION_ID,
          toolCallId: "write-1",
          auditSeq: writeResult.auditSeq,
        }),
      );
      const take = JsonRpcSuccessResponse.parse(JSON.parse(await lines.next()));
      expect(take.result).toMatchObject({
        status: "available",
        artifact: {
          operation: "write",
          observedBefore: {
            status: "file-observed",
            bytes: Buffer.byteLength(observedPreimage),
            mode: 0o640,
          },
          verifiedInstalledAfter: {
            status: "file-observed",
            bytes: Buffer.byteLength(installedAfter),
            mode: 0o640,
          },
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
        },
      });
      const takenArtifact = (take.result as { artifact?: { pathIdentity?: string } }).artifact;
      expect(takenArtifact?.pathIdentity).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(takenArtifact?.pathIdentity).not.toBe("example.txt");
      expect(readFileSync(auditPath, "utf8")).not.toContain(observedPreimage.trim());
    } finally {
      await server.close();
      audit.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
