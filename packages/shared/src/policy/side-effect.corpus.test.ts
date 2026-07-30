import { describe, expect, it } from "vitest";
import { SideEffect, hasExfilDataflowPath, type SideEffectTargetT } from "./side-effect.js";
import { SIDE_EFFECT_CORPUS, type CorpusCategory } from "./side-effect.fixtures.js";

/**
 * §7 adversarial classifier corpus — invariant suite (the freeze proof obligation). Today these prove
 * the EXPECTED LABELS are schema-valid and internally consistent with the §7 rules (BOTH directions:
 * secret namespaces ARE secret, benign paths are NOT; benign composition is NOT obfuscated, genuine
 * obscuring IS; exfil is detected ONLY when data flows). At the Phase-2A freeze the same corpus gates
 * the real warden classifier (it must reproduce these labels).
 */
const ALL_CATEGORIES: readonly CorpusCategory[] = [
  "secret_read",
  "destructive",
  "network",
  "obfuscation",
  "benign_compound",
  "process_perm",
  "exfil",
];

/** Namespaces POL-001/SEC-006 treat as secret — any target resolving here must be tagged `secret`.
 *  Broadened beyond .env/.aws/.ssh to the credential stores POL-001 implies (QC security F6). */
const SECRET_PATTERN =
  /(^|\/)\.env(\.|\/|$)|\.aws(\/|$)|\.ssh(\/|$)|\.netrc(\/|$)|\.docker(\/|$)|\.kube(\/|$)|\.npmrc(\/|$)|(^|\/)\.config\/gh\/|\/proc\/[^/]+\/environ/;

const isSecretNamespace = (t: SideEffectTargetT): boolean =>
  t.kind === "path" && (SECRET_PATTERN.test(t.value) || SECRET_PATTERN.test(t.normalized ?? ""));

