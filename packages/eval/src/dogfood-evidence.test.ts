import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOGFOOD_SCORE_AXES,
  DOGFOOD_WORKFLOW_IDS,
  DogfoodScenarioManifest,
  compareDogfoodEvidence,
} from "./dogfood-evidence.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifestPath = join(
  repoRoot,
  "artifacts",
  "tui-dogfood",
  "20260802T201841-0400",
  "scenario-manifest.json",
);

function manifestFixture(): unknown {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("dogfood scenario manifest", () => {
  it("binds exactly the six workflows to repeatable, sanitized evidence", () => {
    const manifest = DogfoodScenarioManifest.parse(manifestFixture());

    expect(manifest.scoreAxes).toEqual(DOGFOOD_SCORE_AXES);
    expect(manifest.scenarios.map((scenario) => scenario.id)).toEqual(DOGFOOD_WORKFLOW_IDS);
    expect(
      manifest.scenarios.reduce((total, scenario) => total + scenario.costCeilingUsd, 0),
    ).toBeLessThanOrEqual(12);
    for (const scenario of manifest.scenarios) {
      expect(scenario.externalBaselineCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(scenario.terminal).toEqual({ columns: 100, rows: 30 });
      expect(scenario.authoritativeFacts.length).toBeGreaterThan(0);
      expect(scenario.screenshotCheckpoints.length).toBeGreaterThan(0);
      expect(scenario.costCeilingUsd).toBeGreaterThanOrEqual(0);
      for (const checkpoint of scenario.screenshotCheckpoints) {
        expect(existsSync(join(dirname(manifestPath), "screenshots", checkpoint))).toBe(true);
      }
    }
  });

  it("distinguishes ledger-sourced prompts from canonical replay syntheses", () => {
    const raw = manifestFixture() as {
      scenarios: Array<{ promptProvenance?: unknown }>;
    };

    expect(raw.scenarios.map((scenario) => scenario.promptProvenance)).toEqual([
      "source-ledger",
      "source-ledger",
      "source-ledger",
      "source-ledger",
      "canonicalized",
      "canonicalized",
    ]);
  });

  it("keeps the committed manifest free of credential and user-home markers", () => {
    const serialized = readFileSync(manifestPath, "utf8");

    expect(serialized).not.toMatch(
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|sk-ant-|\/Users\/|\/home\//i,
    );
  });

  it("rejects duplicate or missing workflow membership", () => {
    const manifest = DogfoodScenarioManifest.parse(manifestFixture());
    const duplicate = structuredClone(manifest);
    duplicate.scenarios[5] = structuredClone(duplicate.scenarios[0]!);

    expect(() => DogfoodScenarioManifest.parse(duplicate)).toThrow(/exactly once/);
  });

  it("rejects reordered or duplicate score axes", () => {
    const manifest = DogfoodScenarioManifest.parse(manifestFixture());
    const reordered = structuredClone(manifest);
    reordered.scoreAxes[1] = reordered.scoreAxes[0]!;

    expect(() => DogfoodScenarioManifest.parse(reordered)).toThrow(
      /every dogfood axis exactly once/,
    );
  });

  it.each(["../secret.png", "subdir/capture.png", "Capture.PNG", "01 safe.png"])(
    "rejects unsafe screenshot checkpoint %s",
    (checkpoint) => {
      const manifest = DogfoodScenarioManifest.parse(manifestFixture());
      const unsafe = structuredClone(manifest);
      unsafe.scenarios[0]!.screenshotCheckpoints = [checkpoint];

      expect(() => DogfoodScenarioManifest.parse(unsafe)).toThrow();
    },
  );

  it("rejects malformed baselines, costs, missing facts, and unknown fields", () => {
    const manifest = DogfoodScenarioManifest.parse(manifestFixture());

    const malformed = structuredClone(manifest) as Record<string, unknown> & {
      scenarios: Array<Record<string, unknown>>;
    };
    malformed.scenarios[0]!["externalBaselineCommit"] = "00e592c";
    malformed.scenarios[0]!["costCeilingUsd"] = Number.POSITIVE_INFINITY;
    malformed.scenarios[0]!["authoritativeFacts"] = [];
    malformed["unreviewed"] = true;

    expect(() => DogfoodScenarioManifest.parse(malformed)).toThrow();
  });
});

describe("dogfood controller/render truth comparator", () => {
  it("returns no issues for aligned controller facts and rendering", () => {
    expect(
      compareDogfoodEvidence({
        controller: {
          bash: { exitCode: 0, signal: null },
          review: { pending: true, grantable: true, terminal: false },
          mutation: { available: true },
          verification: { status: "passed" },
          interrupt: { state: "queued" },
        },
        rendered: {
          bash: { status: "succeeded" },
          review: { state: "actionable" },
          mutation: { state: "available" },
          verification: { status: "passed" },
          interrupt: { state: "queued" },
        },
      }),
    ).toEqual([]);
  });

  it("accepts aligned indeterminate bash and non-grantable pending review states", () => {
    expect(
      compareDogfoodEvidence({
        controller: {
          bash: { exitCode: null, signal: null },
          review: { pending: true, grantable: false, terminal: false },
        },
        rendered: {
          bash: { status: "indeterminate" },
          review: { state: "waiting" },
        },
      }),
    ).toEqual([]);
  });

  it("flags an exit-zero command rendered as failed", () => {
    expect(
      compareDogfoodEvidence({
        controller: { bash: { exitCode: 0, signal: null } },
        rendered: { bash: { status: "failed" } },
      }),
    ).toEqual([
      {
        code: "bash-render-mismatch",
        domain: "bash",
        expected: "succeeded",
        rendered: "failed",
      },
    ]);
  });

  it("flags each observed contradiction in deterministic authority order", () => {
    const issues = compareDogfoodEvidence({
      controller: {
        bash: { exitCode: 1, signal: null },
        review: { pending: false, grantable: false, terminal: true },
        mutation: { available: false },
        verification: { status: "not-run" },
        interrupt: { state: "interrupted" },
      },
      rendered: {
        bash: { status: "succeeded" },
        review: { state: "actionable" },
        mutation: { state: "available" },
        verification: { status: "passed" },
        interrupt: { state: "completed" },
      },
    });

    expect(issues).toEqual([
      {
        code: "bash-render-mismatch",
        domain: "bash",
        expected: "failed",
        rendered: "succeeded",
      },
      {
        code: "review-render-mismatch",
        domain: "review",
        expected: "terminal",
        rendered: "actionable",
      },
      {
        code: "mutation-render-mismatch",
        domain: "mutation",
        expected: "unavailable",
        rendered: "available",
      },
      {
        code: "verification-render-mismatch",
        domain: "verification",
        expected: "not-run",
        rendered: "passed",
      },
      {
        code: "interrupt-render-mismatch",
        domain: "interrupt",
        expected: "interrupted",
        rendered: "completed",
      },
    ]);
  });

  it("flags signal exits, omitted mutation evidence, and omitted actionable reviews", () => {
    expect(
      compareDogfoodEvidence({
        controller: {
          bash: { exitCode: null, signal: "SIGTERM" },
          review: { pending: true, grantable: true, terminal: false },
          mutation: { available: true },
        },
        rendered: {
          bash: { status: "succeeded" },
          review: { state: "unavailable" },
          mutation: { state: "omitted" },
        },
      }).map((issue) => issue.code),
    ).toEqual(["bash-render-mismatch", "review-render-mismatch", "mutation-render-mismatch"]);
  });

  it("flags queued input rendered as already applied", () => {
    expect(
      compareDogfoodEvidence({
        controller: { interrupt: { state: "queued" } },
        rendered: { interrupt: { state: "applied" } },
      }),
    ).toEqual([
      {
        code: "interrupt-render-mismatch",
        domain: "interrupt",
        expected: "queued",
        rendered: "applied",
      },
    ]);
  });

  it("rejects inconsistent lifecycle facts and unknown observation fields", () => {
    expect(() =>
      compareDogfoodEvidence({
        controller: {
          review: { pending: true, grantable: true, terminal: true },
          policyDecision: "allow",
        },
        rendered: { review: { state: "actionable" } },
      }),
    ).toThrow();
  });

  it("rejects authority claims that make a terminal review grantable", () => {
    expect(() =>
      compareDogfoodEvidence({
        controller: { review: { pending: false, grantable: true, terminal: true } },
        rendered: { review: { state: "terminal" } },
      }),
    ).toThrow(/only a pending review can be grantable/);
  });

  it.each([
    {
      controller: { bash: { exitCode: 0, signal: null } },
      rendered: {},
    },
    {
      controller: {},
      rendered: { bash: { status: "succeeded" } },
    },
  ])("rejects unpaired controller/render evidence", (observation) => {
    expect(() => compareDogfoodEvidence(observation)).toThrow(/must be paired/);
  });

  it("returns presentation mismatches only, never a policy decision", () => {
    const [issue] = compareDogfoodEvidence({
      controller: { review: { pending: false, grantable: false, terminal: true } },
      rendered: { review: { state: "actionable" } },
    });

    expect(issue).toBeDefined();
    expect(Object.keys(issue!)).toEqual(["code", "domain", "expected", "rendered"]);
    expect(JSON.stringify(issue)).not.toMatch(/allow|deny|verdict|decision/i);
  });
});
