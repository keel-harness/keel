import { describe, expect, it } from "vitest";
import type { ToolResultT } from "@keel/shared";
import {
  associateToolDeadlineReviewResult,
  markToolDeadlineSignal,
  takeToolDeadlineReviewResult,
} from "./tool-deadline-review-result.js";

describe("module-private tool-deadline review-result isolation", () => {
  it("binds one reviewed result promise to one exact signal and consumes it once", async () => {
    const exact = new AbortController();
    const sibling = new AbortController();
    const result: ToolResultT = {
      ok: false,
      output:
        "blocked by warden (not executed): review closed as denied; no review remains pending",
    };
    const beforeKeys = Reflect.ownKeys(exact.signal);

    expect(associateToolDeadlineReviewResult(sibling.signal, Promise.resolve(result))).toBe(false);
    markToolDeadlineSignal(exact.signal);
    expect(associateToolDeadlineReviewResult(exact.signal, Promise.resolve(result))).toBe(true);

    expect(Reflect.ownKeys(exact.signal)).toEqual(beforeKeys);
    expect(JSON.stringify(exact.signal)).toBe("{}");
    expect(takeToolDeadlineReviewResult(sibling.signal)).toBeUndefined();

    const associated = takeToolDeadlineReviewResult(exact.signal);
    expect(associated).toBeInstanceOf(Promise);
    await expect(associated).resolves.toBe(result);
    expect(takeToolDeadlineReviewResult(exact.signal)).toBeUndefined();
  });

  it("rejects duplicate association without replacing the original occurrence", async () => {
    const controller = new AbortController();
    const first: ToolResultT = { ok: false, output: "first terminal result" };
    const replacement: ToolResultT = { ok: true, output: "must not replace" };

    markToolDeadlineSignal(controller.signal);
    associateToolDeadlineReviewResult(controller.signal, Promise.resolve(first));
    expect(() =>
      associateToolDeadlineReviewResult(controller.signal, Promise.resolve(replacement)),
    ).toThrow(/already associated/);

    await expect(takeToolDeadlineReviewResult(controller.signal)).resolves.toBe(first);
  });
});
