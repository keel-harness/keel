import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});

describe("ADR-0091 Warden Git credential broker", () => {
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

    await expect(broker.resolve(context, identity)).rejects.toThrow(/already in progress/u);
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
