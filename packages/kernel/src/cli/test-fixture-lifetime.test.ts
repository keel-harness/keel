import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * An empty-bodied `setInterval` does nothing except hold the event loop open forever. In a test
 * fixture that is spawned as a CHILD PROCESS — several of which deliberately ignore SIGTERM, because
 * the thing under test is keel's ability to force-kill a resistant descendant — that is an unbounded
 * lifetime with no owner.
 *
 * Cleanup for those children lives in `finally` blocks, which is correct and works whenever the test
 * completes. It does NOT run when Vitest kills the worker fork on timeout, and a child engineered to
 * survive SIGTERM then survives everything. Observed on a developer machine: 20 orphaned fixture
 * processes aged up to 22 days, two of them having burned 88 and 93 minutes of CPU, holding the
 * idle load average near 7 on a 10-core host. That load is what makes the next run's timing-sensitive
 * tests time out — which kills more workers, which leaks more children. The failure mode feeds itself.
 *
 * So the invariant is: a fixture keepalive must be BOUNDED. `setTimeout(() => process.exit(0), N)`
 * holds the event loop exactly as well, and no failure path can leak it for longer than N.
 *
 * Polling loops are deliberately NOT covered: they have a real body and a `clearInterval`, they
 * terminate on their own condition, and most run in the test process where a worker kill collects
 * them anyway.
 */
const UNBOUNDED_KEEPALIVE = /setInterval\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*,/gu;

function testSourcesUnder(relativeDir: string): string[] {
  const absolute = join(repoRoot, relativeDir);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const next = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist" ? [] : testSourcesUnder(next);
    }
    return entry.isFile() && /\.test\.tsx?$/u.test(entry.name) ? [next] : [];
  });
}

describe("test fixture lifetime", () => {
  it("never spawns a fixture keepalive that can outlive the run", () => {
    const offenders: string[] = [];
    for (const file of testSourcesUnder("packages")) {
      const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
      lines.forEach((text, index) => {
        UNBOUNDED_KEEPALIVE.lastIndex = 0;
        if (UNBOUNDED_KEEPALIVE.test(text)) {
          offenders.push(`${relative(".", file)}:${index + 1}  ${text.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `unbounded fixture keepalive(s) found. Use setTimeout(() => process.exit(0), 60_000) so a killed worker cannot leak the child:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
