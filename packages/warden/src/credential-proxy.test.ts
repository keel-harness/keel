import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PROXY_CONFIG_ENV,
  CREDENTIAL_PROXY_PROJECT_CONFIG_ENV,
  CredentialProxyConfigError,
  CredentialProxyResolutionError,
  credentialProxyAllowedDomains,
  credentialProxyProtectedFilePaths,
  credentialProxyPublicSummary,
  credentialProxyRulesFromEnvValues,
  parseCredentialProxyConfig,
  resolveCredentialProxyRules,
  type CredentialProxyRule,
} from "./credential-proxy.js";

const SECRET = "keel-real-token-sec027-abcdef123456";

function rule(overrides: Partial<CredentialProxyRule> = {}): CredentialProxyRule {
  return {
    id: "fixture-api",
    mode: "swap_on_access",
    host: "API.Example.COM",
    scheme: "Bearer",
    source: { kind: "env", name: "KEEL_FIXTURE_TOKEN" },
    allowPlaintextInject: true,
    ...overrides,
  };
}

describe("credential proxy rules", () => {
  it("resolves the real secret parent-side while public summaries and host grants stay secret-free", () => {
    const rules = [rule()];
    const resolved = resolveCredentialProxyRules(rules, { KEEL_FIXTURE_TOKEN: SECRET });

    expect(resolved).toEqual({
      authorizationHeaders: [
        {
          host: "api.example.com",
          scheme: "Bearer",
          secret: SECRET,
        },
      ],
      allowPlaintextInject: true,
    });
    expect(credentialProxyAllowedDomains(rules)).toEqual(["api.example.com"]);

    const publicSurfaces = JSON.stringify({
      summary: credentialProxyPublicSummary(rules),
      allowedDomains: credentialProxyAllowedDomains(rules),
    });
    expect(publicSurfaces).not.toContain(SECRET);
  });

  it("resolves file sources parent-side and protects the source file from sandbox reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-credential-proxy-file-"));
    const secretPath = join(dir, "api-token");
    writeFileSync(secretPath, `${SECRET}\n`, { mode: 0o600 });
    const rules = [
      rule({
        source: { kind: "file", path: secretPath },
      }),
    ];

    const resolved = resolveCredentialProxyRules(rules, {}, {});

    expect(resolved).toMatchObject({
      authorizationHeaders: [
        {
          host: "api.example.com",
          scheme: "Bearer",
          secret: SECRET,
        },
      ],
    });
    expect(credentialProxyProtectedFilePaths(rules, { workspaceRoot: dir })).toEqual([secretPath]);
    expect(JSON.stringify(credentialProxyPublicSummary(rules))).not.toContain(SECRET);
    expect(JSON.stringify(credentialProxyPublicSummary(rules))).not.toContain(secretPath);
  });

  it("resolves command sources with an argv-only command runner and fails closed on command errors", () => {
    const rules = [
      rule({
        source: {
          kind: "command",
          command: "/usr/bin/security",
          args: ["find-generic-password", "-w", "-s", "keel-fixture"],
        },
      }),
    ];
    const resolved = resolveCredentialProxyRules(
      rules,
      {},
      {
        runCommand: (command, args) => {
          expect(command).toBe("/usr/bin/security");
          expect(args).toEqual(["find-generic-password", "-w", "-s", "keel-fixture"]);
          return { status: 0, stdout: `${SECRET}\n`, stderr: "" };
        },
      },
    );

    expect(resolved?.authorizationHeaders?.[0]?.secret).toBe(SECRET);
    expect(() =>
      resolveCredentialProxyRules(
        rules,
        {},
        {
          runCommand: () => ({ status: 1, stdout: "", stderr: "denied" }),
        },
      ),
    ).toThrow(CredentialProxyResolutionError);
    expect(JSON.stringify(credentialProxyPublicSummary(rules))).not.toContain("keel-fixture");
  });

  it("resolves command sources through the default argv-only command runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-cred-proxy-command-"));
    const secretPath = join(dir, "api-token");
    writeFileSync(secretPath, `${SECRET}\n`, "utf8");

    const resolved = resolveCredentialProxyRules([
      rule({
        source: {
          kind: "command",
          command: "/bin/cat",
          args: [secretPath],
        },
      }),
    ]);

    expect(resolved?.authorizationHeaders?.[0]?.secret).toBe(SECRET);
  });

  it("supports placeholder mode without placing the resolved secret in sandbox-visible env", () => {
    const rules = [
      rule({
        mode: "placeholder",
        source: { kind: "env", name: "KEEL_FIXTURE_TOKEN" },
        placeholderEnv: "KEEL_FIXTURE_AUTH",
      }),
    ];

    const resolved = resolveCredentialProxyRules(
      rules,
      { KEEL_FIXTURE_TOKEN: SECRET },
      {
        placeholderFactory: () => "keelcred_test_placeholder",
      },
    );

    expect(resolved).toEqual({
      authorizationPlaceholders: [
        {
          host: "api.example.com",
          scheme: "Bearer",
          placeholder: "keelcred_test_placeholder",
          secret: SECRET,
        },
      ],
      sandboxEnv: { KEEL_FIXTURE_AUTH: "keelcred_test_placeholder" },
      allowPlaintextInject: true,
    });
    expect(JSON.stringify(resolved?.sandboxEnv)).not.toContain(SECRET);
  });

  it("parses the product config format without resolving or serializing secrets", () => {
    const config = parseCredentialProxyConfig(
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "fixture-api",
            mode: "placeholder",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "file", path: ".keel/secrets/api-token" },
            placeholderEnv: "KEEL_FIXTURE_AUTH",
            allowPlaintextInject: false,
          },
          {
            id: "command-api",
            mode: "swap_on_access",
            host: "command.example.com",
            scheme: "Bearer",
            source: { kind: "command", command: "/usr/bin/security", args: ["find", "token"] },
          },
        ],
      }),
      { workspaceRoot: "/workspace", env: { HOME: "/home/alice" } },
    );

    // `provenance` is derived from the env channel, defaulting to `operator` when the caller does
    // not opt into the restricted project parse. It gates whether the rule's host may widen the
    // sandbox egress allowlist, so it is part of the parsed shape.
    expect(config).toEqual([
      {
        id: "fixture-api",
        mode: "placeholder",
        host: "api.example.com",
        scheme: "Bearer",
        source: { kind: "file", path: "/workspace/.keel/secrets/api-token" },
        placeholderEnv: "KEEL_FIXTURE_AUTH",
        allowPlaintextInject: false,
        provenance: "operator",
      },
      {
        id: "command-api",
        mode: "swap_on_access",
        host: "command.example.com",
        scheme: "Bearer",
        provenance: "operator",
        source: { kind: "command", command: "/usr/bin/security", args: ["find", "token"] },
      },
    ]);
  });

  it("rejects malformed product config and unsafe source declarations fail-closed", () => {
    const parse = (value: unknown, env: NodeJS.ProcessEnv = {}) =>
      parseCredentialProxyConfig(typeof value === "string" ? value : JSON.stringify(value), {
        workspaceRoot: "/workspace",
        env,
      });

    expect(() => parse("{")).toThrow(CredentialProxyConfigError);
    expect(() => parse([])).toThrow(CredentialProxyConfigError);
    expect(() => parse({ version: 1, rules: [], extra: true })).toThrow(CredentialProxyConfigError);
    expect(() => parse({ version: 2, rules: [] })).toThrow(CredentialProxyConfigError);
    // ADR-0072 §4 (P1-12): a higher/unrecognized version reads as an honest "newer keel; upgrade",
    // not a bare "must be 1".
    expect(() => parse({ version: 2, rules: [] })).toThrow(/newer keel/i);
    expect(() => parse({ version: 1, rules: {} })).toThrow(CredentialProxyConfigError);
    expect(() => parse({ version: 1, rules: [{ id: "x" }] })).toThrow(CredentialProxyConfigError);
    expect(() =>
      parse({
        version: 1,
        rules: [
          {
            id: "x",
            mode: "unsupported",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "env", name: "KEEL_TOKEN" },
          },
        ],
      }),
    ).toThrow(CredentialProxyConfigError);
    expect(() =>
      parse({
        version: 1,
        rules: [
          {
            id: "x",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "env", name: "1BAD" },
          },
        ],
      }),
    ).toThrow(/env source/i);
    expect(() =>
      parse(
        {
          version: 1,
          rules: [
            {
              id: "x",
              mode: "swap_on_access",
              host: "api.example.com",
              scheme: "Bearer",
              source: { kind: "file", path: "~/.token" },
            },
          ],
        },
        { HOME: "" },
      ),
    ).toThrow(/HOME is unset/);
    expect(() =>
      parse(
        {
          version: 1,
          rules: [
            {
              id: "x",
              mode: "swap_on_access",
              host: "api.example.com",
              scheme: "Bearer",
              source: { kind: "file", path: "~/.token" },
            },
          ],
        },
        { HOME: "/home/alice" },
      ),
    ).not.toThrow();
    expect(() =>
      parse({
        version: 1,
        rules: [
          {
            id: "x",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "command", command: "security" },
          },
        ],
      }),
    ).toThrow(/absolute command path/);
    expect(() =>
      parse({
        version: 1,
        rules: [
          {
            id: "x",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "command", command: "/usr/bin/security", args: "--bad" },
          },
        ],
      }),
    ).toThrow(/args must be an array/);
    expect(() =>
      parse({
        version: 1,
        rules: [
          {
            id: "x",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "command", command: "/usr/bin/security", args: [1] },
          },
        ],
      }),
    ).toThrow(/args must be strings/);
    expect(() =>
      parse({
        version: 1,
        rules: [
          {
            id: "x",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "nope" },
          },
        ],
      }),
    ).toThrow(/source kind/);
  });

  it("fails closed on invalid direct rules, empty sources, duplicate placeholders, and bad placeholders", () => {
    expect(resolveCredentialProxyRules()).toBeUndefined();
    expect(credentialProxyAllowedDomains([rule(), rule({ id: "same-host" })])).toEqual([
      "api.example.com",
    ]);
    expect(() => credentialProxyPublicSummary([rule({ mode: "placeholder" })])).toThrow(
      CredentialProxyResolutionError,
    );
    expect(() =>
      credentialProxyPublicSummary([rule({ source: { kind: "file", path: "" } })]),
    ).toThrow(CredentialProxyResolutionError);
    expect(() =>
      credentialProxyPublicSummary([
        rule({
          source: { kind: "command", command: "security" },
        }),
      ]),
    ).toThrow(CredentialProxyResolutionError);

    expect(() =>
      resolveCredentialProxyRules(
        [
          rule({
            source: { kind: "file", path: "/missing" },
          }),
        ],
        {},
        { readFile: () => undefined },
      ),
    ).toThrow(/file source is unavailable/);
    expect(() =>
      resolveCredentialProxyRules(
        [
          rule({
            source: { kind: "file", path: "/empty" },
          }),
        ],
        {},
        { readFile: () => "\n" },
      ),
    ).toThrow(/empty value/);
    expect(() =>
      resolveCredentialProxyRules([
        rule({
          source: { kind: "command", command: "/definitely/not/a/real/command" },
        }),
      ]),
    ).toThrow(/command source failed/);
    expect(() =>
      resolveCredentialProxyRules(
        [
          rule({
            mode: "placeholder",
            placeholderEnv: "KEEL_SHARED",
          }),
        ],
        { KEEL_FIXTURE_TOKEN: SECRET },
        { placeholderFactory: () => "not-a-keel-placeholder" },
      ),
    ).toThrow(/invalid placeholder/);
    expect(() =>
      resolveCredentialProxyRules(
        [
          rule({
            id: "one",
            mode: "placeholder",
            placeholderEnv: "KEEL_SHARED",
          }),
          rule({
            id: "two",
            host: "other.example.com",
            mode: "placeholder",
            placeholderEnv: "KEEL_SHARED",
          }),
        ],
        { KEEL_FIXTURE_TOKEN: SECRET },
        {
          placeholderFactory: (summary) => (summary.id === "one" ? "keelcred_one" : "keelcred_two"),
        },
      ),
    ).toThrow(/configured more than once/);
  });

  it("normalizes protected file source paths without leaking or duplicating them", () => {
    expect(
      credentialProxyProtectedFilePaths(
        [
          rule({ source: { kind: "file", path: "secrets/token" } }),
          rule({ id: "dupe", source: { kind: "file", path: "/workspace/secrets/token" } }),
          rule({ id: "env-source" }),
        ],
        { workspaceRoot: "/workspace" },
      ),
    ).toEqual(["/workspace/secrets/token"]);
  });

  it("fails closed when an env source cannot resolve", () => {
    expect(() => resolveCredentialProxyRules([rule()], {})).toThrow(CredentialProxyResolutionError);
  });

  it("rejects invalid hosts and authorization schemes before any sandbox execution", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "api.localhost",
      "Bücher.Localhost",
      "127.0.0.1",
      "[::ffff:127.0.0.1]",
    ]) {
      const rules = [rule({ host })];
      expect(() => credentialProxyPublicSummary(rules), host).toThrow(
        /egress domain|IP-like|localhost|invalid/i,
      );
      expect(() => credentialProxyAllowedDomains(rules), host).toThrow(
        /egress domain|IP-like|localhost|invalid/i,
      );
      expect(
        () => resolveCredentialProxyRules(rules, { KEEL_FIXTURE_TOKEN: SECRET }),
        host,
      ).toThrow(/egress domain|IP-like|localhost|invalid/i);
    }

    expect(() =>
      resolveCredentialProxyRules([rule({ scheme: "Bearer injected" })], {
        KEEL_FIXTURE_TOKEN: SECRET,
      }),
    ).toThrow(/authorization scheme/i);
  });

  it("never serializes resolved secret values into credential-proxy public summaries", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{8,32}$/).map((value) => `sk-test-${value}!`),
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/),
        fc.domain(),
        (secret, envName, domain) => {
          const mode = "swap_on_access";
          const rules = [
            rule({
              mode,
              host: domain,
              source: { kind: "env", name: envName },
            }),
          ];
          const resolved = resolveCredentialProxyRules(rules, { [envName]: secret });
          expect(JSON.stringify(resolved)).toContain(secret);

          const publicSurfaces = JSON.stringify({
            summary: credentialProxyPublicSummary(rules),
            allowedDomains: credentialProxyAllowedDomains(rules),
          });
          expect(publicSurfaces).not.toContain(secret);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects rules that mix allowPlaintextInject true/false at resolve (fail-closed, no silent OR-collapse)", () => {
    const rules = [
      rule({ id: "allow", host: "allow.example.com", allowPlaintextInject: true }),
      rule({ id: "deny", host: "deny.example.com", allowPlaintextInject: false }),
    ];
    // The flag applies to the whole sandbox credential config, so a mixed config would silently
    // plaintext-inject the second rule's secret despite its own rule forbidding it.
    expect(() => resolveCredentialProxyRules(rules, { KEEL_FIXTURE_TOKEN: SECRET })).toThrow(
      CredentialProxyConfigError,
    );
  });

  it("rejects a config whose rules mix allowPlaintextInject at parse (fail-closed at load)", () => {
    const json = JSON.stringify({
      version: 1,
      rules: [
        {
          id: "allow",
          mode: "placeholder",
          host: "allow.example.com",
          scheme: "Bearer",
          source: { kind: "env", name: "ALLOW_TOKEN" },
          placeholderEnv: "ALLOW_ENV",
          allowPlaintextInject: true,
        },
        {
          id: "deny",
          mode: "placeholder",
          host: "deny.example.com",
          scheme: "Bearer",
          source: { kind: "env", name: "DENY_TOKEN" },
          placeholderEnv: "DENY_ENV",
          allowPlaintextInject: false,
        },
      ],
    });
    expect(() =>
      parseCredentialProxyConfig(json, {
        workspaceRoot: "/workspace",
        env: { HOME: "/home/alice" },
      }),
    ).toThrow(CredentialProxyConfigError);
  });

  it("treats an omitted allowPlaintextInject as false, so omitted + explicit-false is not mixed", () => {
    const rules: CredentialProxyRule[] = [
      {
        id: "explicit-false",
        mode: "swap_on_access",
        host: "a.example.com",
        scheme: "Bearer",
        source: { kind: "env", name: "KEEL_FIXTURE_TOKEN" },
        allowPlaintextInject: false,
      },
      {
        id: "omitted",
        mode: "swap_on_access",
        host: "b.example.com",
        scheme: "Bearer",
        source: { kind: "env", name: "KEEL_FIXTURE_TOKEN" },
      },
    ];
    const resolved = resolveCredentialProxyRules(rules, { KEEL_FIXTURE_TOKEN: SECRET });
    expect(resolved?.allowPlaintextInject).toBe(false);
  });
});

