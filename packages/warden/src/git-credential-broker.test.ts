import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitCredentialBrokerError,
  createGitCredentialBroker,
  parseGitCredentialOutput,
  type GitCredentialProcessRequest,
  type GitCredentialProcessResult,
} from "./git-credential-broker.js";

const roots: string[] = [];

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keel-git-credential-broker-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function fakeGit(root: string): string {
  const path = join(root, "git");
  writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  writeFileSync(join(root, "git-credential-osxkeychain"), "#!/bin/sh\nexit 1\n", {
    mode: 0o700,
  });
  return path;
}

function realGitExecutable(): string {
  for (const directory of (process.env["PATH"] ?? "").split(":")) {
    if (!directory.startsWith("/")) continue;
    const candidate = join(directory, "git");
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error("git executable is unavailable for the credential-broker process test");
}

function realHelperBroker(
  helperSource: string,
  options: { readonly timeoutMs?: number; readonly maxOutputBytes?: number } = {},
) {
  const root = privateRoot();
  const home = join(root, "operator-home");
  mkdirSync(home, { mode: 0o700 });
  const helperPath = join(home, "helper.mjs");
  writeFileSync(helperPath, helperSource, { mode: 0o700 });
  writeFileSync(
    join(home, ".gitconfig"),
    `[credential]\n\thelper =\n\thelper = !${process.execPath} ${helperPath}\n`,
    { mode: 0o600 },
  );
  return createGitCredentialBroker({
    gitExecutable: realGitExecutable(),
    tempRoot: root,
    env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C" },
    ...options,
  });
}

function result(
  stdout: string,
  overrides: Partial<GitCredentialProcessResult> = {},
): GitCredentialProcessResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    outputExceeded: false,
    ...overrides,
  };
}

const context = {
  protocol: "https" as const,
  host: "github.com",
  path: "keel-harness/keel.git",
};

function exactCredentialOutput(username: string, password: string): string {
  return [
    "protocol=https",
    "host=github.com",
    "path=keel-harness/keel.git",
    `username=${username}`,
    `password=${password}`,
    "",
  ].join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ADR-0091 operator Git credential protocol", () => {
  it("parses one exact matching HTTPS username/password record", () => {
    expect(
      parseGitCredentialOutput(exactCredentialOutput("x-access-token", "token"), context),
    ).toEqual({ username: "x-access-token", password: "token" });
  });

  it.each([
    [
      "missing password",
      "protocol=https\nhost=github.com\npath=keel-harness/keel.git\nusername=u\n",
    ],
    ["duplicate key", `${exactCredentialOutput("u", "p")}password=again\n`],
    ["unknown key", `${exactCredentialOutput("u", "p")}oauth_refresh_token=hidden\n`],
    ["wrong protocol", exactCredentialOutput("u", "p").replace("https", "http")],
    ["wrong host", exactCredentialOutput("u", "p").replace("github.com", "evil.example")],
    ["wrong path", exactCredentialOutput("u", "p").replace("keel-harness", "someone-else")],
    ["control-bearing username", exactCredentialOutput("u\u0000x", "p")],
    ["colon-bearing Basic username", exactCredentialOutput("u:admin", "p")],
    ["empty username", exactCredentialOutput("", "p")],
    ["empty password", exactCredentialOutput("u", "")],
  ])("rejects %s output", (_label, output) => {
    expect(() => parseGitCredentialOutput(output, context)).toThrow(GitCredentialBrokerError);
  });

  it("rejects an oversized credential record before parsing it", () => {
    expect(() =>
      parseGitCredentialOutput(exactCredentialOutput("u", "x".repeat(8_193)), context),
    ).toThrow(/output bound/u);
  });

  it("rejects a non-canonical DNS label in the requested credential context", () => {
    const invalidContext = { ...context, host: "bad-.example" };
    const output = exactCredentialOutput("u", "p").replace("github.com", invalidContext.host);
    expect(() => parseGitCredentialOutput(output, invalidContext)).toThrow(
      /canonical HTTPS repository/u,
    );
  });

  it.each([
    ["protocol", { protocol: "http" }],
    ["oversized host", { host: `${"a".repeat(250)}.com` }],
    ["IP literal", { host: "127.0.0.1" }],
    ["empty DNS label", { host: "bad..example" }],
    ["empty path", { path: "" }],
    ["leading path slash", { path: "/owner/repo.git" }],
    ["oversized path", { path: "a".repeat(385) }],
    ["noncanonical path byte", { path: "owner/repo%2egit" }],
    ["path traversal", { path: "owner/../repo.git" }],
  ])("rejects an invalid %s credential context", (_label, override) => {
    const invalidContext = { ...context, ...override } as typeof context;
    expect(() => parseGitCredentialOutput(exactCredentialOutput("u", "p"), invalidContext)).toThrow(
      /canonical HTTPS repository/u,
    );
  });

  it.each([
    ["missing final newline", exactCredentialOutput("u", "p").slice(0, -1)],
    ["carriage return", exactCredentialOutput("u", "p").replace("username=u", "username=u\r")],
    ["missing key delimiter", exactCredentialOutput("u", "p").replace("username=u", "username")],
    ["invisible format byte", exactCredentialOutput("u\u200b", "p")],
    ["oversized username", exactCredentialOutput("u".repeat(257), "p")],
    ["oversized password", exactCredentialOutput("u", "p".repeat(4_097))],
  ])("rejects %s credential framing", (_label, output) => {
    expect(() => parseGitCredentialOutput(output, context)).toThrow(GitCredentialBrokerError);
  });
});

