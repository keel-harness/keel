import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@keel/shared";
import { attachWardenClient, startWardenClient, WardenClientError } from "./client.js";
import { WardenExecutor } from "./executor.js";
import { mutationPresentationResolverFor } from "./mutation-presentation-resolver.js";

const ROOT = process.cwd();
const WARDEN_BIN = join(ROOT, "packages/warden/src/bin-entry.ts");
const WARDEN_CREDENTIAL_PROXY_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/credential-proxy.ts"),
).href;
// Generous real-warden handshake budget: a real spawn boots via tsx (TypeScript transpile + module
// load) before its first JSON-RPC frame, and under full-suite fork-pool saturation the child is
// CPU-starved so a 3-5s budget times out — a host-load artifact, not a logic failure (P0 flake).
// 15s clears any realistic loaded cold-start while staying under vitest's 20s testTimeout so a
// genuinely-hung warden still fails cleanly.
const REAL_WARDEN_HANDSHAKE_TIMEOUT_MS = 15_000;
const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const TEST_PRINCIPAL = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
} as const;

const children: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];

type FakeChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  readonly killed: boolean;
};

function fakeChild(options: { writeThrows?: boolean; exitCode?: number | null } = {}): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  if (options.writeThrows === true) {
    Object.defineProperty(stdin, "write", {
      value: () => {
        throw new Error("write failed");
      },
    });
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill(_signal?: NodeJS.Signals | number): boolean {
      killed = true;
      setImmediate(() => emitter.emit("close"));
      return true;
    },
  });
  Object.defineProperties(child, {
    killed: {
      get: () => killed,
    },
    exitCode: {
      get: () => options.exitCode ?? null,
    },
    signalCode: {
      get: () => null,
    },
  });
  return child as FakeChild;
}

