import { describe, expect, it } from "vitest";
import { LocalExecutor } from "../local-executor.js";
import { LoopDetector } from "../loop-detection.js";
import {
  type CoreTool,
  PATH_ARG,
  coreToolSpecs,
  registerCoreTools,
  staticCapability,
} from "./registry.js";
import { Workspace } from "./workspace.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool } from "./bash.js";
import { createSearchTool } from "./search.js";
import type { RunResult, ShellSession } from "./shell-session.js";

const echoTool: CoreTool = {
  spec: { name: "echo", description: "echoes its message" },
  handler: (args) => (typeof args["message"] === "string" ? args["message"] : ""),
  staticCapability: staticCapability("echo", ["fs_read"]),
};

describe("tool registry", () => {
  it("registers each tool's handler on the executor by spec name", async () => {
    const exec = new LocalExecutor();
    registerCoreTools(exec, [echoTool]);
    const result = await exec.execute({ id: "1", name: "echo", args: { message: "hi" } });
    expect(result).toEqual({ ok: true, output: "hi" });
  });

  it("coreToolSpecs returns the specs to advertise to the model", () => {
    expect(coreToolSpecs([echoTool])).toEqual([
      { name: "echo", description: "echoes its message" },
    ]);
  });
});

describe("tool spec names (drift-guard)", () => {
  // A trivial fake workspace and shell session to construct tools without real fs/shell deps.
  const ws = new Workspace(process.cwd());
  const fakeSession: ShellSession = {
    run: (_cmd: string): Promise<RunResult> =>
      Promise.resolve({ output: "", exitCode: 0, outcome: "ok", truncated: false }),
    dispose: (): Promise<void> => Promise.resolve(),
  };

  it("each tool's spec.name matches its canonical name", () => {
    expect(createReadTool(ws).spec.name).toBe("read");
    expect(createWriteTool(ws).spec.name).toBe("write");
    expect(createEditTool(ws).spec.name).toBe("edit");
    expect(createBashTool(fakeSession).spec.name).toBe("bash");
    expect(createSearchTool(ws).spec.name).toBe("search");
  });

  it("edit and write spec names are exactly the LoopDetector editTools ('edit', 'write')", () => {
    // LoopDetector fires its file-edits signal on tool names "edit" and "write" (the default).
    // This test breaks if either tool's spec.name drifts from those literal defaults.
    expect(createEditTool(ws).spec.name).toBe("edit");
    expect(createWriteTool(ws).spec.name).toBe("write");
    // Confirm the detector actually fires on these names (the live contract, not just the default).
    const detector = new LoopDetector();
    let signal: ReturnType<typeof detector.record>;
    for (let i = 0; i < 5; i++) {
      signal = detector.record({
        name: createEditTool(ws).spec.name,
        args: { path: "f.ts", n: i },
      });
    }
    expect(signal).toMatchObject({ signal: "file-edits" });
  });
});

describe("PATH_ARG loop-detection contract (spec §5)", () => {
  it("is 'path' — the key the shipped LoopDetector reads (loop-detection.ts default pathArg)", () => {
    expect(PATH_ARG).toBe("path");
  });

  it("a LoopDetector counts repeated same-path edits via PATH_ARG and tool name 'edit'/'write'", () => {
    for (const toolName of ["edit", "write"] as const) {
      const detector = new LoopDetector();
      let signal;
      for (let i = 0; i < 5; i++) {
        signal = detector.record({ name: toolName, args: { [PATH_ARG]: "f.txt", n: i } });
      }
      expect(signal).toEqual({ signal: "file-edits", detail: "f.txt", advisory: true });
    }
  });
});
