import { describe, expect, it } from "vitest";
import {
  markReviewSettlementPresentation,
  reviewSettlementPresentation,
} from "./review-settlement-presentation.js";

describe("review settlement presentation provenance", () => {
  it("is kernel-local, non-enumerable, and absent from persisted JSON", () => {
    const activity = markReviewSettlementPresentation({ summary: "controller result" }, "partial");

    expect(reviewSettlementPresentation(activity)).toBe("partial");
    expect(Object.keys(activity)).toEqual(["summary"]);
    const persisted: unknown = JSON.parse(JSON.stringify(activity));
    expect(persisted).toEqual({ summary: "controller result" });
    if (typeof persisted !== "object" || persisted === null) throw new Error("expected object");
    expect(reviewSettlementPresentation(persisted)).toBeUndefined();
  });
});
