import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface EvidenceEntry {
  readonly value: number;
  readonly command: string;
  readonly detail: string;
}

interface EvidenceLedger {
  readonly schemaVersion: number;
  readonly stalenessWindowDays: number;
  readonly measuredAt: { readonly date: string; readonly commit: string };
  readonly evidence: Readonly<
    Record<
      | "branchCoveragePercent"
      | "perFileCoverageFloorPercent"
      | "securityTestsPassed"
      | "statementCoveragePercent"
      | "testsPassed"
      | "testsSkipped"
      | "wardenCoverageFloorPercent",
      EvidenceEntry
    >
  >;
}

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function ledger(): EvidenceLedger {
  return JSON.parse(readRepoFile("docs/quality/evidence-numbers.json")) as EvidenceLedger;
}

function formatted(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
}

function readmeEvidenceTable(readme: string): string {
  const section = readme.match(/## Evidence\n(?<body>[\s\S]*?)\n## /u)?.groups?.["body"];
  if (section === undefined) throw new Error("README Evidence section not found");
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .join("\n");
}

function numericTokens(value: string): string[] {
  return [
    ...value.matchAll(/(?<![A-Za-z0-9])(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![A-Za-z0-9])/gu),
  ].map((match) => match[0]);
}

describe("public evidence-number ledger", () => {
  it("records a source command and reproducible measurement provenance for every displayed figure", () => {
    const source = ledger();
    expect(source.schemaVersion).toBe(1);
    expect(source.stalenessWindowDays).toBeGreaterThan(0);
    expect(source.measuredAt.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(source.measuredAt.commit).toMatch(/^[0-9a-f]{40}$/u);

    expect(Object.keys(source.evidence).sort()).toEqual([
      "branchCoveragePercent",
      "perFileCoverageFloorPercent",
      "securityTestsPassed",
      "statementCoveragePercent",
      "testsPassed",
      "testsSkipped",
      "wardenCoverageFloorPercent",
    ]);
    for (const entry of Object.values(source.evidence)) {
      expect(entry.value).toBeGreaterThanOrEqual(0);
      expect(["pnpm test", "pnpm test:cov", "pnpm test:security"]).toContain(entry.command);
      expect(entry.detail).not.toBe("");
    }
  });

  it("keeps every README evidence-table number and command derived from the ledger", () => {
    const source = ledger();
    const table = readmeEvidenceTable(readRepoFile("README.md"));
    const metricRows = table
      .split("\n")
      .filter((line) => /^\| (?:Tests|Coverage|Security suite) \|/u.test(line))
      .join("\n");
    const evidence = source.evidence;

    expect(table).toContain(
      `| Tests | ${formatted(evidence.testsPassed.value)} automated tests passed; ${formatted(evidence.testsSkipped.value)} skipped | \`${evidence.testsPassed.command}\` |`,
    );
    expect(table).toContain(
      `| Coverage | ${formatted(evidence.statementCoveragePercent.value)}% statements / ${formatted(evidence.branchCoveragePercent.value)}% branches, enforced gate (per-file ≥${formatted(evidence.perFileCoverageFloorPercent.value)}%; warden ≥${formatted(evidence.wardenCoverageFloorPercent.value)}% lines/functions/statements) | \`${evidence.statementCoveragePercent.command}\` |`,
    );
    expect(table).toContain(
      `| Security suite | ${formatted(evidence.securityTestsPassed.value)} adversarial / denied-path tests passed | \`${evidence.securityTestsPassed.command}\` |`,
    );
    expect(numericTokens(metricRows)).toEqual([
      formatted(evidence.securityTestsPassed.value),
      formatted(evidence.testsPassed.value),
      formatted(evidence.testsSkipped.value),
      formatted(evidence.statementCoveragePercent.value),
      formatted(evidence.branchCoveragePercent.value),
      formatted(evidence.perFileCoverageFloorPercent.value),
      formatted(evidence.wardenCoverageFloorPercent.value),
    ]);
  });

  it("keeps the security guide and landing page on the same ledger values", () => {
    const source = ledger();
    const securityGuide = readRepoFile("docs/guide/security-model.md");
    const landingHtml = readRepoFile("site/index.html");
    const landingPage = landingHtml.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
    const count = formatted(source.evidence.securityTestsPassed.value);

    expect(securityGuide).toContain(
      `pnpm test:security        # ${count} adversarial and denied-path tests passed`,
    );
    expect(landingPage).toContain(
      `${formatted(source.evidence.testsPassed.value)} automated tests passed; ${formatted(source.evidence.testsSkipped.value)} skipped`,
    );
    expect(landingPage).toContain(
      `${formatted(source.evidence.statementCoveragePercent.value)}% statements, ${formatted(source.evidence.branchCoveragePercent.value)}% branches`,
    );
    expect(landingPage).toContain(`${count} adversarial and denied-path tests passed`);
    const landingTable = landingHtml.match(/<table>(?<body>[\s\S]*?)<\/table>/u)?.groups?.["body"];
    expect(landingTable, "landing-page evidence table not found").toBeDefined();
    expect(numericTokens(landingTable ?? "")).toEqual([
      formatted(source.evidence.securityTestsPassed.value),
      formatted(source.evidence.testsPassed.value),
      formatted(source.evidence.testsSkipped.value),
      formatted(source.evidence.statementCoveragePercent.value),
      formatted(source.evidence.branchCoveragePercent.value),
    ]);

    for (const text of [readRepoFile("README.md"), securityGuide, landingPage]) {
      expect(text).toContain(source.measuredAt.date);
      expect(text).toContain(source.measuredAt.commit.slice(0, 7));
      expect(text).toMatch(/evidence-number ledger/i);
    }
    for (const command of ["pnpm test", "pnpm test:cov", "pnpm test:security"]) {
      expect(landingPage).toContain(command);
    }
  });

  it("keeps documented coverage floors aligned with the executable Vitest gate", () => {
    const source = ledger();
    const config = readRepoFile("vitest.config.ts");
    const globalFloor = source.evidence.perFileCoverageFloorPercent.value;
    const wardenFloor = source.evidence.wardenCoverageFloorPercent.value;

    expect(config).toContain("perFile: true");
    for (const metric of ["lines", "functions", "branches", "statements"]) {
      expect(config).toContain(`${metric}: ${String(globalFloor)}`);
    }
    expect(config).toContain(
      `"packages/warden/src/**": { lines: ${String(wardenFloor)}, functions: ${String(wardenFloor)}, statements: ${String(wardenFloor)}, branches: ${String(globalFloor)} }`,
    );
  });

  it("expires measurements after the configured staleness window", () => {
    const source = ledger();
    const measuredAt = Date.parse(`${source.measuredAt.date}T00:00:00.000Z`);
    expect(Number.isNaN(measuredAt)).toBe(false);
    expect(new Date(measuredAt).toISOString().slice(0, 10)).toBe(source.measuredAt.date);
    const ageDays = Math.floor((Date.now() - measuredAt) / 86_400_000);
    expect(ageDays, "evidence numbers were measured in the future").toBeGreaterThanOrEqual(0);
    expect(
      ageDays,
      `evidence numbers are ${String(ageDays)} days old; rerun the ledger commands and refresh docs/quality/evidence-numbers.json`,
    ).toBeLessThanOrEqual(source.stalenessWindowDays);
  });
});
