import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawnSync, SpawnSyncReturns } from "node:child_process";
import { openDraftInEditor } from "./editor.js";

const ok = (): SpawnSyncReturns<Buffer> => ({
  pid: 1,
  output: [],
  stdout: Buffer.from(""),
  stderr: Buffer.from(""),
  status: 0,
  signal: null,
});

const failed = (): SpawnSyncReturns<Buffer> => ({
  ...ok(),
  status: 1,
});

const errored = (): SpawnSyncReturns<Buffer> => ({
  ...ok(),
  error: new Error("spawn failed"),
});

const asSpawn = (
  fn: (command: string, args?: readonly string[], options?: unknown) => SpawnSyncReturns<Buffer>,
): typeof spawnSync => fn as typeof spawnSync;

describe("openDraftInEditor", () => {
  it("returns undefined when no VISUAL/EDITOR is configured", () => {
    expect(openDraftInEditor("draft", { env: {} })).toBeUndefined();
  });

  it("opens a temp draft with the configured editor and returns sanitized edited text", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-editor-test-"));
    const out = openDraftInEditor("start", {
      env: { EDITOR: "fake-editor" },
      makeTempDir: () => dir,
      spawn: asSpawn((command, args) => {
        expect(command).toBe("fake-editor");
        const file = args?.[0];
        expect(typeof file).toBe("string");
        writeFileSync(file as string, `edited\n${String.fromCharCode(27)}[2J`, "utf8");
        return ok();
      }),
    });
    expect(out).toBe("edited\n[2J");
  });

  it("uses the default temp/spawn path when no test doubles are provided", () => {
    expect(openDraftInEditor("unchanged", { env: { EDITOR: "true" } })).toBe("unchanged");
  });

  it("prefers VISUAL, toggles raw mode around the editor, and restores it", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-editor-test-"));
    const modes: boolean[] = [];
    const out = openDraftInEditor("start", {
      env: { VISUAL: "visual-editor", EDITOR: "fallback-editor" },
      makeTempDir: () => dir,
      stdin: { isTTY: true, isRaw: true, setRawMode: (mode) => modes.push(mode) },
      spawn: asSpawn((command, args) => {
        expect(command).toBe("visual-editor");
        const file = args?.[0];
        expect(typeof file).toBe("string");
        writeFileSync(file as string, "visual draft", "utf8");
        return ok();
      }),
    });
    expect(out).toBe("visual draft");
    expect(modes).toEqual([false, true]);
  });

  it("restores the host NODE_ENV for the editor from process.env, not the editor-selection env", () => {
    const keys = ["NODE_ENV", "KEEL_HOST_NODE_ENV", "KEEL_HOST_NODE_ENV_MANAGED"] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    process.env["NODE_ENV"] = "production";
    process.env["KEEL_HOST_NODE_ENV"] = "development";
    process.env["KEEL_HOST_NODE_ENV_MANAGED"] = "1";
    const dir = mkdtempSync(join(tmpdir(), "keel-editor-test-"));

    try {
      const out = openDraftInEditor("start", {
        env: { EDITOR: "fake-editor", NODE_ENV: "deps-env-must-not-win" },
        makeTempDir: () => dir,
        spawn: asSpawn((_command, args, options) => {
          const spawnEnv = (options as { env?: NodeJS.ProcessEnv } | undefined)?.env;
          expect(spawnEnv?.["NODE_ENV"]).toBe("development");
          expect(spawnEnv).not.toHaveProperty("KEEL_HOST_NODE_ENV");
          expect(spawnEnv).not.toHaveProperty("KEEL_HOST_NODE_ENV_MANAGED");
          writeFileSync(args?.[0] as string, "edited with restored env", "utf8");
          return ok();
        }),
      });

      expect(out).toBe("edited with restored env");
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("returns undefined on editor failure without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-editor-test-"));
    expect(
      openDraftInEditor("start", {
        env: { EDITOR: "fake-editor" },
        makeTempDir: () => dir,
        spawn: asSpawn(() => failed()),
      }),
    ).toBeUndefined();
  });

  it("returns undefined on spawn errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-editor-test-"));
    expect(
      openDraftInEditor("start", {
        env: { EDITOR: "fake-editor" },
        makeTempDir: () => dir,
        spawn: asSpawn(() => errored()),
      }),
    ).toBeUndefined();
  });
});
