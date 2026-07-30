import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorPort, ToolInvocationT, ToolSpecT } from "@keel/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductionWardenRuntime } from "../warden/runtime.js";
import { createEvalDirectConsoleBridgeRuntime, createEvalDirectRuntime } from "./runtime.js";

const toolSpec = (name: string): ToolSpecT => ({
  name,
  description: `${name} test spec`,
  parameters: { type: "object", additionalProperties: true },
});

const call = (name: string): ToolInvocationT => ({ id: `call_${name}`, name, args: {} });

function fakeRuntime(options: {
  readonly tools: readonly ToolSpecT[];
  readonly mutating?: (name: string) => boolean;
  readonly calls: string[];
  readonly disposeCalls: string[];
  readonly label: string;
  readonly disposeError?: unknown;
  readonly withLeases?: boolean;
}): ProductionWardenRuntime {
  const executor: ExecutorPort = {
    execute: async (toolCall) => {
      options.calls.push(toolCall.name);
      return { ok: true, output: `${options.label}:${toolCall.name}` };
    },
  };
  return {
    executor,
    tools: options.tools,
    isMutating: options.mutating ?? (() => false),
    view: {
      protectionRoute: "deliberately-unenforced",
      policy: { active: false, label: "none" },
      posture: { sandbox: false, egress: false, audit: false },
    },
    ...(options.withLeases
      ? {
          activeLeases: () => [],
          cleanupLeases: async () => [],
        }
      : {}),
    dispose: async () => {
      options.disposeCalls.push(options.label);
      if ("disposeError" in options) throw options.disposeError;
    },
  };
}

