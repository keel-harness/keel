import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PolicyInputT, WARDEN_METHODS } from "@keel/shared";
import {
  DEFAULT_CAPABILITY_MANIFEST,
  buildSandboxProfileFromCapabilityManifest,
} from "./capability-manifest.js";
import {
  createDefaultPolicyPort,
  registeredBuiltinStarterPolicyIdentityMatchesPack,
  sandboxProofIsContained,
  type PolicyDecision,
  type SandboxContainmentProof,
} from "./policy.js";
import { createActiveWardenPolicy } from "./mcp/policy.js";
import {
  PROCESS_RUN_REVIEW_MAX_SUMMARY_BYTES,
  PROCESS_RUN_REVIEW_TTL_MS,
  createProcessRunReviewApprovalBinding,
  createProcessRunReviewPolicyOccurrence,
  createProcessRunReviewRequestBinding,
  isProcessRunReviewApprovalBinding,
  processRunReviewDecisionIsExact,
  processRunReviewEffectIsExact,
  processRunReviewEligibility,
  processRunReviewSummary,
  type ProcessRunReviewEligibilityOptions,
  type ProcessRunReviewPolicyOccurrence,
} from "./process-run-review.js";
import { renderProcessRunArgv } from "./process-run.js";

type ExecuteParams = ReturnType<(typeof WARDEN_METHODS)["warden.execute"]["params"]["parse"]>;

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENV = { HOME: "/home/alice", USER: "alice", KEEL_HOME: "/keel-home" } as const;
const HOME_CREDENTIAL_ROOTS = [
  "/home/alice/.ssh",
  "/home/alice/.aws",
  "/home/alice/.gnupg",
  "/home/alice/.netrc",
  "/home/alice/.npmrc",
  "/home/alice/.git-credentials",
  "/home/alice/.pypirc",
  "/home/alice/.dockercfg",
  "/home/alice/.docker",
  "/home/alice/.kube",
  "/home/alice/.config/gh",
  "/home/alice/.config/gcloud",
] as const;

