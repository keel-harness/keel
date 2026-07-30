import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  EVAL_BASH_MAX_TIMEOUT_ENV,
  EVAL_BASH_MAX_TIMEOUT_LIMIT_MS,
  EVAL_BASH_TIMEOUT_ACK,
  EVAL_BASH_TIMEOUT_ACK_ENV,
  EVAL_DENIED_ROOTS_ENV,
  EVAL_DIRECT_EXEC_ACK,
  EVAL_DIRECT_EXEC_ENV,
  EVAL_EXTRA_ROOTS_ACK,
  EVAL_EXTRA_ROOTS_ACK_ENV,
  EVAL_EXTRA_ROOTS_ENV,
  PRODUCTION_BASH_MAX_TIMEOUT_MS,
  WARDEN_EXECUTE_TIMEOUT_MARGIN_MS,
  resolveEvalDeniedRoots,
  resolveEvalExtraRoots,
  resolveEvalBashMaxTimeoutMs,
  resolveExecutorMode,
  resolveWardenExecuteTimeoutMs,
} from "./eval-executor-gate.js";

const BUILD_GLOBAL = "__KEEL_EVAL_DIRECT_EXEC_BUILD__";
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function tempDir(name = "root"): string {
  const root = mkdtempSync(join(tmpdir(), "keel-eval-root-"));
  tempRoots.push(root);
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

describe("resolveExecutorMode — eval-only direct-executor gate", () => {
  // The load-bearing security property: a PRODUCTION/release binary (build gate off) must NEVER
  // select direct execution, no matter the environment. This is the "no backdoor" guarantee.
  it("production build (builtIn=false) ALWAYS selects warden — even with the exact env ack set", () => {
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: EVAL_DIRECT_EXEC_ACK }, false).kind).toBe(
      "warden",
    );
  });

  it("eval build but NO env ack → still warden (governed by default)", () => {
    expect(resolveExecutorMode({}, true).kind).toBe("warden");
  });

  it("eval build + truthy-but-wrong env value → still warden (a bare 1/true is not enough)", () => {
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: "1" }, true).kind).toBe("warden");
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: "true" }, true).kind).toBe("warden");
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: "yes" }, true).kind).toBe("warden");
  });

  it("eval build + EXACT env ack → eval-direct", () => {
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: EVAL_DIRECT_EXEC_ACK }, true).kind).toBe(
      "eval-direct",
    );
  });

  it("default builtIn under node/vitest (no compile-time global) is production-safe", () => {
    // No second arg → reads the compile-time constant, which is undefined unbundled → warden.
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: EVAL_DIRECT_EXEC_ACK }).kind).toBe(
      "warden",
    );
  });
});

describe("resolveExecutorMode — compile-time constant reader (default builtIn)", () => {
  // Simulate the `bin-eval` build by defining the global the way `packaging/build.ts` injects it,
  // exercising the default `evalDirectExecBuiltIn()` reader (both the `typeof` and `=== true` arms).
  const g = globalThis as Record<string, unknown>;
  const had = BUILD_GLOBAL in g;
  const prev = g[BUILD_GLOBAL];
  afterEach(() => {
    if (had) g[BUILD_GLOBAL] = prev;
    else delete g[BUILD_GLOBAL];
  });

  it("constant === true + exact ack → eval-direct via the default reader", () => {
    g[BUILD_GLOBAL] = true;
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: EVAL_DIRECT_EXEC_ACK }).kind).toBe(
      "eval-direct",
    );
    expect(resolveExecutorMode({}).kind).toBe("warden");
  });

  it("constant present but not exactly true → warden (the reader requires `=== true`)", () => {
    g[BUILD_GLOBAL] = 1;
    expect(resolveExecutorMode({ [EVAL_DIRECT_EXEC_ENV]: EVAL_DIRECT_EXEC_ACK }).kind).toBe(
      "warden",
    );
  });
});

