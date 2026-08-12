import {
  chownSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitCredentialAuthorityError,
  gitCredentialDirectoryModeIsSafe,
  inspectGitCredentialHelperAuthority,
  prepareGitCredentialAuthority,
  resolveGitCredentialExecPath,
} from "./git-credential-authority.js";

const roots: string[] = [];

function privateDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function executable(path: string, body = "exit 1"): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keel-helper-authority-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const home = privateDirectory(root, "home");
  const workspaceRoot = privateDirectory(root, "workspace");
  const denyRoot = privateDirectory(root, "deny");
  const bin = privateDirectory(root, "bin");
  const execPath = privateDirectory(root, "git-core");
  const gitExecutable = executable(join(bin, "git"));
  executable(join(execPath, "git-credential-osxkeychain"));
  const configPath = join(home, ".gitconfig");
  writeFileSync(configPath, "[credential]\nhelper = osxkeychain\n", { mode: 0o600 });
  const env = { HOME: home, PATH: bin, SHELL: join(workspaceRoot, "hostile-shell") };
  const base = prepareGitCredentialAuthority({
    gitExecutable,
    inspectionCwd: root,
    temporaryRoot: root,
    workspaceRoot,
    denyRoots: [denyRoot],
    env,
  });
  const resolvedExecPath = resolveGitCredentialExecPath(base, Buffer.from(`${execPath}\n`));
  return {
    root,
    home,
    workspaceRoot,
    denyRoot,
    bin,
    execPath,
    gitExecutable,
    configPath,
    env,
    base,
    resolvedExecPath,
  };
}

function record(scope: string, origin: string, key: string, value: string): Buffer {
  return Buffer.from(`${scope}\0file:${origin}\0${key}\n${value}\0`);
}

