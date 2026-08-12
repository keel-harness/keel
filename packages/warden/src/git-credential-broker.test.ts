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
  applyGitCredentialStdinErrorPolicy,
  createGitCredentialBroker,
  parseGitCredentialOutput,
  runGitCredentialProcess,
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

interface BrokerFixture {
  readonly root: string;
  readonly home: string;
  readonly workspaceRoot: string;
  readonly denyRoot: string;
  readonly configPath: string;
  readonly gitExecutable: string;
  readonly env: NodeJS.ProcessEnv;
}

function brokerFixture(root = privateRoot()): BrokerFixture {
  const home = join(root, "operator-home");
  const workspaceRoot = join(root, "workspace");
  const denyRoot = join(root, "deny");
  for (const directory of [home, workspaceRoot, denyRoot]) {
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const configPath = join(home, ".gitconfig");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "[credential]\n\thelper = osxkeychain\n", { mode: 0o600 });
  }
  return {
    root,
    home,
    workspaceRoot,
    denyRoot,
    configPath,
    gitExecutable: fakeGit(root),
    env: { HOME: home, PATH: root, LANG: "C" },
  };
}

function brokerOptions(fixture: BrokerFixture) {
  return {
    gitExecutable: fixture.gitExecutable,
    tempRoot: fixture.root,
    workspaceRoot: fixture.workspaceRoot,
    denyRoots: [fixture.denyRoot],
    env: fixture.env,
  };
}

function configOutput(fixture: BrokerFixture, value = "osxkeychain", scope = "global"): string {
  return `${scope}\u0000file:${fixture.configPath}\u0000credential.helper\n${value}\u0000`;
}

