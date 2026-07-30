import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

// ADR-0071 P1-10: structurally deny kernel→`@keel/warden` library imports (a Rust warden
// port would strand them), allowing only the sanctioned warden-host entry and the documented
// residuals. This exercises the REAL rule options the flat config uses (single source of
// truth in tools/eslint/kernel-warden-boundary.mjs), so the guard can't silently rot.

let restrictedImports!: Linter.RuleEntry; // production (non-test) kernel rule
let testRestrictedImports!: Linter.RuleEntry; // kernel *.test.ts rule
beforeAll(async () => {
  const mod = (await import(
    new URL("../../../../tools/eslint/kernel-warden-boundary.mjs", import.meta.url).href
  )) as {
    kernelWardenRestrictedImports: Linter.RuleEntry;
    kernelWardenTestRestrictedImports: Linter.RuleEntry;
  };
  restrictedImports = mod.kernelWardenRestrictedImports;
  testRestrictedImports = mod.kernelWardenTestRestrictedImports;
});

const linter = new Linter();
function lintWith(rule: Linter.RuleEntry, code: string): Linter.LintMessage[] {
  return linter.verify(code, [
    {
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaVersion: "latest", sourceType: "module" },
      },
      plugins: { "@typescript-eslint": tseslint.plugin },
      rules: { "@typescript-eslint/no-restricted-imports": rule },
    },
  ]);
}
const lint = (code: string): Linter.LintMessage[] => lintWith(restrictedImports, code);
const lintTestFile = (code: string): Linter.LintMessage[] => lintWith(testRestrictedImports, code);

describe("kernel→warden import boundary (ADR-0071 P1-10)", () => {
  it("denies importing a warden enforcement-library symbol", () => {
    const msgs = lint(`import { runStdioWardenServer } from "@keel/warden";`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.ruleId).toBe("@typescript-eslint/no-restricted-imports");
  });

  it("denies re-importing a moved contract from the warden (the creep this prevents)", () => {
    expect(lint(`import { MCP_TRUSTED_SERVERS_ENV } from "@keel/warden";`)).toHaveLength(1);
  });

  it("denies a type-only warden import (allowTypeImports is off)", () => {
    expect(lint(`import type { SandboxPort } from "@keel/warden";`)).toHaveLength(1);
  });

  it("denies the former warden-host launch entry after packaged process separation", () => {
    expect(lint(`import { runWardenFromEnv } from "@keel/warden";`)).toHaveLength(1);
  });

  it("allows a documented residual pending its own decoupling slice", () => {
    expect(lint(`import { parseCredentialProxyConfig } from "@keel/warden";`)).toHaveLength(0);
  });

  it("denies the offline verifier now that it is a kernel module (slice 2)", () => {
    expect(lint(`import { verifyEvidenceBundle } from "@keel/warden";`)).toHaveLength(1);
  });

  it("does not touch non-warden imports", () => {
    expect(lint(`import { canonicalMcpToolPinForLaunch } from "@keel/shared";`)).toHaveLength(0);
  });

  // Two-tier boundary: the warden evidence WRITER is a permanent test-only fixture reach. It
  // must be DENIED in production kernel code but ALLOWED in *.test.ts, so production kernel code
  // stays provably free of the warden library while the round-trip test can build real bundles.
  it("denies the warden evidence writer in PRODUCTION kernel code", () => {
    expect(lint(`import { buildEvidenceBundle } from "@keel/warden";`)).toHaveLength(1);
    expect(lint(`import { AuditChainWriter } from "@keel/warden";`)).toHaveLength(1);
  });

  it("allows the warden evidence writer only in kernel *.test.ts files", () => {
    expect(lintTestFile(`import { buildEvidenceBundle } from "@keel/warden";`)).toHaveLength(0);
    expect(lintTestFile(`import { AuditChainWriter } from "@keel/warden";`)).toHaveLength(0);
    // …but a genuine enforcement symbol is still denied even in tests.
    expect(lintTestFile(`import { runStdioWardenServer } from "@keel/warden";`)).toHaveLength(1);
  });

  // Wiring guard: the tests above prove the rule OPTIONS behave; this proves the real flat
  // config actually ATTACHES them to packages/kernel. Without it, deleting the config block
  // would leave the behavior tests green while the structural guard silently vanished.
  it("is wired into the real eslint flat config for packages/kernel (both tiers)", async () => {
    const configMod = (await import(
      new URL("../../../../eslint.config.js", import.meta.url).href
    )) as {
      default: ReadonlyArray<{ files?: readonly string[]; rules?: Record<string, unknown> }>;
    };
    const blockFor = (glob: string): { rules?: Record<string, unknown> } | undefined =>
      configMod.default.find(
        (c) =>
          Array.isArray(c.files) &&
          c.files.includes(glob) &&
          c.rules?.["@typescript-eslint/no-restricted-imports"] !== undefined,
      );

    // Production block must come BEFORE the test-file override so flat-config precedence gives
    // *.test.ts the looser rule while every other kernel .ts keeps the strict one.
    const prodBlock = blockFor("packages/kernel/**/*.ts");
    const testBlock = blockFor("packages/kernel/**/*.test.ts");
    expect(prodBlock, "production kernel boundary must be attached").toBeDefined();
    expect(testBlock, "kernel *.test.ts boundary override must be attached").toBeDefined();
    expect(prodBlock!.rules!["@typescript-eslint/no-restricted-imports"]).toEqual(
      restrictedImports,
    );
    expect(testBlock!.rules!["@typescript-eslint/no-restricted-imports"]).toEqual(
      testRestrictedImports,
    );
    expect(configMod.default.indexOf(prodBlock as never)).toBeLessThan(
      configMod.default.indexOf(testBlock as never),
    );
  });
});
