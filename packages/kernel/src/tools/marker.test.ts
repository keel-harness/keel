import { describe, expect, it } from "vitest";
import { makeMarker, parseMarkerLine } from "./marker.js";

describe("marker", () => {
  it("makeMarker is unguessable (>=128 bits) and unique per call", () => {
    const a = makeMarker();
    const b = makeMarker();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^__keel_done_[0-9a-f]{32}__$/); // 16 bytes = 32 hex = 128 bits
  });

  it("parses an anchored marker line into its exit code", () => {
    const m = makeMarker();
    expect(parseMarkerLine(`${m}:0`, m)).toBe(0);
    expect(parseMarkerLine(`${m}:137`, m)).toBe(137);
  });

  it("returns null for a non-marker line, a different marker, or a non-numeric suffix", () => {
    const m = makeMarker();
    expect(parseMarkerLine("just output", m)).toBeNull();
    expect(parseMarkerLine(`${makeMarker()}:0`, m)).toBeNull(); // different nonce
    expect(parseMarkerLine(`${m}:abc`, m)).toBeNull();
    expect(parseMarkerLine(`prefix ${m}:0`, m)).toBeNull(); // not anchored at line start
  });
});
