import { describe, expect, it } from "vitest";
import type { UIPort } from "@keel/shared";
import {
  LIVENESS_REVEAL_MS,
  MAX_LIVENESS_MS,
  PURPOSEFUL_LIVENESS,
  livenessDurationBucket,
  supportsPurposefulLiveness,
} from "./purposeful-liveness.js";

function port(dynamic = false): UIPort {
  return {
    ...(dynamic ? { [PURPOSEFUL_LIVENESS]: true as const } : {}),
    render: () => undefined,
    inputs: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }),
    close: () => Promise.resolve(),
  };
}

describe("purposeful liveness", () => {
  it("is an explicit interactive capability, absent from headless-style ports by default", () => {
    expect(supportsPurposefulLiveness(port())).toBe(false);
    expect(supportsPurposefulLiveness(port(true))).toBe(true);
  });

  it("uses bounded coarse buckets with a timer-free sub-two-second presentation", () => {
    expect(livenessDurationBucket(-1)).toBe(0);
    expect(livenessDurationBucket(Number.NaN)).toBe(0);
    expect(livenessDurationBucket(LIVENESS_REVEAL_MS - 1)).toBe(0);
    expect(livenessDurationBucket(LIVENESS_REVEAL_MS)).toBe(2_000);
    expect(livenessDurationBucket(59_999)).toBe(59_000);
    expect(livenessDurationBucket(69_999)).toBe(60_000);
    expect(livenessDurationBucket(3_661_999)).toBe(3_660_000);
    expect(livenessDurationBucket(Number.POSITIVE_INFINITY)).toBe(MAX_LIVENESS_MS);
    expect(livenessDurationBucket(Number.MAX_VALUE)).toBe(MAX_LIVENESS_MS);
  });
});
