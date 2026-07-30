import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  npxProductionJsxBuildReasons,
  npxProductionJsxBundleReasons,
  resolveNpxKernelTsxInput,
  transpileNpxProductionJsx,
} from "./production-jsx.js";

describe("npx production JSX transform", () => {
  it("emits the production automatic runtime without folding the runtime NODE_ENV", () => {
    const output = transpileNpxProductionJsx(
      `
        import type { ReactNode } from "react";
        type Props = { readonly children: ReactNode };
        export const runtimeMode = process.env.NODE_ENV;
        export function Card({ children }: Props) {
          return <section data-mode={process.env.NODE_ENV}><>{children}<span key="tail">done</span></></section>;
        }
      `,
      "/repo/packages/kernel/src/tui/ink/card.tsx",
    );

    expect(output).toContain('from "react/jsx-runtime"');
    expect(output).not.toContain("react/jsx-dev-runtime");
    expect(output).not.toMatch(/\bjsxDEV\w*\s*\(/u);
    expect(output).toContain("process.env.NODE_ENV");
    expect(output).not.toContain('runtimeMode = "production"');
    expect(output).not.toContain('runtimeMode = "development"');
    expect(output).not.toContain("import type");
  });

  it("fails closed on malformed TSX instead of handing a partial transform to Bun", () => {
    expect(() =>
      transpileNpxProductionJsx(
        "export const Broken = () => <section>",
        "/repo/packages/kernel/src/tui/ink/broken.tsx",
      ),
    ).toThrow(/production JSX transform failed.*broken\.tsx/iu);
  });

  it("resolves physical Kernel TSX inputs and refuses outside or symlink-escaped inputs", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-production-jsx-scope-"));
    const kernelRoot = join(root, "packages", "kernel", "src");
    const kernelInput = join(kernelRoot, "tui", "app.tsx");
    const outsideInput = join(root, "packages", "warden", "src", "outside.tsx");
    const escapedInput = join(kernelRoot, "tui", "escaped.tsx");
    try {
      mkdirSync(join(kernelRoot, "tui"), { recursive: true });
      mkdirSync(join(root, "packages", "warden", "src"), { recursive: true });
      writeFileSync(kernelInput, "export const inside = true;", "utf8");
      writeFileSync(outsideInput, "export const outside = true;", "utf8");
      symlinkSync(outsideInput, escapedInput, "file");

      await expect(resolveNpxKernelTsxInput(kernelInput, kernelRoot)).resolves.toBe(
        realpathSync(kernelInput),
      );
      await expect(resolveNpxKernelTsxInput(outsideInput, kernelRoot)).rejects.toThrow(
        /refused non-Kernel input/iu,
      );
      await expect(resolveNpxKernelTsxInput(escapedInput, kernelRoot)).rejects.toThrow(
        /refused non-Kernel input/iu,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the completed build when zero Kernel TSX inputs were transformed", () => {
    const productionBundle = 'import { jsx } from "react/jsx-runtime"; jsx("div", {});';

    expect(npxProductionJsxBuildReasons(productionBundle, 0)).toEqual([
      "production JSX transform did not receive any Kernel TSX inputs",
    ]);
    expect(npxProductionJsxBuildReasons(productionBundle, 1)).toEqual([]);
  });

  it("rejects development JSX imports and call sites in the completed Kernel bundle", () => {
    expect(
      npxProductionJsxBundleReasons(
        'import { jsxDEV as jsxDEV5 } from "react/jsx-dev-runtime"; jsxDEV5("div", {});',
      ),
    ).toEqual([
      'development JSX runtime marker "react/jsx-dev-runtime" survived the npx Kernel build',
      "development JSX call site jsxDEV5( survived the npx Kernel build",
      'production JSX runtime marker "react/jsx-runtime" is absent from the npx Kernel build',
    ]);
  });

  it("accepts only a production-runtime bundle and does not confuse similarly named text", () => {
    expect(
      npxProductionJsxBundleReasons(
        'import { jsx as jsx2 } from "react/jsx-runtime"; const jsxDeveloperNote = "kept"; jsx2("div", {});',
      ),
    ).toEqual([]);
  });
});
