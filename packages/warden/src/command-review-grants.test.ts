import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PolicyInputT } from "@keel/shared";
import { grantableCommandReview, onceReviewableWorkspaceDelete } from "./command-review-grants.js";
import type { PolicyDecision } from "./policy.js";
import type { SandboxProfile } from "./sandbox.js";

const CONTEXT = {
  workspaceRoot: "/repo",
  policyPack: { name: "test-policy-pack", hash: `sha256:${"a".repeat(64)}` },
};

const REVIEW_DECISION: PolicyDecision = {
  verdict: "review",
  matchedRules: ["POL-REVIEW-CONTAINED-READ"],
  guidance: "contained read requires review",
};

const CONTAINED_PROFILE: SandboxProfile = {
  filesystem: {
    allowRead: ["/repo"],
    allowWrite: ["/repo"],
    denyRead: [],
    denyWrite: [],
  },
  network: {
    allowedDomains: [],
    deniedDomains: ["*"],
    strictAllowlist: true,
  },
};

interface GrantableOptions {
  readonly command?: string;
  readonly sandboxToolName?: string;
  readonly policyInput?: PolicyInputT;
  readonly decision?: PolicyDecision;
  readonly profile?: SandboxProfile;
  readonly useMissingProfile?: boolean;
  readonly mcp?: unknown;
  readonly lifecycle?: unknown;
  readonly typedTool?: unknown;
}

function commandInput(
  options: {
    readonly family?: string;
    readonly effectKinds?: readonly string[];
    readonly scopes?: readonly string[];
    readonly modifiers?: readonly string[];
    readonly targets?: readonly Record<string, unknown>[];
    readonly includeCommandTarget?: boolean;
  } = {},
): PolicyInputT {
  const family = options.family ?? "cat";
  const targets = [
    ...(options.includeCommandTarget === false
      ? []
      : [{ kind: "command", value: family, normalized: family }]),
    ...(options.targets ?? []),
  ];
  return {
    tool: { name: "bash" },
    sideEffect: {
      dynamic: {
        effectKinds: options.effectKinds ?? ["fs_read"],
        scopes: options.scopes ?? ["workspace"],
        modifiers: options.modifiers ?? [],
        targets,
      },
    },
  } as unknown as PolicyInputT;
}

function grantable(options: GrantableOptions = {}): ReturnType<typeof grantableCommandReview> {
  return grantableCommandReview(
    CONTEXT,
    {
      command: options.command ?? "cat README.md",
      sandboxToolName: options.sandboxToolName ?? "bash",
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
      ...(options.typedTool === undefined ? {} : { typedTool: options.typedTool }),
    },
    options.policyInput ?? commandInput(),
    options.decision ?? REVIEW_DECISION,
    options.useMissingProfile === true ? undefined : (options.profile ?? CONTAINED_PROFILE),
  );
}

function deleteInput(options: {
  readonly argv: readonly string[];
  readonly withinWorkspace?: boolean;
  readonly sensitivity?: "internal" | "secret";
  readonly compositionKind?: "atomic" | "sequence";
  readonly effectKinds?: readonly string[];
}): PolicyInputT {
  const target = {
    kind: "path",
    value: options.argv.at(-1) ?? "note.txt",
    normalized: `/repo/${options.argv.at(-1) ?? "note.txt"}`,
    withinWorkspace: options.withinWorkspace ?? true,
    sensitivity: options.sensitivity ?? "internal",
  };
  const effectKinds = options.effectKinds ?? ["fs_write"];
  const segment = {
    effectKinds,
    scopes: ["workspace"],
    targets: [target],
    modifiers: ["destructive"],
  };
  return {
    tool: { name: "bash", args: { command: options.argv.join(" ") } },
    normalized: { argv: [...options.argv], decodedLayers: [] },
    sideEffect: {
      dynamic: {
        ...segment,
        composition: {
          kind: options.compositionKind ?? "atomic",
          segments: [segment],
          edges:
            options.compositionKind === "sequence" ? [{ from: 0, to: 0, kind: "sequence" }] : [],
        },
      },
    },
  } as unknown as PolicyInputT;
}

