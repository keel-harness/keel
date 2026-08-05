import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROCESS_RUN_MAX_ARG_BYTES,
  PROCESS_RUN_MAX_ARGS,
  ProcessRunResolutionError,
  parseProcessRunArgs,
  renderProcessRunArgv,
} from "./process-run.js";

describe("process.run argv boundary", () => {
  it("preserves a bounded exact argv vector, including empty and shell-looking data", () => {
    const argv = [
      "python3",
      "-m",
      "pytest",
      "",
      "literal;not-shell",
      "$(also-data)",
      "quote'probe",
      "snowman-☃",
    ];

    const parsed = parseProcessRunArgs({ argv });

    expect(parsed).toEqual({ argv });
    expect(parsed.argv).not.toBe(argv);
    expect(renderProcessRunArgv(parsed.argv)).toBe(
      "'python3' '-m' 'pytest' '' 'literal;not-shell' '$(also-data)' 'quote'\\''probe' 'snowman-☃'",
    );
  });

  it("accepts the exact argv and per-argument byte boundaries", () => {
    const argv = Array.from({ length: PROCESS_RUN_MAX_ARGS }, (_, index) =>
      index === 0 ? "runner" : "x".repeat(PROCESS_RUN_MAX_ARG_BYTES),
    );

    expect(parseProcessRunArgs({ argv })).toEqual({ argv });
  });

  it.each([
    ["missing argv", {}],
    ["non-array argv", { argv: "pytest -q" }],
    ["empty argv", { argv: [] }],
    ["empty executable", { argv: [""] }],
    ["too many arguments", { argv: Array(PROCESS_RUN_MAX_ARGS + 1).fill("x") }],
    ["oversized ASCII argument", { argv: ["runner", "x".repeat(PROCESS_RUN_MAX_ARG_BYTES + 1)] }],
    ["oversized UTF-8 argument", { argv: ["runner", "☃".repeat(342)] }],
    ["unpaired high surrogate", { argv: ["runner", "bad\ud800value"] }],
    ["terminal unpaired high surrogate", { argv: ["runner", "\ud800"] }],
    ["unpaired low surrogate", { argv: ["runner", "bad\udc00value"] }],
    ["C0 control", { argv: ["runner", "line\nfeed"] }],
    ["C1 or DEL control", { argv: ["runner", "delete\u007f"] }],
    ["format control", { argv: ["runner", "zero\u200bwidth"] }],
    ["line separator", { argv: ["runner", "line\u2028separator"] }],
    ["paragraph separator", { argv: ["runner", "paragraph\u2029separator"] }],
    ["unknown key", { argv: ["runner"], command: "runner" }],
    ["environment authority", { argv: ["runner"], env: { TOKEN: "value" } }],
    ["working-directory authority", { argv: ["runner"], cwd: "/tmp" }],
  ])("rejects %s before execution", (_label, value) => {
    expect(() => parseProcessRunArgs(value)).toThrow(ProcessRunResolutionError);
  });

  it("property: the canonical SRT shell boundary preserves argv and cannot create sibling effects", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-process-argv-injection-"));
    let run = 0;
    try {
      const argument = fc.stringOf(
        fc.constantFrom(
          "a",
          "Z",
          "0",
          " ",
          "'",
          '"',
          "$",
          "(",
          ")",
          "`",
          ";",
          "&",
          "|",
          ">",
          "*",
          "?",
          "{",
          "}",
          "-",
          "/",
          "☃",
        ),
        { maxLength: 32 },
      );

      fc.assert(
        fc.property(fc.array(argument, { maxLength: 10 }), (generated) => {
          run += 1;
          const sibling = join(dir, `sibling-${String(run)}`);
          const dataArgs = [
            ...generated,
            "",
            `$(touch ${sibling})`,
            `\`touch ${sibling}\``,
            `; touch ${sibling}`,
            `&& touch ${sibling}`,
            "2>&1",
            "*.ts",
            "{a,b}",
          ];
          const argv = [
            process.execPath,
            "-e",
            "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
            "--",
            ...dataArgs,
          ];
          const parsed = parseProcessRunArgs({ argv });
          const child = spawnSync("/bin/sh", ["-c", renderProcessRunArgv(parsed.argv)], {
            cwd: dir,
            encoding: "utf8",
          });

          expect(child.status, child.stderr).toBe(0);
          expect(JSON.parse(child.stdout)).toEqual(dataArgs);
          expect(existsSync(sibling)).toBe(false);
        }),
        { numRuns: 64 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
