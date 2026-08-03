import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const suite = fileURLToPath(new URL("./test_pty_product_harness.py", import.meta.url));

describe("packaged-product PTY observer", () => {
  it("keeps launch readiness invariant to incremental redraw chunking", () => {
    const result = spawnSync(process.env["PYTHON"] ?? "python3", [suite], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout || result.stderr).toBe(0);
  });
});
