import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const archiveDocsPresent = existsSync(join(repoRoot, "PROGRESS.md"));
const simulatePublicSeed = process.env["KEEL_PUBLIC_SEED_TEST"] === "1" || !archiveDocsPresent;

function isArchiveOnlyPath(path: string): boolean {
  return (
    path === "PROGRESS.md" ||
    path === "CLAUDE.md" ||
    path === "docs/execution" ||
    path.startsWith("docs/execution/") ||
    path === "docs/superpowers" ||
    path.startsWith("docs/superpowers/")
  );
}

function repoFileAvailable(path: string): boolean {
  return !(simulatePublicSeed && isArchiveOnlyPath(path)) && existsSync(join(repoRoot, path));
}

function readRepoFile(path: string): string {
  if (simulatePublicSeed && isArchiveOnlyPath(path)) {
    throw new Error(`public-seed simulation forbids archive-only path: ${path}`);
  }
  return readFileSync(join(repoRoot, path), "utf8");
}

const RUNNABLE_PLACEHOLDER_PACKAGE_COMMAND =
  /^\s*(?:(?:[-*+]|\d+\.)\s+)?(?:\$\s*)?(?:(?:env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)*|command|sudo(?:\s+-\S+)*)\s+)*(?:npx(?:\s+(?:--yes|-y))?\s+keel-harness|npm\s+(?:exec|x)\s+(?:--\s+)?keel-harness|(?:pnpm|yarn)\s+dlx\s+keel-harness)(?:\s|$)/im;

function markdownFilesUnder(relativeDir: string): string[] {
  const absoluteDir = join(repoRoot, relativeDir);
  if (!repoFileAvailable(relativeDir)) {
    return [];
  }
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDir, entry.name);
    // A research spike may have its own ignored install tree. Repository tests must not depend on
    // ignored machine-local dependency docs that are absent from the committed/public seed.
    if (entry.isDirectory() && entry.name !== "node_modules") {
      return markdownFilesUnder(relativePath);
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [relativePath] : [];
  });
}

function publicTextFilesUnder(relativeDir: string): string[] {
  const absoluteDir = join(repoRoot, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "build") {
      return publicTextFilesUnder(relativePath);
    }
    return entry.isFile() && /\.(?:c|js|json|md|mjs|py|rs|sh|ts|tsx|ya?ml)$/u.test(entry.name)
      ? [relativePath]
      : [];
  });
}

// --- P1-7: a real overclaim guard (not a per-file stale-phrase blacklist) ---
//
// keel's charter forbids claiming a property the code does not structurally provide ("downgrade the
// claim, not the honesty"). This scans a VOCABULARY of absolute-security overclaims across the
// governing + public + charter docs (AGENTS.md, CONTRIBUTING, MASTER_SPEC, README, SECURITY, the
// claim ledger, and every ADR). It is **negation-aware**: an overclaim term is a violation only when
// asserted POSITIVELY — the honest disclaimed forms ("tamper-EVIDENT, not tamper-proof", "the model
// is NOT immune to injection", "we don't claim keel is unhackable") still pass. Prefer a false
// negative (miss one) over a false positive (block an honest doc); the guard is a floor, not a proof.

/** Absolute-security / marketing-absolute overclaims. keel must never assert any of these; the honest
 *  form is always a narrower, disclaimed statement. Matched case-insensitively; `[-\s]?` tolerates a
 *  hyphen OR a space between words ("tamper-proof" / "tamper proof"). NOTE: these words are banned in
 *  the governing docs even in a non-security sense ("an airtight argument") — the scanned set is small
 *  and curated, so we keep the rule blunt rather than risk missing a real security overclaim. */
