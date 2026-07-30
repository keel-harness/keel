import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const NPX_PRODUCTION_JSX_OPTIONS = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: "react",
  isolatedModules: true,
  useDefineForClassFields: true,
  verbatimModuleSyntax: true,
} as const satisfies ts.CompilerOptions;

/**
 * Compile a Kernel TSX source file to the production automatic JSX runtime before Bun sees it.
 *
 * Bun 1.3.14's build API emits the development JSX runtime even when its `jsx.development` field is
 * false. Its environment-driven production mode also replaces runtime `process.env.NODE_ENV` reads
 * in bundled source. TypeScript is already exact-pinned for Keel's syntax checker, and its ReactJSX
 * emit performs only the required TS/JSX lowering while preserving runtime environment reads.
 */
export function transpileNpxProductionJsx(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: NPX_PRODUCTION_JSX_OPTIONS,
    fileName,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const detail = errors
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
      .join("; ");
    throw new Error(`npx production JSX transform failed for ${fileName}: ${detail}`);
  }
  return result.outputText;
}

/** Resolve a TSX input physically and reject anything outside the Kernel source tree. */
export async function resolveNpxKernelTsxInput(
  path: string,
  kernelSourceRoot: string,
): Promise<string> {
  const [physicalPath, physicalKernelRoot] = await Promise.all([
    realpath(isAbsolute(path) ? path : resolve(path)),
    realpath(resolve(kernelSourceRoot)),
  ]);
  const fromKernelRoot = relative(physicalKernelRoot, physicalPath);
  if (
    fromKernelRoot.length === 0 ||
    fromKernelRoot === ".." ||
    fromKernelRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromKernelRoot)
  ) {
    throw new Error(
      `npx production JSX transform refused non-Kernel input ${JSON.stringify(path)}`,
    );
  }
  return physicalPath;
}

/** Fail-closed artifact checks for the external production React JSX runtime contract. */
export function npxProductionJsxBundleReasons(contents: string): string[] {
  const reasons: string[] = [];
  if (contents.includes("react/jsx-dev-runtime")) {
    reasons.push(
      'development JSX runtime marker "react/jsx-dev-runtime" survived the npx Kernel build',
    );
  }
  const developmentCall = /\bjsxDEV[$\w]*\s*\(/u.exec(contents)?.[0].replaceAll(/\s+/gu, "");
  if (developmentCall !== undefined) {
    reasons.push(`development JSX call site ${developmentCall} survived the npx Kernel build`);
  }
  if (!contents.includes("react/jsx-runtime")) {
    reasons.push(
      'production JSX runtime marker "react/jsx-runtime" is absent from the npx Kernel build',
    );
  }
  return reasons;
}

/** Fail-closed checks that require both an exercised transform and a production-compatible bundle. */
export function npxProductionJsxBuildReasons(
  contents: string,
  transformedInputCount: number,
): string[] {
  return [
    ...(transformedInputCount < 1
      ? ["production JSX transform did not receive any Kernel TSX inputs"]
      : []),
    ...npxProductionJsxBundleReasons(contents),
  ];
}
