import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SandboxPort, SandboxProfile } from "./sandbox.js";
import {
  createSandboxTypedMutationRunner,
  TYPED_MUTATION_MAX_PAYLOAD_BYTES,
  type TypedMutationSettlement,
  type TypedMutationRunnerRequest,
} from "./typed-mutation-runner.js";
import { createSrtSandboxPort } from "./srt-sandbox.js";
import {
  createTypedToolState,
  executeReadTool,
  prepareEditToolMutation,
  prepareWriteToolMutation,
  READ_MAX_FILE_BYTES,
  TypedToolError,
  type PreparedTypedMutation,
} from "./typed-tools.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function borrowedPayloadRoot(path: string) {
  return {
    path,
    assertOwned: () => {
      const stat = statSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("test payload root changed");
    },
    cleanup: () => {},
  };
}

function mutation(content = "SECRET-CONTENT"): PreparedTypedMutation {
  return {
    tool: "write",
    path: "draft.txt",
    lexicalPath: "/workspace/draft.txt",
    content,
    preparedRoot: "/workspace",
    preparedParentIdentities: [{ dev: "1", ino: "1" }],
    expectedLeaf: { state: "absent" },
    expectedInstalledHash: "0".repeat(64),
    expectedInstalledMode: 0o644,
    runInProcessAtomicWrite: () => {},
    commit: () => "write: created 'draft.txt' (14 bytes)",
  };
}

function request(
  workspaceRoot: string,
  profile: SandboxProfile,
  prepared = mutation(),
): TypedMutationRunnerRequest {
  return {
    tool: prepared.tool,
    workspaceRoot,
    profile,
    mutation: prepared,
  };
}

function expectMutationError(
  settlement: TypedMutationSettlement | undefined,
  mutationOutcome: "failed" | "indeterminate",
  message: string | RegExp,
  mutationPossible?: boolean,
): void {
  expect(settlement).toBeDefined();
  if (settlement === undefined || settlement.mutation === "committed") {
    throw new Error(`expected ${mutationOutcome} typed-mutation settlement`);
  }
  expect(settlement.mutation).toBe(mutationOutcome);
  expect(settlement.error.message).toMatch(message);
  if (mutationPossible !== undefined) {
    expect(settlement.error.mutationPossible).toBe(mutationPossible);
  }
}

function localHelperSandbox(
  beforeSpawn?: (helperPath: string, payloadPath: string) => void,
): SandboxPort {
  return {
    status: () => ({
      available: true,
      backend: "srt:vendored",
      enforcementTier: "sandbox:srt",
    }),
    execute: async (invocation) =>
      await new Promise((resolve, reject) => {
        const helperPath = invocation.argv?.[1];
        const payloadPath = invocation.argv?.[2];
        if (helperPath === undefined || payloadPath === undefined) {
          reject(new Error("typed mutation helper invocation is incomplete"));
          return;
        }
        beforeSpawn?.(helperPath, payloadPath);
        const argv = invocation.argv ?? [invocation.command];
        const child = spawn(invocation.command, argv.slice(1), {
          cwd: invocation.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          resolve({ exitCode, signal, stdout, stderr });
        });
      }),
  };
}