function processParams(argv: readonly string[]): ExecuteParams {
  return {
    sessionId: SESSION_ID,
    toolCall: { id: "tc_process_review", name: "process.run", args: { argv: [...argv] } },
    provenanceContext: { inputTags: ["workspace"] },
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function containedSandboxProof(): SandboxContainmentProof {
  return {
    status: { available: true, backend: "fake-sandbox", enforcementTier: "sandbox:fake" },
    requiredDenyReadRoots: ["/repo/subdir/.env"],
    workspaceSecretDenyReadComplete: true,
    requiredDenyWriteRoots: ["/keel-home/audit"],
    profile: {
      filesystem: {
        allowRead: ["/repo", "/tmp/keel-task"],
        allowWrite: ["/repo", "/tmp/keel-task"],
        denyRead: [
          "/home/alice/.ssh",
          "/home/alice/.aws",
          "/home/alice/.gnupg",
          "/home/alice/.netrc",
          "/home/alice/.npmrc",
          "/home/alice/.git-credentials",
          "/home/alice/.pypirc",
          "/home/alice/.dockercfg",
          "/home/alice/.docker",
          "/home/alice/.kube",
          "/home/alice/.config/gh",
          "/home/alice/.config/gcloud",
          "/keel-home",
          "/keel-home/audit",
          "/keel-home/policy",
          "/repo/.env",
          "/repo/.env.local",
          "/repo/.env.development",
          "/repo/.env.production",
          "/repo/.env.test",
          "/repo/subdir/.env",
        ],
        denyWrite: ["/keel-home", "/keel-home/audit", "/keel-home/policy"],
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
    },
  };
}

function containmentFor(workspaceRoot: string, homeRoot: string, tempRoot = "/tmp/keel-task") {
  const base = containedSandboxProof();
  const replaceRoot = (path: string) =>
    path.replace(/^\/repo(?=\/|$)/u, workspaceRoot).replace(/^\/home\/alice(?=\/|$)/u, homeRoot);
  return {
    ...base,
    requiredDenyReadRoots: (base.requiredDenyReadRoots ?? []).map(replaceRoot),
    profile: {
      ...base.profile,
      filesystem: {
        allowRead: [workspaceRoot, tempRoot],
        allowWrite: [workspaceRoot, tempRoot],
        denyRead: (base.profile.filesystem?.denyRead ?? []).map(replaceRoot),
        denyWrite: (base.profile.filesystem?.denyWrite ?? []).map(replaceRoot),
      },
    },
  } satisfies SandboxContainmentProof;
}

async function eligibleFixture(argv: readonly string[] = ["pnpm", "test"]) {
  const policy = await createDefaultPolicyPort();
  const activePolicy = createActiveWardenPolicy(policy);
  const executeParams = processParams(argv);
  const sandboxContainment = containedSandboxProof();
  const policyOccurrence = await createProcessRunReviewPolicyOccurrence({
    activePolicy,
    workspaceRoot: "/repo",
    workspaceRealpath: (path) => path,
    env: ENV,
    declaredTempRoots: ["/tmp/keel-task"],
    workspaceTrusted: true,
    executeParams,
    argv,
    sandboxContainment,
  });
  if (policyOccurrence === undefined) throw new Error("process review occurrence was not minted");
  const options: ProcessRunReviewEligibilityOptions = {
    processRunCapabilityAvailable: true,
    durableAuditAvailable: true,
    policyOccurrence,
    policySandboxMismatch: false,
    mutationGeneration: { generation: 7, poisoned: false },
  };
  return { policy, activePolicy, options };
}

async function remintOccurrence(
  activePolicy: ReturnType<typeof createActiveWardenPolicy>,
  base: ProcessRunReviewPolicyOccurrence,
  overrides: Partial<
    Pick<
      ProcessRunReviewPolicyOccurrence,
      | "workspaceRoot"
      | "env"
      | "declaredTempRoots"
      | "workspaceTrusted"
      | "executeParams"
      | "argv"
      | "sandboxContainment"
    >
  > = {},
): Promise<ProcessRunReviewPolicyOccurrence> {
  const occurrence = await createProcessRunReviewPolicyOccurrence({
    activePolicy,
    workspaceRoot: overrides.workspaceRoot ?? base.workspaceRoot,
    workspaceRealpath: (path) => path,
    env: overrides.env ?? base.env,
    declaredTempRoots: overrides.declaredTempRoots ?? base.declaredTempRoots,
    workspaceTrusted: overrides.workspaceTrusted ?? base.workspaceTrusted,
    executeParams: overrides.executeParams ?? base.executeParams,
    argv: overrides.argv ?? base.argv,
    sandboxContainment: overrides.sandboxContainment ?? base.sandboxContainment,
  });
  if (occurrence === undefined) throw new Error("process review occurrence was not reminted");
  return occurrence;
}

describe("ADR-0090 process.run review eligibility", () => {
  it("requires POL-003 to be the sole review cause with no argument rewrite", () => {
    expect(
      processRunReviewDecisionIsExact({
        verdict: "review",
        matchedRules: ["POL-003", "POL-004"],
      }),
    ).toBe(false);
    expect(
      processRunReviewDecisionIsExact({
        verdict: "review",
        matchedRules: ["POL-003"],
        modifiedArgs: {},
      }),
    ).toBe(false);
    expect(processRunReviewDecisionIsExact({ verdict: "review", matchedRules: ["POL-003"] })).toBe(
      true,
    );
    fc.assert(
      fc.property(
        fc.record({
          verdict: fc.constantFrom<PolicyDecision["verdict"]>(
            "allow",
            "warn",
            "modify",
            "review",
            "deny",
          ),
          matchedRules: fc.array(fc.constantFrom("POL-003", "POL-004", "POL-006"), {
            maxLength: 4,
          }),
          modified: fc.boolean(),
        }),
        ({ verdict, matchedRules, modified }) => {
          const decision: PolicyDecision = {
            verdict,
            matchedRules,
            ...(modified ? { modifiedArgs: { argv: ["changed"] } } : {}),
          };
          expect(processRunReviewDecisionIsExact(decision)).toBe(
            verdict === "review" &&
              matchedRules.length === 1 &&
              matchedRules[0] === "POL-003" &&
              !modified,
          );
        },
      ),
      { seed: 9_091, numRuns: 250 },
    );
  });

  it("property-rejects every mutation of the exact effect and composition envelope", async () => {
    const { options } = await eligibleFixture();
    const eligible = processRunReviewEligibility(options)!;

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (suffix) => {
        const mutations: Array<(input: PolicyInputT) => void> = [
          (input) => {
            input.sideEffect.dynamic.effectKinds = ["network_write"];
          },
          (input) => {
            input.sideEffect.dynamic.scopes = ["home"];
          },
          (input) => {
            input.sideEffect.dynamic.modifiers = ["persistent"];
          },
          (input) => {
            input.sideEffect.dynamic.targets.push(jsonClone(input.sideEffect.dynamic.targets[0]!));
          },
          (input) => {
            input.sideEffect.dynamic.targets[0]!.value = `changed-${suffix}`;
          },
          (input) => {
            input.sideEffect.dynamic.targets[0]!.sensitivity = "secret";
          },
          (input) => {
            input.sideEffect.dynamic.composition.kind = "pipeline";
          },
          (input) => {
            input.sideEffect.dynamic.composition.edges = [{ from: 0, to: 0, relation: "pipe" }];
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments.push(
              jsonClone(input.sideEffect.dynamic.composition.segments[0]!),
            );
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.effectKinds = ["fs_write"];
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.scopes = ["system"];
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.modifiers = ["destructive"];
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.targets.push(
              jsonClone(input.sideEffect.dynamic.composition.segments[0]!.targets[0]!),
            );
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.targets[0]!.value = `changed-${suffix}`;
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.targets[0]!.normalized = `changed-${suffix}`;
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.targets[0]!.sensitivity = "secret";
          },
          (input) => {
            input.sideEffect.dynamic.composition.segments[0]!.targets[0]!.withinWorkspace = true;
          },
        ];

        for (const mutate of mutations) {
          const changed = jsonClone(eligible.policyInput);
          mutate(changed);
          expect(processRunReviewEffectIsExact(changed, eligible.renderedArgv)).toBe(false);
        }
      }),
      { seed: 9_094, numRuns: 50 },
    );
  });

  it("admits only the built-in mutable-metadata POL-003 occurrence under complete containment", async () => {
    const { options } = await eligibleFixture();

    const eligible = processRunReviewEligibility(options);

    expect(eligible).toMatchObject({
      argv: ["pnpm", "test"],
      renderedArgv: "'pnpm' 'test'",
      mutationGeneration: 7,
    });
    expect(eligible?.summary).toContain("Approving runs it once: 'pnpm' 'test'.");
    expect(Buffer.byteLength(eligible?.summary ?? "", "utf8")).toBeLessThanOrEqual(
      PROCESS_RUN_REVIEW_MAX_SUMMARY_BYTES,
    );
  });

  it("admits the real default process.run profile without redundant HOME write denials", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const sandboxContainment: SandboxContainmentProof = {
      status: { available: true, backend: "fake-sandbox", enforcementTier: "sandbox:fake" },
      requiredDenyReadRoots: [],
      workspaceSecretDenyReadComplete: true,
      requiredDenyWriteRoots: ["/keel-home/audit"],
      profile: buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        toolName: "process.run",
        workspaceRoot: "/repo",
        declaredTempRoots: ["/tmp/keel-task"],
        env: ENV,
      }),
    };
    const policyOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
      sandboxContainment,
    });

    expect(sandboxContainment.profile.filesystem?.denyWrite).not.toContain("/home/alice/.ssh");
    expect(processRunReviewEligibility({ ...options, policyOccurrence })).toBeDefined();
  });

  it("admits the supported XDG_CONFIG_HOME profile when KEEL_HOME is unset", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const env = { HOME: "/home/alice", USER: "alice", XDG_CONFIG_HOME: "/xdg" } as const;
    const sandboxContainment: SandboxContainmentProof = {
      status: { available: true, backend: "fake-sandbox", enforcementTier: "sandbox:fake" },
      requiredDenyReadRoots: [],
      workspaceSecretDenyReadComplete: true,
      requiredDenyWriteRoots: ["/xdg/keel/audit"],
      profile: buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        toolName: "process.run",
        workspaceRoot: "/repo",
        declaredTempRoots: ["/tmp/keel-task"],
        env,
        realpath: (path) => path,
      }),
    };
    const policyOccurrence = await createProcessRunReviewPolicyOccurrence({
      activePolicy,
      workspaceRoot: "/repo",
      workspaceRealpath: (path) => path,
      env,
      declaredTempRoots: ["/tmp/keel-task"],
      workspaceTrusted: true,
      executeParams: options.policyOccurrence.executeParams,
      argv: options.policyOccurrence.argv,
      sandboxContainment,
    });

    expect(policyOccurrence).toBeDefined();
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: policyOccurrence! }),
    ).toBeDefined();
  });

  it("rejects custom policies even when their pack and decision impersonate the starter policy", async () => {
    const { policy, options } = await eligibleFixture();
    const forgedPolicy = {
      packRef: policy.packRef,
      evaluate: async (): Promise<PolicyDecision> =>
        options.policyOccurrence.policyEvaluation.decision,
    };
    const forgedOccurrence = await remintOccurrence(
      createActiveWardenPolicy(forgedPolicy),
      options.policyOccurrence,
    );

    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: forgedOccurrence,
      }),
    ).toBeUndefined();
  });

  it("property-rejects every custom active-policy identity and pack impersonation", async () => {
    const { policy, options } = await eligibleFixture();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100_000 }), async (suffix) => {
        const customPolicy = {
          packRef: { ...policy.packRef, name: `starter-policy-lookalike-${suffix}` },
          evaluate: async (): Promise<PolicyDecision> =>
            options.policyOccurrence.policyEvaluation.decision,
        };
        const occurrence = await remintOccurrence(
          createActiveWardenPolicy(customPolicy),
          options.policyOccurrence,
        );

        expect(processRunReviewEligibility({ ...options, policyOccurrence: occurrence })).toBe(
          undefined,
        );
      }),
      { seed: 9_095, numRuns: 30 },
    );
  });

  it("property-rejects pack drift while retaining the genuine registered identity", async () => {
    const { options } = await eligibleFixture();
    const { builtinPolicyIdentity, policyPack } = options.policyOccurrence.policyEvaluation;

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.boolean(), (suffix, changeName) => {
        const changedPack = changeName
          ? { ...policyPack, name: `${policyPack.name}-${suffix}` }
          : {
              ...policyPack,
              hash: `sha256:${(suffix % 16).toString(16).repeat(64)}` as const,
            };
        expect(
          registeredBuiltinStarterPolicyIdentityMatchesPack(builtinPolicyIdentity, changedPack),
        ).toBe(false);
      }),
      { seed: 9_101, numRuns: 100 },
    );
  });

  it("rejects wrapper confusion, cloned evaluations, and forged pack facts", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const wrapperOccurrence = await remintOccurrence(
      createActiveWardenPolicy(activePolicy.policy),
      options.policyOccurrence,
    );

    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: wrapperOccurrence,
      }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: { ...options.policyOccurrence },
      }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: {
          ...options.policyOccurrence,
          policyEvaluation: {
            ...options.policyOccurrence.policyEvaluation,
            policyPack: {
              ...options.policyOccurrence.policyEvaluation.policyPack,
              name: "starter-policy-lookalike",
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    ...["pnpm", "npm", "bun", "yarn"].flatMap((manager) =>
      ["build", "format", "lint", "test", "typecheck"].map((command) => [manager, command]),
    ),
    ["git", "diff"],
    ["git", "log"],
    ["git", "show"],
    ["git", "status"],
    ["git", "remote"],
    ["git", "remote", "-v"],
    ["git", "remote", "--verbose"],
    ["git", "remote", "get-url", "origin"],
  ])("admits the existing recognized mutable-metadata argv %j", async (...argv) => {
    const { options } = await eligibleFixture(argv);

    expect(processRunReviewEligibility(options)).toBeDefined();
  });

  it.each([
    ["missing capability", { processRunCapabilityAvailable: false }],
    ["missing audit", { durableAuditAvailable: false }],
    ["sandbox mismatch", { policySandboxMismatch: true }],
    ["poisoned generation", { mutationGeneration: { generation: 7, poisoned: true } }],
  ] as const)("rejects %s", async (_name, mutation) => {
    const { options } = await eligibleFixture();

    expect(processRunReviewEligibility({ ...options, ...mutation })).toBeUndefined();
  });

  it("rejects an untrusted Warden-minted occurrence", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const policyOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
      workspaceTrusted: false,
    });

    expect(processRunReviewEligibility({ ...options, policyOccurrence })).toBeUndefined();
  });

  it("rejects unrecognized argv and any incomplete or egress-capable containment", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const sandboxContainment = options.policyOccurrence.sandboxContainment;
    const unknownArgv = ["unknown-tool", "arg"];
    const unknownParams = processParams(unknownArgv);
    const unknownOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
      executeParams: unknownParams,
      argv: unknownArgv,
    });
    const incomplete = {
      ...sandboxContainment,
      workspaceSecretDenyReadComplete: false,
    };
    const egress = {
      ...sandboxContainment,
      profile: {
        ...sandboxContainment.profile,
        network: { allowedDomains: ["example.com"], deniedDomains: [], strictAllowlist: true },
      },
    };
    const incompleteOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
      sandboxContainment: incomplete,
    });
    const egressOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
      sandboxContainment: egress,
    });

    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: unknownOccurrence,
      }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: incompleteOccurrence }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: egressOccurrence }),
    ).toBeUndefined();
  });

  it.each(HOME_CREDENTIAL_ROOTS)(
    "rejects an incomplete credential read denial for %s",
    async (credentialRoot) => {
      const { activePolicy, options } = await eligibleFixture();
      const sandboxContainment = options.policyOccurrence.sandboxContainment;
      const incompleteCredential = {
        ...sandboxContainment,
        profile: {
          ...sandboxContainment.profile,
          filesystem: {
            ...sandboxContainment.profile.filesystem,
            denyRead: (sandboxContainment.profile.filesystem?.denyRead ?? []).filter(
              (root) => root !== credentialRoot,
            ),
          },
        },
      };
      const policyOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
        sandboxContainment: incompleteCredential,
      });

      expect(
        processRunReviewEligibility({
          ...options,
          policyOccurrence,
        }),
      ).toBeUndefined();
    },
  );

  it("requires credential write denials when an allowed write root overlaps HOME", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const homeWorkspaceProof = containmentFor("/home", "/home/alice");
    const uncovered = await remintOccurrence(activePolicy, options.policyOccurrence, {
      workspaceRoot: "/home",
      sandboxContainment: homeWorkspaceProof,
    });
    const covered = await remintOccurrence(activePolicy, options.policyOccurrence, {
      workspaceRoot: "/home",
      sandboxContainment: {
        ...homeWorkspaceProof,
        profile: {
          ...homeWorkspaceProof.profile,
          filesystem: {
            ...homeWorkspaceProof.profile.filesystem,
            denyWrite: [
              ...(homeWorkspaceProof.profile.filesystem?.denyWrite ?? []),
              ...HOME_CREDENTIAL_ROOTS,
            ],
          },
        },
      },
    });

    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: uncovered }),
    ).toBeUndefined();
    expect(processRunReviewEligibility({ ...options, policyOccurrence: covered })).toBeDefined();
  });

  it("rejects ambient temporary roots not declared by the Warden", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const sandboxContainment = options.policyOccurrence.sandboxContainment;
    const ambientTemp = {
      ...sandboxContainment,
      profile: {
        ...sandboxContainment.profile,
        filesystem: {
          ...sandboxContainment.profile.filesystem,
          allowRead: ["/repo", "/tmp/ambient"],
          allowWrite: ["/repo", "/tmp/ambient"],
        },
      },
    };
    const policyOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
      sandboxContainment: ambientTemp,
    });

    expect(processRunReviewEligibility({ ...options, policyOccurrence })).toBeUndefined();
  });

  it("rejects unminted contradictory workspace and provenance facts", async () => {
    const { options } = await eligibleFixture();
    const base = options.policyOccurrence;
    const untrustedInput = {
      ...base.policyEvaluation.policyInput,
      workspace: { ...base.policyEvaluation.policyInput.workspace, trusted: false },
    };
    const changedProvenanceInput = {
      ...base.policyEvaluation.policyInput,
      provenance: { inputTags: ["user" as const] },
    };

    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: {
          ...base,
          policyEvaluation: { ...base.policyEvaluation, policyInput: untrustedInput },
        },
      }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({
        ...options,
        policyOccurrence: {
          ...base,
          policyEvaluation: { ...base.policyEvaluation, policyInput: changedProvenanceInput },
        },
      }),
    ).toBeUndefined();
  });

  it("fails closed when the workspace cannot be canonicalized", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const base = options.policyOccurrence;

    expect(
      await createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot: base.workspaceRoot,
        workspaceRealpath: () => {
          throw new Error("unresolvable workspace");
        },
        env: base.env,
        declaredTempRoots: base.declaredTempRoots,
        workspaceTrusted: base.workspaceTrusted,
        executeParams: base.executeParams,
        argv: base.argv,
        sandboxContainment: base.sandboxContainment,
      }),
    ).toBeUndefined();
  });

  it("rejects malformed argv before policy evaluation", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const base = options.policyOccurrence;
    expect(
      await createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot: base.workspaceRoot,
        workspaceRealpath: (path) => path,
        env: base.env,
        declaredTempRoots: base.declaredTempRoots,
        workspaceTrusted: base.workspaceTrusted,
        executeParams: processParams(["printf", "unsafe\nargument"]),
        argv: ["printf", "unsafe\nargument"],
        sandboxContainment: base.sandboxContainment,
      }),
    ).toBeUndefined();
  });

  it("uses the host realpath implementation when no test seam is supplied", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const base = options.policyOccurrence;
    const workspaceRoot = process.cwd();
    const tempRoot = mkdtempSync(join(realpathSync("/tmp"), "keel-review-realpath-"));
    try {
      const occurrence = await createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot,
        env: { ...base.env, HOME: homedir() },
        declaredTempRoots: [tempRoot],
        workspaceTrusted: base.workspaceTrusted,
        executeParams: base.executeParams,
        argv: base.argv,
        sandboxContainment: base.sandboxContainment,
      });

      expect(occurrence?.workspaceRoot).toBe(realpathSync(workspaceRoot));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when HOME is missing, empty, or aliases the canonical workspace", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const base = options.policyOccurrence;
    for (const env of [{}, { HOME: "" }]) {
      expect(
        await createProcessRunReviewPolicyOccurrence({
          activePolicy,
          workspaceRoot: base.workspaceRoot,
          workspaceRealpath: (path) => path,
          env,
          declaredTempRoots: base.declaredTempRoots,
          workspaceTrusted: base.workspaceTrusted,
          executeParams: base.executeParams,
          argv: base.argv,
          sandboxContainment: base.sandboxContainment,
        }),
      ).toBeUndefined();
    }

    expect(
      await createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot: "/home/alice-link",
        workspaceRealpath: (path) =>
          resolve(path).replace(/^\/home\/alice-link(?=\/|$)/u, "/srv/alice"),
        env: { HOME: "/home/alice-link", USER: "alice" },
        declaredTempRoots: base.declaredTempRoots,
        workspaceTrusted: base.workspaceTrusted,
        executeParams: base.executeParams,
        argv: base.argv,
        sandboxContainment: base.sandboxContainment,
      }),
    ).toBeUndefined();
  });

  it("admits a safe workspace symlink only when its physical roots remain contained", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const lexicalWorkspace = "/workspace-link";
    const canonicalWorkspace = "/actual-workspace";
    const realpath = (path: string) =>
      resolve(path).replace(/^\/workspace-link(?=\/|$)/u, canonicalWorkspace);
    const sandboxContainment = containmentFor(lexicalWorkspace, ENV.HOME);
    const policyOccurrence = await createProcessRunReviewPolicyOccurrence({
      activePolicy,
      workspaceRoot: lexicalWorkspace,
      workspaceRealpath: realpath,
      env: ENV,
      declaredTempRoots: ["/tmp/keel-task"],
      workspaceTrusted: true,
      executeParams: options.policyOccurrence.executeParams,
      argv: options.policyOccurrence.argv,
      sandboxContainment,
    });

    expect(policyOccurrence?.workspaceRoot).toBe(canonicalWorkspace);
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: policyOccurrence! }),
    ).toBeDefined();
  });

  it("admits the real macOS /var workspace alias only after dual lexical/physical validation", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const root = mkdtempSync(join(tmpdir(), "keel-process-review-alias-"));
    const tempRoot = mkdtempSync(join(realpathSync("/tmp"), "keel-sandbox-review-test-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const keelHome = join(root, "keel-home");
      mkdirSync(workspaceRoot);
      const env = { HOME: homedir(), USER: "alice", KEEL_HOME: keelHome } as const;
      const sandboxContainment: SandboxContainmentProof = {
        status: { available: true, backend: "fake-sandbox", enforcementTier: "sandbox:fake" },
        requiredDenyReadRoots: [],
        workspaceSecretDenyReadComplete: true,
        requiredDenyWriteRoots: [join(keelHome, "audit")],
        profile: buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
          toolName: "process.run",
          workspaceRoot,
          declaredTempRoots: [tempRoot],
          env,
        }),
      };
      const policyOccurrence = await createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot,
        env,
        declaredTempRoots: [tempRoot],
        workspaceTrusted: true,
        executeParams: options.policyOccurrence.executeParams,
        argv: options.policyOccurrence.argv,
        sandboxContainment,
      });

      expect(policyOccurrence?.workspaceRoot).toBe(realpathSync(workspaceRoot));
      expect(policyOccurrence?.policyEvaluation.decision).toMatchObject({
        verdict: "review",
        matchedRules: ["POL-003"],
      });
      expect(
        sandboxProofIsContained(sandboxContainment, {
          workspaceRoot,
          env,
          declaredTempRoots: [tempRoot],
        }),
      ).toBe(true);
      expect(
        processRunReviewEligibility({ ...options, policyOccurrence: policyOccurrence! }),
      ).toBeDefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a declared temporary root that is a symlink to HOME or an external directory", async () => {
    const { activePolicy, options } = await eligibleFixture();
    expect(
      await createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot: "/repo",
        workspaceRealpath: (path) => path,
        env: ENV,
        declaredTempRoots: ["/srv/external"],
        workspaceTrusted: true,
        executeParams: options.policyOccurrence.executeParams,
        argv: options.policyOccurrence.argv,
        sandboxContainment: containmentFor("/repo", ENV.HOME, "/srv/external"),
      }),
    ).toBeUndefined();
    const root = mkdtempSync(join(realpathSync("/tmp"), "keel-process-review-temp-alias-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const homeRoot = join(root, "home");
      const externalRoot = join(root, "external");
      const keelHome = join(root, "keel-home");
      mkdirSync(workspaceRoot);
      mkdirSync(homeRoot);
      mkdirSync(externalRoot);
      const env = { HOME: homeRoot, USER: "alice", KEEL_HOME: keelHome } as const;

      for (const [name, target] of [
        ["home-link", homeRoot],
        ["external-link", externalRoot],
      ] as const) {
        const tempLink = join(root, name);
        symlinkSync(target, tempLink);
        const sandboxContainment: SandboxContainmentProof = {
          status: { available: true, backend: "fake-sandbox", enforcementTier: "sandbox:fake" },
          requiredDenyReadRoots: [],
          workspaceSecretDenyReadComplete: true,
          requiredDenyWriteRoots: [join(keelHome, "audit")],
          profile: buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
            toolName: "process.run",
            workspaceRoot,
            declaredTempRoots: [tempLink],
            env,
          }),
        };

        expect(
          await createProcessRunReviewPolicyOccurrence({
            activePolicy,
            workspaceRoot,
            env,
            declaredTempRoots: [tempLink],
            workspaceTrusted: true,
            executeParams: options.policyOccurrence.executeParams,
            argv: options.policyOccurrence.argv,
            sandboxContainment,
          }),
        ).toBeUndefined();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires physical deny coverage when a credential child aliases an allowed temp root", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const root = mkdtempSync(join(realpathSync("/tmp"), "keel-review-secret-child-"));
    const tempRoot = mkdtempSync(join(realpathSync("/tmp"), "keel-sandbox-secret-child-"));
    try {
      const workspaceRoot = join(root, "workspace");
      const homeRoot = join(root, "home");
      const secretTarget = join(tempRoot, "secrets");
      const keelHome = join(root, "keel-home");
      mkdirSync(workspaceRoot);
      mkdirSync(homeRoot);
      mkdirSync(secretTarget);
      symlinkSync(secretTarget, join(homeRoot, ".ssh"));
      const env = { HOME: homeRoot, USER: "alice", KEEL_HOME: keelHome } as const;
      const profile = buildSandboxProfileFromCapabilityManifest(DEFAULT_CAPABILITY_MANIFEST, {
        toolName: "process.run",
        workspaceRoot,
        declaredTempRoots: [tempRoot],
        env,
      });
      const proof: SandboxContainmentProof = {
        status: { available: true, backend: "fake-sandbox", enforcementTier: "sandbox:fake" },
        requiredDenyReadRoots: [],
        workspaceSecretDenyReadComplete: true,
        requiredDenyWriteRoots: [join(keelHome, "audit")],
        profile,
      };
      const mint = (sandboxContainment: SandboxContainmentProof) =>
        createProcessRunReviewPolicyOccurrence({
          activePolicy,
          workspaceRoot,
          env,
          declaredTempRoots: [tempRoot],
          workspaceTrusted: true,
          executeParams: options.policyOccurrence.executeParams,
          argv: options.policyOccurrence.argv,
          sandboxContainment,
        });
      const completeOccurrence = await mint(proof);
      expect(
        processRunReviewEligibility({ ...options, policyOccurrence: completeOccurrence! }),
      ).toBeDefined();

      const incompleteProof = {
        ...proof,
        profile: {
          ...profile,
          filesystem: {
            ...profile.filesystem,
            denyRead: (profile.filesystem?.denyRead ?? []).filter((path) => path !== secretTarget),
            denyWrite: (profile.filesystem?.denyWrite ?? []).filter(
              (path) => path !== secretTarget,
            ),
          },
        },
      } satisfies SandboxContainmentProof;
      const incompleteOccurrence = await mint(incompleteProof);
      expect(
        processRunReviewEligibility({ ...options, policyOccurrence: incompleteOccurrence! }),
      ).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires both lexical and canonical credential denials across HOME aliases", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const base = options.policyOccurrence;
    const aliasHome = "/home/alice-link";
    const canonicalHome = "/srv/alice";
    const workspaceRoot = "/srv";
    const realpath = (path: string) =>
      resolve(path).replace(/^\/home\/alice-link(?=\/|$)/u, canonicalHome);
    const lexicalOnly = containmentFor(workspaceRoot, aliasHome);
    const canonicalCredentialRoots = HOME_CREDENTIAL_ROOTS.map((path) =>
      path.replace(/^\/home\/alice(?=\/|$)/u, canonicalHome),
    );
    const withCanonicalReads = {
      ...lexicalOnly,
      profile: {
        ...lexicalOnly.profile,
        filesystem: {
          ...lexicalOnly.profile.filesystem,
          denyRead: [
            ...(lexicalOnly.profile.filesystem?.denyRead ?? []),
            ...canonicalCredentialRoots,
          ],
        },
      },
    } satisfies SandboxContainmentProof;
    const fullyCovered = {
      ...withCanonicalReads,
      profile: {
        ...withCanonicalReads.profile,
        filesystem: {
          ...withCanonicalReads.profile.filesystem,
          denyWrite: [
            ...(withCanonicalReads.profile.filesystem?.denyWrite ?? []),
            ...HOME_CREDENTIAL_ROOTS.map((path) =>
              path.replace(/^\/home\/alice(?=\/|$)/u, aliasHome),
            ),
            ...canonicalCredentialRoots,
          ],
        },
      },
    } satisfies SandboxContainmentProof;
    const mint = (sandboxContainment: SandboxContainmentProof) =>
      createProcessRunReviewPolicyOccurrence({
        activePolicy,
        workspaceRoot,
        workspaceRealpath: realpath,
        env: { HOME: aliasHome, USER: "alice", KEEL_HOME: "/keel-home" },
        declaredTempRoots: base.declaredTempRoots,
        workspaceTrusted: true,
        executeParams: base.executeParams,
        argv: base.argv,
        sandboxContainment,
      });
    const lexicalOccurrence = await mint(lexicalOnly);
    const readCoveredOccurrence = await mint(withCanonicalReads);
    const fullyCoveredOccurrence = await mint(fullyCovered);

    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: lexicalOccurrence! }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: readCoveredOccurrence! }),
    ).toBeUndefined();
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: fullyCoveredOccurrence! }),
    ).toBeDefined();
  });

  it("distinguishes safe HOME ancestry from a declared-temp root that aliases HOME", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const base = options.policyOccurrence;
    const aliasHome = "/home/alice-link";
    const canonicalHome = "/srv/alice";
    const realpath = (path: string) =>
      resolve(path).replace(/^\/home\/alice-link(?=\/|$)/u, canonicalHome);
    const canonicalCredentialRoots = HOME_CREDENTIAL_ROOTS.map((path) =>
      path.replace(/^\/home\/alice(?=\/|$)/u, canonicalHome),
    );
    const homeAncestorProof = containmentFor("/srv/alice/project", aliasHome);
    const homeAncestorCovered = {
      ...homeAncestorProof,
      profile: {
        ...homeAncestorProof.profile,
        filesystem: {
          ...homeAncestorProof.profile.filesystem,
          denyRead: [
            ...(homeAncestorProof.profile.filesystem?.denyRead ?? []),
            ...canonicalCredentialRoots,
          ],
        },
      },
    } satisfies SandboxContainmentProof;
    const homeAncestorOccurrence = await createProcessRunReviewPolicyOccurrence({
      activePolicy,
      workspaceRoot: "/srv/alice/project",
      workspaceRealpath: realpath,
      env: { HOME: aliasHome, USER: "alice", KEEL_HOME: "/keel-home" },
      declaredTempRoots: base.declaredTempRoots,
      workspaceTrusted: true,
      executeParams: base.executeParams,
      argv: base.argv,
      sandboxContainment: homeAncestorCovered,
    });
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: homeAncestorOccurrence! }),
    ).toBeDefined();

    const tempHomeProof = containmentFor("/repo", aliasHome, canonicalHome);
    const tempHomeReadCovered = {
      ...tempHomeProof,
      profile: {
        ...tempHomeProof.profile,
        filesystem: {
          ...tempHomeProof.profile.filesystem,
          denyRead: [
            ...(tempHomeProof.profile.filesystem?.denyRead ?? []),
            ...canonicalCredentialRoots,
          ],
        },
      },
    } satisfies SandboxContainmentProof;
    const tempHomeOccurrence = await createProcessRunReviewPolicyOccurrence({
      activePolicy,
      workspaceRoot: "/repo",
      workspaceRealpath: realpath,
      env: { HOME: aliasHome, USER: "alice", KEEL_HOME: "/keel-home" },
      declaredTempRoots: [canonicalHome],
      workspaceTrusted: true,
      executeParams: base.executeParams,
      argv: base.argv,
      sandboxContainment: tempHomeReadCovered,
    });
    expect(
      processRunReviewEligibility({ ...options, policyOccurrence: tempHomeOccurrence! }),
    ).toBeUndefined();
  });

  it("snapshots mutable execute and temp-root authority before awaiting policy evaluation", async () => {
    const basePolicy = await createDefaultPolicyPort();
    let releaseEvaluation!: () => void;
    let evaluationStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      evaluationStarted = resolveStarted;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseEvaluation = resolveRelease;
    });
    const activePolicy = createActiveWardenPolicy({
      packRef: basePolicy.packRef,
      evaluate: async (input) => {
        evaluationStarted();
        await release;
        return basePolicy.evaluate(input);
      },
    });
    const executeParams = processParams(["pnpm", "test"]);
    const declaredTempRoots = ["/tmp/keel-task"];
    const occurrencePromise = createProcessRunReviewPolicyOccurrence({
      activePolicy,
      workspaceRoot: "/repo",
      workspaceRealpath: (path) => path,
      env: ENV,
      declaredTempRoots,
      workspaceTrusted: true,
      executeParams,
      argv: ["pnpm", "test"],
      sandboxContainment: containedSandboxProof(),
    });
    await started;
    executeParams.toolCall.id = "tc_mutated_during_evaluation";
    declaredTempRoots.push("/tmp/ambient-after-await");
    releaseEvaluation();
    const occurrence = await occurrencePromise;

    expect(occurrence?.executeParams.toolCall.id).toBe("tc_process_review");
    expect(occurrence?.declaredTempRoots).toEqual(["/tmp/keel-task"]);
    expect(Object.isFrozen(occurrence?.executeParams)).toBe(true);
    expect(Object.isFrozen(occurrence?.declaredTempRoots)).toBe(true);
  });

  it("property-invalidates coherent argv, args, workspace, session, provenance, and capability changes", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const bindingKey = (next: ProcessRunReviewEligibilityOptions): string | undefined => {
      const eligible = processRunReviewEligibility(next);
      if (eligible === undefined) return undefined;
      return createProcessRunReviewRequestBinding({
        eligible,
        reviewId: "process_review_1",
        createdAtMs: 10_000,
        expiresAtMs: 10_000 + PROCESS_RUN_REVIEW_TTL_MS,
      })?.key;
    };
    const original = bindingKey(options)!;

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 100_000 }), async (suffix) => {
        const argv = ["pnpm", "test", `changed-${suffix}`];
        const argvOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
          executeParams: processParams(argv),
          argv,
        });
        const argvKey = bindingKey({ ...options, policyOccurrence: argvOccurrence });
        if (argvKey !== undefined) expect(argvKey).not.toBe(original);

        const mismatchedArgs = {
          ...options.policyOccurrence.executeParams,
          toolCall: {
            ...options.policyOccurrence.executeParams.toolCall,
            args: { argv: [...options.policyOccurrence.argv], marker: suffix },
          },
        };
        const argsOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
          executeParams: mismatchedArgs,
        });
        expect(
          processRunReviewEligibility({ ...options, policyOccurrence: argsOccurrence }),
        ).toBeUndefined();

        const workspaceRoot = `/repo-${suffix}`;
        const workspaceOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
          workspaceRoot,
          sandboxContainment: containmentFor(workspaceRoot, ENV.HOME),
        });
        expect(bindingKey({ ...options, policyOccurrence: workspaceOccurrence })).not.toBe(
          original,
        );

        const sessionParams = {
          ...options.policyOccurrence.executeParams,
          sessionId: `${SESSION_ID.slice(0, -1)}${suffix % 2 === 0 ? "A" : "B"}`,
        };
        const sessionOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
          executeParams: sessionParams,
        });
        expect(bindingKey({ ...options, policyOccurrence: sessionOccurrence })).not.toBe(original);

        const provenanceParams = {
          ...options.policyOccurrence.executeParams,
          provenanceContext: { inputTags: [suffix % 2 === 0 ? "user" : "mixed"] },
        } satisfies ExecuteParams;
        const provenanceOccurrence = await remintOccurrence(
          activePolicy,
          options.policyOccurrence,
          { executeParams: provenanceParams },
        );
        expect(bindingKey({ ...options, policyOccurrence: provenanceOccurrence })).not.toBe(
          original,
        );
        expect(
          processRunReviewEligibility({ ...options, processRunCapabilityAvailable: false }),
        ).toBeUndefined();
      }),
      { seed: 9_096, numRuns: 30 },
    );
  });

  it("property-fails closed for argv order changes and incomplete secret coverage", async () => {
    const { activePolicy, options } = await eligibleFixture(["git", "remote", "-v"]);
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(["git", "remote", "-v"], { minLength: 3, maxLength: 3 }),
        fc.integer({ min: 0, max: HOME_CREDENTIAL_ROOTS.length - 1 }),
        async (argv, credentialIndex) => {
          fc.pre(argv.join("\0") !== "git\0remote\0-v");
          const orderedOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
            executeParams: processParams(argv),
            argv,
          });
          expect(
            processRunReviewEligibility({ ...options, policyOccurrence: orderedOccurrence }),
          ).toBeUndefined();

          const proof = options.policyOccurrence.sandboxContainment;
          const incomplete = {
            ...proof,
            profile: {
              ...proof.profile,
              filesystem: {
                ...proof.profile.filesystem,
                denyRead: (proof.profile.filesystem?.denyRead ?? []).filter(
                  (root) => root !== HOME_CREDENTIAL_ROOTS[credentialIndex],
                ),
              },
            },
          } satisfies SandboxContainmentProof;
          const incompleteOccurrence = await remintOccurrence(
            activePolicy,
            options.policyOccurrence,
            { sandboxContainment: incomplete },
          );
          expect(
            processRunReviewEligibility({ ...options, policyOccurrence: incompleteOccurrence }),
          ).toBeUndefined();
        },
      ),
      { seed: 9_097, numRuns: 40 },
    );
  });
});