const context = {
  protocol: "https" as const,
  host: "github.com",
  path: "keel-harness/keel.git",
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ADR-0091 Git credential helper authority", () => {
  it("parses one NUL-framed safe global helper and constructs config-independent fill authority", () => {
    const f = fixture();
    const snapshot = inspectGitCredentialHelperAuthority({
      base: f.base,
      gitExecPath: f.resolvedExecPath,
      configurationOutput: record("global", f.configPath, "credential.helper", "osxkeychain"),
      context,
    });

    expect(snapshot.helperCount).toBe(1);
    expect(snapshot.helper.argv).toEqual(["osxkeychain"]);
    expect(snapshot.helper.normalizedExecutionValue).toMatch(
      /^!'[^']*git-credential-osxkeychain'$/u,
    );
    expect(snapshot.fillEnv["SHELL"]).toBe(realpathSync("/bin/sh"));
    expect(snapshot.fillEnv["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(snapshot.fillEnv["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(snapshot.fillEnv["PATH"]).not.toContain(f.workspaceRoot);
  });

  it("applies matching empty resets in exact record order", () => {
    const f = fixture();
    const output = Buffer.concat([
      record("unknown", f.configPath, "credential.helper", "osxkeychain"),
      record("global", f.configPath, "credential.https://github.com.helper", ""),
      record("global", f.configPath, "credential.https://github.com.helper", "osxkeychain"),
    ]);

    expect(
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput: output,
        context,
      }).helperCount,
    ).toBe(1);
  });

  it("refuses zero, multiple, or surviving unknown helpers", () => {
    const f = fixture();
    const outputs = [
      record("global", f.configPath, "credential.helper", ""),
      Buffer.concat([
        record("global", f.configPath, "credential.helper", "osxkeychain"),
        record("global", f.configPath, "credential.helper", "osxkeychain"),
      ]),
      record("unknown", f.configPath, "credential.helper", "osxkeychain"),
    ];
    for (const configurationOutput of outputs) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput,
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
  });

  it("refuses malformed NUL framing and non-file or project scopes", () => {
    const f = fixture();
    const malformed = [
      Buffer.from("global\0file:/operator/.gitconfig\0credential.helper\nosxkeychain"),
      Buffer.from("global\0file:/operator/.gitconfig\0dangling\0extra\0"),
      Buffer.from(`command\0command line:\0credential.helper\nosxkeychain\0`),
      Buffer.from(`local\0file:${f.configPath}\0credential.helper\nosxkeychain\0`),
    ];
    for (const configurationOutput of malformed) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput,
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
  });

  it("refuses workspace and symlinked-workspace config origins", () => {
    const f = fixture();
    const projectConfig = join(f.workspaceRoot, ".gitconfig");
    writeFileSync(projectConfig, "[credential]\nhelper = osxkeychain\n", { mode: 0o600 });
    const alias = join(f.home, "project-config-link");
    symlinkSync(projectConfig, alias);
    for (const origin of [projectConfig, alias]) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("global", origin, "credential.helper", "osxkeychain"),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
  });

  it("refuses group-writable HOME, config, helper parent, and helper executable authority", () => {
    const homeFixture = fixture();
    chmodSync(homeFixture.home, 0o720);
    expect(() =>
      prepareGitCredentialAuthority({
        gitExecutable: homeFixture.gitExecutable,
        inspectionCwd: homeFixture.root,
        temporaryRoot: homeFixture.root,
        workspaceRoot: homeFixture.workspaceRoot,
        denyRoots: [homeFixture.denyRoot],
        env: homeFixture.env,
      }),
    ).toThrow(GitCredentialAuthorityError);

    const configFixture = fixture();
    chmodSync(configFixture.configPath, 0o620);
    expect(() =>
      inspectGitCredentialHelperAuthority({
        base: configFixture.base,
        gitExecPath: configFixture.resolvedExecPath,
        configurationOutput: record(
          "global",
          configFixture.configPath,
          "credential.helper",
          "osxkeychain",
        ),
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);

    const parentFixture = fixture();
    chmodSync(parentFixture.execPath, 0o720);
    expect(() =>
      inspectGitCredentialHelperAuthority({
        base: parentFixture.base,
        gitExecPath: parentFixture.resolvedExecPath,
        configurationOutput: record(
          "global",
          parentFixture.configPath,
          "credential.helper",
          "osxkeychain",
        ),
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);

    const executableFixture = fixture();
    chmodSync(join(executableFixture.execPath, "git-credential-osxkeychain"), 0o720);
    expect(() =>
      inspectGitCredentialHelperAuthority({
        base: executableFixture.base,
        gitExecPath: executableFixture.resolvedExecPath,
        configurationOutput: record(
          "global",
          executableFixture.configPath,
          "credential.helper",
          "osxkeychain",
        ),
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);
  });

  it("accepts Darwin admin-group write only for an operator-owned non-environment directory", () => {
    const uid = 501;
    expect(gitCredentialDirectoryModeIsSafe(0o775, uid, 80, uid, false, "darwin")).toBe(true);
    expect(gitCredentialDirectoryModeIsSafe(0o775, uid, 80, uid, true, "darwin")).toBe(false);
    expect(gitCredentialDirectoryModeIsSafe(0o775, 0, 80, uid, false, "darwin")).toBe(false);
    expect(gitCredentialDirectoryModeIsSafe(0o775, uid, 20, uid, false, "darwin")).toBe(false);
    expect(gitCredentialDirectoryModeIsSafe(0o775, uid, 80, uid, false, "linux")).toBe(false);
    expect(gitCredentialDirectoryModeIsSafe(0o777, uid, 80, uid, false, "darwin")).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "accepts only operator-owned Darwin admin-group writable non-HOME directories end to end",
    () => {
      const f = fixture();
      const uid = process.getuid?.();
      if (uid === undefined) throw new Error("test requires one POSIX operator identity");
      const homebrewEtc = privateDirectory(f.root, "homebrew-etc");
      chownSync(homebrewEtc, uid, 80);
      chmodSync(homebrewEtc, 0o775);
      const systemConfig = join(homebrewEtc, "gitconfig");
      writeFileSync(systemConfig, "[credential]\nhelper = osxkeychain\n", { mode: 0o600 });
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      expect(
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: Buffer.concat([
            record("system", systemConfig, "credential.helper", "osxkeychain"),
            record("global", f.configPath, "credential.helper", ""),
            record("global", f.configPath, "credential.helper", "osxkeychain"),
          ]),
          context,
        }).helperCount,
      ).toBe(1);

      chownSync(systemConfig, uid, 80);
      chmodSync(systemConfig, 0o620);
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: Buffer.concat([
            record("system", systemConfig, "credential.helper", "osxkeychain"),
            record("global", f.configPath, "credential.helper", ""),
            record("global", f.configPath, "credential.helper", "osxkeychain"),
          ]),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);

      chmodSync(systemConfig, 0o600);
      chmodSync(homebrewEtc, 0o777);
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("system", systemConfig, "credential.helper", "osxkeychain"),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);

      chmodSync(homebrewEtc, 0o775);
      platform.mockReturnValue("linux");
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("system", systemConfig, "credential.helper", "osxkeychain"),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);

      platform.mockReturnValue("darwin");
      const xdg = privateDirectory(f.root, "xdg-admin-group");
      chownSync(xdg, uid, 80);
      chmodSync(xdg, 0o775);
      expect(() =>
        prepareGitCredentialAuthority({
          gitExecutable: f.gitExecutable,
          inspectionCwd: f.root,
          temporaryRoot: f.root,
          workspaceRoot: f.workspaceRoot,
          denyRoots: [f.denyRoot],
          env: { ...f.env, XDG_CONFIG_HOME: xdg },
        }),
      ).toThrow(GitCredentialAuthorityError);

      chownSync(f.home, uid, 80);
      chmodSync(f.home, 0o775);
      expect(() =>
        prepareGitCredentialAuthority({
          gitExecutable: f.gitExecutable,
          inspectionCwd: f.root,
          temporaryRoot: f.root,
          workspaceRoot: f.workspaceRoot,
          denyRoots: [f.denyRoot],
          env: f.env,
        }),
      ).toThrow(GitCredentialAuthorityError);
    },
  );

  it.each([
    ["unterminated double quote", '!"unterminated'],
    ["backtick substitution", "!gh `host-command`"],
    ["command substitution", "!gh $(host-command)"],
    ["operator", "!gh auth; host-command"],
    ["interpreter script", "!/bin/sh /workspace/helper.sh"],
    ["environment assignment", "!TOKEN=value gh"],
    ["project path argument", "!gh ./helper"],
  ])("refuses %s helper syntax", (_label, value) => {
    const f = fixture();
    expect(() =>
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput: record("global", f.configPath, "credential.helper", value),
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);
  });

  it("refuses shell metacharacters under generated adversarial placement", () => {
    const f = fixture();
    executable(join(f.bin, "gh"));
    fc.assert(
      fc.property(
        fc.constantFrom("$", "`", "|", "&", ";", "(", ")", "<", ">", "#", "*", "?"),
        fc.stringMatching(/^[A-Za-z0-9]{0,8}$/u),
        fc.stringMatching(/^[A-Za-z0-9]{0,8}$/u),
        (operator, before, after) => {
          expect(() =>
            inspectGitCredentialHelperAuthority({
              base: f.base,
              gitExecPath: f.resolvedExecPath,
              configurationOutput: record(
                "global",
                f.configPath,
                "credential.helper",
                `!gh ${before}${operator}${after}`,
              ),
              context,
            }),
          ).toThrow(GitCredentialAuthorityError);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("supports one quoted absolute bang helper path containing spaces", () => {
    const f = fixture();
    const helperDirectory = privateDirectory(f.root, "helper tools");
    const helper = executable(join(helperDirectory, "credential helper"));
    const snapshot = inspectGitCredentialHelperAuthority({
      base: f.base,
      gitExecPath: f.resolvedExecPath,
      configurationOutput: record("global", f.configPath, "credential.helper", `!'${helper}'`),
      context,
    });

    expect(snapshot.helper.executable.canonicalPath).toBe(realpathSync(helper));
    expect(snapshot.helper.normalizedExecutionValue).toBe(`!'${realpathSync(helper)}'`);
  });

  it("accepts the fixed simple gh form and binds its canonical executable", () => {
    const f = fixture();
    const gh = executable(join(f.bin, "gh"));
    const snapshot = inspectGitCredentialHelperAuthority({
      base: f.base,
      gitExecPath: f.resolvedExecPath,
      configurationOutput: record(
        "global",
        f.configPath,
        "credential.https://github.com.helper",
        "!gh auth git-credential",
      ),
      context,
    });

    expect(snapshot.helper.argv).toEqual(["gh", "auth", "git-credential"]);
    expect(snapshot.helper.executable.canonicalPath).toBe(realpathSync(gh));
    expect(snapshot.helper.normalizedExecutionValue).toContain("auth git-credential");
  });

  it("ignores unsafe ambient PATH entries and never lets a workspace helper win", () => {
    const f = fixture();
    executable(join(f.workspaceRoot, "gh"));
    const safeGh = executable(join(f.bin, "gh"));
    const base = prepareGitCredentialAuthority({
      gitExecutable: f.gitExecutable,
      inspectionCwd: f.root,
      temporaryRoot: f.root,
      workspaceRoot: f.workspaceRoot,
      denyRoots: [f.denyRoot],
      env: { HOME: f.home, PATH: `${f.workspaceRoot}:relative::${f.bin}` },
    });
    const snapshot = inspectGitCredentialHelperAuthority({
      base,
      gitExecPath: resolveGitCredentialExecPath(base, Buffer.from(`${f.execPath}\n`)),
      configurationOutput: record("global", f.configPath, "credential.helper", "!gh auth"),
      context,
    });

    expect(snapshot.helper.executable.canonicalPath).toBe(realpathSync(safeGh));
    expect(snapshot.fillEnv["PATH"]).not.toContain(f.workspaceRoot);
  });

  it("binds an active home-relative include target", () => {
    const f = fixture();
    const included = join(f.home, "credential.inc");
    writeFileSync(included, "[credential]\nhelper = osxkeychain\n", { mode: 0o600 });
    const configurationOutput = Buffer.concat([
      record("global", f.configPath, "include.path", "~/credential.inc"),
      record("global", included, "credential.helper", "osxkeychain"),
    ]);

    expect(
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput,
        context,
      }).helperCount,
    ).toBe(1);
  });

  it("refuses an active include resolving into the workspace", () => {
    const f = fixture();
    const included = join(f.workspaceRoot, "credential.inc");
    writeFileSync(included, "[credential]\nhelper = osxkeychain\n", { mode: 0o600 });
    const configurationOutput = Buffer.concat([
      record("global", f.configPath, "include.path", included),
      record("global", included, "credential.helper", "osxkeychain"),
    ]);

    expect(() =>
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput,
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);
  });

  it("fails closed for unavailable POSIX, workspace, HOME, and XDG authority", () => {
    const f = fixture();
    const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, value: () => -1 });
    try {
      expect(() =>
        prepareGitCredentialAuthority({
          gitExecutable: f.gitExecutable,
          inspectionCwd: f.root,
          temporaryRoot: f.root,
          workspaceRoot: f.workspaceRoot,
          denyRoots: [f.denyRoot],
          env: f.env,
        }),
      ).toThrow(GitCredentialAuthorityError);
    } finally {
      if (getuidDescriptor === undefined) {
        Reflect.deleteProperty(process, "getuid");
      } else {
        Object.defineProperty(process, "getuid", getuidDescriptor);
      }
    }

    for (const options of [
      { workspaceRoot: join(f.root, "missing-workspace"), env: f.env },
      { workspaceRoot: f.workspaceRoot, env: { PATH: f.bin } },
      {
        workspaceRoot: f.workspaceRoot,
        env: { ...f.env, XDG_CONFIG_HOME: f.denyRoot },
      },
    ]) {
      expect(() =>
        prepareGitCredentialAuthority({
          gitExecutable: f.gitExecutable,
          inspectionCwd: f.root,
          temporaryRoot: f.root,
          workspaceRoot: options.workspaceRoot,
          denyRoots: [f.denyRoot],
          env: options.env,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }

    const xdg = privateDirectory(f.root, "xdg");
    const withXdg = prepareGitCredentialAuthority({
      gitExecutable: f.gitExecutable,
      inspectionCwd: f.root,
      temporaryRoot: f.root,
      workspaceRoot: f.workspaceRoot,
      denyRoots: [f.denyRoot],
      env: { ...f.env, XDG_CONFIG_HOME: xdg },
    });
    expect(withXdg.inspectionEnv["XDG_CONFIG_HOME"]).toBe(realpathSync(xdg));
  });

  it("rejects malformed exec-path and exact config framing variants", () => {
    const f = fixture();
    for (const output of [
      Buffer.from([0xff, 0x0a]),
      Buffer.from("relative\n"),
      Buffer.from(`${f.execPath}\r\n`),
      Buffer.from(`${f.execPath}\nextra\n`),
      Buffer.from(`${f.execPath}\0\n`),
      Buffer.from(`/${"x".repeat(1_025)}\n`),
    ]) {
      expect(() => resolveGitCredentialExecPath(f.base, output)).toThrow(
        GitCredentialAuthorityError,
      );
    }

    const malformed = [
      Buffer.alloc(0),
      Buffer.alloc(64 * 1_024 + 1),
      Buffer.from("field\0field\0"),
      Buffer.from("x\0x\0x\0".repeat(1_025)),
      Buffer.from(`unsupported\0file:${f.configPath}\0credential.helper\nosxkeychain\0`),
      Buffer.from(`global\0command line:\0credential.helper\nosxkeychain\0`),
      Buffer.from(`global\0file:relative\0credential.helper\nosxkeychain\0`),
      Buffer.from(`global\0file:${"/x".repeat(1_025)}\0credential.helper\nosxkeychain\0`),
      Buffer.from(`global\0file:${f.configPath}\0credential.helper\0`),
      Buffer.concat([
        Buffer.from("global\0file:"),
        Buffer.from(f.configPath),
        Buffer.from("\0"),
        Buffer.from([0xff, 0x0a, 0x78, 0]),
      ]),
      Buffer.concat([
        Buffer.from([0xff, 0]),
        Buffer.from(`file:${f.configPath}\0credential.helper\nosxkeychain\0`),
      ]),
    ];
    for (const configurationOutput of malformed) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput,
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
  });

  it("validates missing, malformed, relative, and conditional include targets", () => {
    const f = fixture();
    for (const value of ["", "~other/config", `bad${String.fromCharCode(1)}`, "x".repeat(2_049)]) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: Buffer.concat([
            record("global", f.configPath, "include.path", value),
            record("global", f.configPath, "credential.helper", "osxkeychain"),
          ]),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
    expect(() =>
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput: Buffer.concat([
          record("global", f.configPath, "include.path", join(f.home, "missing.inc")),
          record("global", f.configPath, "credential.helper", "osxkeychain"),
        ]),
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);

    const relativeTarget = join(f.home, "relative.inc");
    writeFileSync(relativeTarget, "[user]\nname = safe\n", { mode: 0o600 });
    const conditionalTarget = join(f.home, "conditional.inc");
    writeFileSync(conditionalTarget, "[user]\nemail = safe@invalid\n", { mode: 0o600 });
    const output = Buffer.concat([
      record("global", join(f.home, "missing-irrelevant"), "user.name", "ignored"),
      record("global", f.configPath, "include.path", "relative.inc"),
      record("global", f.configPath, "includeIf.gitdir:~/work.path", conditionalTarget),
      record("global", conditionalTarget, "user.email", "safe@invalid"),
      record("global", f.configPath, "includeIf.gitdir:~/other.path", "missing.inc"),
      record("global", f.configPath, "credential.helper", "osxkeychain"),
    ]);
    expect(
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput: output,
        context,
      }).helperCount,
    ).toBe(1);
  });

  it("rejects malformed scoped helper URLs and applies canonical context matching", () => {
    const f = fixture();
    for (const key of [
      "credential.http://github.com.helper",
      "credential.https://[.helper",
      "credential.https://user@github.com.helper",
      "credential.https://github.com:443.helper",
      "credential.https://github.com?query.helper",
      "credential.https://127.0.0.1.helper",
      "credential.https://github.com/a//b.helper",
      "credential.https://github.com/a^b.helper",
    ]) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("global", f.configPath, key, "osxkeychain"),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }

    for (const key of [
      "credential.https://github.com/keel-harness/keel.git.helper",
      "credential.https://github.com/keel-harness.helper",
    ]) {
      expect(
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("global", f.configPath, key, "osxkeychain"),
          context,
        }).helperCount,
      ).toBe(1);
    }

    expect(
      inspectGitCredentialHelperAuthority({
        base: f.base,
        gitExecPath: f.resolvedExecPath,
        configurationOutput: Buffer.concat([
          record("global", f.configPath, "credential.https://example.com/other.helper", "missing"),
          record("global", f.configPath, "credential.helper", "osxkeychain"),
        ]),
        context,
      }).helperCount,
    ).toBe(1);
  });

  it("bounds helper records and validates their exact bytes and reset scope", () => {
    const f = fixture();
    const invalidUtf8Value = Buffer.concat([
      Buffer.from(`global\0file:${f.configPath}\0credential.helper\n`),
      Buffer.from([0xff, 0]),
    ]);
    const unsupportedValue = Buffer.concat([
      Buffer.from(`global\0file:${f.configPath}\0credential.helper\n`),
      Buffer.from([0x61, 0x0a, 0]),
    ]);
    const outputs = [
      record("global", f.configPath, "credential.helper", "x".repeat(2_049)),
      invalidUtf8Value,
      unsupportedValue,
      Buffer.concat(
        Array.from({ length: 9 }, () =>
          record("global", f.configPath, "credential.helper", "osxkeychain"),
        ),
      ),
      Buffer.concat([
        record("unknown", f.configPath, "credential.helper", ""),
        record("global", f.configPath, "credential.helper", "osxkeychain"),
      ]),
    ];
    for (const configurationOutput of outputs) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput,
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
  });

  it("covers the accepted quote/escape grammar and remaining structural denials", () => {
    const f = fixture();
    executable(join(f.bin, "gh"));
    for (const value of ["!gh au\\th", '!gh "au\\th"', "!gh 'auth'"]) {
      expect(
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("global", f.configPath, "credential.helper", value),
          context,
        }).helper.argv,
      ).toEqual(["gh", "auth"]);
    }
    for (const value of [
      " osxkeychain",
      "osxkeychain ",
      "!",
      "! ",
      "!''",
      `!gh ${Array.from({ length: 16 }, () => "a").join(" ")}`,
      "bad/name",
      "!/tmp/bad^",
      "!foo/bar",
      '!gh "$HOME"',
    ]) {
      expect(() =>
        inspectGitCredentialHelperAuthority({
          base: f.base,
          gitExecPath: f.resolvedExecPath,
          configurationOutput: record("global", f.configPath, "credential.helper", value),
          context,
        }),
      ).toThrow(GitCredentialAuthorityError);
    }
  });

  it("ignores broken ambient discovery entries and rejects alias basename substitution", () => {
    const f = fixture();
    const notDirectory = join(f.root, "not-directory");
    writeFileSync(notDirectory, "ordinary file\n", { mode: 0o600 });
    const gh = executable(join(f.bin, "gh"));
    const base = prepareGitCredentialAuthority({
      gitExecutable: f.gitExecutable,
      inspectionCwd: f.root,
      temporaryRoot: f.root,
      workspaceRoot: f.workspaceRoot,
      denyRoots: [f.denyRoot],
      env: { HOME: f.home, PATH: `${join(f.root, "missing")}:${notDirectory}:${f.bin}` },
    });
    expect(
      inspectGitCredentialHelperAuthority({
        base,
        gitExecPath: resolveGitCredentialExecPath(base, Buffer.from(`${f.execPath}\n`)),
        configurationOutput: record("global", f.configPath, "credential.helper", "!gh"),
        context,
      }).helper.executable.canonicalPath,
    ).toBe(realpathSync(gh));

    const aliasName = "keel-helper-alias-canary";
    const alias = join(f.bin, aliasName);
    symlinkSync(gh, alias);
    expect(() =>
      inspectGitCredentialHelperAuthority({
        base,
        gitExecPath: resolveGitCredentialExecPath(base, Buffer.from(`${f.execPath}\n`)),
        configurationOutput: record("global", f.configPath, "credential.helper", `!${aliasName}`),
        context,
      }),
    ).toThrow(GitCredentialAuthorityError);
  });
});
