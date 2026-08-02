import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function interactiveFlags(source: string): readonly string[] {
  const block = /const interactiveFlags = new Set\(\[([\s\S]*?)\]\);/u.exec(source)?.[1];
  if (block === undefined) throw new Error("interactive flag set is absent from packaging entry");
  return [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
}

function workflowJob(source: string, name: string): string {
  const startMarker = `  ${name}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`workflow job is absent: ${name}`);
  const remainder = source.slice(start + startMarker.length);
  const next = /^ {2}[a-zA-Z0-9_-]+:\n/mu.exec(remainder);
  return next === null ? remainder : remainder.slice(0, next.index);
}

describe("CI packaging workflow", () => {
  it("early-paints every supported interactive resume spelling in the release entry", () => {
    const entry = readFileSync(join(repoRoot, "packaging", "npx-cli-entry.js"), "utf8");
    const compiledEntry = readFileSync(join(repoRoot, "packaging", "cli-entry.js"), "utf8");
    const build = readFileSync(join(repoRoot, "packaging", "build.ts"), "utf8");
    const gettingStarted = readFileSync(
      join(repoRoot, "docs", "guide", "getting-started.md"),
      "utf8",
    );

    for (const flag of ['"--continue"', '"-c"', '"--resume"', '"-r"']) {
      expect(entry).toContain(flag);
    }
    expect(entry).toContain("interactiveFlags.has(args[0])");
    expect(entry).toContain('process.stdout.write("keel · starting")');
    expect(entry).toContain('await import("./keel-kernel.mjs")');
    expect(entry.indexOf('process.stdout.write("keel · starting")')).toBeLessThan(
      entry.indexOf('await import("./keel-kernel.mjs")'),
    );
    expect(interactiveFlags(entry)).toEqual(interactiveFlags(compiledEntry));
    expect(build).toContain('"keel · starting"');
    expect(gettingStarted).toContain("keel --continue");
    expect(gettingStarted).toContain("keel --resume <id>");
  });

  it("maps NO_COLOR before the release entry imports Ink", () => {
    const entry = readFileSync(join(repoRoot, "packaging", "npx-cli-entry.js"), "utf8");
    const mapping = entry.indexOf('process.env.FORCE_COLOR = "0"');
    const rendererImport = entry.indexOf('import("./keel-kernel.mjs")');
    expect(mapping).toBeGreaterThan(0);
    expect(rendererImport).toBeGreaterThan(mapping);
  });

  it("captures host NODE_ENV and forces production after color mapping but before the Kernel import", () => {
    const entry = readFileSync(join(repoRoot, "packaging", "npx-cli-entry.js"), "utf8");
    const colorMapping = entry.indexOf('process.env.FORCE_COLOR = "0"');
    const productionSet = entry.indexOf('process.env.NODE_ENV = "production"');
    const rendererImport = entry.indexOf('import("./keel-kernel.mjs")');

    expect(entry).toContain("KEEL_HOST_NODE_ENV");
    expect(entry).toContain("KEEL_HOST_NODE_ENV_MANAGED");
    expect(productionSet).toBeGreaterThan(colorMapping);
    expect(rendererImport).toBeGreaterThan(productionSet);
    expect(Buffer.byteLength(entry, "utf8")).toBeLessThan(4_096);
  });

  it.each([
    { label: "unset", hostNodeEnv: undefined },
    { label: "set", hostNodeEnv: "development" },
  ])(
    "sets production and captures a $label host NODE_ENV before the Kernel graph loads",
    ({ hostNodeEnv }) => {
      const dir = mkdtempSync(join(tmpdir(), "keel-npx-launcher-ordering-"));
      const launcher = join(dir, "keel.mjs");
      try {
        writeFileSync(
          launcher,
          readFileSync(join(repoRoot, "packaging", "npx-cli-entry.js"), "utf8"),
          "utf8",
        );
        writeFileSync(
          join(dir, "keel-kernel.mjs"),
          `
            process.stdout.write(JSON.stringify({
              nodeEnv: process.env.NODE_ENV,
              hostNodeEnv: process.env.KEEL_HOST_NODE_ENV,
              managed: process.env.KEEL_HOST_NODE_ENV_MANAGED
            }));
          `,
          "utf8",
        );
        const env = { ...process.env };
        delete env["NODE_ENV"];
        delete env["KEEL_HOST_NODE_ENV"];
        delete env["KEEL_HOST_NODE_ENV_MANAGED"];
        if (hostNodeEnv !== undefined) env["NODE_ENV"] = hostNodeEnv;

        const captured = JSON.parse(
          execFileSync(process.execPath, [launcher], { encoding: "utf8", env }).trim(),
        ) as Record<string, string>;

        expect(captured).toEqual({
          nodeEnv: "production",
          ...(hostNodeEnv === undefined ? {} : { hostNodeEnv }),
          managed: "1",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("builds process-specific private npx entries behind the unchanged public bin", () => {
    const build = readFileSync(join(repoRoot, "packaging", "build.ts"), "utf8");
    const releaseMetadata = readFileSync(
      join(repoRoot, "packaging", "release-metadata.ts"),
      "utf8",
    );
    const compiledEntry = readFileSync(join(repoRoot, "packaging", "cli-entry.js"), "utf8");
    const wardenEntry = readFileSync(join(repoRoot, "packaging", "npx-warden-entry.js"), "utf8");

    expect(build).toContain('const NPX_LAUNCHER = "packaging/npx-cli-entry.js"');
    expect(build).toContain('const NPX_KERNEL_ENTRY = "packages/kernel/src/cli/bin.ts"');
    expect(build).toContain('const NPX_WARDEN_ENTRY = "packaging/npx-warden-entry.js"');
    expect(build).toContain("createPublicNpxManifest");
    expect(releaseMetadata).toContain('bin: { keel: "./bin/keel.mjs" }');
    expect(build).toMatch(/NPX_KERNEL_ENTRY,\s*"keel-kernel\.mjs"/u);
    expect(build).toMatch(/NPX_WARDEN_ENTRY,\s*"keel-warden\.mjs"/u);
    expect(build).toContain("new Set([...kernelGraphInputs, ...wardenGraphInputs])");

    const bundledSrt = compiledEntry.indexOf("importBundledVendoredSrtRuntime");
    const compiledWarden = compiledEntry.indexOf('import("../packages/warden/src/bin-entry.ts")');
    const compiledKernel = compiledEntry.indexOf('import("../packages/kernel/src/cli/bin.ts")');
    expect(bundledSrt).toBeGreaterThan(0);
    expect(compiledWarden).toBeGreaterThan(bundledSrt);
    expect(compiledKernel).toBeGreaterThan(compiledWarden);

    const packagedSrt = wardenEntry.indexOf("importBundledVendoredSrtRuntime");
    const packagedWarden = wardenEntry.indexOf(
      'await import("../packages/warden/src/bin-entry.ts")',
    );
    expect(packagedSrt).toBeGreaterThan(0);
    expect(packagedWarden).toBeGreaterThan(packagedSrt);
  });

  it("production-transforms only the npx Kernel JSX and real-PTY smokes the installed carrier", () => {
    const build = readFileSync(join(repoRoot, "packaging", "build.ts"), "utf8");
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const smokePath = join(repoRoot, "packaging", "smoke-npx-production-renderer.py");

    expect(build).toContain("npxProductionJsxPlugin");
    expect(build).toContain("transpileNpxProductionJsx");
    expect(build).toContain("npxProductionJsxBuildReasons");
    expect(build).toContain("await resolveNpxKernelTsxInput(path, KERNEL_SOURCE_ROOT)");
    expect(build).toMatch(/NPX_KERNEL_ENTRY,[\s\S]*\[stubInkDevtools, npxProductionJsxPlugin\]/u);
    expect(build).toMatch(/NPX_WARDEN_ENTRY,[\s\S]*\[stubInkDevtools\]/u);
    expect(build).not.toMatch(
      /define\s*:\s*\{[^}]*["']?process\.env\.NODE_ENV["']?\s*:\s*["']production["']/u,
    );
    expect(workflow).toContain("Smoke installed npx production renderer through a real PTY");
    expect(workflow).toContain('python3 "$PRODUCTION_RENDERER_SMOKE" ./node_modules/.bin/keel');
    expect(readFileSync(smokePath, "utf8")).toContain("run_launch_sample");
  });

  it("keeps installed PTY smoke support inside the publishable packaging tree", () => {
    const rendererSmoke = readFileSync(
      join(repoRoot, "packaging", "smoke-npx-production-renderer.py"),
      "utf8",
    );
    const steeringSmoke = readFileSync(
      join(repoRoot, "packaging", "smoke-urgent-steering.py"),
      "utf8",
    );
    const harnessPath = join(repoRoot, "packaging", "pty-product-harness.py");

    expect(existsSync(harnessPath)).toBe(true);
    expect(rendererSmoke).toContain('REPO_ROOT / "packaging" / "pty-product-harness.py"');
    expect(steeringSmoke).toContain('REPO_ROOT / "packaging" / "pty-product-harness.py"');
    expect(rendererSmoke).not.toContain(' / "docs"');
    expect(steeringSmoke).not.toContain(' / "docs"');
  });

  it("reviews a local-stdio MCP server through the freshly installed npx carrier", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const smokePath = join(repoRoot, "packaging", "smoke-npx-mcp-review.mjs");
    const smoke = readFileSync(smokePath, "utf8");

    expect(workflow).toContain('MCP_REVIEW_SMOKE="$PWD/packaging/smoke-npx-mcp-review.mjs"');
    expect(workflow).toContain('node "$MCP_REVIEW_SMOKE" "$KEEL_BIN"');
    expect(workflow.indexOf("npm install --ignore-scripts")).toBeLessThan(
      workflow.indexOf('node "$MCP_REVIEW_SMOKE" "$KEEL_BIN"'),
    );
    expect(smoke).toContain("mcp review missing");
    expect(smoke).toContain("mcp review fixture");
    expect(smoke).toContain("mcp__fixture__echo");
    expect(smoke).toContain("mcp-trust.json");
    expect(smoke).toContain('join(keelHome, "trust.json")');
    expect(smoke).toContain('decision: "trusted"');
    expect(smoke).toContain("mode: 0o700");
    expect(smoke).toContain("mode: 0o600");
    expect(smoke).not.toContain('KEEL_TRUST: "1"');
    expect(smoke).not.toContain("ANTHROPIC_API_KEY");
    expect(smoke).not.toContain("OPENAI_API_KEY");
  });

  it("requires the installed npx Bash symlink denial and bounded-final carrier on both package platforms", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const smokePath = join(repoRoot, "packaging", "smoke-bash-symlink-deny.mjs");
    const smoke = readFileSync(smokePath, "utf8");

    expect(workflow).toContain(
      'BASH_SYMLINK_DENY_SMOKE="$PWD/packaging/smoke-bash-symlink-deny.mjs"',
    );
    expect(workflow).toContain('node "$BASH_SYMLINK_DENY_SMOKE" --self-test');
    expect(workflow).toContain('node "$BASH_SYMLINK_DENY_SMOKE" "$KEEL_BIN"');
    expect(workflow.indexOf("npm install --ignore-scripts")).toBeLessThan(
      workflow.indexOf('node "$BASH_SYMLINK_DENY_SMOKE" "$KEEL_BIN"'),
    );
    expect(smoke).toContain("symlink-deny-typed-write");
    expect(smoke).toContain("symlink-deny-bash-touch");
    expect(smoke).toContain('"keel.temp"');
    expect(smoke).toContain("spawnControlledTarget");
    expect(smoke).toContain("await terminateProcessGroup(");
    expect(smoke).toContain("exit?.code !== 1");
    expect(smoke).not.toContain("ANTHROPIC_API_KEY");
    expect(smoke).not.toContain("OPENAI_API_KEY");

    const selfTest = execFileSync(process.execPath, [smokePath, "--self-test"], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf8",
    });
    expect(selfTest).toContain("installed Bash symlink denial oracle self-test passed");
    for (const rejected of [
      "exit",
      "typed-canary",
      "bash-canary",
      "process-group",
      "public-path-leak",
      "malformed-denial-diagnostic-redaction",
      "review-route-diagnostic-redaction",
      "tool-result-path-leak-redaction",
      "bash-guidance",
      "typed-audit-diagnostic-redaction",
      "bash-audit-diagnostic-redaction",
      "temp-fact-diagnostic-redaction",
    ]) {
      expect(selfTest).toContain(`rejected:${rejected}`);
    }
  });

  it("gates one exact egress-guard npm carrier across Node 20, 22, and 24", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const packageJob = workflowJob(workflow, "package");
    const productMatrixJob = workflowJob(workflow, "egress-product-matrix");
    const aggregateJob = workflowJob(workflow, "ci-required");
    const productConfig = readFileSync(join(repoRoot, "vitest.egress-product.config.ts"), "utf8");
    const productSetup = readFileSync(join(repoRoot, "vitest.egress-product.setup.ts"), "utf8");
    const smoke = readFileSync(
      join(repoRoot, "packaging", "smoke-egress-address-guard-carrier.mjs"),
      "utf8",
    );

    expect(packageJob).toContain("egress-address-guard-npx-carrier");
    expect(packageJob).toContain("package/bin/keel-kernel.mjs");
    expect(packageJob).toContain("package/bin/keel-warden.mjs");
    expect(packageJob).not.toContain("package/packages/warden/src/bin-entry.ts");
    expect(packageJob).toContain('smoke-egress-address-guard-carrier.mjs --compiled "$BIN"');
    expect(packageJob).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(productMatrixJob).toContain("node: [20, 22, 24]");
    expect(productMatrixJob).toContain("node-version: ${{ matrix.node }}");
    expect(productMatrixJob).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(productMatrixJob).toContain("pnpm test:egress-product");
    expect(productMatrixJob).toContain("pnpm test:sandbox:real");
    expect(productMatrixJob).toContain("smoke-egress-address-guard-carrier.mjs");
    expect(productMatrixJob).toContain("npm install --ignore-scripts");
    expect(productMatrixJob).toContain("npm_config_engine_strict=true");
    expect(aggregateJob).toContain("egress-product-matrix");
    expect(aggregateJob).toContain("EGRESS_PRODUCT_MATRIX_RESULT");
    expect(productConfig).toContain("vendor/sandbox-runtime/test/sandbox/update-config.test.ts");
    expect(productConfig).toContain("vitest.egress-product.setup.ts");
    expect(productSetup).toContain("it.runIf(condition)");

    expect(smoke).toContain("egress-address-guard/v1");
    expect(smoke).toContain("warden.resolveReview");
    expect(smoke).toContain("egress-address-exceptions.v1.json");
    expect(smoke).toContain("requested.review?.allowCommand");
    expect(smoke).toContain("--scope once --domain ${host}");
    expect(smoke).not.toContain("requested.review?.domain");
    expect(smoke).toContain("restricted-address-not-excepted");
    expect(smoke).toContain("hard-deny");
    expect(smoke).toContain("carrier egress address guard smoke passed");
    expect(smoke).toContain("KEEL_INTERNAL_WARDEN_STDIO");
  });

  it("requires the installed final-response carrier on both package platforms", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const packageJob = workflowJob(workflow, "package");
    const smokePath = join(repoRoot, "packaging", "smoke-installed-final-response.mjs");
    const smoke = readFileSync(smokePath, "utf8");

    expect(packageJob).toContain(
      'INSTALLED_FINAL_RESPONSE_SMOKE="$PWD/packaging/smoke-installed-final-response.mjs"',
    );
    expect(packageJob).toContain('node "$INSTALLED_FINAL_RESPONSE_SMOKE" --self-test');
    expect(packageJob).toContain('node "$INSTALLED_FINAL_RESPONSE_SMOKE" "$KEEL_BIN"');
    expect(packageJob.indexOf("npm install --ignore-scripts")).toBeLessThan(
      packageJob.indexOf('node "$INSTALLED_FINAL_RESPONSE_SMOKE" "$KEEL_BIN"'),
    );
    expect(packageJob).toContain("npm audit --omit=dev");
    expect(packageJob).toContain('fromJSON(\'["ubuntu-latest", "macos-15"]\')');
    expect(smoke).toContain("installed-final-response-read");
    expect(smoke).toContain("installed-final-response-edit");
    expect(smoke).toContain("installed-final-response-check");
    expect(smoke).toContain("srt:vendored");
    expect(smoke).toContain("sandbox:srt");
    expect(smoke).toContain("spawnControlledTarget");
    expect(smoke).toContain("await terminateProcessGroup(");
    expect(smoke).not.toContain("ANTHROPIC_API_KEY");
    expect(smoke).not.toContain("OPENAI_API_KEY");

    const selfTest = execFileSync(process.execPath, [smokePath, "--self-test"], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf8",
    });
    expect(selfTest).toContain("installed final-response oracle self-test passed");
    for (const rejected of [
      "missing-final",
      "duplicate-final",
      "changed-final",
      "overclaim-final",
      "fourth-tool",
      "wrong-command",
      "failed-check",
      "wrong-postimage",
      "missing-audit",
      "invalid-chain",
      "unverified-bundle",
      "review-pending",
      "wrong-exit",
      "process-survivor",
      "diagnostic-residue",
      "diagnostic-overflow",
    ]) {
      expect(selfTest).toContain(`rejected:${rejected}`);
    }
  });

  it("imports built @keel/eval dist and loads copied TB-2 data (ER-032)", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const evalPkg = JSON.parse(
      readFileSync(join(repoRoot, "packages", "eval", "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const smokeScript = readFileSync(
      join(repoRoot, "packages", "eval", "scripts", "smoke-dist-load.mjs"),
      "utf8",
    );

    expect(workflow).toContain("Verify built @keel/eval loads copied TB-2 data");
    expect(workflow).toContain("pnpm --filter @keel/eval run smoke:dist");
    expect(evalPkg.scripts?.["smoke:dist"]).toBe("node scripts/smoke-dist-load.mjs");
    expect(smokeScript).toContain('import("../dist/index.js")');
    expect(smokeScript).toContain("assertSubsetIntegrity");
    expect(smokeScript).toContain("catalog.taskCount");
  });

  it("runtime-smokes cross-arch binaries on native GitHub-hosted runners (ER-028)", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow.split("\n")).toContain("  cross-arch-runtime-smoke:");
    expect(workflow).toContain("ubuntu-24.04-arm");
    expect(workflow).toContain("macos-15-intel");

    expect(workflow).toContain("./build/bin/keel-linux-arm64");
    expect(workflow).toContain("./build/bin/keel-darwin-x64");
    expect(
      workflow.match(
        /run -p "verify the shell" --verbose --replay (?:packaging\/smoke\.recording\.json|"\$REC")/gu,
      ),
    ).toHaveLength(3);
    expect(workflow).not.toMatch(
      /run -p "verify the shell" --replay (?:packaging\/smoke\.recording\.json|"\$REC")/u,
    );
    expect(workflow).toContain("keel-replay-ok");
    expect(workflow).toContain("replay-smoke-complete");
    expect(workflow).toContain("grep -Fq 'bash  done'");
    expect(workflow).toContain("grep -Fq 'result: stdout: keel-replay-ok'");
    expect(workflow).not.toContain("grep -Fq '\"exitCode\":0'");
    expect(workflow).not.toContain('grep -Fq \'"stdout":"keel-replay-ok\\n"\'');

    expect(workflow).not.toMatch(/runtime smoke deferred/i);
  });

  it("wires the native compiled-warden smoke and exercises its evidence assertions", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const smokePath = join(repoRoot, "packaging", "smoke-compiled-warden.mjs");
    const smoke = readFileSync(smokePath, "utf8");

    expect(workflow).toContain("Smoke native compiled warden enforcement");
    expect(workflow).toContain('node packaging/smoke-compiled-warden.mjs "$BIN"');
    expect(smoke).toContain('KEEL_INTERNAL_WARDEN_STDIO: "1"');
    expect(smoke).not.toContain("ANTHROPIC_API_KEY");
    expect(smoke).not.toContain("OPENAI_API_KEY");
    const selfTest = execFileSync(process.execPath, [smokePath, "--self-test"], {
      cwd: repoRoot,
      stdio: "pipe",
      encoding: "utf8",
    });
    expect(selfTest).toContain("compiled warden evidence and lifecycle self-test passed");
    expect(selfTest).toContain("process-group-reaped");
    for (const rejectedField of [
      "status.enforcementTier",
      "status.sandboxBackend",
      "allowed.verdict",
      "allowed.result",
      "allowed.result.exitCode",
      "allowed.result.stdout",
      "sandboxProbe.verdict",
      "sandboxProbe.result",
      "sandboxProbe.result.exitCode.type",
      "sandboxProbe.result.exitCode.zero",
      "denied.verdict",
      "denied.guidance.missing",
      "denied.guidance.policy",
      "allowed.auditSeq",
      "sandboxProbe.auditSeq",
      "denied.auditSeq",
      "sandboxTargetExists",
      "deniedTargetExists",
      "audit.allowed.eventType",
      "audit.allowed.toolCallId",
      "audit.allowed.toolName",
      "audit.sandbox.eventType",
      "audit.sandbox.toolCallId",
      "audit.sandbox.toolName",
      "audit.denied.eventType",
      "audit.denied.toolCallId",
      "audit.denied.toolName",
    ]) {
      expect(selfTest).toContain(`rejected:${rejectedField}`);
    }
  });

  it("owns the compiled warden's full POSIX process group through shutdown and failure", () => {
    const smoke = readFileSync(join(repoRoot, "packaging", "smoke-compiled-warden.mjs"), "utf8");
    const cleanup = readFileSync(join(repoRoot, "packaging", "process-group-cleanup.mjs"), "utf8");
    const controller = readFileSync(
      join(repoRoot, "packaging", "process-group-controller.mjs"),
      "utf8",
    );
    const guardian = readFileSync(
      join(repoRoot, "packaging", "process-group-guardian.mjs"),
      "utf8",
    );

    expect(smoke).toContain("spawnControlledTarget");
    expect(controller).toContain("PROCESS_GROUP_GUARDIAN");
    expect(controller).toContain('stdio: ["pipe", "pipe", "pipe", "ipc"]');
    expect(controller).toContain("createGuardedProcessGroupLease(child.pid");
    expect(smoke).toContain("await terminateProcessGroup(processGroupLease, guardianExit)");
    expect(cleanup).toContain('lease.signal("SIGTERM")');
    expect(cleanup).toContain('lease.signal("SIGKILL")');
    expect(cleanup).toContain('exit.signal !== "SIGKILL"');
    expect(guardian).toContain("process.kill(0, signal)");
    expect(guardian).toContain('process.on("SIGTERM", () => {})');
    expect(controller).toContain('type: "signal-commit"');
    expect(guardian).toContain('type: "signal-ready"');
    expect(smoke).toContain('process.stdout.write("resistant-ready\\\\n")');
    expect(smoke).toContain('descendant.stdout.on("data", onDescendantData)');
    expect(smoke).toContain("appendReadinessOutput(partialReadiness.buffer");
    expect(smoke).toContain('child.stdout.on("data", onData)');
    expect(smoke).not.toContain('child.stdout.once("data"');
    expect(smoke).not.toContain("process.kill(-");
    expect(controller).not.toContain("process.kill(-");
    expect(cleanup).not.toContain("process.kill(-");
  });

  it("runs a compiled-binary Phase-2B evidence export and offline verify smoke", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow).toContain("Smoke compiled binary Phase-2B evidence export and verify");
    expect(workflow).toContain('SESSION_FILE=$(find "$KEEL_HOME/audit"');
    expect(workflow).toContain('"$BIN" audit export "$SESSION_ID"');
    expect(workflow).toContain('"$BIN" audit verify "$BUNDLE"');
    expect(workflow).toContain('node "$BUNDLE/verify/verify-bundle.mjs" "$BUNDLE"');
    expect(workflow).toContain("verified audit bundle:");
    expect(workflow).toContain("OK sha256:");
  });

  it("keeps Debian compiled-binary warden startup smoke from tripping pipefail after a successful match", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const debianStep =
      workflow.match(
        /- name: Smoke Linux binary warden startup in Debian[\s\S]*?(?=\n {6}- name: Smoke compiled binary Phase-2B evidence export and verify)/,
      )?.[0] ?? "";

    expect(debianStep).toContain("DEBIAN_OUT=$(docker run --rm --platform linux/amd64");
    expect(debianStep).toContain(
      "printf 'Debian warden startup output missing hello response:\\n%s\\n' \"$DEBIAN_OUT\"",
    );
    expect(debianStep).not.toMatch(/\|\s*grep -q ['"]/);
  });

  it("proves the npx package uses bundled ripgrep, not the runner's system rg (ER-030d)", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow).toContain('NODE_BIN="$(dirname "$(command -v node)")"');
    expect(workflow).toContain('DOCTOR_KEEL_HOME="$WORK/doctor-keel-home"');
    expect(workflow).toContain('mkdir -m 700 -- "$DOCTOR_KEEL_HOME"');
    expect(workflow).toContain(
      'KEEL_HOME="$DOCTOR_KEEL_HOME" PATH="$NODE_BIN:$WORK/node_modules/.bin:/usr/bin:/bin:/usr/sbin:/sbin" ./node_modules/.bin/keel doctor',
    );
  });

  it("typechecks the Bun packaging script before CI packaging builds (ER-030d)", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(rootPkg.scripts?.["typecheck:packaging"]).toBe("tsc -p tsconfig.packaging.json");
    expect(rootPkg.scripts?.["typecheck"]).toContain("typecheck:packaging");
    expect(workflow).toContain("Typecheck packaging script");
    expect(workflow).toContain("pnpm run typecheck:packaging");
    expect(workflow.indexOf("pnpm run typecheck:packaging")).toBeLessThan(
      workflow.indexOf("bun packaging/build.ts npx"),
    );
  });

  it("keeps PR CI path-aware while exposing one stable required status", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow.split("\n")).toContain("  detect-changes:");
    expect(workflow.split("\n")).toContain("  docs:");
    expect(workflow.split("\n")).toContain("  ci-required:");
    expect(workflow).toContain("docs_only");
    expect(workflow).toContain("needs.detect-changes.outputs.docs_only == 'true'");
    expect(workflow).toContain("needs.detect-changes.outputs.code == 'true'");
    expect(workflow).toContain("needs.detect-changes.outputs.package == 'true'");
    expect(workflow).toContain('base="${{ github.event.pull_request.base.sha }}"');
    expect(workflow).toContain("pnpm exec prettier --check --ignore-unknown");
  });

  it("routes every compiled-warden build input through packaging and native smoke", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const packageClassifier =
      workflow.match(/case "\$path" in[\s\S]*?package=true[\s\S]*?;;\n {12}esac/u)?.[0] ?? "";

    for (const pathPattern of [
      "packages/kernel/**",
      "packages/warden/**",
      "packages/shared/**",
      "vendor/**",
      "packaging/**",
      "tools/**",
      ".github/workflows/**",
      "LICENSE",
      "NOTICE",
      "package.json",
      "patches/**",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.packaging.json",
      "vitest*.config.ts",
      "vitest*.setup.ts",
    ]) {
      expect(packageClassifier).toContain(pathPattern);
    }
    expect(workflow).toContain("npm_config_engine_strict=true npm install --ignore-scripts");
  });

  it("keeps standalone binaries test-only and never uploads them as workflow artifacts", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const uploadSteps = workflow
      .split("\n      - ")
      .filter((step) => step.includes("actions/upload-artifact"));

    expect(workflow).not.toContain("keel-linux-binaries");
    for (const step of uploadSteps) {
      expect(step).not.toMatch(/build\/bin\/keel-/u);
    }

    for (const retainedEvidence of [
      "bun packaging/build.ts bin linux-x64 linux-arm64",
      "Smoke the native binary (--version + doctor + hermetic one-task replay run)",
      "Smoke native compiled warden enforcement",
      "Smoke compiled binary ignores a workspace .env before trust",
      "Smoke Linux binary warden startup in Debian",
      "Smoke compiled binary Phase-2B evidence export and verify",
      "Verify companion cross-arch binary built",
      "Runtime-smoke cross-arch binary (--version + doctor + hermetic one-task replay run)",
    ]) {
      expect(workflow).toContain(retainedEvidence);
    }
  });

  it("runs public-doc claim and numeric-evidence guards on docs-only PRs (QC §10)", () => {
    // The build + security jobs run these tests through the full suites, but both are gated on
    // `code == 'true'` and skipped for docs-only PRs. The docs job must run both guards directly.
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const docsJob = workflow.slice(workflow.indexOf("\n  docs:"), workflow.indexOf("\n  build:"));
    expect(docsJob).toContain("docs-claim-consistency.test.ts");
    expect(docsJob).toContain("evidence-numbers.test.ts");
  });

  it("runs the Phase-2A security suite as a real CI gate", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(rootPkg.scripts?.["test:security"]).toContain("vitest run");
    expect(rootPkg.scripts?.["test:security"]).toContain("security-suite.test.ts");

    expect(workflow.split("\n")).toContain("  security:");
    expect(workflow).toContain("pnpm test:security");
    expect(workflow).toContain("SECURITY_RESULT");
    expect(workflow).toContain(
      "needs: [detect-changes, docs, build, node-next, package, egress-product-matrix, security, sandbox-real]",
    );
    expect(workflow).not.toMatch(
      /name: Security suite \(Phase 1\/2 — SEC catalog\)\s+if: false\s+run: exit 1/,
    );
  });

  it("proves real OS-sandbox denials in a required CI leg (P1-4, anti hidden-green)", () => {
    // The unit srt tests drive a FAKE runtime, so a green `pnpm test` never proves the real OS
    // sandbox denies anything. This leg runs the opt-in real-denial probes against the vendored
    // runtime with the fail-closed require flag armed, on a runner that has the tooling installed —
    // so it cannot pass by silently skipping.
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };

    // The script arms the require flag itself, so `pnpm test:sandbox:real` fails closed everywhere.
    expect(rootPkg.scripts?.["test:sandbox:real"]).toContain("KEEL_REQUIRE_REAL_SANDBOX=1");
    expect(rootPkg.scripts?.["test:sandbox:real"]).toContain("vitest run");
    expect(rootPkg.scripts?.["test:sandbox:real"]).toContain("srt-sandbox.real.test.ts");

    // A dedicated job runs it, arms the flag at job scope (belt-and-suspenders), and installs the
    // real sandbox tooling so an unavailable backend is a real failure, not a skip. Scope the
    // tooling-install assertion to the sandbox-real job so it can't be satisfied by an unrelated
    // job that also installs bwrap (package / cross-arch-runtime-smoke).
    expect(workflow.split("\n")).toContain("  sandbox-real:");
    const sandboxRealJob = workflow.slice(
      workflow.indexOf("\n  sandbox-real:"),
      workflow.indexOf("\n  package:"),
    );
    expect(sandboxRealJob).toContain("pnpm test:sandbox:real");
    expect(sandboxRealJob).toContain('KEEL_REQUIRE_REAL_SANDBOX: "1"');
    expect(sandboxRealJob).toContain("command -v bwrap");
    // ripgrep is a vendored-srt dependency — omitting it makes the backend report unavailable and the
    // fail-closed gate redden the required leg (found via a real Debian-container validation run).
    expect(sandboxRealJob).toContain("missing+=(ripgrep)");

    // It is a required gate for code PRs: wired into ci-required's needs and its result check.
    expect(workflow).toContain("SANDBOX_REAL_RESULT");
    expect(workflow).toContain(
      "needs: [detect-changes, docs, build, node-next, package, egress-product-matrix, security, sandbox-real]",
    );
  });

  it("avoids known paid-runner warning paths in packaging CI", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    expect(workflow).toContain('"macos-15"');
    expect(workflow).not.toContain("macos-latest");
    expect(workflow).toContain("Install system doctor prerequisites");
    expect(workflow).toContain("command -v rg");
    expect(workflow).toContain("command -v bwrap");
    expect(workflow).toContain("command -v socat");
    expect(workflow).toContain("sudo apt-get install -y");
    expect(workflow).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(workflow).toContain("test -x /usr/bin/sandbox-exec");
  });
});
