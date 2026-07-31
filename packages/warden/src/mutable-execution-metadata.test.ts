import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { JsonRpcSuccessResponse, WARDEN_METHODS } from "@keel/shared";
import {
  runStdioWardenServer,
  type StdioWardenServer,
  type TypedMutationRunner,
} from "./rpc-server.js";
import type { SandboxPort } from "./sandbox.js";
import type { PolicyPort } from "./policy.js";

const SESSION_A = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_B = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ALLOW_POLICY: PolicyPort = {
  packRef: { name: "test-allow-policy", hash: `sha256:${"1".repeat(64)}` },
  evaluate: async () => ({ verdict: "allow", matchedRules: [] }),
};

const typedMutationRunner: TypedMutationRunner = {
  assertReady: () => {},
  quarantine: () => ({ cleanup: "complete" }),
  close: () => ({ cleanup: "complete" }),
  execute: ({ mutation }) => {
    mutation.runInProcessAtomicWrite();
    return { mutation: "committed", cleanup: "complete" };
  },
};

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function executeFrame(
  id: string,
  sessionId: string,
  name: "bash" | "edit" | "read" | "write",
  args: Record<string, unknown>,
): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "warden.execute",
    params: {
      sessionId,
      toolCall: { id: `tc_${id}`, name, args },
      provenanceContext: { inputTags: ["workspace"] },
    },
  };
}

function readLine(output: PassThrough): Promise<string> {
  output.setEncoding("utf8");
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: string): void => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      output.off("data", onData);
      resolve(buffer.slice(0, newline));
    };
    output.on("data", onData);
  });
}

async function send(
  input: PassThrough,
  output: PassThrough,
  frame: unknown,
): Promise<ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["result"]["parse"]>> {
  const responseLine = readLine(output);
  input.write(`${JSON.stringify(frame)}\n`);
  const response = JsonRpcSuccessResponse.parse(JSON.parse(await responseLine));
  return WARDEN_METHODS["warden.execute"].result.parse(response.result);
}

function startHarness(
  workspaceRoot: string,
  policy?: PolicyPort,
): {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly executions: string[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const executions: string[] = [];
  const sandbox: SandboxPort = {
    status: () => ({
      available: true,
      backend: "fake-mutable-metadata-sandbox",
      enforcementTier: "sandbox:fake",
    }),
    execute: async ({ command }) => {
      executions.push(command);
      if (command === "pnpm test") {
        const manifest = readFileSync(join(workspaceRoot, "package.json"), "utf8");
        return {
          exitCode: 0,
          signal: null,
          stdout: manifest.includes("POISON_EXECUTED") ? "POISON_EXECUTED\n" : "clean\n",
          stderr: "",
        };
      }
      return { exitCode: 0, signal: null, stdout: "VCS_EXECUTED\n", stderr: "" };
    },
  };
  const server: StdioWardenServer = runStdioWardenServer({
    input,
    output,
    workspaceRoot,
    workspaceTrusted: true,
    typedMutationRunner,
    sandbox,
    ...(policy === undefined ? {} : { policy }),
  });
  cleanup.push(async () => server.close());
  return { input, output, executions };
}

function fixtureWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "keel-mutable-execution-metadata-"));
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

