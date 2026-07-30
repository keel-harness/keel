import { describe, expect, it } from "vitest";
import { createBoundedOutputCapture } from "./bounded-output-capture.mjs";

describe("bounded installed-carrier output capture", () => {
  it("retains output through the exact UTF-8 byte ceiling", () => {
    const capture = createBoundedOutputCapture("stdout", 6);
    capture.append("ok");
    capture.append("éé");

    expect(capture.text).toBe("okéé");
    expect(capture.retainedBytes).toBe(6);
    expect(capture.error).toBeUndefined();
  });

  it("keeps draining without retaining bytes after the ceiling is crossed", () => {
    const capture = createBoundedOutputCapture("stderr", 5);
    capture.append("safe");
    capture.append("é");
    capture.append("x".repeat(1_000_000));

    expect(capture.text).toBe("safe");
    expect(capture.retainedBytes).toBe(4);
    expect(capture.error?.message).toBe("installed carrier stderr exceeded 5 bytes");
  });
});
