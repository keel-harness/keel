import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const requireFromBin = createRequire(join(ROOT, "packages/kernel/src/cli/bin.ts"));
const TSX_ESM_LOADER = pathToFileURL(requireFromBin.resolve("tsx/esm")).href;
const BIN_ENTRY = join(ROOT, "packages/kernel/src/cli/bin.ts");
const SESSION_ENTRY = join(ROOT, "packages/kernel/src/cli/session-entry.ts");

describe("bin entrypoint interactive terminal ownership", () => {
  it("contains no Warden host dispatch in the Kernel process entry", () => {
    const source = readFileSync(BIN_ENTRY, "utf8");

    expect(source).not.toContain("runWardenFromEnv");
    expect(source).not.toContain("KEEL_INTERNAL_WARDEN_STDIO");
  });

  it("installs and settles the lifecycle around the exact shared input queue", () => {
    const source = readFileSync(BIN_ENTRY, "utf8");

    expect(source).toContain("const inputQueue = new InputQueue()");
    expect(source).toContain("const terminalLifecycle = installNodeInteractiveTerminalLifecycle({");
    expect(source).toContain("queue: inputQueue");
    expect(source).toContain("const runUi = terminalLifecycle?.ui ?? ui");
    expect(source).toContain("terminalLifecycle?.dispose()");
    expect(source).toContain("terminalLifecycle?.exitCode()");
  });

  it("activates terminal lifecycle only after project trust resolves", () => {
    const source = readFileSync(SESSION_ENTRY, "utf8");
    const trust = source.indexOf("const ctx = await gatherProjectContext({");
    const activation = source.indexOf("activateTerminalLifecycle(deps.ui);");

    expect(trust).toBeGreaterThan(-1);
    expect(activation).toBeGreaterThan(trust);
  });

  it("hands first-open trust input to Ink through the one process.stdin stream", () => {
    const source = readFileSync(BIN_ENTRY, "utf8");

    // A second ReadStream over fd 0 changes the shared terminal descriptor underneath Ink. On
    // real controlling PTYs that handoff can surface an unhandled EAGAIN as soon as Ink mounts.
    // Keep one Node stream owner and preserve any pasted remainder on that same object.
    expect(source).not.toContain('createReadStream("", { fd: process.stdin.fd');
    expect(source).toContain("readTrustLine(process.stdin, process.stdout)");
    expect(source).toContain("process.stdin.unshift(read.remainder)");
  });
});

function binEnv(keelHome: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env["FORCE_COLOR"] = "0";
  env["NO_COLOR"] = "1";
  env["KEEL_HOME"] = keelHome;
  env["KEEL_PROVIDER"] = "openai";
  env["KEEL_MODEL"] = "gpt-test";
  delete env["OPENAI_API_KEY"];
  delete env["ANTHROPIC_API_KEY"];
  delete env["GOOGLE_GENERATIVE_AI_API_KEY"];
  return env;
}

describe("bin entrypoint Plan Autopilot confirmation", () => {
  it.each([
    { args: ["--help"], expectedStatus: 0, expected: /usage: keel \[command\]/i },
    { args: ["--version"], expectedStatus: 0, expected: /^keel \d+\.\d+\.\d+/m },
    {
      args: ["doctor"],
      expectedStatus: 1,
      expected: /keel doctor[\s\S]*ripgrep/i,
    },
  ])(
    "keeps recovery command $args bootstrap-independent when optional ripgrep imports are unavailable",
    ({ args, expectedStatus, expected }) => {
      const keelHome = mkdtempSync(join(tmpdir(), "keel-bin-ripgrep-missing-home-"));
      try {
        const env = binEnv(keelHome);
        env["PATH"] = "";
        env["npm_config_arch"] = "keel-missing-optional";
        const result = spawnSync(
          process.execPath,
          ["--import", TSX_ESM_LOADER, "--conditions=@keel/source", BIN_ENTRY, ...args],
          { encoding: "utf8", env, maxBuffer: 1024 * 1024 },
        );

        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(result.stdout).toMatch(expected);
        expect(result.stderr).not.toMatch(/could not find @vscode\/ripgrep|module_not_found/i);
      } finally {
        rmSync(keelHome, { recursive: true, force: true });
      }
    },
  );

  it("returns exit 1 for an unknown top-level flag", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-bin-usage-home-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          TSX_ESM_LOADER,
          "--conditions=@keel/source",
          BIN_ENTRY,
          "--definitely-invalid",
        ],
        { encoding: "utf8", env: binEnv(keelHome), maxBuffer: 1024 * 1024 },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/usage: keel/i);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("renders a short provider-setup block when a live key is missing", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-bin-missing-key-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "keel-bin-missing-key-ws-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", TSX_ESM_LOADER, "--conditions=@keel/source", BIN_ENTRY],
        {
          cwd,
          encoding: "utf8",
          env: binEnv(keelHome),
          input: "",
          maxBuffer: 1024 * 1024,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe(
        [
          "keel: provider setup needed",
          "",
          "No openai API key was found.",
          "",
          "  Store it:      keel auth set openai",
          "  Or set env:    OPENAI_API_KEY",
          "  Check runtime: keel doctor",
          "",
          `Current KEEL_HOME: ${keelHome}`,
          "",
        ].join("\n"),
      );
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed before provider setup when --plan-confirm cannot read an interactive approval", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-bin-plan-confirm-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "keel-bin-plan-confirm-ws-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          TSX_ESM_LOADER,
          "--conditions=@keel/source",
          BIN_ENTRY,
          "run",
          "-p",
          "ship login fix\nforged row",
          "--plan-confirm",
          "--plan-domain",
          "example.com",
        ],
        {
          cwd,
          encoding: "utf8",
          env: binEnv(keelHome),
          input: "",
          maxBuffer: 1024 * 1024,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Plan Autopilot approval for");
      expect(result.stdout).toContain("task: ship login fix forged row");
      expect(result.stdout).toContain("exact resources requested for this run:");
      expect(result.stdout).toContain("keel: --plan-confirm requires an interactive terminal");
      expect(result.stdout).not.toContain("provider setup needed");
      expect(result.stdout).not.toContain("no openai API key");
      expect(result.stdout).not.toContain("\nforged row");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("bin entrypoint doctor executable posture", () => {
  it("does not misclassify a PATH-selected ripgrep outside the workspace as workspace-writable", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-bin-doctor-rg-path-"));
    const workspace = join(root, "workspace");
    const tools = join(root, "tools");
    const keelHome = join(root, "keel-home");
    mkdirSync(workspace);
    mkdirSync(tools);
    mkdirSync(keelHome, { mode: 0o700 });
    const ripgrep = join(tools, "rg");
    writeFileSync(ripgrep, "#!/bin/sh\nprintf 'ripgrep 15.1.0\\n'\n", { mode: 0o755 });
    chmodSync(ripgrep, 0o755);

    try {
      const env = binEnv(realpathSync(keelHome));
      env["KEEL_RG_PATH"] = "rg";
      env["PATH"] = [tools, process.env["PATH"] ?? ""].join(delimiter);
      const result = spawnSync(
        process.execPath,
        ["--import", TSX_ESM_LOADER, "--conditions=@keel/source", BIN_ENTRY, "doctor"],
        { cwd: workspace, encoding: "utf8", env, maxBuffer: 1024 * 1024 },
      );

      expect([0, 1], `${result.stdout}\n${result.stderr}`).toContain(result.status);
      expect(result.signal, `${result.stdout}\n${result.stderr}`).toBeNull();
      expect(result.stdout).toContain("ripgrep");
      expect(result.stdout).not.toContain("workspace-writable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