describe("mutable execution metadata review boundary", () => {
  it("routes a package script to review after the same session writes package.json", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);

    const write = await send(
      input,
      output,
      executeFrame("write-package", SESSION_A, "write", {
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "printf POISON_EXECUTED" } }),
      }),
    );
    expect(write.verdict, JSON.stringify(write)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-package", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("routes a package script to review after the same session edits package.json", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);

    const read = await send(
      input,
      output,
      executeFrame("read-package", SESSION_A, "read", { path: "package.json" }),
    );
    expect(read.verdict, JSON.stringify(read)).toBe("allow");
    const edit = await send(
      input,
      output,
      executeFrame("edit-package", SESSION_A, "edit", {
        path: "package.json",
        oldString: '"test":"true"',
        newString: '"test":"printf POISON_EXECUTED"',
      }),
    );
    expect(edit.verdict, JSON.stringify(edit)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-edited-package", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("routes a VCS read command to review after the same session writes .git/config", async () => {
    const workspace = fixtureWorkspace();
    mkdirSync(join(workspace, ".git"));
    const { input, output, executions } = startHarness(workspace);

    const write = await send(
      input,
      output,
      executeFrame("write-git-config", SESSION_A, "write", {
        path: ".git/config",
        content: "[diff]\n\texternal = printf VCS_EXECUTED\n",
      }),
    );
    expect(write.verdict, JSON.stringify(write)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-git", SESSION_A, "bash", { command: "git diff" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("routes a VCS read command to review after the same session writes a hook", async () => {
    const workspace = fixtureWorkspace();
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    const { input, output, executions } = startHarness(workspace);

    const write = await send(
      input,
      output,
      executeFrame("write-git-hook", SESSION_A, "write", {
        path: ".git/hooks/pre-commit",
        content: "#!/bin/sh\nprintf HOOK_EXECUTED\n",
      }),
    );
    expect(write.verdict, JSON.stringify(write)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-after-git-hook", SESSION_A, "bash", { command: "git status" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("denies a direct bash write to package metadata before sandbox execution", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace, ALLOW_POLICY);

    const run = await send(
      input,
      output,
      executeFrame("touch-package", SESSION_A, "bash", { command: "touch package.json" }),
    );

    expect(run.verdict).toBe("deny");
    expect(run.result).toEqual({ kind: "policy_sandbox_mismatch" });
    expect(executions).toEqual([]);
  });

  it("keeps the invalidation scoped to the session that changed execution metadata", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);

    await send(
      input,
      output,
      executeFrame("write-package-other-session", SESSION_A, "write", {
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "printf POISON_EXECUTED" } }),
      }),
    );
    const run = await send(
      input,
      output,
      executeFrame("run-package-other-session", SESSION_B, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("allow");
    expect(run.result).toMatchObject({ stdout: "POISON_EXECUTED\n" });
    expect(executions).toEqual(["pnpm test"]);
  });

  it("routes a package command to review after the session writes model-executable test code", async () => {
    const workspace = fixtureWorkspace();
    mkdirSync(join(workspace, "src"));
    const { input, output, executions } = startHarness(workspace);

    const write = await send(
      input,
      output,
      executeFrame("write-test-code", SESSION_A, "write", {
        path: "src/poison.test.ts",
        content:
          'import { execSync } from "node:child_process";\nexecSync("printf POISON_EXECUTED");\n',
      }),
    );
    expect(write.verdict, JSON.stringify(write)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-written-test", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("conservatively routes safe commands to review after an ordinary workspace write", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);

    await send(
      input,
      output,
      executeFrame("write-notes", SESSION_A, "write", {
        path: "notes.txt",
        content: "ordinary workspace content\n",
      }),
    );
    const run = await send(
      input,
      output,
      executeFrame("run-after-notes", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("allows a package.json prefix-collision write but still invalidates safe commands", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);

    await send(
      input,
      output,
      executeFrame("write-package-backup", SESSION_A, "write", {
        path: "package.json.backup",
        content: "not execution metadata\n",
      }),
    );
    const run = await send(
      input,
      output,
      executeFrame("run-after-package-backup", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([]);
  });

  it("routes safe commands to review after governed bash writes an ordinary workspace file", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);
    const writeCommand = "printf POISON_EXECUTED > poison.test.ts";

    const write = await send(
      input,
      output,
      executeFrame("bash-write-test", SESSION_A, "bash", { command: writeCommand }),
    );
    expect(write.verdict, JSON.stringify(write)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-after-bash-write", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("review");
    expect(executions).toEqual([writeCommand]);
  });

  it("keeps safe commands eligible after a read-only workspace action", async () => {
    const workspace = fixtureWorkspace();
    const { input, output, executions } = startHarness(workspace);

    const read = await send(
      input,
      output,
      executeFrame("read-package-only", SESSION_A, "read", { path: "package.json" }),
    );
    expect(read.verdict, JSON.stringify(read)).toBe("allow");

    const run = await send(
      input,
      output,
      executeFrame("run-after-read", SESSION_A, "bash", { command: "pnpm test" }),
    );

    expect(run.verdict).toBe("allow");
    expect(executions).toEqual(["pnpm test"]);
  });
});
