import type { MutationPresentationV1T, UiToolActivity } from "@keel/shared";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { renderFrame } from "./headless.js";
import { App } from "./ink/app.js";
import { resolveMutationPresentationActivity } from "./mutation-presentation.js";
import { toolCardPlan } from "./tool-card.js";
import { initialView, reduce } from "./view-model.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

function activity(name: "edit" | "write"): UiToolActivity {
  return { kind: "tool", id: "fixture", name, status: "ok", summary: "settled" };
}

function artifact(overrides: Partial<MutationPresentationV1T> = {}): MutationPresentationV1T {
  return {
    schemaVersion: "mutation-presentation/v1",
    producer: "warden-typed-mutation",
    operation: "edit",
    auditSeq: 7,
    displayPath: { segments: [{ kind: "literal", text: "src/example.ts" }], redactionCount: 0 },
    pathIdentity: "fixture-path-identity",
    observedBefore: {
      status: "file-observed",
      sha256: SHA_A,
      bytes: 12,
      mode: 0o644,
      contentClass: "text",
      finalNewline: true,
    },
    verifiedInstalledAfter: {
      status: "file-observed",
      sha256: SHA_B,
      bytes: 13,
      mode: 0o644,
      contentClass: "text",
      finalNewline: true,
    },
    transitionBinding: "not-atomic",
    concurrentMutation: "not-excluded",
    comparison: {
      coverage: "complete",
      totals: {
        observedBeforeLines: 1,
        installedAfterLines: 1,
        shownLines: 2,
        hiddenLines: 0,
      },
      hunks: [
        {
          observedBeforeStart: 1,
          observedBeforeLines: 1,
          installedAfterStart: 1,
          installedAfterLines: 1,
          lines: [
            {
              kind: "observed-before",
              observedBeforeLine: 1,
              segments: [{ kind: "literal", text: "before" }],
              redactionCount: 0,
            },
            {
              kind: "installed-after",
              installedAfterLine: 1,
              segments: [{ kind: "literal", text: "after" }],
              redactionCount: 0,
            },
          ],
        },
      ],
      redactionCount: 0,
    },
    freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
    ...overrides,
  };
}

