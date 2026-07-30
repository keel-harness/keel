import { afterEach, describe, expect, it, vi } from "vitest";
import { InfraError, withDeadline } from "./infra.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadline", () => {
  it("resolves with the op's value when it completes in time", async () => {
    await expect(withDeadline(() => Promise.resolve(42), 1000, "tool")).resolves.toBe(42);
  });

  it("propagates the op's own rejection (not an InfraError) when it fails before the deadline", async () => {
    await expect(
      withDeadline(() => Promise.reject(new Error("boom")), 1000, "tool"),
    ).rejects.toThrow("boom");
  });

  it("throws a typed InfraError when the op exceeds the deadline", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(() => new Promise<never>(() => {}), 1000, "tool 'slow'");
    const assertion = expect(pending).rejects.toBeInstanceOf(InfraError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("the InfraError names the label and the deadline", async () => {
    vi.useFakeTimers();
    const pending = withDeadline(() => new Promise<never>(() => {}), 500, "tool 'slow'");
    const assertion = expect(pending).rejects.toThrow(/tool 'slow'.*500ms/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("runs the timeout hook before rejecting the abandoned operation", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const pending = withDeadline(
      () => new Promise<never>(() => {}),
      500,
      "tool 'reviewing'",
      () => order.push("revoked"),
    ).catch((error: unknown) => {
      order.push("rejected");
      throw error;
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(InfraError);

    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(order).toEqual(["revoked", "rejected"]);
  });
});