describe("createEvalDirectRuntime — eval-only direct runtime (honest no-enforcement)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "keel-eval-direct-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("emits the NO-WARDEN banner, reports an all-off posture, and wires a working tool runtime", async () => {
    const lines: string[] = [];
    const rt = createEvalDirectRuntime({ cwd, env: {}, emit: (line) => lines.push(line) });
    try {
      // Honest by construction: the banner is loud, and the HUD says no enforcement.
      expect(lines.join("")).toContain("EVAL DIRECT EXECUTOR ACTIVE");
      expect(rt.view.posture).toEqual({ sandbox: false, egress: false, audit: false });
      expect(rt.view.policy.active).toBe(false);
      expect(rt.view.protectionRoute).toBe("deliberately-unenforced");
      // A usable runtime: the five core tools (+ plan) over the in-process LocalExecutor.
      expect(rt.tools.length).toBeGreaterThan(0);
      const bash = rt.tools.find((tool) => tool.name === "bash");
      expect(
        (bash?.parameters as { readonly properties?: Record<string, unknown> }).properties?.[
          "lease"
        ],
      ).toBeDefined();
      expect(typeof rt.executor.execute).toBe("function");
      expect(typeof rt.cleanupLeases).toBe("function");
      expect(typeof rt.activeLeases).toBe("function");
      expect(rt.activeLeases?.()).toEqual([]);
      await expect(rt.cleanupLeases?.()).resolves.toEqual([]);
      expect(rt.isMutating("write")).toBe(true);
      expect(rt.isMutating("read")).toBe(false);
    } finally {
      await rt.dispose();
    }
  });

  it("defaults the banner sink to process.stderr and accepts no env (covers the optional args)", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const rt = createEvalDirectRuntime({ cwd }); // no emit, no env
    try {
      expect(stderr).toHaveBeenCalled();
      expect(rt.executor).toBeDefined();
    } finally {
      stderr.mockRestore();
      await rt.dispose();
    }
  });

  it("accepts a readEvents reader (covers the optional retrieve-tool branch)", async () => {
    const rt = createEvalDirectRuntime({ cwd, env: {}, readEvents: () => [], emit: () => {} });
    try {
      expect(rt.executor).toBeDefined();
      expect(rt.tools.length).toBeGreaterThan(0);
    } finally {
      await rt.dispose();
    }
  });

  it("bridges only interactive console tools to the warden while keeping eval-direct tools local", async () => {
    const directCalls: string[] = [];
    const consoleCalls: string[] = [];
    const disposeCalls: string[] = [];
    const emitted: string[] = [];
    const direct = fakeRuntime({
      tools: [toolSpec("bash"), toolSpec("plan"), toolSpec("interactive_console.direct_local")],
      mutating: (name) => name === "bash",
      calls: directCalls,
      disposeCalls,
      label: "direct",
      withLeases: true,
    });
    const console = fakeRuntime({
      tools: [
        toolSpec("bash"),
        toolSpec("interactive_console.open"),
        toolSpec("interactive_console.read_screen"),
      ],
      mutating: (name) => name.startsWith("interactive_console."),
      calls: consoleCalls,
      disposeCalls,
      label: "warden-console",
    });

    const rt = createEvalDirectConsoleBridgeRuntime({
      direct,
      console,
      emit: (line) => emitted.push(line),
    });
    try {
      expect(emitted.join("")).toContain("INTERACTIVE CONSOLE WARDEN BRIDGE ACTIVE");
      expect(rt.view).toEqual(direct.view);
      expect(rt.tools.map((tool) => tool.name)).toEqual([
        "bash",
        "plan",
        "interactive_console.open",
        "interactive_console.read_screen",
      ]);
      await expect(rt.executor.execute(call("bash"))).resolves.toEqual({
        ok: true,
        output: "direct:bash",
      });
      await expect(rt.executor.execute(call("interactive_console.read_screen"))).resolves.toEqual({
        ok: true,
        output: "warden-console:interactive_console.read_screen",
      });
      await expect(rt.executor.execute(call("interactive_console.close"))).resolves.toEqual({
        ok: false,
        output:
          "interactive console tool interactive_console.close is not available from the warden bridge",
      });
      expect(directCalls).toEqual(["bash"]);
      expect(consoleCalls).toEqual(["interactive_console.read_screen"]);
      expect(rt.isMutating("bash")).toBe(true);
      expect(rt.isMutating("plan")).toBe(false);
      expect(rt.isMutating("interactive_console.read_screen")).toBe(true);
      expect(rt.isMutating("interactive_console.close")).toBe(true);
      expect(rt.activeLeases?.()).toEqual([]);
      await expect(rt.cleanupLeases?.()).resolves.toEqual([]);
    } finally {
      await rt.dispose();
    }
    expect(disposeCalls).toEqual(["direct", "warden-console"]);
  });

  it("fails closed when an eval-direct console bridge is requested but the warden advertises no console tools", async () => {
    const direct = fakeRuntime({
      tools: [toolSpec("bash")],
      calls: [],
      disposeCalls: [],
      label: "direct",
    });
    const console = fakeRuntime({
      tools: [toolSpec("bash")],
      calls: [],
      disposeCalls: [],
      label: "warden-console",
    });

    expect(() => createEvalDirectConsoleBridgeRuntime({ direct, console, emit: () => {} })).toThrow(
      /interactive console/i,
    );
  });

  it("disposes both bridged runtimes and converts direct-runtime non-Error disposal failures", async () => {
    const disposeCalls: string[] = [];
    const rt = createEvalDirectConsoleBridgeRuntime({
      direct: fakeRuntime({
        tools: [toolSpec("bash")],
        calls: [],
        disposeCalls,
        label: "direct",
        disposeError: "direct dispose failed",
      }),
      console: fakeRuntime({
        tools: [toolSpec("interactive_console.open")],
        calls: [],
        disposeCalls,
        label: "warden-console",
      }),
      emit: () => {},
    });

    await expect(rt.dispose()).rejects.toThrow("direct dispose failed");
    expect(disposeCalls).toEqual(["direct", "warden-console"]);
  });

  it("surfaces console-runtime disposal failures when direct-runtime disposal succeeds", async () => {
    const disposeCalls: string[] = [];
    const rt = createEvalDirectConsoleBridgeRuntime({
      direct: fakeRuntime({
        tools: [toolSpec("bash")],
        calls: [],
        disposeCalls,
        label: "direct",
      }),
      console: fakeRuntime({
        tools: [toolSpec("interactive_console.open")],
        calls: [],
        disposeCalls,
        label: "warden-console",
        disposeError: new Error("console dispose failed"),
      }),
      emit: () => {},
    });

    await expect(rt.dispose()).rejects.toThrow("console dispose failed");
    expect(disposeCalls).toEqual(["direct", "warden-console"]);
  });
});
