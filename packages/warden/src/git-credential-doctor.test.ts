import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_CREDENTIAL_DOCTOR_REQUEST_ENV,
  inspectGitCredentialDoctorFromEnv,
  runGitCredentialDoctorFromEnv,
} from "./git-credential-doctor.js";

const roots: string[] = [];

function fixture(
  helper = "osxkeychain",
  scope = "global",
  options: { readonly homeName?: string; readonly configParentName?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "keel-credential-doctor-test-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, options.homeName ?? "home");
  const workspaceRoot = join(root, "workspace");
  const keelHome = join(root, "keel-home");
  const configParent =
    options.configParentName === undefined ? home : join(root, options.configParentName);
  for (const directory of new Set([bin, home, workspaceRoot, keelHome, configParent])) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const configPath = join(configParent, ".gitconfig");
  writeFileSync(configPath, `[credential]\n\thelper = ${helper}\n`, { mode: 0o600 });
  const helperPath = join(bin, "git-credential-osxkeychain");
  writeFileSync(helperPath, "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  const configurationOutput = join(root, "configuration-output.bin");
  writeFileSync(
    configurationOutput,
    Buffer.from(`${scope}\0file:${configPath}\0credential.helper\n${helper}\0`),
    { mode: 0o600 },
  );
  const git = join(bin, "git");
  writeFileSync(
    git,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'git version 2.39.5\\n'; exit 0; fi
if [ "$1" = "--exec-path" ]; then printf '%s\\n' '${bin}'; exit 0; fi
if [ "$1" = "config" ]; then cat '${configurationOutput}'; exit 0; fi
exit 1
`,
    { mode: 0o700 },
  );
  const request = Buffer.from(
    JSON.stringify({ workspaceRoot, remoteUrl: "https://github.com/owner/repo.git" }),
    "utf8",
  ).toString("base64");
  return {
    root,
    configParent,
    configPath,
    helperPath,
    home,
    env: {
      HOME: home,
      KEEL_HOME: keelHome,
      PATH: bin,
      [GIT_CREDENTIAL_DOCTOR_REQUEST_ENV]: request,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git credential authority doctor", () => {
  it("reports eligibility only after the real Warden authority inspection", async () => {
    await expect(inspectGitCredentialDoctorFromEnv(fixture().env)).resolves.toEqual({
      status: "ok",
      detail: "operator helper authority eligible",
    });
  });

  it("returns one bounded remediation without reproducing rejected helper bytes", async () => {
    const rejected = "!node /workspace/secret-helper.mjs";
    const result = await inspectGitCredentialDoctorFromEnv(fixture(rejected).env);

    expect(result).toMatchObject({
      status: "error",
      detail: "credential helper command is not one eligible fixed helper",
    });
    expect(result.fix?.split("\n")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(rejected);
    expect(JSON.stringify(result)).not.toContain("secret-helper");
  });

  it("rejects malformed or duplicate-key internal requests", async () => {
    const { env } = fixture();
    const encoded = (value: unknown): string =>
      Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString(
        "base64",
      );
    for (const request of [
      "",
      "x".repeat(8 * 1_024 + 1),
      "not-base64",
      encoded('{"workspaceRoot":"/tmp","workspaceRoot":"/tmp","remoteUrl":"x"}'),
      encoded(null),
      encoded([]),
      encoded({ unexpected: true }),
      encoded({ workspaceRoot: 1, remoteUrl: "x" }),
      encoded({ workspaceRoot: "/tmp", remoteUrl: 1 }),
    ]) {
      await expect(
        inspectGitCredentialDoctorFromEnv({
          ...env,
          [GIT_CREDENTIAL_DOCTOR_REQUEST_ENV]: request,
        }),
      ).rejects.toThrow();
    }
    const withoutRequest = { ...env, [GIT_CREDENTIAL_DOCTOR_REQUEST_ENV]: undefined };
    await expect(inspectGitCredentialDoctorFromEnv(withoutRequest)).rejects.toThrow();
    await expect(inspectGitCredentialDoctorFromEnv()).rejects.toThrow();
  });

  it("reports unsupported Git and every bounded authority remediation class", async () => {
    const unavailable = fixture();
    await expect(
      inspectGitCredentialDoctorFromEnv({ ...unavailable.env, PATH: "" }),
    ).resolves.toMatchObject({
      status: "error",
      detail: "supported Git executable authority is unavailable",
    });

    const unsafeEnvironment = fixture();
    const withoutHome = { ...unsafeEnvironment.env, HOME: undefined };
    await expect(inspectGitCredentialDoctorFromEnv(withoutHome)).resolves.toEqual({
      status: "error",
      detail: "operator HOME/XDG authority is unsafe",
      fix: "set HOME/XDG_CONFIG_HOME to an existing operator-owned directory, then run: keel doctor",
    });

    const unsafeHome = fixture();
    chmodSync(unsafeHome.home, 0o720);
    await expect(inspectGitCredentialDoctorFromEnv(unsafeHome.env)).resolves.toEqual({
      status: "error",
      detail: `operator HOME/XDG directory permissions rejected: ${unsafeHome.home}`,
      fix: `chmod 700 '${unsafeHome.home}' && keel doctor`,
    });

    const unsafeConfig = fixture();
    chmodSync(unsafeConfig.configPath, 0o620);
    await expect(inspectGitCredentialDoctorFromEnv(unsafeConfig.env)).resolves.toEqual({
      status: "error",
      detail: `credential helper config file permissions rejected: ${unsafeConfig.configPath}`,
      fix: `chmod go-w '${unsafeConfig.configPath}' && keel doctor`,
    });

    const unsafeConfigParent = fixture("osxkeychain", "global", {
      configParentName: "operator-config",
    });
    chmodSync(unsafeConfigParent.configParent, 0o720);
    await expect(inspectGitCredentialDoctorFromEnv(unsafeConfigParent.env)).resolves.toEqual({
      status: "error",
      detail: `credential helper config directory permissions rejected: ${realpathSync(unsafeConfigParent.configParent)}`,
      fix: `chmod go-w '${realpathSync(unsafeConfigParent.configParent)}' && keel doctor`,
    });

    const unsafeExecutable = fixture();
    chmodSync(unsafeExecutable.helperPath, 0o720);
    await expect(inspectGitCredentialDoctorFromEnv(unsafeExecutable.env)).resolves.toEqual({
      status: "error",
      detail: `credential helper executable file permissions rejected: ${realpathSync(unsafeExecutable.helperPath)}`,
      fix: `chmod go-w,u+x '${realpathSync(unsafeExecutable.helperPath)}' && keel doctor`,
    });

    await expect(
      inspectGitCredentialDoctorFromEnv(fixture("osxkeychain", "local").env),
    ).resolves.toMatchObject({
      status: "error",
      detail: "credential helper is not system/global authority",
    });
    await expect(inspectGitCredentialDoctorFromEnv(fixture("").env)).resolves.toMatchObject({
      status: "error",
      detail: "credential helper command is not one eligible fixed helper",
    });
    await expect(inspectGitCredentialDoctorFromEnv(fixture("missing-helper").env)).resolves.toEqual(
      {
        status: "error",
        detail: "credential helper executable unavailable: git-credential-missing-helper",
        fix:
          "gh auth login --git-protocol https && gh auth setup-git && " +
          "git config --global --get-all credential.helper && keel doctor",
      },
    );
  });

  it("does not prescribe chmod for an unavailable authority entry", async () => {
    const f = fixture();
    const missingHome = join(f.root, "missing-home");

    await expect(
      inspectGitCredentialDoctorFromEnv({ ...f.env, HOME: missingHome }),
    ).resolves.toEqual({
      status: "error",
      detail: `operator HOME/XDG directory unavailable: ${missingHome}`,
      fix: "set HOME/XDG_CONFIG_HOME to an existing operator-owned directory, then run: keel doctor",
    });
  });

  it("maps malformed Git configuration framing to configuration repair", async () => {
    const f = fixture();
    const git = join(f.root, "bin", "git");
    writeFileSync(
      git,
      `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'git version 2.39.5\\n'; exit 0; fi
if [ "$1" = "--exec-path" ]; then printf '%s\\n' '${join(f.root, "bin")}'; exit 0; fi
if [ "$1" = "config" ]; then printf 'malformed'; exit 0; fi
exit 1
`,
      { mode: 0o700 },
    );

    await expect(inspectGitCredentialDoctorFromEnv(f.env)).resolves.toEqual({
      status: "error",
      detail: "credential helper config origin/include is unsafe",
      fix: "repair the affected system/global Git config origin/include, then run: keel doctor",
    });
  });

  it("shell-quotes an exact adversarial chmod target without executing its bytes", async () => {
    const f = fixture("osxkeychain", "global", {
      homeName: "home'$(touch injected); metacharacters",
    });
    chmodSync(f.home, 0o720);
    const result = await inspectGitCredentialDoctorFromEnv(f.env);
    expect(result.status).toBe("error");
    expect(result.fix).toBe(`chmod 700 '${f.home.replaceAll("'", "'\\''")}' && keel doctor`);

    const suffix = " && keel doctor";
    const fix = result.fix;
    if (fix === undefined || !fix.endsWith(suffix)) throw new Error("expected one chmod fix");
    execFileSync("/bin/sh", ["-c", fix.slice(0, -suffix.length)], { cwd: f.root });

    expect(statSync(f.home).mode & 0o777).toBe(0o700);
    expect(existsSync(join(f.root, "injected"))).toBe(false);
  });

  it("suppresses C0, C1, format, line, and paragraph controls from exact entries", async () => {
    for (const [index, control] of ["\t", "\u0085", "\u202e", "\u2028", "\u2029"].entries()) {
      const f = fixture("osxkeychain", "global", {
        homeName: `unsafe-${String(index)}-${control}-home`,
      });
      chmodSync(f.home, 0o720);

      const result = await inspectGitCredentialDoctorFromEnv(f.env);

      expect(result).toEqual({
        status: "error",
        detail: "operator HOME/XDG authority is unsafe",
        fix: "set HOME/XDG_CONFIG_HOME to an existing operator-owned directory, then run: keel doctor",
      });
      expect(result.detail).not.toContain(control);
      expect(result.fix).not.toContain(control);
      expect(Buffer.byteLength(`${JSON.stringify(result)}\n`, "utf8")).toBeLessThanOrEqual(1_024);
    }
  });

  it("bounds the complete one-shot response below the kernel wire limit", async () => {
    const f = fixture();
    const segment = "long-authority-entry-".padEnd(120, "x");
    const longHome = join(f.root, segment, segment, segment);
    mkdirSync(longHome, { recursive: true, mode: 0o700 });
    chmodSync(longHome, 0o720);

    const result = await inspectGitCredentialDoctorFromEnv({ ...f.env, HOME: longHome });
    const line = `${JSON.stringify(result)}\n`;

    expect(line).not.toContain(longHome);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("writes exactly one JSON result through the one-shot Warden entry", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runGitCredentialDoctorFromEnv(fixture().env);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe(
      '{"status":"ok","detail":"operator helper authority eligible"}\n',
    );
  });
});