describe("§7 side-effect classifier corpus (freeze proof obligation)", () => {
  it("has unique ids and covers every §7 category", () => {
    const ids = SIDE_EFFECT_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const present = new Set(SIDE_EFFECT_CORPUS.map((c) => c.category));
    for (const cat of ALL_CATEGORIES) expect(present.has(cat)).toBe(true);
  });

  it("maps every anchor §7 proof-obligation class to ≥1 fixture (executable coverage table)", () => {
    // The anchor (docs/design/2026-06-21-side-effect-taxonomy-problem.md §7) enumerates the command
    // classes the freeze must prove. This is the executable coverage map the freeze gates on (QC
    // re-review F7) — a new anchor class without a fixture fails here.
    const ANCHOR_COVERAGE: Record<string, readonly string[]> = {
      eval: ["eval-dynamic", "benign-opam-eval"],
      "bash -c / sh -c": ["bash-c-secret-read"],
      "command substitution $()": ["exfil-substitution", "benign-opam-eval"],
      backticks: ["exfil-backtick-substitution"],
      "process substitution <()": ["procsub-download-exec"],
      heredocs: ["benign-heredoc-write"],
      "base64 decode": ["base64-decode-exec"],
      "hex/url decode": ["hex-decode-exec"],
      "curl | bash": ["curl-pipe-bash"],
      "bash <(curl)": ["procsub-download-exec"],
      "package managers": ["npm-install"],
      "git push": ["git-push-force"],
      "git fetch": ["git-fetch"],
      symlinks: ["symlink-escape-secret-read"],
      "path traversal": ["path-traversal-to-dotenv"],
      ".env": ["read-dotenv"],
      "~/.aws": ["read-aws-creds"],
      "~/.ssh": ["read-ssh-key"],
      "/proc/self/environ": ["read-proc-environ"],
      "env/printenv": ["printenv-dump"],
      chmod: ["chmod-777"],
      chown: ["chown-recursive"],
      "background/nohup": ["nohup-daemon"],
      "fork bomb": ["fork-bomb"],
      dd: ["dd-overwrite"],
      "busy loop": ["busy-loop-cpu"],
      rm: ["rm-rf-workspace", "rm-rf-system"],
      truncate: ["truncate-zero"],
      "find -delete": ["find-delete"],
      "git reset --hard": ["git-reset-hard"],
      "script-lang -c opacity": ["python-c-opaque"],
    };
    const ids = new Set(SIDE_EFFECT_CORPUS.map((c) => c.id));
    for (const [cls, refs] of Object.entries(ANCHOR_COVERAGE)) {
      expect(refs.length, `${cls}: no fixture mapped`).toBeGreaterThan(0);
      for (const id of refs) expect(ids.has(id), `${cls} → ${id} (missing fixture)`).toBe(true);
    }
  });

  it("every expected classification is schema-valid and canonicalizes idempotently", () => {
    for (const c of SIDE_EFFECT_CORPUS) {
      const parsed = SideEffect.parse(c.expected); // validates + canonicalizes (sorts set-arrays)
      expect(SideEffect.parse(parsed), c.id).toEqual(parsed); // idempotent → hash-stable
    }
  });

  it("tags every known-secret namespace `secret` (normative; no DOWNWARD classification)", () => {
    let matched = 0;
    for (const c of SIDE_EFFECT_CORPUS) {
      for (const t of c.expected.dynamic.targets) {
        if (isSecretNamespace(t)) {
          matched++;
          expect(t.sensitivity, `${c.id}: ${t.value}`).toBe("secret");
        }
      }
    }
    expect(
      matched,
      "no secret-namespace targets matched — the invariant would pass vacuously",
    ).toBeGreaterThan(3);
    // each secret_read case actually carries a secret target
    for (const c of SIDE_EFFECT_CORPUS.filter((x) => x.category === "secret_read")) {
      const hasSecret = c.expected.dynamic.targets.some((t) => t.sensitivity === "secret");
      expect(hasSecret, c.id).toBe(true);
    }
  });

  it("never tags a NON-secret-namespace path `secret` (no UPWARD over-classification)", () => {
    let benignPaths = 0;
    for (const c of SIDE_EFFECT_CORPUS) {
      for (const t of c.expected.dynamic.targets) {
        if (t.kind === "path" && !isSecretNamespace(t)) {
          benignPaths++;
          expect(t.sensitivity, `${c.id}: ${t.value} should not be over-tagged secret`).not.toBe(
            "secret",
          );
        }
      }
    }
    // a classifier that tagged everything `secret` would fail the above; prove the sample is non-empty
    expect(
      benignPaths,
      "no benign path targets — over-classification guard would pass vacuously",
    ).toBeGreaterThan(3);
  });

  it("never labels benign composition `obfuscated`/`unknown` (over-classification guard)", () => {
    const benign = SIDE_EFFECT_CORPUS.filter((x) => x.category === "benign_compound");
    expect(benign.length).toBeGreaterThan(0);
    for (const c of benign) {
      const conf = c.expected.dynamic.classifier.confidence;
      expect(["exact", "conservative"], c.id).toContain(conf);
    }
  });

  it("labels genuinely obscuring inputs `obfuscated`", () => {
    const obf = SIDE_EFFECT_CORPUS.filter((x) => x.category === "obfuscation");
    expect(obf.length).toBeGreaterThan(0);
    for (const c of obf) {
      expect(c.expected.dynamic.classifier.confidence, c.id).toBe("obfuscated");
    }
  });

  it("detects exfil dataflow iff data actually flows secret→external (incl. single-segment upload, transitive, env-dump, substitution/redirect; NOT on ordering/file edges)", () => {
    // covers escaped mutants: transitivity (exfil-transitive-3seg), isSecretSource env_var (exfil-env-dump),
    // same-segment upload (exfil-single-segment-upload), benign-source (exfil-negative-benign-source),
    // local-sink (exfil-negative-local-sink), and the file-mediated KNOWN LIMITATION
    // (exfil-file-mediated-unmodeled → false, by design).
    let trueCount = 0;
    let falseCount = 0;
    for (const c of SIDE_EFFECT_CORPUS) {
      expect(hasExfilDataflowPath(c.expected), c.id).toBe(c.expectExfil);
      if (c.expectExfil) trueCount++;
      else falseCount++;
    }
    expect(trueCount, "expected some positive exfil cases").toBeGreaterThan(3);
    expect(falseCount, "expected some negative exfil cases").toBeGreaterThan(3);
  });

  it("the exfil pair differs ONLY by edge relation, yet is structurally distinguishable", () => {
    const piped = SIDE_EFFECT_CORPUS.find((c) => c.id === "exfil-pipe")!;
    const seq = SIDE_EFFECT_CORPUS.find((c) => c.id === "exfil-sequence-no-flow")!;
    expect(piped.expected.dynamic.effectKinds).toEqual(seq.expected.dynamic.effectKinds);
    expect(piped.expected.dynamic.scopes).toEqual(seq.expected.dynamic.scopes);
    expect(hasExfilDataflowPath(piped.expected)).toBe(true);
    expect(hasExfilDataflowPath(seq.expected)).toBe(false);
  });
});
