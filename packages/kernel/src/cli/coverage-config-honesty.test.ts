import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("coverage configuration honesty", () => {
  it("describes the live Warden coverage gate instead of a future activation", () => {
    const config = readRepoFile("vitest.config.ts");
    const excludeBlock = config.match(/exclude:\s*\[(?<body>[\s\S]*?)\n\s*\],/u)?.groups?.["body"];

    expect(config).toContain(
      '"packages/warden/src/**": { lines: 95, functions: 95, statements: 95, branches: 90 }',
    );
    expect(excludeBlock).toBeDefined();
    expect(excludeBlock).toContain('"packages/warden/src/bin.ts"');
    expect(excludeBlock).not.toContain('"packages/warden/src/**"');
    expect(config).not.toMatch(/activate it .* removing warden from\s+`exclude`/iu);
    expect(config).toMatch(/warden.*live.*coverage gate/iu);
  });

  it("does not label unconfigured dedicated CI placeholders as landed phase gates", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");

    expect(workflow).not.toContain("Integration (Phase 2 — warden via RPC)");
    expect(workflow).not.toContain("E2E (Phase 1 — pty TUI)");
    expect(workflow).not.toContain("Benchmark (Phase 1 — TB-2 subset)");
    expect(workflow).toContain("Reserved dedicated gates below remain NOT_RUN");
  });
});