function realGitExecutable(): string {
  if (existsSync("/usr/bin/git")) return realpathSync("/usr/bin/git");
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
  const workspaceRoot = join(root, "workspace");
  const denyRoot = join(root, "deny");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workspaceRoot, { mode: 0o700 });
  mkdirSync(denyRoot, { mode: 0o700 });
  const helperPath = join(home, "credential-helper");
  writeFileSync(helperPath, `#!/bin/sh\n${helperSource}\n`, { mode: 0o700 });
  chmodSync(helperPath, 0o700);
  writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper =\n\thelper = !${helperPath}\n`, {
    mode: 0o600,
  });
  return createGitCredentialBroker({
    gitExecutable: realGitExecutable(),
    tempRoot: root,
    workspaceRoot,
    denyRoots: [denyRoot],
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
  it.each([
    ["empty inspection input", "", 0],
    ["credential-bearing input", "protocol=https\n", 1],
  ] as const)("handles an asynchronous stdin failure for %s", (_label, stdin, failures) => {
    const failClosed = vi.fn();

    applyGitCredentialStdinErrorPolicy(stdin, failClosed);

    expect(failClosed).toHaveBeenCalledTimes(failures);
  });

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
    const fixture = brokerFixture();
    expect(() =>
      createGitCredentialBroker({
        ...brokerOptions(fixture),
        ...override,
      }),
    ).toThrow(GitCredentialBrokerError);
  });

  it("rejects a non-directory or non-private broker temporary root", () => {
    const fixture = brokerFixture();
    const fileRoot = join(fixture.root, "ordinary-file");
    writeFileSync(fileRoot, "not a directory\n", { mode: 0o600 });
    expect(() =>
      createGitCredentialBroker({ ...brokerOptions(fixture), tempRoot: fileRoot }),
    ).toThrow(/owner-only/u);

    chmodSync(fixture.root, 0o755);
    expect(() =>
      createGitCredentialBroker({ ...brokerOptions(fixture), tempRoot: fixture.root }),
    ).toThrow(/owner-only/u);
  });

  it("binds system/global helper configuration without resolving a credential", async () => {
    const fixture = brokerFixture();
    const requests: GitCredentialProcessRequest[] = [];
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      requests.push(request);
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
      runProcess,
    });

    const identity = await broker.inspect(context);

    expect(identity.version).toBe("git-credential-broker/v1");
    expect(identity.helperCount).toBe(1);
    expect(identity.configurationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(identity.helperDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.argv.includes("credential"))).toBe(false);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    expect(requests.at(-1)?.argv).toEqual([
      "config",
      "--null",
      "--includes",
      "--show-origin",
      "--show-scope",
      "--list",
    ]);
  });

  it("rejects non-file Git and non-directory helper executable identities", async () => {
    const directoryFixture = brokerFixture();
    const directoryGitBroker = createGitCredentialBroker({
      ...brokerOptions(directoryFixture),
      gitExecutable: directoryFixture.root,
      runProcess: async (request) => {
        if (request.argv.includes("--exec-path")) return result(`${directoryFixture.root}\n`);
        return result(configOutput(directoryFixture));
      },
    });
    await expect(directoryGitBroker.inspect(context)).rejects.toThrow(GitCredentialBrokerError);

    const fileFixture = brokerFixture();
    const fileExecBroker = createGitCredentialBroker({
      ...brokerOptions(fileFixture),
      runProcess: async (request) => {
        if (request.argv.includes("--exec-path")) {
          return result(`${fileFixture.gitExecutable}\n`);
        }
        return result(configOutput(fileFixture));
      },
    });
    await expect(fileExecBroker.inspect(context)).rejects.toThrow(GitCredentialBrokerError);
  });

  it.each([
    ["relative", "relative/git-core\n"],
    ["embedded newline", "/operator/git\ncore\n"],
    ["oversized", `/${"a".repeat(1_025)}\n`],
  ])("rejects a %s Git helper exec path", async (_label, execPathOutput) => {
    const fixture = brokerFixture();
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
      runProcess: async (request) => {
        if (request.argv.includes("--exec-path")) return result(execPathOutput);
        return result(configOutput(fixture));
      },
    });
    await expect(broker.inspect(context)).rejects.toThrow(GitCredentialBrokerError);
  });

  it("resolves only with credential fill after exact identity revalidation", async () => {
    const fixture = brokerFixture();
    const canaryUser = `user-${randomBytes(8).toString("hex")}`;
    const canarySecret = `token-${randomBytes(24).toString("base64url")}`;
    const requests: GitCredentialProcessRequest[] = [];
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      requests.push(request);
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      if (request.argv.at(-2) === "credential" && request.argv.at(-1) === "fill") {
        return result(exactCredentialOutput(canaryUser, canarySecret));
      }
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
      runProcess,
      env: {
        ...fixture.env,
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
    expect(fill.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(fill.env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(fill.argv.slice(0, 6)).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      expect.stringMatching(/^credential\.helper=!/u),
      "-c",
      "credential.useHttpPath=true",
    ]);
    expect(fill.env).not.toHaveProperty("GIT_DIR");
  });

  it("resolves a GitHub bearer token from only the helper password", async () => {
    const fixture = brokerFixture();
    const canaryUser = `ignored-${randomBytes(8).toString("hex")}`;
    const canarySecret = `github_pat_${randomBytes(24).toString("base64url")}`;
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      if (request.argv.at(-1) === "fill") {
        return result(exactCredentialOutput(canaryUser, canarySecret));
      }
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
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
    const fixture = brokerFixture();
    let inspection = 0;
    const requests: GitCredentialProcessRequest[] = [];
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      requests.push(request);
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      if (request.argv.includes("--list")) {
        inspection += 1;
        return result(
          `${configOutput(fixture)}global\u0000file:${fixture.configPath}\u0000user.review\n${String(inspection)}\u0000`,
        );
      }
      return result("");
    });
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
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
    const fixture = brokerFixture();
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      if (request.argv.at(-1) === "fill") {
        return result("", override);
      }
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
      runProcess,
    });
    const identity = await broker.inspect(context);

    await expect(broker.resolve(context, identity)).rejects.toThrow(GitCredentialBrokerError);
    await expect(broker.resolve(context, identity)).rejects.not.toThrow(
      "helper leaked diagnostics",
    );
  });

  it("enforces the real helper-process timeout independently of Git inspection load", async () => {
    const root = privateRoot();
    const helperPath = join(root, "slow-credential-helper");
    writeFileSync(
      helperPath,
      '#!/bin/sh\nwhile IFS= read -r line; do [ -z "$line" ] && break; done\nsleep 60\n',
      { mode: 0o700 },
    );

    await expect(
      runGitCredentialProcess({
        command: helperPath,
        argv: [],
        cwd: root,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C" },
        stdin: "protocol=https\nhost=github.com\npath=keel-harness/keel.git\n\n",
        timeoutMs: 250,
        maxOutputBytes: 8 * 1024,
      }),
    ).resolves.toMatchObject({
      timedOut: true,
      outputExceeded: false,
    });
  });

  it("aborts a real in-flight helper process and fails closed", async () => {
    const broker = realHelperBroker(
      `while IFS= read -r line; do [ -z "$line" ] && break; done\nsleep 60`,
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
      `while IFS= read -r line; do [ -z "$line" ] && break; done