// SEC-011 / SECURITY: `.keel/credential-proxy.json` is authored by the model's governed tools inside a
// trusted workspace, so a project-provenance config must not be able to run code or read files the
// sandbox cannot. Operator (env) provenance keeps ADR-0066's full source power; project provenance is
// restricted to a workspace-contained `file` source. Default provenance is operator, so every existing
// test above is unchanged.
describe("credential proxy project-provenance restrictions", () => {
  const parseProject = (rules: unknown[], env: NodeJS.ProcessEnv = { HOME: "/home/victim" }) =>
    parseCredentialProxyConfig(JSON.stringify({ version: 1, rules }), {
      workspaceRoot: "/workspace",
      env,
      provenance: "project",
    });
  const projectRule = (source: unknown) => ({
    id: "r",
    mode: "swap_on_access",
    host: "attacker.example",
    scheme: "Bearer",
    source,
  });

  it("rejects allowPlaintextInject (ADR-0066 §9: a fixture lever, not the product posture)", () => {
    // `allowPlaintextInject` is the ONLY path by which a resolved secret reaches the wire: keel
    // never sets `tlsTerminate`, so HTTPS goes down an opaque CONNECT tunnel with no header
    // injection. Letting a repo-authored config set it is what turns a pre-committed
    // `.keel/credential-proxy.json` naming `.env` into real exfiltration over plain HTTP.
    expect(() =>
      parseProject([
        { ...projectRule({ kind: "file", path: "secrets/token" }), allowPlaintextInject: true },
      ]),
    ).toThrow(CredentialProxyConfigError);
  });

  it("keeps a project rule's host out of the sandbox egress allowlist", () => {
    // Operator config may widen egress implicitly (ADR-0066 §4) — it is set by whoever launches the
    // warden. A repo-authored rule must not: silently allowlisting an attacker-chosen host defeats
    // "egress is deny-all until a human grants a domain" with no prompt and no audited grant.
    const rules = parseProject([projectRule({ kind: "file", path: "secrets/token" })]);
    expect(credentialProxyAllowedDomains(rules)).toEqual([]);
  });

  it("still folds an operator rule's host into the egress allowlist", () => {
    const rules = parseCredentialProxyConfig(
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "r",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "env", name: "API_TOKEN" },
          },
        ],
      }),
      { workspaceRoot: "/workspace", env: { HOME: "/home/victim" }, provenance: "operator" },
    );
    expect(credentialProxyAllowedDomains(rules)).toEqual(["api.example.com"]);
  });

  it("derives provenance and refuses a config that declares its own", () => {
    // Provenance must come from the CHANNEL the bytes arrived on, never from the bytes. If a
    // project config could declare `provenance: "operator"` it would re-open every restriction.
    expect(() =>
      parseProject([
        { ...projectRule({ kind: "file", path: "secrets/token" }), provenance: "operator" },
      ]),
    ).toThrow(CredentialProxyConfigError);
  });

  it("rejects a command source (no arbitrary code execution in the warden)", () => {
    expect(() =>
      parseProject([projectRule({ kind: "command", command: "/bin/sh", args: ["-c", "id"] })]),
    ).toThrow(CredentialProxyConfigError);
  });

  it("rejects an env source (no reading warden-side secrets the model cannot see)", () => {
    expect(() =>
      parseProject([projectRule({ kind: "env", name: "AWS_SECRET_ACCESS_KEY" })]),
    ).toThrow(CredentialProxyConfigError);
  });

  it("rejects a file source that uses ~ expansion (no reading ~/.ssh/id_rsa)", () => {
    expect(() => parseProject([projectRule({ kind: "file", path: "~/.ssh/id_rsa" })])).toThrow(
      CredentialProxyConfigError,
    );
  });

  it("rejects a file source with an absolute path outside the workspace", () => {
    expect(() => parseProject([projectRule({ kind: "file", path: "/etc/passwd" })])).toThrow(
      CredentialProxyConfigError,
    );
  });

  it("rejects a file source that escapes the workspace with ..", () => {
    expect(() =>
      parseProject([projectRule({ kind: "file", path: "../../../etc/passwd" })]),
    ).toThrow(CredentialProxyConfigError);
  });

  it("accepts a file source contained in the workspace", () => {
    const config = parseProject([projectRule({ kind: "file", path: ".keel/secrets/token" })]);
    expect(config[0]!.source).toEqual({
      kind: "file",
      path: "/workspace/.keel/secrets/token",
      workspaceConfinement: "/workspace",
    });
  });

  it("rejects a file source that resolves through an in-workspace symlink pointing outside", () => {
    const ws = mkdtempSync(join(tmpdir(), "keel-credproxy-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "keel-credproxy-outside-"));
    writeFileSync(join(outside, "id_rsa"), "SECRET");
    // A symlink inside the workspace whose target is outside it — the exact pre-planted-repo vector.
    symlinkSync(join(outside, "id_rsa"), join(ws, "link"));
    expect(() =>
      parseCredentialProxyConfig(
        JSON.stringify({ version: 1, rules: [projectRule({ kind: "file", path: "link" })] }),
        { workspaceRoot: ws, env: { HOME: "/home/victim" }, provenance: "project" },
      ),
    ).toThrow(CredentialProxyConfigError);
  });

  it("accepts a real (non-symlinked) workspace file for project provenance", () => {
    const ws = mkdtempSync(join(tmpdir(), "keel-credproxy-real-"));
    mkdirSync(join(ws, ".keel", "secrets"), { recursive: true });
    writeFileSync(join(ws, ".keel", "secrets", "token"), "SECRET");
    const config = parseCredentialProxyConfig(
      JSON.stringify({
        version: 1,
        rules: [projectRule({ kind: "file", path: ".keel/secrets/token" })],
      }),
      { workspaceRoot: ws, env: { HOME: "/home/victim" }, provenance: "project" },
    );
    // The pinned path is realpath-normalized (physical), so it reads the real target directly.
    expect((config[0]!.source as { path: string }).path).toBe(
      realpathSync(join(ws, ".keel", "secrets", "token")),
    );
  });

  it("rejects a project file source that becomes an out-of-workspace symlink AFTER parse (TOCTOU)", () => {
    const ws = mkdtempSync(join(tmpdir(), "keel-credproxy-toctou-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "keel-credproxy-toctou-out-"));
    writeFileSync(join(outside, "id_rsa"), "SUPER-SECRET-WARDEN-KEY");
    // Parse the config while the bait path does NOT exist yet — it passes containment and is pinned.
    const rules = parseCredentialProxyConfig(
      JSON.stringify({ version: 1, rules: [projectRule({ kind: "file", path: "bait" })] }),
      { workspaceRoot: ws, env: { HOME: "/home/victim" }, provenance: "project" },
    );
    // AFTER parse, plant a symlink at the pinned path pointing outside the workspace.
    symlinkSync(join(outside, "id_rsa"), join(ws, "bait"));
    // The read-time resolution must NOT follow the symlink out of the workspace.
    expect(() => resolveCredentialProxyRules(rules, {})).toThrow(CredentialProxyResolutionError);
  });

  it("resolves a legitimate in-workspace project file source at read time", () => {
    const ws = mkdtempSync(join(tmpdir(), "keel-credproxy-ok-"));
    mkdirSync(join(ws, ".keel", "secrets"), { recursive: true });
    writeFileSync(join(ws, ".keel", "secrets", "token"), "WS-CONTAINED-SECRET\n");
    const rules = parseCredentialProxyConfig(
      JSON.stringify({
        version: 1,
        rules: [projectRule({ kind: "file", path: ".keel/secrets/token" })],
      }),
      { workspaceRoot: ws, env: { HOME: "/home/victim" }, provenance: "project" },
    );
    const resolved = resolveCredentialProxyRules(rules, {});
    expect(resolved?.authorizationHeaders?.[0]?.secret).toBe("WS-CONTAINED-SECRET");
  });

  it("fails closed when a project file source does not exist at read time", () => {
    const ws = mkdtempSync(join(tmpdir(), "keel-credproxy-missing-"));
    const rules = parseCredentialProxyConfig(
      JSON.stringify({ version: 1, rules: [projectRule({ kind: "file", path: "absent" })] }),
      { workspaceRoot: ws, env: { HOME: "/home/victim" }, provenance: "project" },
    );
    expect(() => resolveCredentialProxyRules(rules, {})).toThrow(CredentialProxyResolutionError);
  });

  it("keeps operator provenance (default) able to use command sources — ADR-0066 unchanged", () => {
    const config = parseCredentialProxyConfig(
      JSON.stringify({
        version: 1,
        rules: [projectRule({ kind: "command", command: "/usr/bin/security", args: ["find"] })],
      }),
      { workspaceRoot: "/workspace", env: { HOME: "/home/op" } },
    );
    expect(config[0]!.source).toEqual({
      kind: "command",
      command: "/usr/bin/security",
      args: ["find"],
    });
  });
});

// The warden entrypoint selects a config source (operator env var vs project env var) and the
// provenance to parse it under. That selection is the pure security-critical decision; bin.ts is a
// thin wrapper over it.
describe("credentialProxyRulesFromEnvValues (provenance selection)", () => {
  const commandCfg = JSON.stringify({
    version: 1,
    rules: [
      {
        id: "r",
        mode: "swap_on_access",
        host: "h.example",
        scheme: "Bearer",
        source: { kind: "command", command: "/bin/sh", args: ["-c", "id"] },
      },
    ],
  });
  const fileCfg = JSON.stringify({
    version: 1,
    rules: [
      {
        id: "r",
        mode: "swap_on_access",
        host: "h.example",
        scheme: "Bearer",
        source: { kind: "file", path: ".keel/t" },
      },
    ],
  });

  it("returns undefined when neither env var is set", () => {
    expect(
      credentialProxyRulesFromEnvValues({ workspaceRoot: "/workspace", env: {} }),
    ).toBeUndefined();
  });

  it("parses the operator var under operator provenance (command source allowed)", () => {
    const rules = credentialProxyRulesFromEnvValues({
      workspaceRoot: "/workspace",
      env: { [CREDENTIAL_PROXY_CONFIG_ENV]: commandCfg },
    });
    expect(rules?.[0]!.source.kind).toBe("command");
  });

  it("parses the project var under project provenance — a command source is rejected", () => {
    expect(() =>
      credentialProxyRulesFromEnvValues({
        workspaceRoot: "/workspace",
        env: { [CREDENTIAL_PROXY_PROJECT_CONFIG_ENV]: commandCfg },
      }),
    ).toThrow(CredentialProxyConfigError);
  });

  it("parses a workspace file source from the project var", () => {
    const rules = credentialProxyRulesFromEnvValues({
      workspaceRoot: "/workspace",
      env: { [CREDENTIAL_PROXY_PROJECT_CONFIG_ENV]: fileCfg },
    });
    expect(rules?.[0]!.source).toEqual({
      kind: "file",
      path: "/workspace/.keel/t",
      workspaceConfinement: "/workspace",
    });
  });

  it("lets the operator var win when both are set (operator provenance)", () => {
    const rules = credentialProxyRulesFromEnvValues({
      workspaceRoot: "/workspace",
      env: {
        [CREDENTIAL_PROXY_CONFIG_ENV]: commandCfg,
        [CREDENTIAL_PROXY_PROJECT_CONFIG_ENV]: fileCfg,
      },
    });
    expect(rules?.[0]!.source.kind).toBe("command");
  });
});