function onceDelete(
  options: Parameters<typeof deleteInput>[0] & { readonly command?: string },
  profile = CONTAINED_PROFILE,
) {
  return onceReviewableWorkspaceDelete(
    CONTEXT,
    { command: options.command ?? options.argv.join(" "), sandboxToolName: "bash" },
    deleteInput(options),
    { verdict: "review", matchedRules: ["POL-004"] },
    profile,
  );
}

describe("command review grants", () => {
  it("admits only exact non-recursive workspace deletes to the once-only review path", () => {
    for (const argv of [
      ["rm", "note.txt"],
      ["rm", "-f", "note.txt"],
      ["rm", "-"],
      ["rm", "--", "-literal-name"],
    ]) {
      expect(onceDelete({ argv })?.key, argv.join(" ")).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }

    for (const options of [
      { argv: ["rm", "-r", "dist"] },
      { argv: ["rm", "--recursive", "dist"] },
      { argv: ["rm", "-i", "note.txt"] },
      { argv: ["rm", "note.txt"], withinWorkspace: false },
      { argv: ["rm", "note.txt"], sensitivity: "secret" as const },
      { argv: ["rm", "note.txt"], compositionKind: "sequence" as const },
      { argv: ["rm", "note.txt"], effectKinds: ["fs_write", "process_exec"] },
      { argv: ["rm", "one.txt", "two.txt"] },
      { argv: ["rm", "note.txt"], command: "rm\n./payload" },
      { argv: ["rm", "note.txt"], command: "rm\r\n./payload" },
      { argv: ["rm", "note.txt"], command: 'rm "note.txt"' },
      { argv: ["rm", "note.txt"], command: "rm note\\.txt" },
      { argv: ["rm", "*"], command: "rm *" },
      { argv: ["rm", "$TARGET"], command: "rm $TARGET" },
      { argv: ["rm", "payload?"], command: "rm payload?" },
      { argv: ["rm", "{one,two}"], command: "rm {one,two}" },
      { argv: ["rm", "~/note.txt"], command: "rm ~/note.txt" },
      { argv: ["rm", "safe\u200bname"], command: "rm safe\u200bname" },
      { argv: ["rm", "safe\u2060name"], command: "rm safe\u2060name" },
    ]) {
      expect(onceDelete(options), JSON.stringify(options)).toBeUndefined();
    }
    expect(onceDelete({ argv: ["rm", "note.txt"] }, {})).toBeUndefined();
  });

  it("builds a stable session command grant key for contained command reviews", () => {
    const first = grantable();
    const second = grantable();

    expect(first?.key).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second?.key).toBe(first?.key);
  });

  it("accepts workspace and temp write roots as contained", () => {
    const systemTmpPrivateAlias = tmpdir().startsWith("/var/")
      ? [`/private${join(tmpdir(), "keel")}`]
      : [];
    for (const allowWrite of [
      ["/repo"],
      ["/tmp"],
      ["/private/tmp"],
      [join(tmpdir(), "keel")],
      systemTmpPrivateAlias,
    ]) {
      if (allowWrite.length === 0) continue;
      const result = grantable({
        profile: { ...CONTAINED_PROFILE, filesystem: { allowRead: ["/repo"], allowWrite } },
      });
      expect(result?.key).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("rejects command reviews outside the exact session-command grant envelope", () => {
    const profileWithoutNetwork: SandboxProfile = {
      filesystem: {
        allowRead: ["/repo"],
        allowWrite: ["/repo"],
        denyRead: [],
        denyWrite: [],
      },
    };

    const cases: Array<readonly [string, GrantableOptions]> = [
      ["non-review verdict", { decision: { verdict: "allow", matchedRules: [] } }],
      ["mcp command", { mcp: { serverId: "server" } }],
      ["lifecycle command", { lifecycle: { actionId: "test" } }],
      ["typed tool command", { typedTool: "read" }],
      ["non-bash sandbox tool", { sandboxToolName: "read" }],
      ["missing profile", { useMissingProfile: true }],
      ["network without strict allowlist", { profile: profileWithoutNetwork }],
      [
        "ambient egress",
        {
          profile: {
            ...CONTAINED_PROFILE,
            network: { allowedDomains: ["example.com"], deniedDomains: [], strictAllowlist: true },
          },
        },
      ],
      [
        "missing network deny-all",
        {
          profile: {
            ...CONTAINED_PROFILE,
            network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
          },
        },
      ],
      [
        "broad read root",
        {
          profile: {
            ...CONTAINED_PROFILE,
            filesystem: { allowRead: ["/"], allowWrite: ["/repo"] },
          },
        },
      ],
      [
        "no read roots",
        { profile: { ...CONTAINED_PROFILE, filesystem: { allowWrite: ["/repo"] } } },
      ],
      ["no write roots", { profile: { ...CONTAINED_PROFILE, filesystem: { allowWrite: [] } } }],
      ["explicit egress", { command: "curl https://example.com" }],
      ["unknown effect", { policyInput: commandInput({ effectKinds: ["unknown"] }) }],
      ["process execution", { policyInput: commandInput({ effectKinds: ["process_exec"] }) }],
      ["unknown scope", { policyInput: commandInput({ scopes: ["unknown"] }) }],
      ["unknown modifier", { policyInput: commandInput({ modifiers: ["unknown"] }) }],
      [
        "unsupported shell syntax target",
        {
          policyInput: commandInput({
            effectKinds: ["process_exec", "unknown"],
            scopes: ["process", "unknown"],
            modifiers: ["unknown"],
            targets: [
              {
                kind: "command",
                value: "unsupported-shell-syntax: qemu-img info *.qcow2",
                normalized: "unsupported-shell-syntax: qemu-img info *.qcow2",
              },
            ],
          }),
        },
      ],
      [
        "unsupported shell syntax target with otherwise known effects",
        {
          policyInput: commandInput({
            targets: [
              {
                kind: "command",
                value: "unsupported-shell-syntax: qemu-img info *.qcow2",
                normalized: "unsupported-shell-syntax: qemu-img info *.qcow2",
              },
            ],
          }),
        },
      ],
      [
        "opaque runtime",
        {
          command: "python3 script.py",
          policyInput: commandInput({ family: "python3", effectKinds: ["unknown"] }),
        },
      ],
      ["network effect", { policyInput: commandInput({ effectKinds: ["network_read"] }) }],
      ["external scope", { policyInput: commandInput({ scopes: ["external_service"] }) }],
      ["home scope", { policyInput: commandInput({ scopes: ["home"] }) }],
      ["system scope", { policyInput: commandInput({ scopes: ["system"] }) }],
      ["destructive modifier", { policyInput: commandInput({ modifiers: ["destructive"] }) }],
      ["irreversible modifier", { policyInput: commandInput({ modifiers: ["irreversible"] }) }],
      ["persistent modifier", { policyInput: commandInput({ modifiers: ["persistent"] }) }],
      [
        "host target",
        { policyInput: commandInput({ targets: [{ kind: "host", value: "example.com" }] }) },
      ],
      [
        "url target",
        { policyInput: commandInput({ targets: [{ kind: "url", value: "https://example.com" }] }) },
      ],
      [
        "env target",
        { policyInput: commandInput({ targets: [{ kind: "env_var", value: "API_KEY" }] }) },
      ],
      [
        "unknown target",
        { policyInput: commandInput({ targets: [{ kind: "unknown", value: "future-target" }] }) },
      ],
      [
        "secret target",
        {
          policyInput: commandInput({
            targets: [
              { kind: "path", value: ".env", withinWorkspace: true, sensitivity: "secret" },
            ],
          }),
        },
      ],
      [
        "unknown sensitivity target",
        {
          policyInput: commandInput({
            targets: [
              { kind: "path", value: "mystery.txt", withinWorkspace: true, sensitivity: "unknown" },
            ],
          }),
        },
      ],
      [
        "outside path target",
        {
          policyInput: commandInput({
            targets: [
              {
                kind: "path",
                value: "/opt/data.img",
                normalized: "/opt/data.img",
                withinWorkspace: false,
              },
            ],
          }),
        },
      ],
    ];

    for (const [label, options] of cases) {
      expect(grantable(options), label).toBeUndefined();
    }
  });

  it("keeps command-family and target serialization deterministic for sparse inputs", () => {
    const result = grantable({
      policyInput: commandInput({
        includeCommandTarget: false,
        effectKinds: ["fs_read"],
        targets: [
          { kind: "path", value: "b.txt", normalized: "/repo/b.txt", withinWorkspace: true },
          { kind: "path", value: "a.txt", normalized: "/repo/a.txt", withinWorkspace: true },
        ],
      }),
    });

    expect(result?.key).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