printf '%s\\n' 'username=u' 'password=${canary}'`,
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
    const fixture = brokerFixture();
    let releaseFill!: () => void;
    const fillBlocked = new Promise<void>((resolve) => {
      releaseFill = resolve;
    });
    let fillStarted!: () => void;
    const fillDidStart = new Promise<void>((resolve) => {
      fillStarted = resolve;
    });
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      if (request.argv.at(-1) === "fill") {
        fillStarted();
        await fillBlocked;
        return result(exactCredentialOutput("u", "p"));
      }
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({
      ...brokerOptions(fixture),
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
    for (const helperOutputFor of ["", "malformed", "over-bound"]) {
      const fixture = brokerFixture();
      const helperOutput =
        helperOutputFor === "malformed"
          ? `global\u0000file:${fixture.configPath}\u0000credential.helper-without-value\u0000`
          : helperOutputFor === "over-bound"
            ? Array.from(
                { length: 9 },
                (_, index) =>
                  `global\u0000file:${fixture.configPath}\u0000credential.helper\nh${String(index)}\u0000`,
              ).join("")
            : "";
      const broker = createGitCredentialBroker({
        ...brokerOptions(fixture),
        runProcess: async (request) => {
          if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
          return result(helperOutput);
        },
      });
      await expect(broker.inspect(context)).rejects.toThrow(GitCredentialBrokerError);
    }
  });

  it("binds resolved helper executable identity and detects binary drift", async () => {
    const fixture = brokerFixture();
    const helperPath = join(fixture.root, "git-credential-osxkeychain");
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({ ...brokerOptions(fixture), runProcess });
    const before = await broker.inspect(context);

    writeFileSync(helperPath, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    const after = await broker.inspect(context);

    expect(after.configurationDigest).toBe(before.configurationDigest);
    expect(after.helperDigest).not.toBe(before.helperDigest);
  });

  it("binds consumed configuration file identity even when Git reports the same records", async () => {
    const fixture = brokerFixture();
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({ ...brokerOptions(fixture), runProcess });
    const before = await broker.inspect(context);

    writeFileSync(
      fixture.configPath,
      "[credential]\n\thelper = osxkeychain\n[user]\n\tname = changed\n",
      { mode: 0o600 },
    );
    const after = await broker.inspect(context);

    expect(after.configurationDigest).toBe(before.configurationDigest);
    expect(after.helperDigest).not.toBe(before.helperDigest);
  });

  it("binds the selected helper parent directory authority", async () => {
    const fixture = brokerFixture();
    const runProcess = vi.fn(async (request: GitCredentialProcessRequest) => {
      if (request.argv.includes("--exec-path")) return result(`${fixture.root}\n`);
      return result(configOutput(fixture));
    });
    const broker = createGitCredentialBroker({ ...brokerOptions(fixture), runProcess });
    const before = await broker.inspect(context);

    chmodSync(fixture.root, 0o500);
    const after = await broker.inspect(context);
    chmodSync(fixture.root, 0o700);

    expect(after.helperDigest).not.toBe(before.helperDigest);
  });
});