const OVERCLAIM_VOCABULARY = [
  "unhackable",
  "unbreakable",
  "uncompromisable",
  "hack[-\\s]*proof",
  "tamper[-\\s]*proof",
  "bullet[-\\s]*proof",
  "fool[-\\s]*proof",
  "escape[-\\s]*proof",
  "jailbreak[-\\s]*proof",
  "impenetrable",
  "air[-\\s]*tight",
  "military[-\\s]+grade",
  "bank[-\\s]+grade",
  "injection[-\\s]*proof",
  "provably secure",
  "100% secure",
  "completely secure",
  "totally secure",
  "immune to (?:injection|attack|prompt|compromise|tampering)",
  "guaranteed secure",
  "security guarantee",
  "zero attack surface",
  "prevents all\\b.{0,24}?(?:attacks?|injection|exfiltration|compromise|tampering)",
  "impossible to (?:exfiltrate|escape|bypass|tamper|hijack|compromise)",
  "(?:exfiltration|escape|compromise|tampering|bypass|injection|leak\\w*) (?:is|are)? ?impossible",
  "eliminates? the risk of",
];

/** Overclaims phrased as a NEGATIVE capability ("cannot be hijacked") whose honest counterpart reads
 *  the other way ("the model CAN be fooled") — so they are forbidden outright, not negation-gated. */
const NEGATIVE_CAPABILITY_OVERCLAIMS = [
  "can['’]?t be hijacked",
  "cannot be hijacked",
  "hijack[-\\s]*proof",
  "can['’]?t be (?:fooled|injected|tampered)",
  "cannot be (?:fooled|injected|tampered)",
  "can (?:never|['’]?t) (?:leak|escape|be bypassed)",
  "secrets? can never leak",
];

