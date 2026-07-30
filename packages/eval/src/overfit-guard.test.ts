import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The §7 tests-first "overfit-guard checklist exists in the PR template" check. The template lives at
// the repo root; this test resolves it relative to this file (packages/eval/src → repo root is 3 up).
const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../../.github/pull_request_template.md", import.meta.url)),
  "utf8",
);

describe("overfit-guard checklist in the PR template (QR-6)", () => {
  it("has an Overfit guard section", () => {
    expect(TEMPLATE).toMatch(/##\s*Overfit guard/i);
  });

  it("enumerates the required checklist questions (not just a heading)", () => {
    // The load-bearing questions — each must be present so a reviewer can actually apply the guard.
    expect(TEMPLATE).toMatch(/general failure mode, not a task's surface details/i);
    expect(TEMPLATE).toMatch(/held-out set/i);
    expect(TEMPLATE).toMatch(/trajectory-ID evidence/i);
    expect(TEMPLATE).toMatch(/One change per PR/i);
    expect(TEMPLATE).toMatch(/never `keel`'s exit code/i); // QR-7
    expect(TEMPLATE).toMatch(/trajectory-quality regression/i); // §8.2 >2-pt rule
  });

  it("is a checklist (renders as checkboxes)", () => {
    const overfit = TEMPLATE.slice(TEMPLATE.search(/##\s*Overfit guard/i));
    expect((overfit.match(/- \[ \]/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});