describe("ADR-0090 lossless process.run presentation", () => {
  it("preserves empty, repeated, leading, trailing, and quoted argument bytes", () => {
    const argv = ["printf", "", "  repeated  ", " leading", "trailing ", "quote'arg"];
    const summary = processRunReviewSummary(argv);

    expect(summary).toContain("'printf' '' '  repeated  ' ' leading' 'trailing ' 'quote'\\''arg'");
    expect(Buffer.byteLength(summary ?? "", "utf8")).toBeLessThanOrEqual(
      PROCESS_RUN_REVIEW_MAX_SUMMARY_BYTES,
    );
  });

  it("fails closed instead of truncating long or control-bearing argv", () => {
    expect(processRunReviewSummary(["printf", "x".repeat(200)])).toBeUndefined();
    expect(processRunReviewSummary(["printf", "line\nbreak"])).toBeUndefined();
  });

  it("fails closed when redaction would change any displayed argv byte", () => {
    expect(
      processRunReviewSummary(["printf", "sk-proj-123456789012345678901234567890"]),
    ).toBeUndefined();
  });

  it("is exact and bounded for arbitrary displayable short arguments", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.stringOf(fc.constantFrom("a", "Z", "7", " ", "'", ".", "_", "-", "é", "😀"), {
            maxLength: 12,
          }),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        (tail) => {
          const argv = ["printf", ...tail];
          const summary = processRunReviewSummary(argv);
          expect(summary).toBeDefined();
          expect(summary?.endsWith(`${renderProcessRunArgv(argv)}.`)).toBe(true);
          expect(Buffer.byteLength(summary!, "utf8")).toBeLessThanOrEqual(
            PROCESS_RUN_REVIEW_MAX_SUMMARY_BYTES,
          );
        },
      ),
      { seed: 9_090, numRuns: 200 },
    );
  });
});