describe("Epic 3.10 Slice 3A mutation semantic projection", () => {
  it("fails closed when the producer operation does not match the settled typed tool", () => {
    const projected = resolveMutationPresentationActivity(activity("edit"), {
      status: "available",
      artifact: artifact({ operation: "write" }),
    });

    expect(projected).toMatchObject({
      name: "edit",
      summary: "settled",
      mutationPresentation: { status: "unavailable", reason: "invalid-response" },
    });
    expect(projected).not.toHaveProperty("diff");
  });

  it("preserves operation and safe image metadata needed to explain absent writes and missing newlines", () => {
    const projected = resolveMutationPresentationActivity(activity("write"), {
      status: "available",
      artifact: artifact({
        operation: "write",
        observedBefore: { status: "absent-observed" },
        verifiedInstalledAfter: {
          status: "file-observed",
          sha256: SHA_B,
          bytes: 7,
          mode: 0o640,
          contentClass: "text",
          finalNewline: false,
        },
        comparison: {
          coverage: "complete",
          totals: {
            observedBeforeLines: 0,
            installedAfterLines: 1,
            shownLines: 1,
            hiddenLines: 0,
          },
          hunks: [],
          redactionCount: 0,
        },
      }),
    });

    expect(projected.mutationPresentation).toMatchObject({
      status: "available",
      operation: "write",
      observedBefore: { status: "absent-observed" },
      verifiedInstalledAfter: {
        bytes: 7,
        mode: 0o640,
        contentClass: "text",
        finalNewline: false,
      },
    });
    expect(JSON.stringify(projected.mutationPresentation)).not.toContain(SHA_A);
    expect(JSON.stringify(projected.mutationPresentation)).not.toContain(SHA_B);
    expect(JSON.stringify(projected.mutationPresentation)).not.toContain("fixture-path-identity");
  });

  it("keeps binary classification and exact non-content metadata without inventing text hunks", () => {
    const projected = resolveMutationPresentationActivity(activity("write"), {
      status: "available",
      artifact: artifact({
        operation: "write",
        observedBefore: {
          status: "file-observed",
          sha256: SHA_A,
          bytes: 4,
          mode: 0o600,
          contentClass: "binary",
          finalNewline: false,
        },
        comparison: {
          coverage: "summary-only",
          totals: {
            observedBeforeLines: "unknown",
            installedAfterLines: 1,
            shownLines: 0,
            hiddenLines: "unknown",
          },
          hunks: [],
          redactionCount: 0,
        },
      }),
    });

    expect(projected.diff).toEqual([]);
    expect(projected.mutationPresentation).toMatchObject({
      status: "available",
      observedBefore: {
        status: "file-observed",
        bytes: 4,
        mode: 0o600,
        contentClass: "binary",
        finalNewline: false,
      },
      coverage: "summary-only",
    });
  });

  it("discloses special image facts and incomplete comparison coverage without exact-effect wording", () => {
    const projected = resolveMutationPresentationActivity(activity("write"), {
      status: "available",
      artifact: artifact({
        operation: "write",
        observedBefore: { status: "absent-observed" },
        verifiedInstalledAfter: {
          status: "file-observed",
          sha256: SHA_B,
          bytes: 7,
          mode: 0o640,
          contentClass: "text",
          finalNewline: false,
        },
        comparison: {
          coverage: "truncated",
          totals: {
            observedBeforeLines: 0,
            installedAfterLines: 2_001,
            shownLines: 2_000,
            hiddenLines: 1,
          },
          hunks: [],
          redactionCount: 0,
        },
      }),
    });
    const lines = toolCardPlan(projected, "full").mutationReview?.lines ?? [];

    expect(lines).toContain(
      "image  observed absent → verified text · 7 B · mode 0640 · final newline missing",
    );
    expect(lines).toContain("comparison  truncated · 2000 rows shown · 1 hidden");
    expect(lines.join("\n")).not.toMatch(/created|modified|removed|exact diff/iu);
  });

  it("labels an identical observed comparison without claiming that no mutation occurred", () => {
    const projected = resolveMutationPresentationActivity(activity("write"), {
      status: "available",
      artifact: artifact({
        operation: "write",
        comparison: {
          coverage: "complete",
          totals: {
            observedBeforeLines: 2,
            installedAfterLines: 2,
            shownLines: 0,
            hiddenLines: 2,
          },
          hunks: [],
          redactionCount: 0,
        },
      }),
    });
    const copy = toolCardPlan(projected, "full").mutationReview?.lines.join("\n") ?? "";

    expect(copy).toContain("comparison  no differing rows · 2 unchanged rows omitted");
    expect(copy).not.toMatch(/no mutation|unchanged file|no-op/iu);
  });

  it("does not claim omitted rows for an identical empty-file observation", () => {
    const projected = resolveMutationPresentationActivity(activity("write"), {
      status: "available",
      artifact: artifact({
        operation: "write",
        observedBefore: {
          status: "file-observed",
          sha256: SHA_A,
          bytes: 0,
          mode: 0o644,
          contentClass: "text",
          finalNewline: false,
        },
        verifiedInstalledAfter: {
          status: "file-observed",
          sha256: SHA_A,
          bytes: 0,
          mode: 0o644,
          contentClass: "text",
          finalNewline: false,
        },
        comparison: {
          coverage: "complete",
          totals: {
            observedBeforeLines: 0,
            installedAfterLines: 0,
            shownLines: 0,
            hiddenLines: 0,
          },
          hunks: [],
          redactionCount: 0,
        },
      }),
    });
    const copy = toolCardPlan(projected, "full").mutationReview?.lines.join("\n") ?? "";

    expect(copy).toContain("comparison  no differing rows");
    expect(copy).not.toContain("0 unchanged rows omitted");
  });

  it("keeps ordinary successful mutation cards compact while detail modes retain integrity facts", () => {
    const projected = resolveMutationPresentationActivity(activity("edit"), {
      status: "available",
      artifact: artifact(),
    });
    const base = initialView([]);
    const mutationView = { ...base, items: [projected] };

    for (const density of ["normal", "quiet"] as const) {
      const calm = { ...mutationView, density };
      for (const frame of [
        renderFrame(calm),
        render(createElement(App, { view: calm })).lastFrame() ?? "",
      ]) {
        expect(frame).toContain("edit");
        expect(frame).toContain("src/example.ts");
        expect(frame).not.toContain("review  src/example.ts");
        expect(frame).not.toMatch(/evidence\s+observed before → verified installed after/u);
        expect(frame).not.toMatch(/scope\s+transition not atomic/u);
        if (density === "normal") expect(frame).toContain("transition not atomic");
      }
    }

    for (const detailed of [
      { ...mutationView, density: "verbose" as const },
      { ...mutationView, density: "debug" as const },
      { ...mutationView, density: "normal" as const, diffMode: "full" as const },
    ]) {
      for (const frame of [
        renderFrame(detailed),
        render(createElement(App, { view: detailed })).lastFrame() ?? "",
      ]) {
        expect(frame).toContain("review  src/example.ts");
        expect(frame).toContain("observed before → verified installed after");
        expect(frame).toContain("transition not atomic");
      }
    }
  });

  it("keeps captured line content out of headless while Ink and headless retain all semantic labels", () => {
    const observedOnly = "OBSERVED-FIXTURE-CONTENT";
    const installedOnly = "INSTALLED-FIXTURE-CONTENT";
    const projected = resolveMutationPresentationActivity(activity("edit"), {
      status: "available",
      artifact: artifact({
        comparison: {
          coverage: "truncated",
          totals: {
            observedBeforeLines: 1,
            installedAfterLines: 1,
            shownLines: 2,
            hiddenLines: 3,
          },
          hunks: [
            {
              observedBeforeStart: 1,
              observedBeforeLines: 1,
              installedAfterStart: 1,
              installedAfterLines: 1,
              lines: [
                {
                  kind: "observed-before",
                  observedBeforeLine: 1,
                  segments: [{ kind: "literal", text: observedOnly }],
                  redactionCount: 0,
                },
                {
                  kind: "installed-after",
                  installedAfterLine: 1,
                  segments: [{ kind: "literal", text: installedOnly }],
                  redactionCount: 0,
                },
              ],
            },
          ],
          redactionCount: 0,
        },
      }),
    });
    const base = initialView([]);
    const view = { ...base, items: [projected], diffMode: "full" as const };

    const headless = renderFrame(view);
    expect(headless).toContain("comparison  truncated · 2 rows shown · 3 hidden");
    expect(headless).toContain("transition not atomic");
    expect(headless).not.toContain(observedOnly);
    expect(headless).not.toContain(installedOnly);

    const ink = render(createElement(App, { view })).lastFrame() ?? "";
    expect(ink).toContain("comparison  truncated · 2 rows shown · 3 hidden");
    expect(ink).toContain("transition not atomic");
    expect(ink).toContain(observedOnly);
    expect(ink).toContain(installedOnly);
  });

  it("keeps renderer-cap footers out of summary-only headless mutation evidence", () => {
    const lines = Array.from({ length: 45 }, (_, index) => ({
      kind: "installed-after" as const,
      installedAfterLine: index + 1,
      segments: [{ kind: "literal" as const, text: `installed-${index}` }],
      redactionCount: 0,
    }));
    const projected = resolveMutationPresentationActivity(activity("edit"), {
      status: "available",
      artifact: artifact({
        comparison: {
          coverage: "complete",
          totals: {
            observedBeforeLines: 0,
            installedAfterLines: lines.length,
            shownLines: lines.length,
            hiddenLines: 0,
          },
          hunks: [
            {
              observedBeforeStart: 0,
              observedBeforeLines: 0,
              installedAfterStart: 1,
              installedAfterLines: lines.length,
              lines,
            },
          ],
          redactionCount: 0,
        },
      }),
    });
    const frame = renderFrame({ ...initialView([]), items: [projected], diffMode: "full" });

    expect(frame).toContain("observed before → verified installed after · 0 → 45 lines");
    expect(frame).not.toContain("installed-0");
    expect(frame).not.toContain("hidden in this view");
  });

  it("renders uncaptured mutation classes explicitly in both UI implementations", () => {
    let view = initialView([]);
    view = reduce(view, {
      type: "tool-call",
      id: "uncaptured-bash",
      name: "bash",
      args: { command: "mv old.txt new.txt" },
    });
    view = reduce(view, {
      type: "tool-result",
      id: "uncaptured-bash",
      ok: true,
      output: "done",
    });

    expect(renderFrame(view)).toContain("workspace effects  not captured for this tool");
    expect(render(createElement(App, { view })).lastFrame() ?? "").toContain(
      "workspace effects  not captured for this tool",
    );
  });
});