describe("typed mutation sandbox runner", () => {
  it("emits bounded write presentation candidates only after committed settlement", async () => {
    const tempRoot = tempDir("keel-typed-runner-write-presentation-temp-");
    const workspace = tempDir("keel-typed-runner-write-presentation-workspace-");
    try {
      const before = Buffer.from([0x61, 0x00, 0xff, 0x62]);
      const after = "verified installed\n";
      writeFileSync(join(workspace, "existing.bin"), before, { mode: 0o600 });
      const prepared = prepareWriteToolMutation(
        { path: "existing.bin", content: after },
        { workspaceRoot: workspace, captureMutationPresentation: () => true },
      );
      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox((_helperPath, payloadPath) => {
          const payload = readFileSync(payloadPath, "utf8");
          expect(payload).not.toContain("presentationObservation");
          expect(payload).not.toContain("writeObservedBefore");
        }),
        declaredTempRoots: [tempRoot],
      });

      const settlement = await runner?.execute({
        ...request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
        capturePresentation: true,
      });

      expect(settlement).toMatchObject({
        mutation: "committed",
        presentationCandidate: {
          operation: "write",
          displayPath: "existing.bin",
          observedBefore: {
            status: "file-observed",
            content: before,
            bytes: before.byteLength,
            mode: 0o600,
          },
          verifiedInstalledAfter: {
            content: after,
            bytes: Buffer.byteLength(after),
            mode: 0o600,
          },
        },
      });
      expect(readFileSync(join(workspace, "existing.bin"), "utf8")).toBe(after);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("binds the verified installed mode instead of re-reading a later process umask", async () => {
    const tempRoot = tempDir("keel-typed-runner-write-mode-binding-temp-");
    const workspace = tempDir("keel-typed-runner-write-mode-binding-workspace-");
    const originalUmask = process.umask();
    try {
      process.umask(0o022);
      const prepared = prepareWriteToolMutation(
        { path: "new.txt", content: "verified installed\n" },
        { workspaceRoot: workspace, captureMutationPresentation: () => true },
      );
      const childSandbox = localHelperSandbox();
      const sandbox: SandboxPort = {
        ...childSandbox,
        execute: async (invocation, profile, options) => {
          const previous = process.umask(0o077);
          try {
            return await childSandbox.execute(invocation, profile, options);
          } finally {
            process.umask(previous);
          }
        },
      };
      const runner = createSandboxTypedMutationRunner({
        sandbox,
        declaredTempRoots: [tempRoot],
      });
      const settlement = await runner?.execute({
        ...request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
        capturePresentation: true,
      });
      if (settlement === undefined || settlement.mutation !== "committed") {
        throw new Error("expected committed write settlement");
      }
      expect(settlement.presentationCandidate?.verifiedInstalledAfter.mode).toBe(
        statSync(join(workspace, "new.txt")).mode & 0o777,
      );
    } finally {
      process.umask(originalUmask);
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a helper payload that decouples an existing leaf from its observed mode", async () => {
    const tempRoot = tempDir("keel-typed-runner-write-mode-mismatch-temp-");
    const workspace = tempDir("keel-typed-runner-write-mode-mismatch-workspace-");
    const target = join(workspace, "existing.txt");
    try {
      writeFileSync(target, "observed\n", { mode: 0o600 });
      chmodSync(target, 0o600);
      const prepared = prepareWriteToolMutation(
        { path: "existing.txt", content: "must not install\n" },
        { workspaceRoot: workspace },
      );
      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox((_helperPath, payloadPath) => {
          const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<string, unknown>;
          payload["expectedInstalledMode"] = 0o644;
          writeFileSync(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
        }),
        declaredTempRoots: [tempRoot],
      });

      const settlement = await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
      );

      expect(settlement).toMatchObject({ mutation: "failed", error: { mutationPossible: false } });
      expect(readFileSync(target, "utf8")).toBe("observed\n");
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("presents the exact UTF-8 postimage installed for lone-surrogate write input", async () => {
    const tempRoot = tempDir("keel-typed-runner-write-utf8-postimage-temp-");
    const workspace = tempDir("keel-typed-runner-write-utf8-postimage-workspace-");
    try {
      const requested = "before-\ud800-after\n";
      const installed = "before-�-after\n";
      const prepared = prepareWriteToolMutation(
        { path: "unicode.txt", content: requested },
        { workspaceRoot: workspace, captureMutationPresentation: () => true },
      );
      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox(),
        declaredTempRoots: [tempRoot],
      });
      const settlement = await runner?.execute({
        ...request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
        capturePresentation: true,
      });
      if (settlement === undefined || settlement.mutation !== "committed") {
        throw new Error("expected committed write settlement");
      }

      expect(readFileSync(join(workspace, "unicode.txt"), "utf8")).toBe(installed);
      expect(settlement.presentationCandidate?.verifiedInstalledAfter.content).toBe(installed);
      expect(settlement.presentationCandidate?.verifiedInstalledAfter.bytes).toBe(
        Buffer.byteLength(installed),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("is unavailable unless the sandbox tier is enforcing srt", () => {
    const sandbox = {
      status: () => ({ available: true, backend: "fake", enforcementTier: "sandbox:fake" }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    } satisfies SandboxPort;

    expect(
      createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempDir("keel-tm-")] }),
    ).toBeUndefined();
    expect(
      createSandboxTypedMutationRunner({
        sandbox: {
          ...sandbox,
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
        },
        declaredTempRoots: [],
      }),
    ).toBeDefined();
    expect(
      createSandboxTypedMutationRunner({
        sandbox: {
          ...sandbox,
          status: () => ({ available: false, backend: "none", enforcementTier: "none" }),
        },
        declaredTempRoots: [tempDir("keel-tm-unavailable-")],
      }),
    ).toBeUndefined();
  });

  it("fails closed in a compiled Bun carrier instead of trusting a PATH-resolved helper runtime", () => {
    const sandbox = {
      status: () => ({
        available: true,
        backend: "srt:vendored",
        enforcementTier: "sandbox:srt",
      }),
      execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
    } satisfies SandboxPort;
    const original = Object.getOwnPropertyDescriptor(process.versions, "bun");
    try {
      Object.defineProperty(process.versions, "bun", {
        configurable: true,
        value: "1.2.0-test",
      });
      expect(createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [] })).toBeUndefined();
      expect(
        createSandboxTypedMutationRunner({
          sandbox,
          declaredTempRoots: [],
          execPath: "/trusted/node",
        }),
      ).toBeDefined();
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.versions, "bun");
      else Object.defineProperty(process.versions, "bun", original);
    }
  });

  it("fails before dispatch when its private mutation directory cannot be created", async () => {
    const tempRoot = tempDir("keel-typed-runner-create-fail-temp-");
    let sandboxExecutions = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            sandboxExecutions += 1;
            return { exitCode: 0, signal: null, stdout: "", stderr: "" };
          },
        },
        declaredTempRoots: [tempRoot],
        createDirectory: () => {
          throw new Error("private temp allocation failed");
        },
      });

      const settlement = await runner?.execute(
        request("/workspace", { network: { allowedDomains: [] } }),
      );
      expect(settlement).toMatchObject({
        mutation: "failed",
        cleanup: "complete",
        error: { mutationPossible: false },
      });
      expectMutationError(settlement, "failed", /private payload setup failed/u, false);
      expect(sandboxExecutions).toBe(0);

      const rootFailureRunner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            sandboxExecutions += 1;
            return { exitCode: 0, signal: null, stdout: "", stderr: "" };
          },
        },
        declaredTempRoots: [],
        createPayloadRoot: () => {
          throw new Error("private root allocation failed");
        },
      });
      const rootSettlement = await rootFailureRunner?.execute(
        request("/workspace", { network: { allowedDomains: [] } }),
      );
      expectMutationError(rootSettlement, "failed", /private payload setup failed/u);
      expect(rootSettlement?.cleanup).toBe("complete");
      expect(sandboxExecutions).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed before writing a payload when the private root is projected to the governed tool", async () => {
    const workspace = tempDir("keel-typed-runner-projected-root-workspace-");
    let sandboxExecutions = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            sandboxExecutions += 1;
            return { exitCode: 0, signal: null, stdout: "", stderr: "" };
          },
        },
        declaredTempRoots: [],
        createPayloadRoot: () => borrowedPayloadRoot(workspace),
      });

      const settlement = await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );

      expect(settlement).toMatchObject({
        mutation: "failed",
        cleanup: "complete",
        error: { code: "TOOL_DENIED", mutationPossible: false },
      });
      expectMutationError(settlement, "failed", /private payload root is not isolated/u, false);
      expect(sandboxExecutions).toBe(0);
      expect(readdirSync(workspace)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects private-root overlap through a missing descendant of a symlinked authority", async () => {
    const workspace = tempDir("keel-typed-runner-missing-alias-workspace-");
    const authorityRoot = tempDir("keel-typed-runner-missing-alias-authority-");
    const aliasContainer = tempDir("keel-typed-runner-missing-alias-container-");
    const privateRoot = join(authorityRoot, "private");
    const authorityAlias = join(aliasContainer, "authority-alias");
    const missingAuthority = join(authorityAlias, "private", "future-child");
    mkdirSync(privateRoot);
    symlinkSync(authorityRoot, authorityAlias, "dir");

    try {
      for (const source of ["profile", "declared"] as const) {
        let sandboxExecutions = 0;
        const runner = createSandboxTypedMutationRunner({
          sandbox: {
            status: () => ({
              available: true,
              backend: "srt:vendored",
              enforcementTier: "sandbox:srt",
            }),
            execute: async () => {
              sandboxExecutions += 1;
              return { exitCode: 0, signal: null, stdout: "", stderr: "" };
            },
          },
          declaredTempRoots: source === "declared" ? [missingAuthority] : [],
          createPayloadRoot: () => borrowedPayloadRoot(privateRoot),
        });
        const profile: SandboxProfile = {
          ...(source === "profile" ? { filesystem: { allowRead: [missingAuthority] } } : {}),
          network: { allowedDomains: [] },
        };

        const settlement = await runner?.execute(request(workspace, profile));
        expect(settlement, source).toMatchObject({
          mutation: "failed",
          cleanup: "complete",
          error: { code: "TOOL_DENIED", mutationPossible: false },
        });
        expectMutationError(settlement, "failed", /private payload root is not isolated/u, false);
        expect(sandboxExecutions, source).toBe(0);
        expect(readdirSync(privateRoot), source).toEqual([]);
      }
    } finally {
      rmSync(aliasContainer, { recursive: true, force: true });
      rmSync(authorityRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs a helper from a private unprojected directory without putting file content in argv", async () => {
    const tempRoot = tempDir("keel-typed-runner-temp-");
    const workspace = tempDir("keel-typed-runner-workspace-");
    let helperPath = "";
    let payloadPath = "";
    let capturedProfile: SandboxProfile | undefined;
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async (invocation, profile) => {
          capturedProfile = profile;
          expect(invocation.command).toBe(process.execPath);
          expect(invocation.argv?.join(" ")).not.toContain("SECRET-CONTENT");
          helperPath = invocation.argv?.[1] ?? "";
          payloadPath = invocation.argv?.[2] ?? "";
          expect(helperPath.startsWith(tempRoot)).toBe(false);
          expect(payloadPath.startsWith(tempRoot)).toBe(false);
          expect(dirname(helperPath)).toBe(dirname(payloadPath));
          const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<string, unknown>;
          expect(payload).toMatchObject({
            tool: "write",
            workspaceRoot: workspace,
            path: "draft.txt",
            content: "SECRET-CONTENT",
          });
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        },
      };
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });

      await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );

      const invocationRoot = dirname(helperPath);
      expect(capturedProfile?.filesystem?.allowRead).toEqual(
        expect.arrayContaining([workspace, invocationRoot]),
      );
      expect(capturedProfile?.filesystem?.allowRead).not.toContain(tempRoot);
      expect(capturedProfile?.filesystem?.allowWrite).toEqual([workspace]);
      expect(capturedProfile?.filesystem?.denyWrite).toEqual([invocationRoot]);
      expect(existsSync(helperPath)).toBe(false);
      expect(existsSync(payloadPath)).toBe(false);
      expect(existsSync(dirname(invocationRoot))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not leak payload bytes through the SRT command or spawn descriptor environment", async () => {
    const tempRoot = tempDir("keel-typed-runner-srt-leak-temp-");
    const workspace = tempDir("keel-typed-runner-srt-leak-workspace-");
    const secret = "SECRET-CONTENT";
    let wrappedCommand = "";
    let descriptorEnv = "";
    let descriptorArgv = "";
    try {
      const sandbox = createSrtSandboxPort({
        status: { available: true, backend: "srt:fake", enforcementTier: "sandbox:srt" },
        runtime: {
          wrapWithSandboxArgv: async (command) => {
            wrappedCommand = command;
            return {
              argv: ["/usr/bin/env", "node-helper"],
              env: {
                PATH: "/usr/bin",
                TERM: "xterm-256color",
                KEEL_PAYLOAD_SHOULD_NOT_SURVIVE: secret,
              },
            };
          },
        },
        runner: {
          run: async (descriptor) => {
            descriptorArgv = JSON.stringify(descriptor.argv);
            descriptorEnv = JSON.stringify(descriptor.env);
            return { exitCode: 0, signal: null, stdout: "", stderr: "" };
          },
        },
      });
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });

      await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          mutation(secret),
        ),
      );

      expect(wrappedCommand).not.toContain(secret);
      expect(descriptorArgv).not.toContain(secret);
      expect(descriptorEnv).not.toContain(secret);
      expect(descriptorEnv).not.toContain("KEEL_PAYLOAD_SHOULD_NOT_SURVIVE");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not copy malformed private request bytes into helper error diagnostics", async () => {
    const tempRoot = tempDir("keel-typed-runner-json-error-temp-");
    const workspace = tempDir("keel-typed-runner-json-error-workspace-");
    const secret = "SECRET-MALFORMED-PRIVATE-PAYLOAD";
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox((_helperPath, payloadPath) => {
          writeFileSync(payloadPath, secret, { encoding: "utf8", mode: 0o600 });
        }),
        declaredTempRoots: [tempRoot],
      });

      const settlement = await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );
      expect(settlement).toMatchObject({ mutation: "failed", error: { mutationPossible: false } });
      const message = settlement?.mutation === "committed" ? "" : (settlement?.error.message ?? "");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("SECRET-MAL");
      expect(message).toContain("typed mutation request is invalid");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects well-formed JSON that does not exactly match the bounded helper schema", async () => {
    const tempRoot = tempDir("keel-typed-runner-json-schema-temp-");
    try {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly mutate: (payload: Record<string, unknown>) => void;
      }> = [
        {
          name: "unknown top-level field",
          mutate: (payload) => {
            payload["unexpected"] = "SECRET-UNKNOWN-FIELD";
          },
        },
        {
          name: "unknown nested identity field",
          mutate: (payload) => {
            const identities = payload["preparedParentIdentities"] as Array<
              Record<string, unknown>
            >;
            identities[0]!["unexpected"] = true;
          },
        },
        {
          name: "invalid installed hash",
          mutate: (payload) => {
            payload["expectedInstalledHash"] = "NOT-A-SHA256";
          },
        },
        {
          name: "invalid installed mode",
          mutate: (payload) => {
            payload["expectedInstalledMode"] = -1;
          },
        },
        {
          name: "helper-side oversized race",
          mutate: (payload) => {
            payload["content"] = "x".repeat(TYPED_MUTATION_MAX_PAYLOAD_BYTES);
          },
        },
      ];
      for (const testCase of cases) {
        const workspace = tempDir("keel-typed-runner-json-schema-workspace-");
        try {
          const prepared = prepareWriteToolMutation(
            { path: "schema.txt", content: "must-not-install" },
            { workspaceRoot: workspace, state: createTypedToolState() },
          );
          const runner = createSandboxTypedMutationRunner({
            sandbox: localHelperSandbox((_helperPath, payloadPath) => {
              const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Record<
                string,
                unknown
              >;
              testCase.mutate(payload);
              writeFileSync(payloadPath, JSON.stringify(payload), {
                encoding: "utf8",
                mode: 0o600,
              });
            }),
            declaredTempRoots: [tempRoot],
          });

          const settlement = await runner?.execute(
            request(
              workspace,
              {
                filesystem: { allowRead: [workspace], allowWrite: [workspace] },
                network: { allowedDomains: [] },
              },
              prepared,
            ),
          );
          expect(settlement, testCase.name).toMatchObject({
            mutation: "failed",
            error: { mutationPossible: false },
          });
          expect(JSON.stringify(settlement), testCase.name).not.toContain("SECRET-UNKNOWN-FIELD");
          expect(existsSync(join(workspace, "schema.txt")), testCase.name).toBe(false);
        } finally {
          rmSync(workspace, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("bounds helper payload reads when the request grows after its descriptor is opened", async () => {
    const tempRoot = tempDir("keel-typed-runner-payload-growth-temp-");
    const workspace = tempDir("keel-typed-runner-payload-growth-workspace-");
    try {
      const sandbox = localHelperSandbox((helperPath, _payloadPath) => {
        const source = readFileSync(helperPath, "utf8");
        expect(source).not.toContain("readFileSync(payloadFd)");
        expect(source).toContain("readPayloadBounded(payloadFd)");
        expect(source).toContain("readSync(fd, buffer");
        const needle = "    const openedPayload = fstatSync(payloadFd, { bigint: true });";
        const injected = source.replace(
          needle,
          `${needle}\n    writeFileSync(payloadPath, Buffer.alloc(${String(
            TYPED_MUTATION_MAX_PAYLOAD_BYTES + 1,
          )}, 0x61));`,
        );
        if (injected === source) throw new Error("payload growth test injection hook is missing");
        writeFileSync(helperPath, injected, { encoding: "utf8", mode: 0o600 });
      });
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });
      const prepared = prepareWriteToolMutation(
        { path: "must-not-install.txt", content: "bounded" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );

      const settlement = await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
      );

      if (settlement === undefined || settlement.mutation === "committed") {
        throw new Error("expected bounded helper payload failure");
      }
      expect(settlement.error.message).toMatch(/typed mutation request is invalid/u);
      expectMutationError(settlement, "failed", /typed mutation request is invalid/u, false);
      expect(settlement).toMatchObject({ mutation: "failed", error: { mutationPossible: false } });
      expect(existsSync(join(workspace, "must-not-install.txt"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports helper failures as mutation-possible typed-tool errors", async () => {
    const tempRoot = tempDir("keel-typed-runner-fail-temp-");
    const workspace = tempDir("keel-typed-runner-fail-workspace-");
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async () => ({
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "helper failed after launch",
        }),
      };
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });

      const settlement = await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );
      expect(settlement).toMatchObject({
        mutation: "indeterminate",
        cleanup: "complete",
        error: { mutationPossible: true },
      });
      expect(settlement?.mutation === "committed" ? "" : settlement?.error.message).toContain(
        "helper failed after launch",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("settles every abnormal helper termination conservatively and commits only zero-without-signal", async () => {
    const cases = [
      {
        name: "zero-with-signal",
        result: { exitCode: 0, signal: "SIGTERM", stdout: "", stderr: "signaled" },
        mutation: "indeterminate",
      },
      {
        name: "null-with-signal",
        result: { exitCode: null, signal: "SIGKILL", stdout: "", stderr: "signaled" },
        mutation: "indeterminate",
      },
      {
        name: "null-without-signal",
        result: { exitCode: null, signal: null, stdout: "", stderr: "unknown" },
        mutation: "indeterminate",
      },
      {
        name: "failed-no-mutation-with-signal",
        result: { exitCode: 41, signal: "SIGTERM", stdout: "", stderr: "signaled" },
        mutation: "indeterminate",
      },
      {
        name: "failed-no-mutation",
        result: { exitCode: 41, signal: null, stdout: "", stderr: "checked failure" },
        mutation: "failed",
      },
      {
        name: "ordinary-success",
        result: { exitCode: 0, signal: null, stdout: "", stderr: "" },
        mutation: "committed",
      },
    ] as const;

    for (const testCase of cases) {
      const tempRoot = tempDir(`keel-typed-runner-${testCase.name}-`);
      const workspace = tempDir(`keel-typed-runner-${testCase.name}-workspace-`);
      try {
        const runner = createSandboxTypedMutationRunner({
          sandbox: {
            status: () => ({
              available: true,
              backend: "srt:vendored",
              enforcementTier: "sandbox:srt",
            }),
            execute: async () => testCase.result,
          },
          declaredTempRoots: [tempRoot],
        });

        const settlement = await runner?.execute(
          request(workspace, {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          }),
        );
        expect(settlement?.mutation, testCase.name).toBe(testCase.mutation);
        if (testCase.mutation !== "committed") {
          expect(settlement, testCase.name).toMatchObject({
            cleanup: "complete",
            error: { mutationPossible: testCase.mutation === "indeterminate" },
          });
        }
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  });

  it("reports thrown sandbox failures as mutation-possible typed-tool errors", async () => {
    const tempRoot = tempDir("keel-typed-runner-throw-temp-");
    const workspace = tempDir("keel-typed-runner-throw-workspace-");
    const controller = new AbortController();
    let capturedProfile: SandboxProfile | undefined;
    let capturedOptions: { readonly signal?: AbortSignal } | undefined;
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async (_invocation, profile, options) => {
          capturedProfile = profile;
          capturedOptions = options;
          throw new Error("sandbox runner crashed after dispatch");
        },
      };
      const runner = createSandboxTypedMutationRunner({
        sandbox,
        declaredTempRoots: [tempRoot],
        execPath: "/custom/node",
      });

      const settlement = await runner?.execute({
        ...request(workspace, { network: { allowedDomains: [] } }),
        signal: controller.signal,
      });
      const privateInvocationRoot = capturedProfile?.filesystem?.allowRead?.[0];
      expect(privateInvocationRoot).toBeDefined();
      expect(privateInvocationRoot).not.toBe(tempRoot);
      expect(capturedProfile?.filesystem?.allowWrite).toBeUndefined();
      expect(capturedProfile?.filesystem?.denyWrite).toEqual([privateInvocationRoot]);
      expect(capturedOptions?.signal).toBe(controller.signal);
      expect(settlement).toMatchObject({
        mutation: "indeterminate",
        cleanup: "complete",
        error: { mutationPossible: true },
      });
      expect(settlement?.mutation === "committed" ? "" : settlement?.error.message).toContain(
        "sandbox runner crashed after dispatch",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves the primary sandbox failure while cleanup debt remains bounded and blocking", async () => {
    const tempRoot = tempDir("keel-typed-runner-composed-failure-temp-");
    const workspace = tempDir("keel-typed-runner-composed-failure-workspace-");
    let removeCalls = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            throw new Error("PRIMARY-SANDBOX-FAILURE");
          },
        },
        declaredTempRoots: [],
        createPayloadRoot: () => borrowedPayloadRoot(tempRoot),
        removeDirectory: (path) => {
          removeCalls += 1;
          if (removeCalls <= 2) throw new Error("SECONDARY-CLEANUP-FAILURE");
          rmSync(path, { recursive: true, force: true });
        },
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace], allowWrite: [workspace] },
        network: { allowedDomains: [] },
      };

      const settlement = await runner.execute(request(workspace, profile));
      expectMutationError(settlement, "indeterminate", /PRIMARY-SANDBOX-FAILURE/u, true);
      expect(settlement.cleanup).toBe("retry-required");
      expect(JSON.stringify(settlement)).not.toContain("SECONDARY-CLEANUP-FAILURE");
      expect(() => runner.assertReady()).toThrow(/cleanup is pending/u);
      expect(runner.close()).toEqual({ cleanup: "complete" });
      expect(removeCalls).toBe(3);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retains and retries an identity-bound root when only root cleanup fails", async () => {
    const tempRoot = tempDir("keel-typed-runner-root-cleanup-temp-");
    const workspace = tempDir("keel-typed-runner-root-cleanup-workspace-");
    let rootCleanupCalls = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        },
        declaredTempRoots: [],
        createPayloadRoot: () => ({
          path: tempRoot,
          assertOwned: () => {},
          cleanup: () => {
            rootCleanupCalls += 1;
            if (rootCleanupCalls === 1) throw new Error("root cleanup failed");
          },
        }),
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");

      await expect(
        runner.execute(
          request(workspace, {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          }),
        ),
      ).resolves.toEqual({ mutation: "committed", cleanup: "retry-required" });
      expect(() => runner.assertReady()).not.toThrow();
      expect(rootCleanupCalls).toBe(2);
      expect(runner.quarantine()).toEqual({ cleanup: "complete" });
      expect(() => runner.assertReady()).toThrow(/closed/u);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("uses sanitized byte-bounded stdout or a fallback reason when helper failures have no stderr", async () => {
    const tempRoot = tempDir("keel-typed-runner-output-temp-");
    const workspace = tempDir("keel-typed-runner-output-workspace-");
    let execution = 0;
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async () => {
          execution += 1;
          return {
            exitCode: 1,
            signal: null,
            stdout: execution === 1 ? "stdout-only failure" : "",
            stderr:
              execution === 3 ? `\u001b[31mPRIVATE\n${workspace}\u0007${"🙂".repeat(700)}` : "",
          };
        },
      };
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });

      const stdoutSettlement = await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );
      expectMutationError(stdoutSettlement, "indeterminate", /stdout-only failure/u);
      const fallbackSettlement = await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );
      expectMutationError(
        fallbackSettlement,
        "indeterminate",
        /contained mutation helper failed$/u,
      );
      const sanitizedSettlement = await runner?.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );
      expectMutationError(sanitizedSettlement, "indeterminate", /PRIVATE/u);
      const message =
        sanitizedSettlement?.mutation === "committed"
          ? ""
          : (sanitizedSettlement?.error.message ?? "");
      expect(message).not.toContain(workspace);
      expect(
        [...message].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
        }),
      ).toBe(false);
      expect(message).not.toContain("\u001b[31m");
      expect(message).not.toContain("�");
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
        Buffer.byteLength("write: contained mutation helper failed: ", "utf8") + 2048,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("strips every bidi control and known canonical host path from result and spawn diagnostics", async () => {
    const cleanupRoots: string[] = [];
    try {
      const workspace = tempDir("keel-typed-runner-diagnostic-workspace-");
      cleanupRoots.push(workspace);
      const declaredTempRoot = tempDir("keel-typed-runner-diagnostic-declared-");
      cleanupRoots.push(declaredTempRoot);
      const readAuthority = tempDir("keel-typed-runner-diagnostic-read-");
      cleanupRoots.push(readAuthority);
      const writeAuthority = tempDir("keel-typed-runner-diagnostic-write-");
      cleanupRoots.push(writeAuthority);
      const denyReadAuthority = tempDir("keel-typed-runner-diagnostic-deny-read-");
      cleanupRoots.push(denyReadAuthority);
      const denyWriteAuthority = tempDir("keel-typed-runner-diagnostic-deny-write-");
      cleanupRoots.push(denyWriteAuthority);
      const runtimeRoot = tempDir("keel-typed-runner-diagnostic-runtime-");
      cleanupRoots.push(runtimeRoot);
      const aliasedAuthorityRoot = tempDir("keel-typed-runner-diagnostic-aliased-root-");
      cleanupRoots.push(aliasedAuthorityRoot);
      const aliasContainer = tempDir("keel-typed-runner-diagnostic-alias-container-");
      cleanupRoots.push(aliasContainer);
      const authorityAlias = join(aliasContainer, "authority-alias");
      const missingAliasedAuthority = join(authorityAlias, "missing-child");
      const missingCanonicalAuthority = join(realpathSync(aliasedAuthorityRoot), "missing-child");
      symlinkSync(aliasedAuthorityRoot, authorityAlias, "dir");
      const execPath = join(runtimeRoot, "exact-node-runtime");
      writeFileSync(execPath, "test runtime marker");
      const canonicalWorkspace = realpathSync(workspace);
      const prepared: PreparedTypedMutation = {
        ...mutation(),
        lexicalPath: join(canonicalWorkspace, "draft.txt"),
        preparedRoot: canonicalWorkspace,
      };
      const profile: SandboxProfile = {
        filesystem: {
          allowRead: [workspace, readAuthority, missingAliasedAuthority],
          allowWrite: [workspace, writeAuthority],
          denyRead: [denyReadAuthority],
          denyWrite: [denyWriteAuthority],
        },
        network: { allowedDomains: [] },
      };
      const bidiControls = [
        0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
        0x2069,
      ].map((codePoint) => String.fromCodePoint(codePoint));
      const configuredPaths = [
        workspace,
        canonicalWorkspace,
        prepared.lexicalPath,
        prepared.preparedRoot,
        declaredTempRoot,
        readAuthority,
        writeAuthority,
        denyReadAuthority,
        denyWriteAuthority,
        missingAliasedAuthority,
        missingCanonicalAuthority,
        execPath,
      ];

      for (const mode of ["result", "throw"] as const) {
        let invocationPaths: string[] = [];
        const sandbox: SandboxPort = {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async (invocation) => {
            invocationPaths = [invocation.command, ...(invocation.argv ?? [])];
            const diagnostic = [
              "VISIBLE-DIAGNOSTIC",
              ...configuredPaths,
              ...invocationPaths,
              ...bidiControls,
            ].join("|");
            if (mode === "throw") throw new Error(diagnostic);
            return { exitCode: 1, signal: null, stdout: "", stderr: diagnostic };
          },
        };
        const runner = createSandboxTypedMutationRunner({
          sandbox,
          declaredTempRoots: [declaredTempRoot],
          execPath,
        });

        const settlement = await runner?.execute(request(workspace, profile, prepared));
        expectMutationError(settlement, "indeterminate", /VISIBLE-DIAGNOSTIC/u);
        const message =
          settlement?.mutation === "committed" ? "" : (settlement?.error.message ?? "");
        for (const path of new Set([...configuredPaths, ...invocationPaths])) {
          expect(message, `${mode}: leaked ${path}`).not.toContain(path);
        }
        for (const control of bidiControls) {
          expect(
            message,
            `${mode}: leaked U+${control.codePointAt(0)?.toString(16)}`,
          ).not.toContain(control);
        }
        expect(message).not.toContain("�");
        expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(
          Buffer.byteLength("write: contained mutation helper failed: ", "utf8") + 2048,
        );
      }
    } finally {
      for (const root of cleanupRoots.reverse()) rmSync(root, { recursive: true, force: true });
    }
  });

  it("settles authority canonicalization failures without leaking paths, payload roots, or runner state", async () => {
    const cleanupRoots: string[] = [];
    const createdPayloadRoots: string[] = [];
    let sandboxExecutions = 0;

    try {
      const workspace = tempDir("keel-typed-runner-canonical-failure-workspace-");
      cleanupRoots.push(workspace);
      const loopRoot = tempDir("keel-typed-runner-canonical-failure-loop-");
      cleanupRoots.push(loopRoot);
      const loopPath = join(loopRoot, "loop");
      const unresolvableAuthority = join(loopPath, "missing-child");
      symlinkSync(loopPath, loopPath);
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            sandboxExecutions += 1;
            return { exitCode: 0, signal: null, stdout: "", stderr: "" };
          },
        },
        declaredTempRoots: [],
        createPayloadRoot: () => {
          const path = tempDir("keel-typed-runner-canonical-failure-payload-");
          createdPayloadRoots.push(path);
          return {
            path,
            assertOwned: () => {
              const stat = statSync(path);
              if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error("test payload root changed");
              }
            },
            cleanup: () => rmSync(path, { recursive: true, force: true }),
          };
        },
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");

      for (const authority of ["allowRead", "denyRead"] as const) {
        const settlement = await runner.execute(
          request(workspace, {
            filesystem: { [authority]: [unresolvableAuthority] },
            network: { allowedDomains: [] },
          }),
        );
        expect(settlement).toMatchObject({
          mutation: "failed",
          cleanup: "complete",
          error: {
            code: "TOOL_ERROR",
            message: "write: contained mutation helper failed: private payload setup failed",
            mutationPossible: false,
          },
        });
        expect(settlement.mutation === "committed" ? "" : settlement.error.message).not.toContain(
          unresolvableAuthority,
        );
        expect(createdPayloadRoots.every((path) => !existsSync(path))).toBe(true);
        expect(sandboxExecutions).toBe(0);
      }

      await expect(
        runner.execute(request(workspace, { network: { allowedDomains: [] } })),
      ).resolves.toMatchObject({ mutation: "committed", cleanup: "complete" });
      expect(createdPayloadRoots.every((path) => !existsSync(path))).toBe(true);
      expect(sandboxExecutions).toBe(1);
    } finally {
      for (const path of createdPayloadRoots) rmSync(path, { recursive: true, force: true });
      for (const path of cleanupRoots.reverse()) rmSync(path, { recursive: true, force: true });
    }
  });

  it("keeps payload-write failures primary, sanitized, undispatched, and quarantined when cleanup also fails", async () => {
    for (const failedWrite of [1, 2]) {
      const tempRoot = tempDir(`keel-typed-runner-payload-write-${String(failedWrite)}-`);
      const workspace = tempDir(
        `keel-typed-runner-payload-write-${String(failedWrite)}-workspace-`,
      );
      let writeCalls = 0;
      let removeCalls = 0;
      let sandboxExecutions = 0;
      try {
        const runner = createSandboxTypedMutationRunner({
          sandbox: {
            status: () => ({
              available: true,
              backend: "srt:vendored",
              enforcementTier: "sandbox:srt",
            }),
            execute: async () => {
              sandboxExecutions += 1;
              return { exitCode: 0, signal: null, stdout: "", stderr: "" };
            },
          },
          declaredTempRoots: [],
          createPayloadRoot: () => borrowedPayloadRoot(tempRoot),
          writePrivateFile: (...args) => {
            writeCalls += 1;
            if (writeCalls === failedWrite) {
              throw new Error(`PAYLOAD-WRITE-FAILURE\n${tempRoot}\u001b[31mSECRET`);
            }
            return writeFileSync(...args);
          },
          removeDirectory: (path) => {
            removeCalls += 1;
            if (removeCalls <= 2) throw new Error("SECONDARY-CLEANUP-FAILURE");
            rmSync(path, { recursive: true, force: true });
          },
        });
        if (runner === undefined) throw new Error("expected typed mutation runner");

        const settlement = await runner.execute(
          request(workspace, {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          }),
        );
        expect(settlement).toMatchObject({
          mutation: "failed",
          cleanup: "retry-required",
          error: { mutationPossible: false },
        });
        expectMutationError(settlement, "failed", /private payload setup failed/u, false);
        expect(JSON.stringify(settlement)).not.toContain("PAYLOAD-WRITE-FAILURE");
        expect(JSON.stringify(settlement)).not.toContain("SECONDARY-CLEANUP-FAILURE");
        expect(JSON.stringify(settlement)).not.toContain(tempRoot);
        expect(JSON.stringify(settlement)).not.toContain("SECRET");
        expect(sandboxExecutions).toBe(0);
        expect(() => runner.assertReady()).toThrow(/cleanup is pending/u);
        expect(runner.close()).toEqual({ cleanup: "complete" });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  });

  it("executes the generated helper for prepared writes and edits", async () => {
    const tempRoot = tempDir("keel-typed-runner-live-temp-");
    const workspace = tempDir("keel-typed-runner-live-workspace-");
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async (invocation) =>
          await new Promise((resolve, reject) => {
            const argv = invocation.argv ?? [invocation.command];
            const child = spawn(invocation.command, argv.slice(1), {
              cwd: invocation.cwd,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
              stdout += chunk;
            });
            child.stderr.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.once("error", reject);
            child.once("close", (exitCode, signal) => {
              resolve({ exitCode, signal, stdout, stderr });
            });
          }),
      };
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace, tempRoot], allowWrite: [workspace, tempRoot] },
        network: { allowedDomains: [] },
      };
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });
      const state = createTypedToolState();
      const writeMutation = prepareWriteToolMutation(
        { path: "draft.txt", content: "alpha beta\n" },
        { workspaceRoot: workspace, state },
      );

      await runner?.execute(request(workspace, profile, writeMutation));
      expect(writeMutation.commit()).toBe("write: created 'draft.txt' (11 bytes)");
      expect(readFileSync(join(workspace, "draft.txt"), "utf8")).toBe("alpha beta\n");

      executeReadTool({ path: "draft.txt" }, { workspaceRoot: workspace, state });
      const editMutation = prepareEditToolMutation(
        { path: "draft.txt", oldString: "beta", newString: "gamma" },
        { workspaceRoot: workspace, state },
      );

      await runner?.execute(request(workspace, profile, editMutation));
      expect(editMutation.commit()).toBe("edit: replaced 1 occurrence in 'draft.txt'");
      expect(readFileSync(join(workspace, "draft.txt"), "utf8")).toBe("alpha gamma\n");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves existing file permissions and uses ordinary umask semantics for new paths", async () => {
    const tempRoot = tempDir("keel-typed-runner-mode-temp-");
    const workspace = tempDir("keel-typed-runner-mode-workspace-");
    const previousUmask = process.umask(0o027);
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox(),
        declaredTempRoots: [tempRoot],
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace], allowWrite: [workspace] },
        network: { allowedDomains: [] },
      };

      for (const mode of [0o755, 0o600]) {
        const path = join(workspace, `existing-${mode.toString(8)}.txt`);
        writeFileSync(path, "before");
        chmodSync(path, mode);
        const prepared = prepareWriteToolMutation(
          { path: `existing-${mode.toString(8)}.txt`, content: "after" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        );
        await runner.execute(request(workspace, profile, prepared));
        expect(statSync(path).mode & 0o777, mode.toString(8)).toBe(mode);
      }

      const existingParent = join(workspace, "existing-parent");
      mkdirSync(existingParent, { mode: 0o711 });
      chmodSync(existingParent, 0o711);
      const nested = prepareWriteToolMutation(
        { path: "existing-parent/new/sub/file.txt", content: "nested" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );
      await runner.execute(request(workspace, profile, nested));
      expect(statSync(existingParent).mode & 0o777).toBe(0o711);
      expect(statSync(join(existingParent, "new")).mode & 0o777).toBe(0o750);
      expect(statSync(join(existingParent, "new", "sub")).mode & 0o777).toBe(0o750);
      expect(statSync(join(existingParent, "new", "sub", "file.txt")).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(previousUmask);
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reports possible workspace mutation when a pre-rename failure cannot remove its temp file", async () => {
    const tempRoot = tempDir("keel-typed-runner-residue-temp-");
    const workspace = tempDir("keel-typed-runner-residue-workspace-");
    try {
      const sandbox = localHelperSandbox((helperPath) => {
        const source = readFileSync(helperPath, "utf8");
        const injected = source
          .replace(
            "    fsyncSync(fd);",
            '    fsyncSync(fd);\n    throw new Error("injected pre-rename failure");',
          )
          .replace(
            "        rmSync(tmpName, { force: true });",
            '        throw new Error("injected temp cleanup failure");',
          );
        if (injected === source)
          throw new Error("workspace-residue test injection hook is missing");
        writeFileSync(helperPath, injected, { encoding: "utf8", mode: 0o600 });
      });
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });
      const prepared = prepareWriteToolMutation(
        { path: "residue.txt", content: "residual-content" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );

      const settlement = await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
      );
      expect(settlement).toMatchObject({
        mutation: "indeterminate",
        error: { mutationPossible: true },
      });
      expect(existsSync(join(workspace, "residue.txt"))).toBe(false);
      expect(readdirSync(workspace).some((name) => name.endsWith(".tmp"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("bounds helper-side edit revalidation before hashing swapped large targets", async () => {
    const tempRoot = tempDir("keel-typed-runner-large-temp-");
    const workspace = tempDir("keel-typed-runner-large-workspace-");
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async (invocation) =>
          await new Promise((resolve, reject) => {
            const argv = invocation.argv ?? [invocation.command];
            const child = spawn(invocation.command, argv.slice(1), {
              cwd: invocation.cwd,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
              stdout += chunk;
            });
            child.stderr.on("data", (chunk: string) => {
              stderr += chunk;
            });
            child.once("error", reject);
            child.once("close", (exitCode, signal) => {
              resolve({ exitCode, signal, stdout, stderr });
            });
          }),
      };
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace, tempRoot], allowWrite: [workspace, tempRoot] },
        network: { allowedDomains: [] },
      };
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });
      const state = createTypedToolState();
      writeFileSync(join(workspace, "draft.txt"), "alpha SECRET omega", "utf8");
      executeReadTool({ path: "draft.txt" }, { workspaceRoot: workspace, state });
      const editMutation = prepareEditToolMutation(
        { path: "draft.txt", oldString: "SECRET", newString: "gamma" },
        { workspaceRoot: workspace, state },
      );
      writeFileSync(join(workspace, "draft.txt"), Buffer.alloc(READ_MAX_FILE_BYTES + 1, 0x61));

      const settlement = await runner?.execute(request(workspace, profile, editMutation));
      expectMutationError(settlement, "failed", /exceeds maximum size/u);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing file beyond the bounded preimage ceiling", () => {
    const workspace = tempDir("keel-typed-runner-large-write-preimage-");
    try {
      const target = join(workspace, "large.bin");
      writeFileSync(target, Buffer.alloc(READ_MAX_FILE_BYTES + 1, 0x61));

      expect(() =>
        prepareWriteToolMutation(
          { path: "large.bin", content: "replacement" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        ),
      ).toThrow(/too large for bounded mutation preimage/u);
      expect(statSync(target).size).toBe(READ_MAX_FILE_BYTES + 1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when an existing leaf cannot be opened for no-follow preimage verification", () => {
    const workspace = tempDir("keel-typed-runner-unreadable-preimage-");
    const target = join(workspace, "unreadable.txt");
    try {
      writeFileSync(target, "private preimage");
      chmodSync(target, 0o000);

      expect(() =>
        prepareWriteToolMutation(
          { path: "unreadable.txt", content: "replacement" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        ),
      ).toThrow(/cannot verify.*without following links/u);
    } finally {
      chmodSync(target, 0o600);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects non-directory components and non-regular edit leaves during preparation", () => {
    const workspace = tempDir("keel-typed-runner-non-regular-path-");
    try {
      writeFileSync(join(workspace, "parent-file"), "not a directory");
      expect(() =>
        prepareWriteToolMutation(
          { path: "parent-file/notes.txt", content: "replacement" },
          {
            workspaceRoot: workspace,
            state: createTypedToolState(),
            stat: () => {
              const error = new Error("missing target") as NodeJS.ErrnoException;
              error.code = "ENOENT";
              throw error;
            },
          },
        ),
      ).toThrow(/parent path component.*file, not a directory/u);

      mkdirSync(join(workspace, "directory-leaf"));
      expect(() =>
        prepareEditToolMutation(
          { path: "directory-leaf", oldString: "before", newString: "after" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        ),
      ).toThrow(/not a regular file/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects root and nested component identity failures before reading a mutation leaf", () => {
    const workspace = tempDir("keel-typed-runner-component-observation-");
    const outside = tempDir("keel-typed-runner-component-observation-outside-");
    try {
      mkdirSync(join(workspace, "parent"));

      expect(() =>
        prepareWriteToolMutation(
          { path: "notes.txt", content: "replacement" },
          {
            workspaceRoot: workspace,
            state: createTypedToolState(),
            realpath: (path) => {
              if (path === ".") throw new Error("root identity unavailable");
              return realpathSync(path);
            },
          },
        ),
      ).toThrow(/changed while being validated/u);

      let dotCalls = 0;
      expect(() =>
        prepareWriteToolMutation(
          { path: "parent/notes.txt", content: "replacement" },
          {
            workspaceRoot: workspace,
            state: createTypedToolState(),
            realpath: (path) => {
              if (path === "." && (dotCalls += 1) === 2) {
                throw new Error("nested identity unavailable");
              }
              return realpathSync(path);
            },
          },
        ),
      ).toThrow(/changed while being validated/u);

      dotCalls = 0;
      expect(() =>
        prepareWriteToolMutation(
          { path: "parent/notes.txt", content: "replacement" },
          {
            workspaceRoot: workspace,
            state: createTypedToolState(),
            realpath: (path) => {
              if (path === "." && (dotCalls += 1) === 2) return outside;
              return realpathSync(path);
            },
          },
        ),
      ).toThrow(/changed while being validated/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an edit when the leaf changes between its bounded read and final observation", () => {
    const workspace = tempDir("keel-typed-runner-edit-observation-race-");
    const state = createTypedToolState();
    const target = join(workspace, "notes.txt");
    try {
      writeFileSync(target, "alpha SECRET omega");
      executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });

      expect(() =>
        prepareEditToolMutation(
          { path: "notes.txt", oldString: "SECRET", newString: "safe" },
          {
            workspaceRoot: workspace,
            state,
            readFile: (path) => {
              const before = readFileSync(path);
              writeFileSync(path, "concurrent replacement");
              return before;
            },
          },
        ),
      ).toThrow(/changed while being validated/u);
      expect(readFileSync(target, "utf8")).toBe("concurrent replacement");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a leaf swapped to a symlink after the no-follow edit descriptor opens", () => {
    const workspace = tempDir("keel-typed-runner-edit-open-symlink-race-");
    const outside = tempDir("keel-typed-runner-edit-open-symlink-race-outside-");
    const state = createTypedToolState();
    const target = join(workspace, "notes.txt");
    const relocated = join(workspace, "notes.prepared.txt");
    const outsideTarget = join(outside, "secret.txt");
    try {
      writeFileSync(target, "alpha SECRET omega");
      writeFileSync(outsideTarget, "outside secret");
      const canonicalTarget = realpathSync(target);
      executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });
      let targetRealpathCalls = 0;

      expect(() =>
        prepareEditToolMutation(
          { path: "notes.txt", oldString: "SECRET", newString: "safe" },
          {
            workspaceRoot: workspace,
            state,
            realpath: (path) => {
              const real = realpathSync(path);
              if (path === canonicalTarget && (targetRealpathCalls += 1) === 2) {
                renameSync(target, relocated);
                symlinkSync(outsideTarget, target);
              }
              return real;
            },
          },
        ),
      ).toThrow(/changed while being validated/u);
      expect(readFileSync(outsideTarget, "utf8")).toBe("outside secret");
      expect(readFileSync(relocated, "utf8")).toBe("alpha SECRET omega");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects an edit leaf that grows beyond the bounded-read ceiling after open", () => {
    const workspace = tempDir("keel-typed-runner-edit-open-growth-race-");
    const state = createTypedToolState();
    const target = join(workspace, "notes.txt");
    try {
      writeFileSync(target, "alpha SECRET omega");
      const canonicalTarget = realpathSync(target);
      executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });
      let targetRealpathCalls = 0;

      expect(() =>
        prepareEditToolMutation(
          { path: "notes.txt", oldString: "SECRET", newString: "safe" },
          {
            workspaceRoot: workspace,
            state,
            realpath: (path) => {
              const real = realpathSync(path);
              if (path === canonicalTarget && (targetRealpathCalls += 1) === 2) {
                writeFileSync(target, Buffer.alloc(READ_MAX_FILE_BYTES + 1, 0x61));
              }
              return real;
            },
          },
        ),
      ).toThrow(/too large to edit/u);
      expect(statSync(target).size).toBe(READ_MAX_FILE_BYTES + 1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("fails closed when edit-leaf containment cannot be resolved after no-follow open", () => {
    const workspace = tempDir("keel-typed-runner-edit-open-resolution-race-");
    const state = createTypedToolState();
    const target = join(workspace, "notes.txt");
    try {
      writeFileSync(target, "alpha SECRET omega");
      const canonicalTarget = realpathSync(target);
      executeReadTool({ path: "notes.txt" }, { workspaceRoot: workspace, state });
      let targetRealpathCalls = 0;

      expect(() =>
        prepareEditToolMutation(
          { path: "notes.txt", oldString: "SECRET", newString: "safe" },
          {
            workspaceRoot: workspace,
            state,
            realpath: (path) => {
              if (path === canonicalTarget && (targetRealpathCalls += 1) === 2) {
                throw new Error("simulated resolver failure after open");
              }
              return realpathSync(path);
            },
          },
        ),
      ).toThrow(/changed while being validated/u);
      expect(readFileSync(target, "utf8")).toBe("alpha SECRET omega");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects same-workspace leaf and parent symlinks during mutation preparation", () => {
    const workspace = tempDir("keel-typed-runner-symlink-workspace-");
    try {
      mkdirSync(join(workspace, "real-parent"));
      writeFileSync(join(workspace, "real-parent", "notes.txt"), "alpha SECRET omega");
      symlinkSync(join(workspace, "real-parent", "notes.txt"), join(workspace, "leaf.txt"));
      symlinkSync(join(workspace, "missing-target.txt"), join(workspace, "dangling.txt"));
      symlinkSync(join(workspace, "real-parent"), join(workspace, "parent"), "dir");

      expect(() =>
        prepareWriteToolMutation(
          { path: "leaf.txt", content: "replacement" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        ),
      ).toThrow(/symbolic link/u);
      expect(() =>
        prepareWriteToolMutation(
          { path: "dangling.txt", content: "replacement" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        ),
      ).toThrow(/symbolic link/u);
      expect(() =>
        prepareWriteToolMutation(
          { path: "parent/new.txt", content: "replacement" },
          { workspaceRoot: workspace, state: createTypedToolState() },
        ),
      ).toThrow(/symbolic link/u);

      const state = createTypedToolState();
      executeReadTool({ path: "leaf.txt" }, { workspaceRoot: workspace, state });
      expect(() =>
        prepareEditToolMutation(
          { path: "leaf.txt", oldString: "SECRET", newString: "safe" },
          { workspaceRoot: workspace, state },
        ),
      ).toThrow(/symbolic link/u);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("refuses write races against both expected absence and an expected preimage hash", async () => {
    const tempRoot = tempDir("keel-typed-runner-write-race-temp-");
    const workspace = tempDir("keel-typed-runner-write-race-workspace-");
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox(),
        declaredTempRoots: [tempRoot],
      });
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace, tempRoot], allowWrite: [workspace, tempRoot] },
        network: { allowedDomains: [] },
      };

      const absent = prepareWriteToolMutation(
        { path: "absent.txt", content: "keel-installed" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );
      writeFileSync(join(workspace, "absent.txt"), "concurrent-create");
      const absenceRace = await runner?.execute(request(workspace, profile, absent));
      expectMutationError(absenceRace, "failed", /changed after preparation/u, false);
      expect(readFileSync(join(workspace, "absent.txt"), "utf8")).toBe("concurrent-create");

      writeFileSync(join(workspace, "existing.txt"), "prepared-preimage");
      const existing = prepareWriteToolMutation(
        { path: "existing.txt", content: "keel-installed" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );
      writeFileSync(join(workspace, "existing.txt"), "concurrent-change");
      const existingRace = await runner?.execute(request(workspace, profile, existing));
      expectMutationError(existingRace, "failed", /changed after preparation/u);
      expect(readFileSync(join(workspace, "existing.txt"), "utf8")).toBe("concurrent-change");

      writeFileSync(join(workspace, "referent.txt"), "referent-sentinel");
      writeFileSync(join(workspace, "swapped-link.txt"), "prepared-file");
      const swappedLink = prepareWriteToolMutation(
        { path: "swapped-link.txt", content: "keel-installed" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );
      rmSync(join(workspace, "swapped-link.txt"), { force: true });
      symlinkSync(join(workspace, "referent.txt"), join(workspace, "swapped-link.txt"));
      const symlinkRace = await runner?.execute(request(workspace, profile, swappedLink));
      expectMutationError(symlinkRace, "failed", /changed after preparation/u);
      expect(readFileSync(join(workspace, "referent.txt"), "utf8")).toBe("referent-sentinel");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("binds the prepared parent identity even when its path is replaced by another in-workspace directory", async () => {
    const tempRoot = tempDir("keel-typed-runner-parent-identity-temp-");
    const workspace = tempDir("keel-typed-runner-parent-identity-workspace-");
    try {
      mkdirSync(join(workspace, "parent"));
      const prepared = prepareWriteToolMutation(
        { path: "parent/notes.txt", content: "keel-installed" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );
      renameSync(join(workspace, "parent"), join(workspace, "original-parent"));
      mkdirSync(join(workspace, "parent"));
      writeFileSync(join(workspace, "parent", "notes.txt"), "replacement-parent-sentinel");

      const runner = createSandboxTypedMutationRunner({
        sandbox: localHelperSandbox(),
        declaredTempRoots: [tempRoot],
      });
      const settlement = await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
      );
      expectMutationError(settlement, "failed", /parent.*changed after preparation/u);
      expect(readFileSync(join(workspace, "parent", "notes.txt"), "utf8")).toBe(
        "replacement-parent-sentinel",
      );
      expect(existsSync(join(workspace, "original-parent", "notes.txt"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not create a missing child outside the workspace when a validated parent is swapped to a symlink", async () => {
    const tempRoot = tempDir("keel-typed-runner-parent-symlink-temp-");
    const workspace = tempDir("keel-typed-runner-parent-symlink-workspace-");
    const outside = tempDir("keel-typed-runner-parent-symlink-outside-");
    try {
      mkdirSync(join(workspace, "parent"));
      const prepared = prepareWriteToolMutation(
        { path: "parent/missing/notes.txt", content: "keel-installed" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );
      const sandbox = localHelperSandbox((helperPath) => {
        const source = readFileSync(helperPath, "utf8");
        const withSymlinkImport = source.replace(
          "  renameSync,\n  rmSync,",
          "  renameSync,\n  rmSync,\n  symlinkSync,",
        );
        const needle = "      stable.push({ path: current, expected });";
        const injected = withSymlinkImport.replace(
          needle,
          `${needle}\n      if (current.endsWith(sep + "parent")) {\n        renameSync(current, current + "-prepared");\n        symlinkSync(${JSON.stringify(outside)}, current, "dir");\n      }`,
        );
        if (injected === source) throw new Error("parent-race test injection hook is missing");
        writeFileSync(helperPath, injected, { encoding: "utf8", mode: 0o600 });
      });
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });

      const settlement = await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
      );
      expectMutationError(settlement, "failed", /parent.*changed after preparation/u);
      expect(existsSync(join(outside, "missing"))).toBe(false);
      expect(existsSync(join(workspace, "parent-prepared", "missing"))).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("verifies the installed postimage and reports drift as mutation-possible", async () => {
    const tempRoot = tempDir("keel-typed-runner-postimage-temp-");
    const workspace = tempDir("keel-typed-runner-postimage-workspace-");
    try {
      const sandbox = localHelperSandbox((helperPath) => {
        const source = readFileSync(helperPath, "utf8");
        const needle = "renameSync(tmpName, targetName);";
        const injected = source.replace(
          needle,
          `${needle}\n    writeFileSync(targetName, "concurrent-postimage", "utf8");`,
        );
        if (injected === source) throw new Error("postimage test injection hook is missing");
        writeFileSync(helperPath, injected, { encoding: "utf8", mode: 0o600 });
      });
      const runner = createSandboxTypedMutationRunner({ sandbox, declaredTempRoots: [tempRoot] });
      const prepared = prepareWriteToolMutation(
        { path: "notes.txt", content: "keel-installed" },
        { workspaceRoot: workspace, state: createTypedToolState() },
      );

      const settlement = await runner?.execute(
        request(
          workspace,
          {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          },
          prepared,
        ),
      );
      expectMutationError(settlement, "indeterminate", /installed postimage/u, true);
      expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("concurrent-postimage");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("preserves committed settlement across cleanup failure and fails closed on one bounded debt", async () => {
    const tempRoot = tempDir("keel-typed-runner-cleanup-temp-");
    const workspace = tempDir("keel-typed-runner-cleanup-workspace-");
    const secret = "SECRET-CLEANUP-DIAGNOSTIC";
    let removeCalls = 0;
    let sandboxExecutions = 0;
    try {
      const sandbox: SandboxPort = {
        status: () => ({
          available: true,
          backend: "srt:vendored",
          enforcementTier: "sandbox:srt",
        }),
        execute: async () => {
          sandboxExecutions += 1;
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        },
      };
      const runner = createSandboxTypedMutationRunner({
        sandbox,
        declaredTempRoots: [],
        createPayloadRoot: () => borrowedPayloadRoot(tempRoot),
        removeDirectory: (path: string) => {
          removeCalls += 1;
          if (removeCalls <= 2) throw new Error(secret);
          rmSync(path, { recursive: true, force: true });
        },
      });
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace], allowWrite: [workspace] },
        network: { allowedDomains: [] },
      };

      await expect(runner?.execute(request(workspace, profile))).resolves.toEqual({
        mutation: "committed",
        cleanup: "retry-required",
      });
      const retained = readdirSync(tempRoot);
      expect(retained).toHaveLength(1);
      const retainedRoot = join(tempRoot, retained[0]!);
      expect(readdirSync(retainedRoot).sort()).toEqual(["helper.mjs", "request.json"]);
      const helperBytes = statSync(join(retainedRoot, "helper.mjs")).size;
      const requestBytes = statSync(join(retainedRoot, "request.json")).size;
      expect(helperBytes).toBeLessThanOrEqual(128 * 1024);
      expect(requestBytes).toBeLessThanOrEqual(TYPED_MUTATION_MAX_PAYLOAD_BYTES);
      expect(helperBytes + requestBytes).toBeLessThanOrEqual(
        TYPED_MUTATION_MAX_PAYLOAD_BYTES + 128 * 1024,
      );

      let blocked: unknown;
      try {
        await runner?.execute(request(workspace, profile));
      } catch (error) {
        blocked = error;
      }
      expect(blocked).toBeInstanceOf(TypedToolError);
      expect((blocked as TypedToolError).code).toBe("TOOL_DENIED");
      expect((blocked as TypedToolError).mutationPossible).toBe(false);
      expect((blocked as Error).message).not.toContain(secret);
      expect(sandboxExecutions).toBe(1);

      await expect(runner?.execute(request(workspace, profile))).resolves.toEqual({
        mutation: "committed",
        cleanup: "complete",
      });
      expect(sandboxExecutions).toBe(2);
      expect(removeCalls).toBe(4);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("admits only one execution and one cleanup debt across concurrent calls", async () => {
    const tempRoot = tempDir("keel-typed-runner-concurrent-temp-");
    const workspace = tempDir("keel-typed-runner-concurrent-workspace-");
    const resultResolvers: Array<
      (result: { exitCode: number; signal: null; stdout: string; stderr: string }) => void
    > = [];
    let sandboxExecutions = 0;
    let directoryCreations = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            sandboxExecutions += 1;
            return await new Promise((resolve) => resultResolvers.push(resolve));
          },
        },
        declaredTempRoots: [tempRoot],
        createDirectory: (prefix) => {
          directoryCreations += 1;
          return mkdtempSync(prefix);
        },
        removeDirectory: () => {
          throw new Error("retained cleanup debt");
        },
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace], allowWrite: [workspace] },
        network: { allowedDomains: [] },
      };

      const first = runner.execute(request(workspace, profile));
      await vi.waitFor(() => expect(sandboxExecutions).toBeGreaterThanOrEqual(1));
      const second = Promise.resolve(runner.execute(request(workspace, profile))).then(
        () => undefined,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setImmediate(resolve));
      for (const resolve of resultResolvers) {
        resolve({ exitCode: 0, signal: null, stdout: "", stderr: "" });
      }
      const [firstSettlement, secondError] = await Promise.all([first, second]);

      expect(firstSettlement).toEqual({ mutation: "committed", cleanup: "retry-required" });
      expect(secondError).toMatchObject({ code: "TOOL_DENIED", mutationPossible: false });
      expect(sandboxExecutions).toBe(1);
      expect(directoryCreations).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("closes deterministically across an in-flight execution and rejects post-close calls", async () => {
    const tempRoot = tempDir("keel-typed-runner-close-race-temp-");
    const workspace = tempDir("keel-typed-runner-close-race-workspace-");
    let settleSandbox:
      | ((result: { exitCode: number; signal: null; stdout: string; stderr: string }) => void)
      | undefined;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () =>
            await new Promise((resolve) => {
              settleSandbox = resolve;
            }),
        },
        declaredTempRoots: [tempRoot],
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");
      const profile: SandboxProfile = {
        filesystem: { allowRead: [workspace], allowWrite: [workspace] },
        network: { allowedDomains: [] },
      };

      const inFlight = runner.execute(request(workspace, profile));
      await vi.waitFor(() => expect(settleSandbox).toBeTypeOf("function"));
      expect(runner.close?.()).toEqual({ cleanup: "retry-required" });
      expect(runner.close?.()).toEqual({ cleanup: "retry-required" });
      settleSandbox?.({ exitCode: 0, signal: null, stdout: "", stderr: "" });
      await expect(inFlight).resolves.toEqual({ mutation: "committed", cleanup: "complete" });
      expect(runner.close?.()).toEqual({ cleanup: "complete" });
      expect(runner.close?.()).toEqual({ cleanup: "complete" });
      await expect(runner.execute(request(workspace, profile))).rejects.toMatchObject({
        code: "TOOL_DENIED",
        mutationPossible: false,
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retains one debt when close races an execution whose cleanup fails", async () => {
    const tempRoot = tempDir("keel-typed-runner-close-debt-race-temp-");
    const workspace = tempDir("keel-typed-runner-close-debt-race-workspace-");
    let settleSandbox:
      | ((result: { exitCode: number; signal: null; stdout: string; stderr: string }) => void)
      | undefined;
    let removeCalls = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () =>
            await new Promise((resolve) => {
              settleSandbox = resolve;
            }),
        },
        declaredTempRoots: [],
        createPayloadRoot: () => borrowedPayloadRoot(tempRoot),
        removeDirectory: (path) => {
          removeCalls += 1;
          if (removeCalls === 1) throw new Error("first cleanup fails");
          rmSync(path, { recursive: true, force: true });
        },
      });
      if (runner === undefined) throw new Error("expected typed mutation runner");
      const inFlight = runner.execute(
        request(workspace, {
          filesystem: { allowRead: [workspace], allowWrite: [workspace] },
          network: { allowedDomains: [] },
        }),
      );
      await vi.waitFor(() => expect(settleSandbox).toBeTypeOf("function"));
      expect(runner.close()).toEqual({ cleanup: "retry-required" });
      settleSandbox?.({ exitCode: 0, signal: null, stdout: "", stderr: "" });
      await expect(inFlight).resolves.toEqual({
        mutation: "committed",
        cleanup: "retry-required",
      });
      expect(runner.close()).toEqual({ cleanup: "complete" });
      expect(removeCalls).toBe(2);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retries one cleanup debt on close without exposing retained payload bytes", async () => {
    const tempRoot = tempDir("keel-typed-runner-close-debt-temp-");
    const workspace = tempDir("keel-typed-runner-close-debt-workspace-");
    let removeCalls = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }),
        },
        declaredTempRoots: [],
        createPayloadRoot: () => borrowedPayloadRoot(tempRoot),
        removeDirectory: (path) => {
          removeCalls += 1;
          if (removeCalls <= 2) throw new Error("SECRET-RETAINED-PAYLOAD");
          rmSync(path, { recursive: true, force: true });
        },
      });

      await expect(
        runner?.execute(
          request(workspace, {
            filesystem: { allowRead: [workspace], allowWrite: [workspace] },
            network: { allowedDomains: [] },
          }),
        ),
      ).resolves.toEqual({ mutation: "committed", cleanup: "retry-required" });
      expect(readdirSync(tempRoot)).toHaveLength(1);
      expect(runner?.close?.()).toEqual({ cleanup: "retry-required" });
      expect(readdirSync(tempRoot)).toHaveLength(1);
      expect(runner?.close?.()).toEqual({ cleanup: "complete" });
      expect(removeCalls).toBe(3);
      expect(readdirSync(tempRoot)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects an oversized helper payload before creating cleanup debt or dispatching", async () => {
    const tempRoot = tempDir("keel-typed-runner-payload-cap-temp-");
    const workspace = tempDir("keel-typed-runner-payload-cap-workspace-");
    let sandboxExecutions = 0;
    try {
      const runner = createSandboxTypedMutationRunner({
        sandbox: {
          status: () => ({
            available: true,
            backend: "srt:vendored",
            enforcementTier: "sandbox:srt",
          }),
          execute: async () => {
            sandboxExecutions += 1;
            return { exitCode: 0, signal: null, stdout: "", stderr: "" };
          },
        },
        declaredTempRoots: [tempRoot],
      });

      await expect(
        runner?.execute(
          request(
            workspace,
            { filesystem: {}, network: { allowedDomains: [] } },
            mutation("x".repeat(TYPED_MUTATION_MAX_PAYLOAD_BYTES)),
          ),
        ),
      ).rejects.toMatchObject({ code: "TOOL_DENIED", mutationPossible: false });
      expect(sandboxExecutions).toBe(0);
      expect(readdirSync(tempRoot)).toEqual([]);
      expect(runner?.close?.()).toEqual({ cleanup: "complete" });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
