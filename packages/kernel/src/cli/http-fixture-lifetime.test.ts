import { describe, expect, it } from "vitest";
import { closeHttpFixture, type HttpFixtureServer } from "./http-fixture-lifetime.test-support.js";

describe("HTTP fixture lifetime", () => {
  it("stops accepting connections before force-closing the established set", async () => {
    const calls: string[] = [];
    let accepting = true;
    const server: HttpFixtureServer = {
      close(callback) {
        calls.push("close");
        accepting = false;
        queueMicrotask(callback);
      },
      closeAllConnections() {
        calls.push("closeAllConnections");
        if (accepting) throw new Error("force-close raced an accepting listener");
      },
    };

    await expect(closeHttpFixture(server)).resolves.toBeUndefined();
    expect(calls).toEqual(["close", "closeAllConnections"]);
  });

  it("preserves a listener-close failure", async () => {
    const failure = new Error("listener close failed");
    const server: HttpFixtureServer = {
      close(callback) {
        queueMicrotask(() => callback(failure));
      },
      closeAllConnections() {},
    };

    await expect(closeHttpFixture(server)).rejects.toBe(failure);
  });
});
