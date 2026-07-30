import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelMessageT,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  ToolSpecT,
} from "@keel/shared";
import { HeadlessUI } from "../tui/headless.js";
import { runKeelCommand } from "./session-entry.js";
import { createToolRuntime } from "./runtime.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "keel-trust-"));
const GOVERNED_TYPED_FILE_TOOLS = ["bash", "read", "search", "write", "edit"];

/** Captures the messages + tools handed to the model on the first turn (the seed). */
class CapturingModel implements ModelPort {
  firstMessages: readonly ModelMessageT[] | undefined;
  firstTools: readonly ToolSpecT[] | undefined;
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.firstMessages ??= input.messages;
    this.firstTools ??= input.tools;
    yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

const seededSystem = (m: CapturingModel): string =>
  (m.firstMessages ?? [])
    .filter((msg) => msg.role === "system")
    .map((msg) => msg.content)
    .join("\n");

describe("runKeelCommand trust-gates the environment snapshot (trust-before-parse, SEC-012)", () => {
  it("untrusted (default): NO environment snapshot is seeded — zero project context before trust", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "package.json"), "{}");
    const model = new CapturingModel();
    await runKeelCommand("hello", { model, ui: new HeadlessUI(), cwd, env: { KEEL_HOME: cwd } });
    expect(seededSystem(model)).not.toMatch(/# Environment/);
  });

  it("trusted (KEEL_TRUST=1): the environment snapshot IS seeded, post-trust", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "package.json"), "{}");
    const model = new CapturingModel();
    await runKeelCommand("hello", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: { KEEL_HOME: cwd, KEEL_TRUST: "1" },
    });
    const sys = seededSystem(model);
    expect(sys).toMatch(/# Environment/);
    expect(sys).toMatch(/package\.json/);
  });

  it("trusted: the workspace AGENTS.md is seeded as a system message (post-trust)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-RULE: use pnpm");
    const model = new CapturingModel();
    await runKeelCommand("hello", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: { KEEL_HOME: cwd, KEEL_TRUST: "1" },
    });
    expect(seededSystem(model)).toMatch(/PROJECT-RULE: use pnpm/);
  });

  it("untrusted: the workspace AGENTS.md is NOT read or seeded (trust-before-parse)", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-RULE: use pnpm");
    const model = new CapturingModel();
    await runKeelCommand("hello", { model, ui: new HeadlessUI(), cwd, env: { KEEL_HOME: cwd } });
    expect(seededSystem(model)).not.toMatch(/PROJECT-RULE/);
  });

  it("trusted via the --trust flag (trustFlag) without KEEL_TRUST: snapshot is seeded", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "package.json"), "{}");
    const model = new CapturingModel();
    await runKeelCommand("hello", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: { KEEL_HOME: cwd },
      trustFlag: true,
    });
    expect(seededSystem(model)).toMatch(/# Environment/);
  });

  it("interactive accept through runKeelCommand: the prompt grants trust and seeds the snapshot", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "package.json"), "{}");
    const model = new CapturingModel();
    await runKeelCommand("hello", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: { KEEL_HOME: cwd },
      isTTY: true,
      promptTrust: async () => true,
    });
    expect(seededSystem(model)).toMatch(/# Environment/);
  });

  it("trusted: built-in skills are discovered and stubs are seeded, but local `skill` is not advertised in governed mode", async () => {
    // uses keel's real shipped skills/ (commit-message, debug-failing-test)
    const cwd = tmp();
    const model = new CapturingModel();
    await runKeelCommand("hello", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: { KEEL_HOME: cwd, KEEL_TRUST: "1" },
    });
    expect(model.firstTools?.map((t) => t.name)).toEqual(GOVERNED_TYPED_FILE_TOOLS);
    expect(model.firstTools?.map((t) => t.name)).not.toContain("skill");
    expect(seededSystem(model)).toMatch(/# Skills/); // the stub list header
    expect(seededSystem(model)).toMatch(/commit-message/); // a built-in skill stub
  });

  it("untrusted: no skills, so NO `skill` tool is advertised (trust-before-parse)", async () => {
    const cwd = tmp();
    const model = new CapturingModel();
    await runKeelCommand("hello", { model, ui: new HeadlessUI(), cwd, env: { KEEL_HOME: cwd } });
    expect(model.firstTools?.map((t) => t.name)).not.toContain("skill");
    expect(seededSystem(model)).not.toMatch(/# Skills/);
  });

  it("the model is advertised NO trust-setting tool (ADR-0017 — the model may not self-trust)", async () => {
    const cwd = tmp();
    const rt = createToolRuntime({ cwd });
    try {
      expect(rt.tools.some((t) => /trust/i.test(t.name))).toBe(false);
    } finally {
      await rt.dispose();
    }
  });
});
