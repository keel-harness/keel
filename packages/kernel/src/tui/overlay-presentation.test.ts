import { describe, expect, it } from "vitest";
import type { Overlay } from "@keel/shared";
import { overlayPresentation, withOverlayPresentation } from "./overlay-presentation.js";

describe("Ink-only overlay presentation metadata", () => {
  it("composes local state while remaining absent from JSON carriers", () => {
    const base: Overlay = { kind: "palette", query: "/" };
    const selected = withOverlayPresentation(base, { selected: 2 });
    const scrolled = withOverlayPresentation(selected, { offset: 8 });

    expect(overlayPresentation(scrolled)).toEqual({ selected: 2, offset: 8 });
    expect(JSON.stringify(scrolled)).toBe(JSON.stringify(base));
    expect(Object.keys(scrolled)).toEqual(["kind", "query"]);
  });
});