function spawnFixture(script: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function isolatedKeelHome(): string {
  const dir = mkdtempSync(join(realpathSync(systemTmpdir()), "keel-warden-client-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 500);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGKILL");
      });
    }),
  );
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withManagedHostNodeEnv<T>(
  hostNodeEnv: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const keys = ["NODE_ENV", "KEEL_HOST_NODE_ENV", "KEEL_HOST_NODE_ENV_MANAGED"] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env["NODE_ENV"] = "production";
  process.env["KEEL_HOST_NODE_ENV_MANAGED"] = "1";
  if (hostNodeEnv === undefined) delete process.env["KEEL_HOST_NODE_ENV"];
  else process.env["KEEL_HOST_NODE_ENV"] = hostNodeEnv;
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function envProbeWardenScript(capturePath: string): string {
  return `
    const { writeFileSync } = require("node:fs");
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      NODE_ENV: process.env.NODE_ENV,
      KEEL_HOST_NODE_ENV: process.env.KEEL_HOST_NODE_ENV,
      KEEL_HOST_NODE_ENV_MANAGED: process.env.KEEL_HOST_NODE_ENV_MANAGED
    }));
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.method !== "warden.hello") continue;
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            wardenVersion: "env-probe",
            protocolVersion: request.params.protocolVersion,
            capabilities: [],
            enforcementTier: "none",
            policyPack: { name: "none", hash: ${JSON.stringify(ZERO_HASH)} }
          }
        }) + "\\n");
      }
    });
  `;
}

function credentialProxyProbeWardenScript(sourcePath: string, capturePath: string): string {
  return `
    import { resolveCredentialProxyRules } from ${JSON.stringify(WARDEN_CREDENTIAL_PROXY_URL)};

    resolveCredentialProxyRules([{
      id: "node-env-probe",
      mode: "swap_on_access",
      host: "api.example.com",
      scheme: "Bearer",
      source: {
        kind: "command",
        command: ${JSON.stringify(process.execPath)},
        args: [${JSON.stringify(sourcePath)}, ${JSON.stringify(capturePath)}]
      }
    }]);

    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (request.method !== "warden.hello") continue;
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            wardenVersion: "credential-proxy-env-probe",
            protocolVersion: request.params.protocolVersion,
            capabilities: [],
            enforcementTier: "none",
            policyPack: { name: "none", hash: ${JSON.stringify(ZERO_HASH)} }
          }
        }) + "\\n");
      }
    });
  `;
}

function wardenSpawnOptions(
  protocolVersion: string = PROTOCOL_VERSION,
): Parameters<typeof startWardenClient>[0] {
  return {
    command: process.execPath,
    args: ["--import", "tsx/esm", "--conditions=@keel/source", WARDEN_BIN],
    cwd: ROOT,
    env: { FORCE_COLOR: "0", KEEL_HOME: isolatedKeelHome() },
    kernelVersion: "0.0.0",
    protocolVersion,
    requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
  };
}

function fakeSandboxWardenSpawnOptions(): Parameters<typeof startWardenClient>[0] {
  return {
    command: process.execPath,
    args: [
      "--import",
      "tsx/esm",
      "--conditions=@keel/source",
      "--input-type=module",
      "-e",
      `
        import { runStdioWardenServer } from "./packages/warden/src/rpc-server.ts";

        runStdioWardenServer({
          sandbox: {
            status: () => ({
              available: true,
              backend: "fake-process-sandbox",
              enforcementTier: "sandbox:fake"
            }),
            execute: async (invocation, profile) => ({
              exitCode: 0,
              signal: null,
              stdout: JSON.stringify({ invocation, profile }),
              stderr: ""
            })
          }
        });
      `,
    ],
    cwd: ROOT,
    env: { FORCE_COLOR: "0", KEEL_HOME: isolatedKeelHome() },
    kernelVersion: "0.0.0",
    requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
  };
}

function statusResult(): unknown {
  return {
    enforcementTier: "none",
    sandboxBackend: "none",
    policyPack: { name: "none", hash: ZERO_HASH },
    auditHead: { seq: 0, hash: ZERO_HASH },
    pendingReviews: 0,
  };
}

describe("kernel warden process client", () => {
  it("spawns the real warden, handshakes, and validates status responses", async () => {
    const client = await startWardenClient(wardenSpawnOptions());
    children.push(client.child);
    try {
      expect(client.hello.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(client.hello.enforcementTier).toBe("none");

      const status = await client.call("warden.status", {});
      expect(status.enforcementTier).toBe("none");
      expect(status.sandboxBackend).toBe("none");
      expect(status.pendingReviews).toBe(0);
    } finally {
      await client.close();
    }
  });

  it.each([
    { label: "unset", hostNodeEnv: undefined, expected: {} },
    { label: "development", hostNodeEnv: "development", expected: { NODE_ENV: "development" } },
    { label: "production", hostNodeEnv: "production", expected: { NODE_ENV: "production" } },
  ])(
    "restores the host NODE_ENV ($label) at the real warden spawn and strips both sentinels",
    async ({ hostNodeEnv, expected }) => {
      await withManagedHostNodeEnv(hostNodeEnv, async () => {
        const capturePath = join(isolatedKeelHome(), "warden-env.json");
        const client = await startWardenClient({
          command: process.execPath,
          args: ["-e", envProbeWardenScript(capturePath)],
          cwd: ROOT,
          kernelVersion: "0.0.0",
          requestTimeoutMs: 1_000,
        });
        children.push(client.child);
        try {
          expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual(expected);
        } finally {
          await client.close();
        }
      });
    },
  );

  it("keeps launcher-captured NODE_ENV sentinels authoritative over injected spawn env", async () => {
    await withManagedHostNodeEnv("development", async () => {
      const capturePath = join(isolatedKeelHome(), "warden-env.json");
      const client = await startWardenClient({
        command: process.execPath,
        args: ["-e", envProbeWardenScript(capturePath)],
        cwd: ROOT,
        env: {
          NODE_ENV: "caller-override",
          KEEL_HOST_NODE_ENV: "caller-override",
          KEEL_HOST_NODE_ENV_MANAGED: "0",
        },
        kernelVersion: "0.0.0",
        requestTimeoutMs: 1_000,
      });
      children.push(client.child);
      try {
        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
          NODE_ENV: "development",
        });
      } finally {
        await client.close();
      }
    });
  });

  it("keeps credential-proxy command sources on the restored host env", async () => {
    await withManagedHostNodeEnv(undefined, async () => {
      const dir = isolatedKeelHome();
      const sourcePath = join(dir, "credential-source.cjs");
      const capturePath = join(dir, "credential-source-env.json");
      writeFileSync(
        sourcePath,
        `
          const { writeFileSync } = require("node:fs");
          writeFileSync(process.argv[2], JSON.stringify({
            NODE_ENV: process.env.NODE_ENV,
            KEEL_HOST_NODE_ENV: process.env.KEEL_HOST_NODE_ENV,
            KEEL_HOST_NODE_ENV_MANAGED: process.env.KEEL_HOST_NODE_ENV_MANAGED
          }));
          process.stdout.write("fixture-secret\\n");
        `,
        "utf8",
      );

      const client = await startWardenClient({
        command: process.execPath,
        args: [
          "--import",
          "tsx/esm",
          "--conditions=@keel/source",
          "--input-type=module",
          "-e",
          credentialProxyProbeWardenScript(sourcePath, capturePath),
        ],
        cwd: ROOT,
        kernelVersion: "0.0.0",
        requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
      });
      children.push(client.child);
      try {
        expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({});
      } finally {
        await client.close();
      }
    });
  });

  it("keeps a protocol-1.1 kernel compatible with a protocol-1.0 warden without presentation work", async () => {
    const client = await startWardenClient({
      command: process.execPath,
      args: [
        "-e",
        `
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const newline = buffer.indexOf("\\n");
              if (newline < 0) return;
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              const request = JSON.parse(line);
              const result = request.method === "warden.hello"
                ? {
                    wardenVersion: "0.0.0-old",
                    protocolVersion: "1.0.0",
                    capabilities: [],
                    enforcementTier: "sandbox:old-fixture",
                    policyPack: { name: "old-fixture", hash: ${JSON.stringify(ZERO_HASH)} }
                  }
                : request.method === "warden.execute"
                  ? { verdict: "allow", result: "edited by old warden", auditSeq: 4 }
                  : null;
              const response = result === null
                ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } }
                : { jsonrpc: "2.0", id: request.id, result };
              process.stdout.write(JSON.stringify(response) + "\\n");
            }
          });
        `,
      ],
      cwd: ROOT,
      kernelVersion: "0.0.0",
      protocolVersion: PROTOCOL_VERSION,
      requestTimeoutMs: 1_000,
    });
    children.push(client.child);
    try {
      expect(client.hello.protocolVersion).toBe("1.0.0");
      expect(client.hello.capabilities).not.toContain("mutation-presentation/v1");
      const executor = new WardenExecutor({
        client,
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      });
      const result = await executor.execute({
        id: "edit-old-peer",
        name: "edit",
        args: { path: "a.ts", oldString: "before", newString: "after" },
      });

      expect(result).toEqual({ ok: true, output: "edited by old warden" });
      expect(mutationPresentationResolverFor(result)).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("DENIED PATH: returns actionable guidance to the model, then allows a corrected command through the same warden process", async () => {
    const client = await startWardenClient(fakeSandboxWardenSpawnOptions());
    children.push(client.child);
    const executor = new WardenExecutor({
      client,
      sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    try {
      const denied = await executor.execute({
        id: "tc_denied",
        name: "bash",
        args: { command: "cat .env" },
      });
      expect(denied.ok).toBe(false);
      expect(denied.output).toContain("blocked by warden");
      expect(denied.output).toMatch(/secret|blocked|workspace-safe|policy/i);

      const corrected = await executor.execute({
        id: "tc_corrected",
        name: "bash",
        args: { command: "printf ok" },
      });
      expect(corrected.ok).toBe(true);
      expect(corrected.output).toContain("printf ok");
    } finally {
      await client.close();
    }
  });

  it("refuses startup when the warden reports a protocol-major mismatch", async () => {
    await expect(startWardenClient(wardenSpawnOptions("2.0.0"))).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
  });

  it("rejects invalid response payloads instead of trusting unvalidated data", async () => {
    const child = spawnFixture(`
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        const id = JSON.parse(String(chunk).trim()).id;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { bad: true } }) + "\\n");
      });
    `);
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });

    await expect(client.call("warden.status", {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects invalid params locally before writing to the warden", async () => {
    const child = spawnFixture("process.stdin.resume();");
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });

    await expect(client.call("warden.status", { extra: true })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
      requestSent: false,
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects stdin write failures as warden-unavailable", async () => {
    const child = fakeChild({ writeThrows: true });
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });

    await expect(client.call("warden.status", {})).rejects.toMatchObject({
      code: "WARDEN_UNAVAILABLE",
      requestSent: false,
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects invalid JSON and invalid JSON-RPC responses from the child", async () => {
    const invalidJson = spawnFixture(`
      process.stdin.once("data", () => {
        process.stdout.write("not-json\\n");
      });
    `);
    const invalidJsonClient = attachWardenClient(invalidJson, { requestTimeoutMs: 1_000 });
    await expect(invalidJsonClient.call("warden.status", {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const invalidEnvelope = spawnFixture(`
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, result: {} }) + "\\n");
      });
    `);
    const invalidEnvelopeClient = attachWardenClient(invalidEnvelope, { requestTimeoutMs: 1_000 });
    await expect(invalidEnvelopeClient.call("warden.status", {})).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });

    const invalidKnownId = fakeChild();
    const invalidKnownIdClient = attachWardenClient(invalidKnownId, { requestTimeoutMs: 1_000 });
    const pending = invalidKnownIdClient.call("warden.status", {});
    invalidKnownId.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, nope: true }) + "\n");
    await expect(pending).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("drains pending calls on a child process error event", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    const pending = client.call("warden.status", {});

    child.emit("error", new Error("child pipe failed"));

    await expect(pending).rejects.toMatchObject({ code: "WARDEN_UNAVAILABLE" });
    expect(client.pendingCount()).toBe(0);
  });

  it("includes child stderr when process death drains pending calls", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    const pending = client.call("warden.status", {});

    child.stderr.write("warden exploded");
    child.emit("close");

    await expect(pending).rejects.toMatchObject({ code: "WARDEN_UNAVAILABLE" });
    await expect(pending).rejects.toThrow(/warden exploded/);
    expect(client.pendingCount()).toBe(0);
  });

  it("reports isClosed() false while live and true after the child closes", () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    expect(client.isClosed()).toBe(false);
    child.emit("close");
    expect(client.isClosed()).toBe(true);
  });

  it("reports isClosed() true once the child has a non-null exit code", () => {
    const child = fakeChild({ exitCode: 0 });
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    expect(client.isClosed()).toBe(true);
  });

  it("reports isClosed() true after a fatal child error, before close fires", () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    expect(client.isClosed()).toBe(false);
    child.emit("error", new Error("spawn EACCES"));
    expect(client.isClosed()).toBe(true);
  });

  it("treats JSON-RPC errors with a null id as process-wide failures", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    const pending = client.call("warden.status", {});

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "fatal boundary failure",
          data: { code: "FATAL_BOUNDARY_FAILURE" },
        },
      })}\n`,
    );

    await expect(pending).rejects.toMatchObject({
      code: "FATAL_BOUNDARY_FAILURE",
      rpcCode: -32000,
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("ignores JSON-RPC responses whose ids do not match an outstanding request", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    const pending = client.call("warden.status", {});

    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, result: statusResult() })}\n`);
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 100,
        error: { code: -32000, message: "stale response" },
      })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: statusResult() })}\n`);

    await expect(pending).resolves.toMatchObject({
      enforcementTier: "none",
      sandboxBackend: "none",
    });
    expect(client.pendingCount()).toBe(0);
  });

  it("maps JSON-RPC error responses without data.code to RPC_ERROR", async () => {
    const child = spawnFixture(`
      process.stdin.on("data", (chunk) => {
        const id = JSON.parse(String(chunk).trim()).id;
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "plain failure" }
        }) + "\\n");
      });
    `);
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });

    await expect(client.call("warden.status", {})).rejects.toMatchObject({
      code: "RPC_ERROR",
      rpcCode: -32000,
    });
  });

  it("drains pending calls when the warden dies and never falls back to local execution", async () => {
    const child = spawnFixture(`
      process.stdin.once("data", () => {
        process.stderr.write("boom");
        process.stdin.resume();
      });
    `);
    const client = attachWardenClient(child, { requestTimeoutMs: 5_000 });
    const pending = client.call("warden.status", {});

    await new Promise((resolve) => setTimeout(resolve, 20));
    child.kill("SIGKILL");

    await expect(pending).rejects.toMatchObject({ code: "WARDEN_UNAVAILABLE" });
    expect(client.pendingCount()).toBe(0);
  });

  it("maps execute non-execution into a structured fail-closed result", async () => {
    const client = await startWardenClient(wardenSpawnOptions());
    children.push(client.child);
    try {
      await expect(
        client.call("warden.execute", {
          sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          toolCall: { id: "tc_1", name: "bash", args: { command: "touch should-not-exist" } },
          provenanceContext: { inputTags: ["workspace"] },
        }),
      ).rejects.toMatchObject({
        code: "TIER_UNAVAILABLE",
      });
    } finally {
      await client.close();
    }
  });

  it("routes egress review and once approval across a real warden process boundary", async () => {
    const client = await startWardenClient(fakeSandboxWardenSpawnOptions());
    children.push(client.child);
    try {
      const execute = await client.call("warden.execute", {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCall: {
          id: "tc_egress",
          name: "bash",
          args: { command: "curl -fsS https://Example.COM/releases/latest" },
        },
        provenanceContext: { inputTags: ["workspace"] },
      });

      expect(execute.verdict).toBe("review");
      expect(execute.review?.summary).toContain("example.com");
      expect(execute.review?.allowCommand).toContain("--scope once");
      expect(execute.auditSeq).toBe(0);

      const status = await client.call("warden.status", {});
      expect(status.pendingReviews).toBe(1);
      expect(status.policyPack.name).toBe("phase2a-starter-policy-pack");
      expect(status.auditHead.seq).toBe(0);

      const reviewId = execute.review?.reviewId;
      if (reviewId === undefined) throw new Error("expected pending egress review id");
      const resolved = await client.call("warden.resolveReview", {
        reviewId,
        approved: true,
        principal: TEST_PRINCIPAL,
        scope: "once",
      });
      expect(resolved.verdict).toBe("allow");
      expect(resolved.auditSeq).toBe(0);
      const result = resolved.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error(`expected command result object, got ${JSON.stringify(result)}`);
      }
      const stdout = result["stdout"];
      if (typeof stdout !== "string") {
        throw new Error(`expected command stdout, got ${JSON.stringify(result)}`);
      }
      const sandboxObservation = JSON.parse(stdout) as {
        profile?: { network?: { allowedDomains?: string[] } };
      };
      expect(sandboxObservation.profile?.network?.allowedDomains).toEqual(["example.com"]);

      await expect(
        client.call("warden.resolveReview", {
          reviewId,
          approved: true,
          principal: TEST_PRINCIPAL,
          scope: "once",
        }),
      ).rejects.toMatchObject({ code: "REVIEW_NOT_FOUND" });
    } finally {
      await client.close();
    }
  });

  it("routes policy denial before sandbox execution across a real warden process boundary", async () => {
    const client = await startWardenClient(fakeSandboxWardenSpawnOptions());
    children.push(client.child);
    try {
      const denied = await client.call("warden.execute", {
        sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        toolCall: {
          id: "tc_policy_deny",
          name: "bash",
          args: { command: "cat .env" },
        },
        provenanceContext: { inputTags: ["workspace"] },
      });

      expect(denied.verdict).toBe("deny");
      expect(denied.guidance).toContain("POL-001");
      expect(denied.result).toBeUndefined();

      const status = await client.call("warden.status", {});
      expect(status.pendingReviews).toBe(0);
      expect(status.policyPack.name).toBe("phase2a-starter-policy-pack");
      expect(status.policyPack.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(status.auditHead.seq).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("exposes local client errors as WardenClientError instances", async () => {
    const child = spawnFixture("process.stdin.resume();");
    const client = attachWardenClient(child, { requestTimeoutMs: 20 });

    await expect(client.call("warden.status", {})).rejects.toBeInstanceOf(WardenClientError);
  });

  it("rejects calls after close without restarting or falling back", async () => {
    const child = spawnFixture("process.stdin.resume();");
    const client = attachWardenClient(child, { requestTimeoutMs: 20 });

    await client.close();

    await expect(client.call("warden.status", {})).rejects.toMatchObject({
      code: "WARDEN_UNAVAILABLE",
    });
  });

  it("close is a no-op for an already exited child", async () => {
    const child = fakeChild({ exitCode: 0 });
    const client = attachWardenClient(child);

    await client.close();

    expect(client.pendingCount()).toBe(0);
  });

  it("kills the warden and drains the pending call on request timeout", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 5 });

    await expect(client.call("warden.status", {})).rejects.toMatchObject({
      code: "WARDEN_TIMEOUT",
    });
    expect(child.killed).toBe(true);
    expect(client.pendingCount()).toBe(0);
    await expect(client.call("warden.status", {})).rejects.toMatchObject({
      code: "WARDEN_UNAVAILABLE",
    });
  });

  it("keeps the warden alive when presentation-only take times out and ignores its late response", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });

    try {
      await expect(
        client.call(
          "warden.presentation.take",
          {
            sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            toolCallId: "edit-presentation-timeout",
            auditSeq: 7,
          },
          { timeoutMs: 5 },
        ),
      ).rejects.toMatchObject({ code: "WARDEN_TIMEOUT" });
      expect(child.killed).toBe(false);
      expect(client.isClosed()).toBe(false);
      expect(client.pendingCount()).toBe(0);

      child.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { status: "unavailable", reason: "not-found-or-consumed" },
        })}\n`,
      );
      const status = client.call("warden.status", {}, { timeoutMs: 100 });
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: statusResult() })}\n`);
      await expect(status).resolves.toMatchObject({
        enforcementTier: "none",
        sandboxBackend: "none",
      });
      expect(child.killed).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("honors a per-call timeout override for long-running requests", async () => {
    const child = spawnFixture(`
      process.stdin.on("data", (chunk) => {
        const id = JSON.parse(String(chunk).trim()).id;
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: ${JSON.stringify(statusResult())}
          }) + "\\n");
        }, 25);
      });
    `);
    const client = attachWardenClient(child, { requestTimeoutMs: 5 });

    await expect(client.call("warden.status", {}, { timeoutMs: 1_000 })).resolves.toMatchObject({
      enforcementTier: "none",
      sandboxBackend: "none",
    });
  });

  it("kills the warden and drains the pending call when an in-flight request aborts", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = client.call("warden.status", {}, { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "WARDEN_ABORTED" });
    expect(child.killed).toBe(true);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects an already aborted request before writing to the warden", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, { requestTimeoutMs: 1_000 });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.call("warden.status", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "WARDEN_ABORTED",
      requestSent: false,
    });
    expect(child.killed).toBe(false);
    expect(client.pendingCount()).toBe(0);
  });

  it("fails closed and kills the warden on an oversized response frame", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, {
      requestTimeoutMs: 1_000,
      responseMaxLineBytes: 32,
    });
    const pending = client.call("warden.status", {});

    child.stdout.write("x".repeat(64));

    await expect(pending).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(child.killed).toBe(true);
    expect(client.pendingCount()).toBe(0);
  });

  it("applies the response size limit per frame, not per stdout chunk", async () => {
    const child = fakeChild();
    const client = attachWardenClient(child, {
      requestTimeoutMs: 1_000,
      responseMaxLineBytes: 512,
    });
    const first = client.call("warden.status", {});
    const second = client.call("warden.status", {});
    const result = statusResult();

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result,
      })}\n`,
    );

    await expect(first).resolves.toMatchObject({ enforcementTier: "none" });
    await expect(second).resolves.toMatchObject({ enforcementTier: "none" });
    expect(child.killed).toBe(false);
    expect(client.pendingCount()).toBe(0);
  });
});