/** Docs whose claims are read as authoritative by users/auditors/forkers. */
const OVERCLAIM_SCANNED_DOCS = (): string[] => [
  "README.md",
  "SECURITY.md",
  "MASTER_SPEC.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/roadmap.md",
  "docs/benchmarks.md",
  "docs/quality/claim-ledger.md",
  ...readdirSync(join(repoRoot, "docs/adr"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/adr/${f}`),
  // User-facing usability guides: the surface where an overclaim would mislead most directly.
  ...readdirSync(join(repoRoot, "docs/guide"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/guide/${f}`),
  // The published landing page (keel-harness.com). It is the highest-traffic claim surface the
  // project owns and the one most likely to drift toward marketing language, so it is held to the
  // same vocabulary floor as the governing docs. Markup is scanned as text: an overclaim is just as
  // misleading inside a <p> as inside a paragraph of Markdown.
  ...(existsSync(join(repoRoot, "site/index.html")) ? ["site/index.html"] : []),
];

// Deliberately excludes bare "no" — it is a common word that would exempt an unrelated overclaim
// nearby ("keel has no peer — it is unhackable"). `not`/`never`/`n't`/`without`/`neither`/`≠` cover the
// honest disclaimers keel actually writes ("not tamper-proof", "we do not claim …", "≠ immunity").
const NEGATION_MARKER = /\b(?:not|never|neither|without)\b|n['’]t|≠/i;

/** Return each overclaim asserted POSITIVELY in `text` (empty = clean). A vocabulary term is allowed
 *  when a negation precedes it within the same line (an honest disclaimer); the negative-capability
 *  phrases are never allowed. */
function findOverclaims(text: string): { term: string; line: string }[] {
  const hits: { term: string; line: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    for (const term of OVERCLAIM_VOCABULARY) {
      const re = new RegExp(term, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const before = line.slice(Math.max(0, m.index - 32), m.index);
        if (!NEGATION_MARKER.test(before)) {
          hits.push({ term, line: line.trim().slice(0, 140) });
          break;
        }
      }
    }
    for (const term of NEGATIVE_CAPABILITY_OVERCLAIMS) {
      if (new RegExp(term, "i").test(line)) hits.push({ term, line: line.trim().slice(0, 140) });
    }
  }
  return hits;
}

describe("public docs claim consistency", () => {
  it("keeps README status aligned with open-source preparation evidence and limitations", () => {
    const readme = readRepoFile("README.md");
    const blockquoteText = readme.replace(/\n>\s*/g, " ");

    expect(readme).not.toMatch(/Phase 2A warden build in progress/i);
    expect(readme).not.toMatch(/Other typed tools are intentionally unavailable/i);
    expect(readme).not.toMatch(/No all-tool governance,\s*signed evidence/i);
    expect(readme).not.toMatch(/later evidence hardening land/i);

    expect(readme).not.toMatch(/private developer preview/i);
    expect(readme).toMatch(/open-source preparation/i);
    expect(readme).toMatch(/trusted `read`\/`search`\/`write`\/`edit`/i);
    expect(readme).toMatch(/signed.*offline.*evidence/i);
    expect(readme).toMatch(/macOS audit-latency pass/i);
    expect(readme).toMatch(/comparable live TB-2/i);
    expect(readme).toMatch(/out-of-band signer key/i);
    expect(blockquoteText).toMatch(/not a stable or public-alpha\s+release/i);
  });

  it("keeps SECURITY status aligned with the current threat model instead of stale Phase-1 wording", () => {
    const security = readRepoFile("SECURITY.md");
    const spec = readRepoFile("MASTER_SPEC.md");
    const guide = readRepoFile("docs/guide/security-model.md");
    const ledger = readRepoFile("docs/quality/claim-ledger.md");

    expect(security).not.toMatch(/Phase 1/i);
    expect(security).not.toMatch(/no enforcement and no\s+security guarantees/i);
    expect(security).not.toMatch(/trust plane .* lands in Phase 2/i);

    expect(security).toMatch(/pre-alpha/i);
    expect(security).not.toMatch(/private developer-preview readiness/i);
    expect(security).toMatch(/open-source preparation/i);
    expect(security).toMatch(/not a stable or public-alpha release/i);
    expect(security).toMatch(/same-user malware/i);
    expect(security).toMatch(/out-of-band signer key/i);
    expect(security).toMatch(/private vulnerability reporting/i);
    expect(spec).toMatch(/classification fidelity.*classifier claim/is);
    expect(spec).toMatch(/tamper-evidence.*integrity.*not.*semantic/is);
    expect(spec).toContain("$HOME/.ssh/id_rsa");
    expect(guide).toMatch(/audit tamper-evidence.*semantic classification/is);
    expect(ledger).toMatch(/audit integrity does not guarantee semantic classification accuracy/i);
  });

  it("keeps support guidance aligned with the monitored private vulnerability channel", () => {
    const security = readRepoFile("SECURITY.md");
    const support = readRepoFile("SUPPORT.md");

    expect(security).toMatch(/private vulnerability reporting/i);
    expect(support).toMatch(/private vulnerability reporting/i);
    expect(support).not.toMatch(/fallback\s+email/i);
  });

  it("keeps package metadata from advertising the stale bash-only Phase-2A posture", () => {
    const releaseMetadata = readRepoFile("packaging/release-metadata.ts");

    expect(releaseMetadata).not.toMatch(/Phase 2A: warden-governed bash/i);
    expect(releaseMetadata).not.toMatch(/private developer preview readiness/i);
    expect(releaseMetadata).toMatch(/pre-alpha/i);
    expect(releaseMetadata).toMatch(/structurally enforced boundaries/i);
  });

  it("uses the locked name (not the taken 'keel' placeholder / working-codename marker) (P0-8)", () => {
    const readme = readRepoFile("README.md");
    const packaging = readRepoFile("packaging/build.ts");
    const releaseMetadata = readRepoFile("packaging/release-metadata.ts");
    const spec = readRepoFile("MASTER_SPEC.md");

    // The name was locked 2026-07-09 (product "keel", npm "keel-harness"): the front-page H1 must not
    // still call the name provisional, and the publishable package must not ship as the taken bare
    // "keel" placeholder.
    expect(readme).not.toMatch(/working codename/i);
    expect(releaseMetadata).not.toMatch(/PUBLIC_PACKAGE_NAME = "keel"/);
    expect(releaseMetadata).toMatch(/PUBLIC_PACKAGE_NAME = "keel-harness"/);
    expect(spec).not.toMatch(/"keel" is a working placeholder/i);
    expect(spec).toMatch(/product \/ brand: `keel`/i);
    expect(spec).toMatch(/npm package: `keel-harness`/i);

    // Public install strings must name the PACKAGE (`keel-harness`), not the taken bare `keel`
    // package — the command is still `keel`, but `npx <pkg>` takes the package name. `(?![-\w])`
    // forbids bare `npx keel` while allowing `npx keel-harness`.
    expect(readme).not.toMatch(/npx keel(?![-\w])/);
    expect(spec).not.toMatch(/npx keel(?![-\w])/);
    expect(packaging).not.toMatch(/npx keel(?![-\w])/);
  });

  it("keeps the placeholder npm package from becoming a broken public quickstart", () => {
    const readme = readRepoFile("README.md");
    const publicDocs = [
      "MASTER_SPEC.md",
      "README.md",
      "SECURITY.md",
      ...markdownFilesUnder("docs").filter(
        (doc) => !doc.startsWith("docs/execution/") && !doc.startsWith("docs/superpowers/"),
      ),
    ];

    expect(readme).toMatch(/`keel-harness@0\.0\.1`[^.]*placeholder/i);
    expect(readme).toMatch(/do not use it as the release carrier/i);
    for (const doc of publicDocs) {
      expect(
        readRepoFile(doc),
        `${doc} contains a runnable placeholder-package instruction`,
      ).not.toMatch(RUNNABLE_PLACEHOLDER_PACKAGE_COMMAND);
    }
  });

  it.each([
    "npx keel-harness",
    "$ npx keel-harness",
    "env KEEL_TRUST=1 npx keel-harness",
    "command npx keel-harness",
    "sudo npx keel-harness",
    "npm exec keel-harness",
    "npm exec -- keel-harness",
    "pnpm dlx keel-harness",
    "yarn dlx keel-harness",
  ])("recognizes runnable placeholder-package command: %s", (command) => {
    expect(command).toMatch(RUNNABLE_PLACEHOLDER_PACKAGE_COMMAND);
  });

  it.each([
    "The npm name is reserved; do not run npx keel-harness yet.",
    "Public npx keel-harness remains gated on a real signed carrier.",
    "`npx keel-harness` is a roadmap command, not an install instruction.",
  ])("does not mistake explanatory prose for a runnable command: %s", (prose) => {
    expect(prose).not.toMatch(RUNNABLE_PLACEHOLDER_PACKAGE_COMMAND);
  });

  it("scopes MCP proof to reviewed pinned local-stdio calls", () => {
    const readme = readRepoFile("README.md");

    expect(readme).toMatch(/reviewed, pinned local-stdio MCP/i);
    expect(readme).toMatch(/spawned Warden/i);
    expect(readme).toMatch(/remote, localhost, and unreviewed MCP/i);
    expect(readme).toMatch(/resources, prompts, sampling, and elicitation/i);
  });

  it("keeps tracked documentation portable and free of private local attachment roots", () => {
    const docs = [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "MASTER_SPEC.md",
      "README.md",
      "SECURITY.md",
      ...(repoFileAvailable("PROGRESS.md") ? ["PROGRESS.md"] : []),
      ...markdownFilesUnder("docs"),
    ];
    const builderHomePath =
      /\/Users\/(?!<user>\/)[^/\s`"']+\/(?:[^\s`"']*\/)?(?:keel-harness|\.bun|\.codex\/attachments)(?:\/|$)/i;

    for (const doc of docs) {
      const text = readRepoFile(doc);
      expect(text, `${doc} contains a builder-specific absolute home path`).not.toMatch(
        builderHomePath,
      );
      expect(text, `${doc} contains a private Codex attachment root`).not.toMatch(
        /\/Users\/[^/\s]+\/\.codex\/attachments\/[0-9a-f-]+\//i,
      );
    }
  });

  it("keeps the fresh public history free of opaque private remediation provenance", () => {
    const files = [
      "AGENTS.md",
      "CHANGELOG.md",
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "MASTER_SPEC.md",
      "README.md",
      "SECURITY.md",
      "SUPPORT.md",
      "package.json",
      ...publicTextFilesUnder(".github"),
      ...publicTextFilesUnder("docs"),
      ...publicTextFilesUnder("eval"),
      ...publicTextFilesUnder("packages").filter(
        (file) => file !== "packages/kernel/src/cli/docs-claim-consistency.test.ts",
      ),
      ...publicTextFilesUnder("packaging"),
    ];
    const forbidden = [
      /issue[-_]?388/iu,
      /#(?:78|88|268|325)\b/u,
      /\bPR[1-5]\b/u,
      /\bB1b\b/u,
      /\bB3\b/u,
      /\bkeel-(?:14|59)\b/iu,
      /matrix-B-noverify\.json/iu,
      /\bepic318\b/iu,
      /\brun-b1b\b/iu,
      /\bb3-run-1\b/iu,
      /\bfeat\/(?:cache-rolling-breakpoints|cache-ttl-lever|epic-1\.23-slice2-resume)\b/iu,
      /\bfix\/pre-warden-qc-r1-hardening\b/iu,
      /keel-final-dogfood-[0-9]{8}T[0-9]{6}Z/iu,
      /56\.5\/100/u,
    ];

    for (const file of files) {
      const text = readRepoFile(file);
      for (const pattern of forbidden) {
        expect(text, `${file} contains opaque private provenance ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not let §1.3 launch copy overclaim injection immunity (P0-6)", () => {
    const spec = readRepoFile("MASTER_SPEC.md");
    const readme = readRepoFile("README.md");
    // "Your agent can't be hijacked by a web page" is broader than §1.2(1)'s own body (which never
    // claims injection immunity — the model CAN be fooled; what's structurally prevented is
    // exfiltration through governed tools). The headline-never-broader-than-body rule forbids it.
    expect(spec).not.toMatch(/can't be hijacked by a web page/i);
    expect(spec).not.toMatch(/cannot be hijacked by a web page/i);
    expect(readme).not.toMatch(/can't be hijacked by a web page/i);
  });

  it("keeps the §3.3 threat model reconciled with the shipped privileged surfaces (P0-5)", () => {
    const spec = readRepoFile("MASTER_SPEC.md");
    // §3 is the trust anchor auditors read first; every shipped surface's non-defenses must be in the
    // canonical "document, never hide" list, not only in ADRs / the claim ledger.
    expect(spec).toMatch(/provider-API egress is not warden-governed/i);
    expect(spec).toMatch(/guest OS[^.]*ungoverned/i);
    expect(spec).toMatch(/MCP server[^.]*trust-on-first-use/i);
    expect(spec).toMatch(/DNS rebinding/i);
    expect(spec).toMatch(/classifier residual/i);
  });

  it("keeps Phase-2 closeout docs from reintroducing pending-CI or all-tool claims", () => {
    const spec = readRepoFile("MASTER_SPEC.md");
    const closeoutPath = "docs/execution/phase-2-closeout-preview-readiness.md";

    expect(spec).not.toMatch(/all tool execution flows through it/i);
    expect(spec).not.toMatch(/All-tool warden execution bridge/i);
    expect(spec).toMatch(/claimed product tool/i);

    if (repoFileAvailable(closeoutPath)) {
      const closeout = readRepoFile(closeoutPath);
      expect(closeout).not.toMatch(/PR\/post-merge CI pending/i);
      expect(closeout).not.toMatch(/PR CI, post-merge CI, and worktree cleanup are external/i);
      expect(closeout).toMatch(/current `main`/i);
    }

    if (repoFileAvailable("PROGRESS.md")) {
      const progress = readRepoFile("PROGRESS.md");
      expect(progress).not.toMatch(/PR\/MAIN CI PENDING/i);
      expect(progress).not.toMatch(/PR CI, post-merge main CI, primary-checkout sync/i);
    }
  });

  it("runs without archive-only documents in the curated public-seed profile", () => {
    expect(repoFileAvailable("README.md")).toBe(true);
    expect(repoFileAvailable("packages/kernel/src/cli/docs-claim-consistency.test.ts")).toBe(true);
    expect(repoFileAvailable("PROGRESS.md")).toBe(!simulatePublicSeed);
    expect(repoFileAvailable("docs/execution/phase-2-closeout-preview-readiness.md")).toBe(
      !simulatePublicSeed,
    );
  });
});

describe("overclaim vocabulary guard (P1-7)", () => {
  // Non-vacuity: the guard must actually BITE on a positive overclaim and, just as importantly, must
  // NOT fire on keel's honest disclaimed phrasings (else it would push writers toward LESS honesty).
  it("flags positive absolute-security overclaims", () => {
    expect(findOverclaims("keel is unhackable")).not.toHaveLength(0);
    expect(findOverclaims("the audit log is tamper-proof")).not.toHaveLength(0);
    expect(findOverclaims("military-grade security")).not.toHaveLength(0);
    expect(findOverclaims("makes your agent immune to injection")).not.toHaveLength(0);
    expect(findOverclaims("100% secure by construction")).not.toHaveLength(0);
  });

  it("flags whitespace-separated forms, not just hyphenated (S1)", () => {
    expect(findOverclaims("the audit log is TAMPER PROOF")).not.toHaveLength(0);
    expect(findOverclaims("military   grade security")).not.toHaveLength(0);
    expect(findOverclaims("the design is fool proof")).not.toHaveLength(0);
  });

  it("flags the additional overclaim phrasings (S3)", () => {
    expect(findOverclaims("keel prevents all prompt injection")).not.toHaveLength(0);
    expect(findOverclaims("keel makes exfiltration impossible")).not.toHaveLength(0);
    expect(findOverclaims("it is impossible to exfiltrate secrets")).not.toHaveLength(0);
    expect(findOverclaims("keel has zero attack surface")).not.toHaveLength(0);
    expect(findOverclaims("keel is unbreakable")).not.toHaveLength(0);
    expect(findOverclaims("your secrets can never leak")).not.toHaveLength(0);
    expect(findOverclaims("this eliminates the risk of exfiltration")).not.toHaveLength(0);
  });

  it("bare 'no' near an overclaim no longer exempts it (S2 vacuity hole)", () => {
    expect(findOverclaims("keel has no peer — it is unhackable")).not.toHaveLength(0);
  });

  it("flags negative-capability overclaims (honest form reads the other way)", () => {
    expect(findOverclaims("your agent cannot be hijacked by a web page")).not.toHaveLength(0);
    expect(findOverclaims("keel is hijack-proof")).not.toHaveLength(0);
  });

  it("does NOT flag the honest disclaimed forms keel actually uses", () => {
    expect(findOverclaims("the audit chain is tamper-evident, not tamper-proof")).toEqual([]);
    expect(findOverclaims("the model is not immune to injection — it can be fooled")).toEqual([]);
    expect(findOverclaims("we do not claim keel is unhackable")).toEqual([]);
    expect(findOverclaims("the model can be hijacked; what is prevented is exfiltration")).toEqual(
      [],
    );
    expect(findOverclaims("keel is tamper-evident (SEC-008)")).toEqual([]);
  });

  it.each(OVERCLAIM_SCANNED_DOCS())("keeps %s free of unqualified overclaims", (doc) => {
    const found = findOverclaims(readRepoFile(doc));
    expect(
      found,
      `overclaim(s) in ${doc}: ${found.map((h) => `"${h.term}" — ${h.line}`).join(" | ")}`,
    ).toEqual([]);
  });
});

// --- Published landing page (site/index.html) ---
//
// The landing page is a claim surface with no reviewer between it and the public: it is what a
// launch post links to, and it is edited for persuasion rather than for accuracy. The markdown docs
// already have a guard; without this one the page is the single place where a claim can drift free
// of enforcement. These tests bind the page's numbers to the README that sources them, and keep the
// page's honest framing (pre-alpha status, the unpublished npm carrier) from being quietly dropped.
describe("landing page claim consistency (site/index.html)", () => {
  const PAGE = "site/index.html";
  const pageAvailable = existsSync(join(repoRoot, PAGE));
  const page = (): string => readRepoFile(PAGE);

  // Strip tags so assertions read the rendered sentence, not the markup that happens to split it.
  const pageText = (): string =>
    page()
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ");

  it.runIf(pageAvailable)("states the pre-alpha status without needing to scroll", () => {
    // The status is the first thing that makes every other claim on the page honest.
    expect(pageText()).toMatch(/pre-alpha/i);
    expect(pageText()).toMatch(/prototype|work in progress/i);
  });

  it.runIf(pageAvailable)("keeps the evidence numbers identical to the README's table", () => {
    // The page copies the README's evidence table. If the README is revised down (fewer tests, a
    // lower coverage number) and the page keeps the old figure, the page silently overclaims.
    const readme = readRepoFile("README.md");
    const text = pageText();

    const claims = [
      { what: "test count", re: /([\d,]+)\s*automated tests passed/i },
      { what: "statement coverage", re: /(\d+\.\d+)%\s*statements/i },
      { what: "branch coverage", re: /(\d+\.\d+)%\s*branches/i },
      { what: "security-suite count", re: /([\d,]+)\s*adversarial/i },
    ];

    for (const { what, re } of claims) {
      const fromReadme = readme.match(re);
      const fromPage = text.match(re);
      expect(fromReadme, `README no longer states the ${what}; update this guard`).not.toBeNull();
      expect(fromPage, `${PAGE} no longer states the ${what}`).not.toBeNull();
      expect(
        fromPage?.[1],
        `${PAGE} ${what} (${fromPage?.[1]}) disagrees with README (${fromReadme?.[1]})`,
      ).toBe(fromReadme?.[1]);
    }
  });

  it.runIf(pageAvailable)("never presents the reserved npm name as a working install", () => {
    // `npm i keel-harness` resolves to the 0.0.1 name-reservation placeholder, so shipping it as a
    // bare instruction hands visitors a stub. Showing the command is fine; showing it as ready is
    // not. (RUNNABLE_PLACEHOLDER_PACKAGE_COMMAND covers npx/dlx, which need no install step; this
    // covers the install form a landing-page quickstart actually reaches for.)
    const text = pageText();
    const mentionsInstall = /npm\s+(?:i|install)\b[^.]{0,40}keel-harness/i.test(text);

    if (mentionsInstall) {
      expect(text, `${PAGE} shows an npm install without saying it is unpublished`).toMatch(
        /not published|does not work|not yet available/i,
      );
      expect(text, `${PAGE} shows an npm install without explaining the placeholder`).toMatch(
        /placeholder|reserved/i,
      );
    }
    // Regardless of phrasing, the never-runnable forms stay banned outright.
    expect(page()).not.toMatch(RUNNABLE_PLACEHOLDER_PACKAGE_COMMAND);
  });

  it.runIf(pageAvailable)("keeps the load-bearing limitations on the page", () => {
    // The limits section is the page's credibility. Each of these is a limitation the README states
    // and a reader would otherwise reasonably assume keel had solved.
    const text = pageText();
    for (const limit of [
      /injection immunity|can still be fooled/i, // not injection-proof
      /provider api egress/i, // provider calls are ungoverned
      /tamper-evident/i, // not tamper-proof
      /windows/i, // unsupported platform
    ]) {
      expect(text, `${PAGE} dropped a required limitation: ${limit}`).toMatch(limit);
    }
  });

  it.runIf(pageAvailable)("links only to documentation that exists in the repository", () => {
    // A 404 from the launch page is the cheapest possible credibility loss.
    const blobLinks = [
      ...page().matchAll(/https:\/\/github\.com\/keel-harness\/keel\/blob\/main\/([^"#?]+)/g),
    ]
      .map((m) => m[1] ?? "")
      .filter(Boolean);

    expect(blobLinks.length, "expected the page to link to repository docs").toBeGreaterThan(0);
    const missing = [...new Set(blobLinks)].filter((p) => !existsSync(join(repoRoot, p)));
    expect(
      missing,
      `${PAGE} links to non-existent repository paths: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it.runIf(pageAvailable)("stays self-contained (no third-party subresources)", () => {
    // The page is served from the project's own domain. A CDN script, remote font, or tracker is a
    // third party that can change what a visitor executes — an unacceptable shape for this project.
    const html = page();
    expect(html, "external src=").not.toMatch(/src\s*=\s*"(?:https?:)?\/\//i);
    expect(html, "external stylesheet").not.toMatch(
      /<link[^>]+rel\s*=\s*"stylesheet"[^>]+href\s*=\s*"(?:https?:)?\/\//i,
    );
    expect(html, "external CSS @import").not.toMatch(/@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
    expect(html, "external url() in CSS").not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
  });
});