describe("resolveEvalBashMaxTimeoutMs — eval-only bash ceiling gate", () => {
  const env = {
    [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
    [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000",
  };

  it("production build ignores the env even with the exact ack", () => {
    expect(resolveEvalBashMaxTimeoutMs(env, false)).toBeUndefined();
  });

  it("eval build without exact ack keeps the production ceiling", () => {
    expect(
      resolveEvalBashMaxTimeoutMs({ [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000" }, true),
    ).toBeUndefined();
    expect(
      resolveEvalBashMaxTimeoutMs(
        {
          [EVAL_BASH_TIMEOUT_ACK_ENV]: "1",
          [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000",
        },
        true,
      ),
    ).toBeUndefined();
  });

  it("eval build plus exact ack accepts a bounded higher ceiling", () => {
    expect(resolveEvalBashMaxTimeoutMs(env, true)).toBe(10_800_000);
  });

  it("rejects invalid, lower/equal, and above-3h values", () => {
    for (const raw of ["600000", "599999", "10800001", "3h", "1.5", "-1"]) {
      expect(
        resolveEvalBashMaxTimeoutMs(
          {
            [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
            [EVAL_BASH_MAX_TIMEOUT_ENV]: raw,
          },
          true,
        ),
      ).toBeUndefined();
    }
  });
});

describe("resolveWardenExecuteTimeoutMs — eval-aware warden RPC execute backstop", () => {
  const evalEnv = {
    [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
    [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000",
  };
  const PRODUCTION = PRODUCTION_BASH_MAX_TIMEOUT_MS + WARDEN_EXECUTE_TIMEOUT_MARGIN_MS;

  it("keeps the production 630s default (no eval build) even with the eval env set", () => {
    // Production/unbundled: no bash ceiling override → warden RPC backstop stays the 600s+30s default.
    expect(resolveWardenExecuteTimeoutMs(evalEnv, false)).toBe(PRODUCTION);
    expect(resolveWardenExecuteTimeoutMs({}, false)).toBe(PRODUCTION);
    expect(PRODUCTION).toBe(630_000); // no production relaxation — identical to the prior hardcoded value
  });

  it("default builtIn under node/vitest (no compile-time global) is production-safe", () => {
    expect(resolveWardenExecuteTimeoutMs(evalEnv)).toBe(PRODUCTION);
  });

  it("raises the backstop to the eval bash ceiling + margin when structurally gated", () => {
    expect(resolveWardenExecuteTimeoutMs(evalEnv, true)).toBe(
      EVAL_BASH_MAX_TIMEOUT_LIMIT_MS + WARDEN_EXECUTE_TIMEOUT_MARGIN_MS,
    );
    expect(resolveWardenExecuteTimeoutMs(evalEnv, true)).toBe(10_830_000);
  });

  it("falls back to the production default when the eval ceiling is out of range", () => {
    expect(
      resolveWardenExecuteTimeoutMs(
        {
          [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
          [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800001",
        },
        true,
      ),
    ).toBe(PRODUCTION);
  });

  it("preserves the fail-closed ordering: bash ceiling < warden RPC backstop < kernel infra backstop", () => {
    // The warden RPC backstop must sit ABOVE the shell's own bash ceiling (so a legitimately long
    // command settles via the shell, not a premature RPC timeout) and BELOW the kernel infra backstop
    // (INFRA margin = 60s; the Warden timeout contract) so a wedged warden still fails closed at the warden layer first.
    const ceiling = EVAL_BASH_MAX_TIMEOUT_LIMIT_MS;
    const warden = resolveWardenExecuteTimeoutMs(evalEnv, true);
    const infra = ceiling + 60_000;
    expect(warden).toBeGreaterThan(ceiling);
    expect(warden).toBeLessThan(infra);
  });
});

describe("resolveEvalExtraRoots — eval-only typed-tool root gate", () => {
  it("production build ignores extra-root env even with the exact ack", () => {
    const root = tempDir();
    const env = {
      [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
      [EVAL_EXTRA_ROOTS_ENV]: root,
    };
    expect(resolveEvalExtraRoots(env, false)).toEqual([]);
  });

  it("eval build without exact ack ignores extra-root env", () => {
    const root = tempDir();
    expect(resolveEvalExtraRoots({ [EVAL_EXTRA_ROOTS_ENV]: root }, true)).toEqual([]);
    expect(
      resolveEvalExtraRoots(
        {
          [EVAL_EXTRA_ROOTS_ACK_ENV]: "1",
          [EVAL_EXTRA_ROOTS_ENV]: root,
        },
        true,
      ),
    ).toEqual([]);
  });

  it("eval build plus exact ack declares existing read/write eval-only directory roots", () => {
    const first = tempDir("compiler-work");
    const second = tempDir("service-config");
    expect(
      resolveEvalExtraRoots(
        {
          [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
          [EVAL_EXTRA_ROOTS_ENV]: [first, second].join(delimiter),
        },
        true,
      ),
    ).toEqual([
      {
        root: first,
        label: `eval-extra-root:${first}`,
        source: "eval-extra-root",
        allow: ["read", "write"],
      },
      {
        root: second,
        label: `eval-extra-root:${second}`,
        source: "eval-extra-root",
        allow: ["read", "write"],
      },
    ]);
  });

  it("rejects relative, empty, broad, control-character, traversal, glob, file, missing, and duplicate declarations", () => {
    const allowed = tempDir("allowed");
    const fileRoot = join(tempDir("file-parent"), "artifact.txt");
    writeFileSync(fileRoot, "not a directory");
    expect(
      resolveEvalExtraRoots(
        {
          [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
          [EVAL_EXTRA_ROOTS_ENV]: [
            allowed,
            "relative",
            "",
            "/",
            "/tmp",
            `${allowed}/../allowed`,
            `${allowed}/*`,
            fileRoot,
            join(allowed, "missing"),
            "/tmp/bad\nroot",
            allowed,
          ].join(delimiter),
        },
        true,
      ),
    ).toEqual([
      {
        root: allowed,
        label: `eval-extra-root:${allowed}`,
        source: "eval-extra-root",
        allow: ["read", "write"],
      },
    ]);
  });

  it("canonicalizes realpath duplicates and keeps the narrower overlapping root", () => {
    const parent = tempDir("parent");
    const child = join(parent, "child");
    mkdirSync(child);
    const link = join(tempDir("links"), "parent-link");
    symlinkSync(parent, link);

    expect(
      resolveEvalExtraRoots(
        {
          [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
          [EVAL_EXTRA_ROOTS_ENV]: [parent, link, child].join(delimiter),
        },
        true,
      ),
    ).toEqual([
      {
        root: realpathSync(child),
        label: `eval-extra-root:${realpathSync(child)}`,
        source: "eval-extra-root",
        allow: ["read", "write"],
      },
    ]);
  });

  it("refuses roots whose real target is inside the eval denied-root set", () => {
    const denied = tempDir("denied");
    const symlinked = join(tempDir("links"), "denied-link");
    symlinkSync(denied, symlinked);
    const allowed = tempDir("allowed");

    expect(
      resolveEvalExtraRoots(
        {
          [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
          [EVAL_DENIED_ROOTS_ENV]: denied,
          [EVAL_EXTRA_ROOTS_ENV]: [symlinked, allowed].join(delimiter),
        },
        true,
      ),
    ).toEqual([
      {
        root: allowed,
        label: `eval-extra-root:${allowed}`,
        source: "eval-extra-root",
        allow: ["read", "write"],
      },
    ]);
  });

  it("resolves default and explicit eval denied roots only under the eval extra-root ack", () => {
    const denied = tempDir("denied");
    expect(resolveEvalDeniedRoots({ [EVAL_DENIED_ROOTS_ENV]: denied }, true)).toEqual([]);
    const resolved = resolveEvalDeniedRoots(
      {
        [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
        [EVAL_DENIED_ROOTS_ENV]: [denied, "relative", "/"].join(delimiter),
      },
      true,
    );
    expect(resolved).toContain(denied);
    expect(resolved).toContain("/proc");
    expect(resolved).not.toContain("/");
  });
});
