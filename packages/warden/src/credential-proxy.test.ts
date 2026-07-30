import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CredentialProxyConfigError,
  CredentialProxyResolutionError,
  credentialProxyAllowedDomains,
  credentialProxyProtectedFilePaths,
  credentialProxyPublicSummary,
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

    expect(config).toEqual([
      {
        id: "fixture-api",
        mode: "placeholder",
        host: "api.example.com",
        scheme: "Bearer",
        source: { kind: "file", path: "/workspace/.keel/secrets/api-token" },
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
    expect(() =>
      resolveCredentialProxyRules([rule({ host: "127.0.0.1" })], {
        KEEL_FIXTURE_TOKEN: SECRET,
      }),
    ).toThrow(/egress domain|IP-like/i);

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