describe("ADR-0090 exact occurrence bindings", () => {
  it("binds the complete request occurrence and two-stage approval", async () => {
    const { options } = await eligibleFixture();
    const eligible = processRunReviewEligibility(options)!;
    const base = {
      eligible,
      reviewId: "process_review_1",
      createdAtMs: 10_000,
      expiresAtMs: 10_000 + PROCESS_RUN_REVIEW_TTL_MS,
    } as const;
    const requestBinding = createProcessRunReviewRequestBinding(base);

    expect(requestBinding?.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(
      createProcessRunReviewRequestBinding({ ...base, reviewId: "process_review_2" })?.key,
    ).not.toBe(requestBinding?.key);
    expect(
      createProcessRunReviewRequestBinding({ ...base, expiresAtMs: base.expiresAtMs + 1 }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewRequestBinding({
        ...base,
        createdAtMs: Number.MAX_VALUE,
        expiresAtMs: Number.POSITIVE_INFINITY,
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewRequestBinding({
        ...base,
        reviewId: `process_review_${"9".repeat(40)}`,
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewRequestBinding({
        ...base,
        reviewId: "process_review_9999999999999999",
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewRequestBinding({ ...base, eligible: { ...eligible } }),
    ).toBeUndefined();

    const approval = createProcessRunReviewApprovalBinding({
      requestBinding,
      nowMs: base.createdAtMs + 1,
      principal: {
        osUser: "alice",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      scope: "once",
    });
    expect(approval?.key).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(isProcessRunReviewApprovalBinding(approval!)).toBe(true);
    expect(isProcessRunReviewApprovalBinding({ ...approval! })).toBe(false);
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding,
        nowMs: base.createdAtMs + 1,
        principal: {
          osUser: "mallory",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        scope: "once",
      })?.key,
    ).not.toBe(approval?.key);
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding,
        nowMs: base.createdAtMs + 1,
        principal: {
          osUser: "alice",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        scope: "project",
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding,
        nowMs: base.createdAtMs + 1,
        principal: { osUser: "alice" },
        scope: "once",
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding: {
          key: `sha256:${"0".repeat(64)}`,
          reviewId: base.reviewId,
          createdAtMs: base.createdAtMs,
          expiresAtMs: base.expiresAtMs,
        },
        nowMs: base.createdAtMs + 1,
        principal: {
          osUser: "alice",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        scope: "once",
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding: { ...requestBinding!, reviewId: "process_review_999" },
        nowMs: base.createdAtMs + 1,
        principal: {
          osUser: "alice",
          configuredId: null,
          authProvider: "local",
          assurance: "local-os-user",
        },
        scope: "once",
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding,
        nowMs: base.createdAtMs - 1,
        principal: approval!.principal,
        scope: "once",
      }),
    ).toBeUndefined();
    expect(
      createProcessRunReviewApprovalBinding({
        requestBinding,
        nowMs: base.expiresAtMs,
        principal: approval!.principal,
        scope: "once",
      }),
    ).toBeUndefined();
  });

  it("changes the request binding for every security-relevant live fact", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const baseOccurrence = options.policyOccurrence;
    const sandboxContainment = baseOccurrence.sandboxContainment;
    const keyFor = (next: ProcessRunReviewEligibilityOptions): string => {
      const eligible = processRunReviewEligibility(next);
      expect(eligible).toBeDefined();
      const binding = createProcessRunReviewRequestBinding({
        eligible: eligible!,
        reviewId: "process_review_1",
        createdAtMs: 10_000,
        expiresAtMs: 10_000 + PROCESS_RUN_REVIEW_TTL_MS,
      });
      if (binding === undefined) throw new Error("eligible review did not produce a request key");
      return binding.key;
    };
    const original = keyFor(options);
    const nextParams = {
      ...baseOccurrence.executeParams,
      toolCall: { ...baseOccurrence.executeParams.toolCall, id: "tc_changed" },
    };
    const nextContainment = {
      ...sandboxContainment,
      status: { ...sandboxContainment.status, backend: "different-sandbox" },
    };
    const nextParamsOccurrence = await remintOccurrence(activePolicy, baseOccurrence, {
      executeParams: nextParams,
    });
    const nextContainmentOccurrence = await remintOccurrence(activePolicy, baseOccurrence, {
      sandboxContainment: nextContainment,
    });
    const nextTempOccurrence = await remintOccurrence(activePolicy, baseOccurrence, {
      declaredTempRoots: [...baseOccurrence.declaredTempRoots, "/tmp/keel-other"],
    });

    expect(keyFor({ ...options, policyOccurrence: nextParamsOccurrence })).not.toBe(original);
    expect(keyFor({ ...options, policyOccurrence: nextContainmentOccurrence })).not.toBe(original);
    expect(keyFor({ ...options, policyOccurrence: nextTempOccurrence })).not.toBe(original);
    expect(
      keyFor({
        ...options,
        mutationGeneration: {
          generation: options.mutationGeneration.generation + 1,
          poisoned: false,
        },
      }),
    ).not.toBe(original);
  });

  it("property-binds generation and coherent call identity changes", async () => {
    const { activePolicy, options } = await eligibleFixture();
    const keyFor = (next: ProcessRunReviewEligibilityOptions): string => {
      const eligible = processRunReviewEligibility(next);
      expect(eligible).toBeDefined();
      const binding = createProcessRunReviewRequestBinding({
        eligible: eligible!,
        reviewId: "process_review_1",
        createdAtMs: 10_000,
        expiresAtMs: 10_000 + PROCESS_RUN_REVIEW_TTL_MS,
      });
      if (binding === undefined) throw new Error("eligible review did not bind");
      return binding.key;
    };
    const original = keyFor(options);

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (delta) => {
        expect(
          keyFor({
            ...options,
            mutationGeneration: {
              generation: options.mutationGeneration.generation + delta,
              poisoned: false,
            },
          }),
        ).not.toBe(original);
      }),
      { seed: 9_092, numRuns: 100 },
    );
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10_000 }), async (suffix) => {
        const executeParams = {
          ...options.policyOccurrence.executeParams,
          toolCall: {
            ...options.policyOccurrence.executeParams.toolCall,
            id: `tc_process_review_${suffix}`,
          },
        };
        const policyOccurrence = await remintOccurrence(activePolicy, options.policyOccurrence, {
          executeParams,
        });

        expect(keyFor({ ...options, policyOccurrence })).not.toBe(original);
      }),
      { seed: 9_093, numRuns: 40 },
    );
  });

  it("property-binds review ID, expiry, principal, and exact-once scope", async () => {
    const { options } = await eligibleFixture();
    const eligible = processRunReviewEligibility(options)!;
    const request = (reviewId: string, createdAtMs: number, expiresAtMs: number) =>
      createProcessRunReviewRequestBinding({ eligible, reviewId, createdAtMs, expiresAtMs });
    const original = request("process_review_1", 10_000, 10_000 + PROCESS_RUN_REVIEW_TTL_MS)!;
    const originalPrincipal = {
      osUser: "alice",
      configuredId: null,
      authProvider: "local" as const,
      assurance: "local-os-user" as const,
    };
    const originalApproval = createProcessRunReviewApprovalBinding({
      requestBinding: original,
      principal: originalPrincipal,
      scope: "once",
      nowMs: 10_001,
    })!;

    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1_000_000 }), (reviewNumber) => {
        const changed = request(
          `process_review_${reviewNumber}`,
          10_000,
          10_000 + PROCESS_RUN_REVIEW_TTL_MS,
        );
        expect(changed?.key).not.toBe(original.key);
      }),
      { seed: 9_098, numRuns: 100 },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: -100_000, max: 100_000 }).filter((offset) => offset !== 0),
        (offset) => {
          expect(
            request("process_review_1", 10_000, 10_000 + PROCESS_RUN_REVIEW_TTL_MS + offset),
          ).toBeUndefined();
        },
      ),
      { seed: 9_099, numRuns: 100 },
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (suffix) => {
        const changed = createProcessRunReviewApprovalBinding({
          requestBinding: original,
          principal: { ...originalPrincipal, osUser: `alice-${suffix}` },
          scope: "once",
          nowMs: 10_001,
        });
        expect(changed?.key).not.toBe(originalApproval.key);
        expect(
          createProcessRunReviewApprovalBinding({
            requestBinding: original,
            principal: originalPrincipal,
            scope: suffix % 2 === 0 ? "project" : undefined,
            nowMs: 10_001,
          }),
        ).toBeUndefined();
      }),
      { seed: 9_100, numRuns: 100 },
    );
  });
});
