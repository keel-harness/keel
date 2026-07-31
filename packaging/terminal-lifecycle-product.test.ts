import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probe = fileURLToPath(new URL("./terminal-lifecycle-product-probe.py", import.meta.url));

describe("interactive terminal lifecycle through the real PTY product path", () => {
  it("turns idle Ctrl-D and SIGHUP into bounded clean process-group exits", () => {
    const result = spawnSync(process.env["PYTHON"] ?? "python3", [probe, process.execPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 18_000,
      maxBuffer: 1024 * 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout || result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        status: "PASS",
        scenario: "ctrl-d",
        exitCode: 0,
        processGroupReaped: true,
      }),
      expect.objectContaining({
        status: "PASS",
        scenario: "sighup",
        exitCode: 129,
        processGroupReaped: true,
      }),
    ]);
  });
});
