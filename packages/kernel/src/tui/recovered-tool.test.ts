import { describe, expect, it } from "vitest";
import type { ViewItem } from "@keel/shared";
import { markToolPresentationOutcome } from "../tool-presentation-outcome.js";
import { recoveredExploratoryFailureIndexes } from "./recovered-tool.js";

describe("recovered exploratory failures", () => {
  it("never hides a binary refusal merely because another read later succeeds", () => {
    const binaryRefusal = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "binary",
        name: "read",
        status: "error",
        summary: "read: 'binary-fixture.bin' appears to be a binary file; refusing to read",
        subject: "binary-fixture.bin",
      } as const,
      "failed",
    );
    const items: ViewItem[] = [
      { kind: "message", role: "user", content: "inspect each requested file" },
      binaryRefusal,
      {
        kind: "tool",
        id: "text",
        name: "read",
        status: "ok",
        summary: "plain text",
        subject: "README.md",
      },
      { kind: "message", role: "assistant", content: "I inspected both requested files." },
    ];

    expect(recoveredExploratoryFailureIndexes(items)).not.toContain(1);
  });

  it("never hides an invalid UTF-8 refusal merely because another read later succeeds", () => {
    const invalidUtf8 = markToolPresentationOutcome(
      {
        kind: "tool",
        id: "invalid-utf8",
        name: "read",
        status: "error",
        summary: "read: 'bytes.txt' is not complete UTF-8 text; refusing to read",
      } as const,
      "failed",
    );
    const items: ViewItem[] = [
      { kind: "message", role: "user", content: "inspect each requested file" },
      invalidUtf8,
      { kind: "tool", id: "text", name: "read", status: "ok", summary: "README.md" },
      { kind: "message", role: "assistant", content: "I inspected the readable target." },
    ];

    expect(recoveredExploratoryFailureIndexes(items)).not.toContain(1);
  });

  it("classifies a large turn in one reverse pass", () => {
    const items: ViewItem[] = Array.from({ length: 10_000 }, (_, index) =>
      markToolPresentationOutcome(
        {
          kind: "tool",
          id: `read-${index}`,
          name: "read",
          status: "error",
          summary: "ordinary read miss",
        },
        "failed",
      ),
    );
    items.push(
      { kind: "tool", id: "read-ok", name: "read", status: "ok", summary: "README.md" },
      { kind: "message", role: "assistant", content: "I found the requested context." },
    );
    let indexedReads = 0;
    const observed = new Proxy(items, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    const recovered = recoveredExploratoryFailureIndexes(observed);
    expect(recovered.size).toBe(10_000);
    expect(indexedReads).toBeLessThanOrEqual(items.length + 2);
  });
});