describe("ADR-0091 Warden Git credential broker", () => {
  it.each([
    ["zero timeout", { timeoutMs: 0 }],
    ["fractional timeout", { timeoutMs: 1.5 }],
    ["oversized timeout", { timeoutMs: 5_001 }],
    ["zero output bound", { maxOutputBytes: 0 }],
    ["fractional output bound", { maxOutputBytes: 1.5 }],
    ["oversized output bound", { maxOutputBytes: 8_193 }],
  ])("rejects a %s at construction", (_label, override) => {
    const root = privateRoot();
    expect(() =>
      createGitCredentialBroker({
        gitExecutable: fakeGit(root),
        tempRoot: root,
        ...override,
      }),
    ).toThrow(GitCredentialBrokerError);
  });

  it("rejects a non-directory or non-private broker temporary root", () => {
    const root = privateRoot();
    const fileRoot = join(root, "ordinary-file");
    writeFileSync(fileRoot, "not a directory\n", { mode: 0o600 });
    expect(() =>
      createGitCredentialBroker({ gitExecutable: fakeGit(root), tempRoot: fileRoot }),
    ).toThrow(/owner-only/u);

    chmodSync(root, 0o755);
    expect(() =>
      createGitCredentialBroker({ gitExecutable: join(root, "git"), tempRoot: root }),
    ).toThrow(/owner-only/u);
  });

  it("binds system/global helper configuration without resolving a credential", async () => {
    const root = privateRoot();
    const requests: GitCredentialProcessRequest[] = [];
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      requests.push(request);
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.includes("--list")) {
        return result(
          "global\u0000file:/operator/.gitconfig\u0000credential.helper\nosxkeychain\u0000",
        );
      }
      return result("credential.helper\nosxkeychain\u0000");
    });
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess,
      env: { HOME: "/operator", PATH: "/usr/bin:/bin" },
    });

    const identity = await broker.inspect(context);

    expect(identity.version).toBe("git-credential-broker/v1");
    expect(identity.helperCount).toBe(1);
    expect(identity.configurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(identity.helperDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.argv.includes("credential"))).toBe(false);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
  });

  it("rejects non-file Git and non-directory helper executable identities", async () => {
    const directoryGitRoot = privateRoot();
    const directoryGitBroker = createGitCredentialBroker({
      gitExecutable: directoryGitRoot,
      tempRoot: directoryGitRoot,
      runProcess: async (request) => {
        if (request.argv.includes("--exec-path")) return result(`${directoryGitRoot}\n`);
        return result("credential.helper\nosxkeychain\u0000");
      },
    });
    await expect(directoryGitBroker.inspect(context)).rejects.toThrow(/ordinary file/u);

    const fileExecRoot = privateRoot();
    const gitExecutable = fakeGit(fileExecRoot);
    const fileExecBroker = createGitCredentialBroker({
      gitExecutable,
      tempRoot: fileExecRoot,
      runProcess: async (request) => {
        if (request.argv.includes("--exec-path")) return result(`${gitExecutable}\n`);
        return result("credential.helper\nosxkeychain\u0000");
      },
    });
    await expect(fileExecBroker.inspect(context)).rejects.toThrow(/not a directory/u);
  });

  it.each([
    ["relative", "relative/git-core\n"],
    ["embedded newline", "/operator/git\ncore\n"],
    ["oversized", `/${"a".repeat(1_025)}\n`],
  ])("rejects a %s Git helper exec path", async (_label, execPathOutput) => {
    const root = privateRoot();
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess: async (request) => {
        if (request.argv.includes("--exec-path")) return result(execPathOutput);
        return result("credential.helper\nosxkeychain\u0000");
      },
    });
    await expect(broker.inspect(context)).rejects.toThrow(/exec path is malformed/u);
  });

  it("resolves only with credential fill after exact identity revalidation", async () => {
    const root = privateRoot();
    const canaryUser = `user-${randomBytes(8).toString("hex")}`;
    const canarySecret = `token-${randomBytes(24).toString("base64url")}`;
    const requests: GitCredentialProcessRequest[] = [];
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      requests.push(request);
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.at(-2) === "credential" && request.argv.at(-1) === "fill") {
        return result(exactCredentialOutput(canaryUser, canarySecret));
      }
      if (request.argv.includes("--list")) {
        return result(
          "global\u0000file:/operator/.gitconfig\u0000credential.helper\nosxkeychain\u0000",
        );
      }
      return result("credential.helper\nosxkeychain\u0000");
    });
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess,
      env: {
        HOME: "/operator",
        PATH: "/usr/bin:/bin",
        TMPDIR: "/tmp/untrusted-operator-temp",
        GIT_ASKPASS: "/hostile",
      },
    });
    const identity = await broker.inspect(context);

    const authorization = await broker.resolve(context, identity);

    expect(authorization).toEqual({
      scheme: "Basic",
      secret: Buffer.from(`${canaryUser}:${canarySecret}`, "utf8").toString("base64"),
    });
    const fill = requests.at(-1)!;
    expect(fill.argv.slice(-2)).toEqual(["credential", "fill"]);
    expect(
      requests.some((request) =>
        request.argv.some((arg) => /approve|store|reject|erase/u.test(arg)),
      ),
    ).toBe(false);
    expect(fill.stdin).toBe("protocol=https\nhost=github.com\npath=keel-harness/keel.git\n\n");
    expect(fill.argv.join("\u0000")).not.toContain(canaryUser);
    expect(fill.argv.join("\u0000")).not.toContain(canarySecret);
    expect(JSON.stringify(fill.env)).not.toContain(canaryUser);
    expect(JSON.stringify(fill.env)).not.toContain(canarySecret);
    expect(fill.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(fill.env["GIT_ASKPASS"]).toBe("/usr/bin/false");
    expect(fill.env["SSH_ASKPASS"]).toBe("/usr/bin/false");
    expect(fill.env["GCM_INTERACTIVE"]).toBe("never");
    expect(fill.env["TMPDIR"]).toBe(fill.cwd);
    expect(fill.env).not.toHaveProperty("GIT_DIR");
  });

  it("resolves a GitHub bearer token from only the helper password", async () => {
    const root = privateRoot();
    const canaryUser = `ignored-${randomBytes(8).toString("hex")}`;
    const canarySecret = `github_pat_${randomBytes(24).toString("base64url")}`;
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.at(-1) === "fill") {
        return result(exactCredentialOutput(canaryUser, canarySecret));
      }
      return result("credential.helper\nosxkeychain\u0000");
    });
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess,
    });
    const identity = await broker.inspect(context);

    const authorization = await broker.resolveBearer(context, identity);

    expect(authorization).toEqual({ scheme: "Bearer", secret: canarySecret });
    expect(JSON.stringify(authorization)).not.toContain(canaryUser);
    expect(JSON.stringify(authorization)).not.toContain(
      Buffer.from(`${canaryUser}:${canarySecret}`, "utf8").toString("base64"),
    );
  });

  it("rejects helper/config drift before invoking credential fill", async () => {
    const root = privateRoot();
    let inspection = 0;
    const requests: GitCredentialProcessRequest[] = [];
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      requests.push(request);
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.includes("--list")) {
        inspection += 1;
        return result(`global\u0000credential.helper\nhelper-${String(inspection)}\u0000`);
      }
      return result(`credential.helper\nhelper-${String(inspection)}\u0000`);
    });
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess,
    });
    const identity = await broker.inspect(context);

    await expect(broker.resolve(context, identity)).rejects.toThrow(/identity changed/u);
    expect(requests.some((request) => request.argv.at(-1) === "fill")).toBe(false);
  });

  it.each([
    ["timeout", { timedOut: true }],
    ["output bound", { outputExceeded: true }],
    ["nonzero exit", { exitCode: 1 }],
    ["stderr", { stderr: "helper leaked diagnostics" }],
  ] as const)("fails closed on %s without including helper output", async (_label, override) => {
    const root = privateRoot();
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.at(-1) === "fill") {
        return result("", override);
      }
      if (request.argv.includes("--list")) return result("credential.helper\nosxkeychain\u0000");
      return result("credential.helper\nosxkeychain\u0000");
    });
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess,
    });
    const identity = await broker.inspect(context);

    await expect(broker.resolve(context, identity)).rejects.toThrow(GitCredentialBrokerError);
    await expect(broker.resolve(context, identity)).rejects.not.toThrow(
      "helper leaked diagnostics",
    );
  });

  it("enforces the real helper-process timeout without returning helper diagnostics", async () => {
    const broker = realHelperBroker(
      `process.stdin.resume(); setTimeout(() => process.exit(0), 60_000);`,
      { timeoutMs: 1_000 },
    );
    const identity = await broker.inspect(context);

    const startedAt = performance.now();
    await expect(broker.resolve(context, identity)).rejects.toThrow(/resolution timed out/u);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it("aborts a real in-flight helper process and fails closed", async () => {
    const broker = realHelperBroker(
      `process.stdin.resume(); setTimeout(() => process.exit(0), 60_000);`,
    );
    const identity = await broker.inspect(context);
    const controller = new AbortController();
    controller.abort();

    await expect(broker.resolve(context, identity, controller.signal)).rejects.toThrow(
      GitCredentialBrokerError,
    );
  });

  it("enforces the real helper-process output bound without returning credential bytes", async () => {
    const canary = `token-${randomBytes(3_000).toString("base64url")}`;
    const broker = realHelperBroker(
      `process.stdin.resume(); process.stdin.on("end", () => {
        process.stdout.write("username=u\\npassword=${canary}\\n");
      });`,
      { maxOutputBytes: 1_024 },
    );
    const identity = await broker.inspect(context);

    let caught: unknown;
    try {
      await broker.resolve(context, identity);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitCredentialBrokerError);
    expect(String(caught)).toMatch(/output bound/u);
    expect(String(caught)).not.toContain(canary);
  });

  it("rejects concurrent resolution instead of queueing or duplicating helper execution", async () => {
    const root = privateRoot();
    let releaseFill!: () => void;
    const fillBlocked = new Promise<void>((resolve) => {
      releaseFill = resolve;
    });
    let fillStarted!: () => void;
    const fillDidStart = new Promise<void>((resolve) => {
      fillStarted = resolve;
    });
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.at(-1) === "fill") {
        fillStarted();
        await fillBlocked;
        return result(exactCredentialOutput("u", "p"));
      }
      return result("credential.helper\nosxkeychain\u0000");
    });
    const broker = createGitCredentialBroker({
      gitExecutable: fakeGit(root),
      tempRoot: root,
      runProcess,
    });
    const identity = await broker.inspect(context);
    const first = broker.resolve(context, identity);
    await fillDidStart;

    await expect(broker.resolveBearer(context, identity)).rejects.toThrow(/already in progress/u);
    releaseFill();
    await expect(first).resolves.toEqual({
      scheme: "Basic",
      secret: Buffer.from("u:p", "utf8").toString("base64"),
    });
  });

  it("withholds the broker when helper discovery is empty, malformed, or over the bound", async () => {
    for (const helperOutput of [
      "",
      "credential.helper-without-value\u0000",
      Array.from({ length: 9 }, (_, index) => `credential.helper\nh${String(index)}\u0000`).join(
        "",
      ),
    ]) {
      const root = privateRoot();
      const broker = createGitCredentialBroker({
        gitExecutable: fakeGit(root),
        tempRoot: root,
        runProcess: async (request) => {
          if (request.argv.includes("--exec-path")) return result(`${root}\n`);
          return request.argv.includes("--list") ? result("config\u0000") : result(helperOutput);
        },
      });
      await expect(broker.inspect(context)).rejects.toThrow(GitCredentialBrokerError);
    }
  });

  it("binds resolved helper executable identity and detects binary drift", async () => {
    const root = privateRoot();
    const gitExecutable = fakeGit(root);
    const helperPath = join(root, "git-credential-osxkeychain");
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${root}\n`);
      if (request.argv.includes("--list")) return result("credential.helper\nosxkeychain\u0000");
      return result("credential.helper\nosxkeychain\u0000");
    });
    const broker = createGitCredentialBroker({ gitExecutable, tempRoot: root, runProcess });
    const before = await broker.inspect(context);

    writeFileSync(helperPath, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    const after = await broker.inspect(context);

    expect(after.configurationDigest).toBe(before.configurationDigest);
    expect(after.helperDigest).not.toBe(before.helperDigest);
  });
});
