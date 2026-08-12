import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_CREDENTIAL_DOCTOR_REQUEST_ENV,
  inspectGitCredentialDoctorFromEnv,
  runGitCredentialDoctorFromEnv,
} from "./git-credential-doctor.js";

const roots: string[] = [];

function fixture(helper = "osxkeychain", scope = "global") {
  const root = mkdtempSync(join(tmpdir(), "keel-credential-doctor-test-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  const workspaceRoot = join(root, "workspace");
  const keelHome = join(root, "keel-home");
  for (const directory of [bin, home, workspaceRoot, keelHome]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const configPath = join(home, ".gitconfig");
  writeFileSync(configPath, `[credential]\n\thelper = ${helper}\n`, { mode: 0o600 });
  writeFileSync(join(bin, "git-credential-osxkeychain"), "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  const git = join(bin, "git");
  writeFileSync(
    git,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'git version 2.39.5\\n'; exit 0; fi
if [ "$1" = "--exec-path" ]; then printf '%s\\n' '${bin}'; exit 0; fi
if [ "$1" = "config" ]; then printf '${scope}\\0file:${configPath}\\0credential.helper\\n${helper}\\0'; exit 0; fi
exit 1
`,
    { mode: 0o700 },
  );
  const request = Buffer.from(
    JSON.stringify({ workspaceRoot, remoteUrl: "https://github.com/owner/repo.git" }),
    "utf8",
  ).toString("base64");
  return {
    configPath,
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
    await expect(inspectGitCredentialDoctorFromEnv(withoutHome)).resolves.toMatchObject({
      status: "error",
      detail: "operator HOME/XDG authority is unsafe",
    });

    const unsafeConfig = fixture();
    chmodSync(unsafeConfig.configPath, 0o620);
    await expect(inspectGitCredentialDoctorFromEnv(unsafeConfig.env)).resolves.toMatchObject({
      status: "error",
      detail: "credential helper config origin/include is unsafe",
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
    await expect(
      inspectGitCredentialDoctorFromEnv(fixture("missing-helper").env),
    ).resolves.toMatchObject({
      status: "error",
      detail: "credential helper executable could not be identity-bound",
    });
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