describe("warden process lifecycle — no orphan on kernel death (P1-19)", () => {
  // A warden whose event loop is kept alive by a ref'd handle AFTER stdin EOF — exactly the srt
  // proxy / console-broker handle that, in production, turns a would-be natural process exit into a
  // LIVE orphan holding the audit lock. Without an EOF-triggered shutdown it never exits; with it,
  // `onShutdown` fires and breaks the keep-alive + exits. This is the real regression signal (a
  // hello-only warden would exit naturally on EOF and mask the bug).
  const LINGERING_HANDLE_WARDEN = `
    import { runStdioWardenServer } from "./packages/warden/src/rpc-server.ts";
    const keepAlive = setTimeout(() => process.exit(0), 60_000);
    runStdioWardenServer({
      onShutdown: () => {
        clearTimeout(keepAlive);
        process.exit(0);
      },
    });
  `;

  function spawnLingeringWarden(home: string): ChildProcessWithoutNullStreams {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--conditions=@keel/source",
        "--input-type=module",
        "-e",
        LINGERING_HANDLE_WARDEN,
      ],
      { cwd: ROOT, env: { FORCE_COLOR: "0", KEEL_HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
    );
    children.push(child);
    child.stdout.setEncoding("utf8");
    return child;
  }

  function waitForStdout(
    child: ChildProcessWithoutNullStreams,
    predicate: (acc: string) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let acc = "";
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for warden stdout; got: ${acc.slice(0, 200)}`)),
        timeoutMs,
      );
      child.stdout.on("data", (chunk: string) => {
        acc += chunk;
        if (predicate(acc)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  it("exits when stdin closes without a SIGTERM, even while a handle keeps its loop alive (kernel died)", async () => {
    const child = spawnLingeringWarden(isolatedKeelHome());
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "h1",
        method: "warden.hello",
        params: { kernelVersion: "0.0.0", protocolVersion: PROTOCOL_VERSION },
      })}\n`,
    );
    // Booted + answered the hello (fully up), so the exit below is a real EOF-triggered shutdown —
    // not a boot failure.
    await waitForStdout(
      child,
      (acc) => acc.includes('"h1"') || acc.includes("wardenVersion"),
      REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
    );

    // Simulate a hard kernel death: the RPC pipe closes (EOF). NO warden.shutdown RPC, NO SIGTERM —
    // exactly the `kill -9` / crash case the stale-lock reclaim cannot recover (a live orphan PID).
    // The ref'd keep-alive handle means the warden CANNOT exit naturally; only an EOF-triggered
    // shutdown gets it out.
    child.stdin.end();

    const exited = await waitForExit(child, 10_000);
    expect(exited).toBe(true);
    expect(child.exitCode).toBe(0);
  }, 30_000);

  /** A fake child that records the signals it is sent and only emits `close` on the chosen signal —
   *  so a test can simulate a warden that ignores SIGTERM but dies on SIGKILL. */
  function signalRecordingChild(exitOn: "any" | "sigkill"): {
    child: ChildProcessWithoutNullStreams;
    signals: (NodeJS.Signals | number | undefined)[];
  } {
    const emitter = new EventEmitter();
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal?: NodeJS.Signals | number): boolean {
        signals.push(signal);
        const isKill = signal === "SIGKILL" || signal === 9;
        if (exitOn === "any" || isKill) setImmediate(() => emitter.emit("close"));
        return true;
      },
    });
    Object.defineProperties(child, {
      killed: { get: () => signals.length > 0 },
      exitCode: { get: () => null },
      signalCode: { get: () => null },
    });
    return { child: child as unknown as ChildProcessWithoutNullStreams, signals };
  }

  it("escalates to SIGKILL when the warden ignores SIGTERM on close(), instead of hanging (P1-19)", async () => {
    const { child, signals } = signalRecordingChild("sigkill");
    const client = attachWardenClient(child, { terminateGraceMs: 20 });
    // close() must resolve (not hang) — via the SIGKILL escalation, since SIGTERM is ignored here.
    await client.close();
    expect(signals[0]).toBeUndefined(); // first kill() is a default SIGTERM
    expect(signals).toContain("SIGKILL");
  });

  it("does not SIGKILL a warden that exits promptly on SIGTERM", async () => {
    const { child, signals } = signalRecordingChild("any");
    const client = attachWardenClient(child, { terminateGraceMs: 5_000 });
    await client.close();
    // The child closed on the SIGTERM before the grace window, so no SIGKILL was sent.
    expect(signals).toEqual([undefined]);
  });
});
