import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const REQUIRED_SEC_IDS = [
  "SEC-001",
  "SEC-002",
  "SEC-003",
  "SEC-004",
  "SEC-005",
  "SEC-006",
  "SEC-007",
  "SEC-008",
  "SEC-009",
  "SEC-010",
  "SEC-011",
  "SEC-012",
  "SEC-013",
  "SEC-014",
  "SEC-015",
  "SEC-016",
  "SEC-017",
  "SEC-018",
  "SEC-019",
  "SEC-021",
  "SEC-027",
] as const;
const REQUIRED_SEC_MCP_IDS = [
  "SEC-MCP-01",
  "SEC-MCP-01b",
  "SEC-MCP-02",
  "SEC-MCP-03",
  "SEC-MCP-03b",
  "SEC-MCP-03c",
  "SEC-MCP-04",
  "SEC-MCP-05b",
  "SEC-MCP-07",
  "SEC-MCP-08",
  "SEC-MCP-09",
  "SEC-MCP-11",
  "SEC-MCP-14",
  "SEC-MCP-15",
] as const;

describe("Phase-2A security suite inventory", () => {
  it("maps the required SEC catalog to tests or explicit documented limitations", () => {
    const doc = readFileSync(join(repoRoot, "docs", "quality", "security-suite-v1.md"), "utf8");
    expect(doc).toContain("pnpm test:security");
    expect(doc).toContain("packages/kernel/src/warden/security-suite.test.ts");

    const rows = doc
      .split("\n")
      .filter((line) => /^\| SEC-\d{3} \|/u.test(line))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );

    expect(rows.map((row) => row[0])).toEqual([...REQUIRED_SEC_IDS]);
    const rowById = new Map(rows.map((row) => [row[0], row]));

    for (const row of rows) {
      const [id, status, coverage, honesty] = row as [string, string, string, string];
      expect(["PASS", "DOC-LIMIT (not pass)", "FOLLOW-UP"], `${id} status`).toContain(status);
      expect(coverage, `${id} coverage`).not.toBe("");
      expect(honesty, `${id} honesty`).not.toBe("");
      if (status === "DOC-LIMIT (not pass)") {
        expect(`${coverage} ${honesty}`).toMatch(/not counted as pass|documented limitation/i);
      }
    }

    for (const id of ["SEC-002", "SEC-011"] as const) {
      const row = rowById.get(id);
      expect(row, `${id} row`).toBeDefined();
      expect(row?.[1], `${id} must be executable proof after Epic 2.16`).toBe("PASS");
      expect(
        `${row?.[2] ?? ""} ${row?.[3] ?? ""}`,
        `${id} cannot remain a placeholder`,
      ).not.toMatch(/follow-up|pending|not claim-grade/i);
    }

    for (const id of ["SEC-003", "SEC-015", "SEC-017"] as const) {
      const row = rowById.get(id);
      expect(row, `${id} row`).toBeDefined();
      expect(row?.[1], `${id} remains an honest limitation until backend proof exists`).toBe(
        "DOC-LIMIT (not pass)",
      );
      expect(`${row?.[2] ?? ""} ${row?.[3] ?? ""}`, `${id} limitation wording`).toMatch(
        /not counted as pass|documented limitation/i,
      );
    }

    expect(doc).toContain("fixtures/hostile-servers/");
    for (const id of REQUIRED_SEC_MCP_IDS) {
      expect(doc, `${id} local-stdio inventory row`).toContain(`| ${id} | PASS |`);
    }
    expect(doc).toContain("Remote/localhost MCP remains out");
  });
});
