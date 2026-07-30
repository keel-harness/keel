import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  checkCode,
  formatRejection,
  isOptedOut,
  MAX_CHECK_BYTES,
  pythonSyntaxErrorsFor,
} from "./code-check.js";

const HAS_PY = spawnSync("python3", ["--version"]).status === 0;
const requireFromRoot = createRequire(`${process.cwd()}/package.json`);
const TSX_ESM_LOADER = pathToFileURL(requireFromRoot.resolve("tsx/esm")).href;
const CODE_CHECK_SOURCE = pathToFileURL(
  resolve(process.cwd(), "packages/kernel/src/tools/code-check.ts"),
).href;

describe("checkCode — TS/JS in-process syntax checking", () => {
  it("does not load the TypeScript parser until a TS/JS check needs it", () => {
    const script = `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const typescript = require.resolve("typescript");
      if (require.cache[typescript] !== undefined) throw new Error("loader preloaded typescript");
      Object.defineProperty(globalThis, Symbol.for("keel.internal.typescript-loader.v1"), {
        value: Object.freeze({}),
        configurable: false,
        enumerable: false,
        writable: false,
      });
      const codeCheck = await import(${JSON.stringify(CODE_CHECK_SOURCE)});
      if (require.cache[typescript] !== undefined) throw new Error("module import loaded typescript");
      const result = codeCheck.checkCode("lazy.ts", undefined, "const value: number = ;");
      if (result.ok || result.checker !== "typescript") throw new Error("typescript check changed");
      if (require.cache[typescript] === undefined) throw new Error("typescript was not loaded on demand");
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", TSX_ESM_LOADER, "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        encoding: "utf8",
      },
    );

    expect({ status: child.status, signal: child.signal, stderr: child.stderr }).toEqual({
      status: 0,
      signal: null,
      stderr: "",
    });
  });

  it("flags a new syntax error in a fresh TS write (before=undefined)", () => {
    const r = checkCode("a.ts", undefined, "const x: number = ;"); // missing RHS
    expect(r.checker).toBe("typescript");
    expect(r.ok).toBe(false);
    expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
    expect(r.newSyntaxErrors[0]!.line).toBe(1);
  });

  it("passes valid TS", () => {
    const r = checkCode("a.ts", undefined, "export const x: number = 1;\n");
    expect(r.ok).toBe(true);
    expect(r.newSyntaxErrors).toEqual([]);
  });

  it("does NOT type-check (only syntax): an undefined symbol is allowed", () => {
    // `notDefined` is a SEMANTIC error (code ≥ 2000) — must NOT be reported by a syntax-only check.
    const r = checkCode("a.ts", undefined, "export const x = notDefined + 1;\n");
    expect(r.ok).toBe(true);
    expect(r.newSyntaxErrors).toEqual([]);
  });

  it("checks plain JS too (via the same TS parser)", () => {
    const r = checkCode("a.js", undefined, "function f( { return 1 }"); // broken params
    expect(r.ok).toBe(false);
  });

  it("regression: .js file whose path contains '.ts' is treated as JS, not TS", () => {
    // Old substring logic: path.includes(".ts") would wrongly select ScriptKind.TS for
    // a .js file inside a directory named "typescript/" or with ".ts" in the filename.
    // Fix: use extOf(path) for an exact extension match.

    // Valid JS (no TS-only syntax) in a path containing ".ts" → must still pass
    const valid = checkCode(
      "src/typescript-utils/helpers.js",
      undefined,
      "function f() { return 1; }\n",
    );
    expect(valid.checker).toBe("typescript");
    expect(valid.ok).toBe(true);
    expect(valid.newSyntaxErrors).toEqual([]);

    // Broken JS syntax in the same kind of path → must still be flagged
    const broken = checkCode(
      "src/typescript-utils/helpers.js",
      undefined,
      "function f( { return 1 }",
    );
    expect(broken.checker).toBe("typescript");
    expect(broken.ok).toBe(false);
    expect(broken.newSyntaxErrors.length).toBeGreaterThan(0);
  });

  it("returns checker:'none' and ok:true for an unsupported extension (honest fallback)", () => {
    const r = checkCode("a.rb", undefined, "def broken(");
    expect(r).toEqual({ ok: true, checker: "none", newSyntaxErrors: [] });
  });

  it("returns checker:'none' for a path with no extension (e.g. Makefile)", () => {
    // extOf returns "" when there is no dot — not in TS_EXTS, so honest fallback.
    const r = checkCode("Makefile", undefined, "broken syntax here");
    expect(r).toEqual({ ok: true, checker: "none", newSyntaxErrors: [] });
  });

  it("checks TSX files with TSX script kind", () => {
    const r = checkCode("a.tsx", undefined, "export const x: number = ;"); // missing RHS
    expect(r.checker).toBe("typescript");
    expect(r.ok).toBe(false);
  });

  it("checks JSX files with JSX script kind", () => {
    const r = checkCode("a.jsx", undefined, "function f( { return 1 }"); // broken params
    expect(r.checker).toBe("typescript");
    expect(r.ok).toBe(false);
  });

  it("property: an unsupported language is always ok:true with no diagnostics", () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        const r = checkCode("x.unknownext", undefined, content);
        return r.ok === true && r.newSyntaxErrors.length === 0 && r.checker === "none";
      }),
    );
  });

  it("property: unsupported extension never blocks regardless of before/after content", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (before, after) => {
        const r = checkCode("x.unknownext", before, after);
        return r.ok === true && r.newSyntaxErrors.length === 0 && r.checker === "none";
      }),
    );
  });

  it("does not re-report pre-existing errors when before is provided (edit baseline)", () => {
    // Both before and after have the same syntax error — it is pre-existing, not new.
    const broken = "const x: number = ;";
    const r = checkCode("a.ts", broken, broken);
    expect(r.ok).toBe(true);
    expect(r.newSyntaxErrors).toEqual([]);
  });

  it("reports NEW errors introduced by an edit (before is provided and valid)", () => {
    const before = "export const x: number = 1;\n";
    const after = "const x: number = ;"; // broken edit
    const r = checkCode("a.ts", before, after);
    expect(r.ok).toBe(false);
    expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
  });
});

describe("checkCode — baseline (only NEW errors block)", () => {
  it("a file already broken before the edit does NOT block an edit that leaves it equally broken", () => {
    const broken = "const x = ;\n"; // pre-existing syntax error on line 1
    const r = checkCode("a.ts", broken, broken + "export const y = 1;\n");
    // line-1 error is in the baseline → not "new" → not blocking
    expect(r.ok).toBe(true);
    expect(r.newSyntaxErrors).toEqual([]);
  });

  it("an edit that ADDS a new syntax error to an already-broken file blocks only on the new one", () => {
    const broken = "const x = ;\n"; // pre-existing on line 1
    const after = "const x = ;\nconst z: = 2;\n"; // new error on line 2
    const r = checkCode("a.ts", broken, after);
    expect(r.ok).toBe(false);
    expect(r.newSyntaxErrors.every((d) => d.line !== 1)).toBe(true); // line 1 was baselined out
  });

  // R1 regression — line-shift false-positive: an edit that shifts a pre-existing error
  // to a different line (e.g. by inserting a comment above) must NOT be blocked.
  it("R1: an edit that inserts a line ABOVE a pre-existing error does NOT block (line-shift)", () => {
    // before: error on line 1; after: same error shifts to line 2 — must be ok:true
    const r = checkCode("a.ts", "const x = ;\n", "// comment\nconst x = ;\n");
    expect(r.ok).toBe(true);
    expect(r.newSyntaxErrors).toEqual([]);
  });

  it("R1: a genuinely new error on a different line IS still caught even when a pre-existing error exists (line-shift + new)", () => {
    // before: one error; after: same error shifts to line 2, PLUS a NEW distinct error on line 3
    // → must block, and the reported error must be the new one (with its actual line), not the shifted one
    const before = "const x = ;\n";
    const after = "// comment\nconst x = ;\nconst z: = 2;\n";
    const r = checkCode("a.ts", before, after);
    expect(r.ok).toBe(false);
    // The shifted pre-existing error (now on line 2) must NOT appear in newSyntaxErrors
    const lines = r.newSyntaxErrors.map((d) => d.line);
    // The new error is on line 3; shifted pre-existing on line 2 must be consumed
    expect(lines.every((l) => l !== 2)).toBe(true);
    // At least one error is reported (the new one on line 3)
    expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
  });

  it("R1: a SECOND occurrence of the same error message is caught (count increase)", () => {
    // before: one `const x = ;` error; after: TWO such errors → net +1 → must block
    const before = "const x = ;\n";
    const after = "const x = ;\nconst y = ;\n"; // same error message appears twice
    const r = checkCode("a.ts", before, after);
    expect(r.ok).toBe(false);
    expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_PY)("checkCode — Python", () => {
  it("flags a new Python syntax error", () => {
    const r = checkCode("a.py", undefined, "def f(:\n    pass\n");
    expect(r.checker).toBe("python");
    expect(r.ok).toBe(false);
  });
  it("passes valid Python", () => {
    expect(checkCode("a.py", undefined, "def f():\n    return 1\n").ok).toBe(true);
  });
  it("reports the line number of a syntax error", () => {
    // "def f(:" is the broken line — it is on line 2 (after "x = 1\n").
    // Assert the exact known line so a regex regression that falls back to line 1 is caught.
    const r = checkCode("a.py", undefined, "x = 1\ndef f(:\n    pass\n");
    expect(r.checker).toBe("python");
    expect(r.ok).toBe(false);
    expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
    expect(r.newSyntaxErrors[0]!.line).toBe(2);
  });
  it("catches IndentationError (a SyntaxError subclass — syntax-family guard must not be too narrow)", () => {
    // "pass" must be indented inside the function body; without indentation python raises
    // IndentationError, which ast.parse surfaces. The tightened syntax-family guard must
    // still catch it (regression guard against being too strict).
    const r = checkCode("a.py", undefined, "def f():\npass\n");
    expect(r.checker).toBe("python");
    expect(r.ok).toBe(false);
    expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
  });
  it("does NOT re-report pre-existing Python errors (edit baseline)", () => {
    const broken = "def f(:\n    pass\n";
    const r = checkCode("a.py", broken, broken);
    expect(r.ok).toBe(true);
    expect(r.newSyntaxErrors).toEqual([]);
  });
});

it("Python with no runtime → honest 'none' (never blocks)", () => {
  // When python3 is absent, .py resolves to checker:"none"; assert the contract holds either way:
  const r = checkCode("a.py", undefined, "def f():\n    return 1\n");
  expect(r.ok).toBe(true); // valid OR unchecked — both ok:true
});

describe("isOptedOut — KEEL_NO_EDIT_CHECK gate", () => {
  it("returns false when the env var is absent", () => {
    expect(isOptedOut({})).toBe(false);
  });
  it("returns true for truthy values (1, true, yes — case-insensitive)", () => {
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "1" })).toBe(true);
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "true" })).toBe(true);
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "TRUE" })).toBe(true);
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "yes" })).toBe(true);
  });
  it("returns false for falsy values (0, false, empty string)", () => {
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "0" })).toBe(false);
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "false" })).toBe(false);
    expect(isOptedOut({ KEEL_NO_EDIT_CHECK: "" })).toBe(false);
  });
});

// ===========================================================================
// Hardening against pathological / hostile inputs (adversarial QC, PR-B1).
// The honest-fallback invariant: oversized / timeout / killed / parser-threw /
// non-syntax failure ⇒ checker:"none" or no diagnostics — NEVER block, NEVER
// fabricate. A genuinely-broken IN-RANGE file must STILL be caught.
// ===========================================================================

describe("checkCode — Fix 1: content-size cap (DoS + maxBuffer false-negative)", () => {
  it("a broken but >MAX_CHECK_BYTES .py short-circuits to checker:'none' (never blocked, never falsely passed)", () => {
    // "x = (".repeat(...) is a broken Python file (unbalanced parens) that is also
    // larger than the cap. Pre-fix this would either DoS (50MB blocked the loop 156s)
    // or overflow spawnSync's 1MB maxBuffer → status===null → [] → SILENTLY WRITTEN.
    // Post-fix: it is too large to check honestly, so checker:"none", ok:true — and it
    // returns instantly because it short-circuits BEFORE any spawn/parse.
    const big = "x = (".repeat(300_000); // ~1.5 MB, > MAX_CHECK_BYTES
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_CHECK_BYTES);
    const r = checkCode("big.py", undefined, big);
    expect(r).toEqual({ ok: true, checker: "none", newSyntaxErrors: [] });
  });

  it("a broken but >MAX_CHECK_BYTES .ts short-circuits to checker:'none' (no parse, no block)", () => {
    const big = "const x: number = ;\n".repeat(100_000); // broken + > cap
    expect(Buffer.byteLength(big)).toBeGreaterThan(MAX_CHECK_BYTES);
    const r = checkCode("big.ts", undefined, big);
    expect(r).toEqual({ ok: true, checker: "none", newSyntaxErrors: [] });
  });

  it("the cap also applies to the `before` baseline (a >cap before never spawns/parses)", () => {
    const bigBefore = "y = (".repeat(300_000);
    expect(Buffer.byteLength(bigBefore)).toBeGreaterThan(MAX_CHECK_BYTES);
    const r = checkCode("big.py", bigBefore, "x = 1\n");
    expect(r).toEqual({ ok: true, checker: "none", newSyntaxErrors: [] });
  });

  it("a broken in-range file is STILL caught (the cap must not weaken the gate)", () => {
    const r = checkCode("a.ts", undefined, "const x: number = ;");
    expect(r.checker).toBe("typescript");
    expect(r.ok).toBe(false);
  });
});

describe.skipIf(!HAS_PY)(
  "checkCode — Fix 3: leading BOM is stripped before the python check (R2)",
  () => {
    it("a BOM-prefixed valid .py is NOT falsely blocked (mirror Python's file loader)", () => {
      // ast.parse on the in-memory string sees U+FEFF and raises
      // "invalid non-printable character U+FEFF"; but `python3 file.py` strips a
      // leading UTF-8 BOM. We strip it too, so a fresh BOM write is not false-blocked.
      const r = checkCode("a.py", undefined, "﻿print(1)\n");
      expect(r.checker).toBe("python");
      expect(r.ok).toBe(true);
      expect(r.newSyntaxErrors).toEqual([]);
    });

    it("a genuinely-broken BOM-prefixed .py is STILL flagged (only the BOM is stripped)", () => {
      const r = checkCode("a.py", undefined, "﻿def f(:\n    pass\n");
      expect(r.checker).toBe("python");
      expect(r.ok).toBe(false);
      expect(r.newSyntaxErrors.length).toBeGreaterThan(0);
    });
  },
);

describe.skipIf(!HAS_PY)(
  "checkCode — Fix 4: null-byte .py is a deterministic syntax error (M1)",
  () => {
    it("a NUL byte in .py content yields a deterministic checker:'python' block on line 1", () => {
      // A NUL byte is genuinely invalid Python (ast.parse: "source code string cannot
      // contain null bytes"), but real python's traceback for it has NO `<unknown>` frame
      // (compile() raises before reaching the user filename) — pre-fix that fell through to
      // the /* v8 ignore */ line-1 fallback, an untested reachable branch. We intercept the
      // NUL byte BEFORE spawn so the result is deterministic and the branch is covered.
      const r = checkCode("a.py", undefined, "x = 1\0\n");
      expect(r.checker).toBe("python");
      expect(r.ok).toBe(false);
      expect(r.newSyntaxErrors).toEqual([
        { line: 1, message: "source code string cannot contain null bytes" },
      ]);
    });

    it("a NUL byte that is pre-existing (in `before`) does NOT block (baseline holds)", () => {
      const broken = "x = 1\0\n";
      const r = checkCode("a.py", broken, broken);
      expect(r.ok).toBe(true);
      expect(r.newSyntaxErrors).toEqual([]);
    });
  },
);

describe("checkCode — Fix 5: a TS parser fault cannot escape as a raw error (S3)", () => {
  it("deeply-nested TS under the size cap does NOT throw; yields an honest result", () => {
    // The in-process `typescript` parser can throw RangeError: Maximum call stack size
    // exceeded on deeply-nested input. checkCode must NEVER let a parser fault escape —
    // on any throw it returns an honest "couldn't check" (no diagnostics → ok:true).
    const deep = "[".repeat(2000) + "]".repeat(2000);
    expect(Buffer.byteLength(deep)).toBeLessThanOrEqual(MAX_CHECK_BYTES);
    let r!: ReturnType<typeof checkCode>;
    expect(() => {
      r = checkCode("deep.ts", undefined, deep);
    }).not.toThrow();
    expect(r.ok).toBe(true);
    // Either it parsed fine (no new errors) or the parser threw and we fell open;
    // in BOTH honest cases ok:true with no blocking diagnostics.
    expect(r.newSyntaxErrors).toEqual([]);
  });
});

describe("pythonSyntaxErrorsFor — Fix 6: injectable spawn proves the fail-open branches (M2)", () => {
  it("status===null (killed/signalled, e.g. timeout/maxBuffer) ⇒ [] (never block on ambiguous failure)", () => {
    const fakeSpawn = () => ({
      status: null as number | null,
      stderr: 'SyntaxError: bad (a.py, line 1)\n  File "<unknown>", line 1',
    });
    expect(pythonSyntaxErrorsFor("x = 1\n", fakeSpawn)).toEqual([]);
  });

  it("status===1 with a non-syntax-family stderr (e.g. MemoryError) ⇒ [] (don't block)", () => {
    const fakeSpawn = () => ({ status: 1 as number | null, stderr: "MemoryError\n" });
    expect(pythonSyntaxErrorsFor("x = 1\n", fakeSpawn)).toEqual([]);
  });

  it("status===0 ⇒ [] (valid python)", () => {
    const fakeSpawn = () => ({ status: 0 as number | null, stderr: "" });
    expect(pythonSyntaxErrorsFor("x = 1\n", fakeSpawn)).toEqual([]);
  });

  it("an exact compact syntax record IS surfaced (parsed line + message)", () => {
    const fakeSpawn = () => ({
      status: 1 as number | null,
      stderr: "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00007\u0000invalid syntax",
    });
    expect(pythonSyntaxErrorsFor("...", fakeSpawn)).toEqual([
      { line: 7, message: "invalid syntax" },
    ]);
  });

  it.each(["IndentationError", "TabError"])(
    "accepts the exact compact %s subclass record",
    (kind) => {
      const fakeSpawn = () => ({
        status: 1 as number | null,
        stderr: `KEEL_PY_SYNTAX_V1\u0000${kind}\u00003\u0000invalid indentation`,
      });
      expect(pythonSyntaxErrorsFor("...", fakeSpawn)).toEqual([
        { line: 3, message: "invalid indentation" },
      ]);
    },
  );

  it("a legacy traceback is ambiguous and rejected even when it names a syntax-family error", () => {
    const fakeSpawn = () => ({
      status: 1 as number | null,
      stderr: '  File "<unknown>", line 7\n    def f(:\n          ^\nSyntaxError: invalid syntax\n',
    });
    expect(pythonSyntaxErrorsFor("...", fakeSpawn)).toEqual([]);
  });

  it("a NUL byte in the content is intercepted BEFORE spawn (the seam is never called)", () => {
    let called = false;
    const fakeSpawn = () => {
      called = true;
      return { status: 0 as number | null, stderr: "" };
    };
    const errs = pythonSyntaxErrorsFor("x = 1\0\n", fakeSpawn);
    expect(called).toBe(false);
    expect(errs).toEqual([{ line: 1, message: "source code string cannot contain null bytes" }]);
  });

  it.each([
    ["wrong version", "KEEL_PY_SYNTAX_V0\u0000SyntaxError\u00007\u0000invalid syntax"],
    ["missing kind separator", "KEEL_PY_SYNTAX_V1\u0000SyntaxError"],
    ["missing line separator", "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00007"],
    ["unknown error family", "KEEL_PY_SYNTAX_V1\u0000RuntimeError\u00007\u0000invalid syntax"],
    ["zero line", "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00000\u0000invalid syntax"],
    ["non-decimal line", "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u0000seven\u0000invalid syntax"],
    [
      "unsafe line integer",
      "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00009007199254740992\u0000invalid syntax",
    ],
    ["missing message", "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00007\u0000"],
    ["whitespace-only message", "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00007\u0000 \t\n"],
  ])("rejects malformed compact syntax framing: %s", (_name, stderr) => {
    const fakeSpawn = () => ({ status: 1 as number | null, stderr });
    expect(pythonSyntaxErrorsFor("...", fakeSpawn)).toEqual([]);
  });

  it("rejects an exact compact record paired with an unexpected child exit status", () => {
    const fakeSpawn = () => ({
      status: 2 as number | null,
      stderr: "KEEL_PY_SYNTAX_V1\u0000SyntaxError\u00007\u0000invalid syntax",
    });
    expect(pythonSyntaxErrorsFor("...", fakeSpawn)).toEqual([]);
  });

  it("the leading BOM is stripped before spawn (the seam sees content without U+FEFF)", () => {
    let seen = "";
    const fakeSpawn = (content: string) => {
      seen = content;
      return { status: 0 as number | null, stderr: "" };
    };
    pythonSyntaxErrorsFor("﻿print(1)\n", fakeSpawn);
    expect(seen).toBe("print(1)\n");
  });
});

describe("formatRejection — model-facing rejection message", () => {
  it("formats a rejection with the file path and error list", () => {
    const errs = [{ line: 3, message: "Expression expected." }];
    const msg = formatRejection("src/foo.ts", errs);
    expect(msg).toContain("src/foo.ts");
    expect(msg).toContain("line 3: Expression expected.");
    expect(msg).toContain("keel: edit not applied");
  });

  it("truncates to at most 10 errors", () => {
    const errs = Array.from({ length: 15 }, (_, i) => ({ line: i + 1, message: "err" }));
    const msg = formatRejection("f.ts", errs);
    // Should only contain 10 "line N:" entries
    const matches = msg.match(/line \d+:/g) ?? [];
    expect(matches.length).toBe(10);
  });
});
