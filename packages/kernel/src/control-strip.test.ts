import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { oneLineText, stripControl, stripControlLine } from "./control-strip.js";

const BIDI_CONTROLS = [
  "\u061c",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202b",
  "\u202c",
  "\u202d",
  "\u202e",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
] as const;

describe("terminal control stripping", () => {
  it("removes every Unicode bidi control before text reaches a human display boundary", () => {
    for (const control of BIDI_CONTROLS) {
      expect(stripControl(`${control}ALLOW${control} DENY${control}`)).toBe("ALLOW DENY");
      expect(stripControlLine(`review${control}\nDENY`)).toBe("review DENY");
      expect(oneLineText(`approve${control}\nDENY`)).toBe("approve DENY");
    }
  });

  it("removes nested and unbalanced bidi controls without reordering approval labels", () => {
    expect(oneLineText(`ALLOW\u202eDENY\u2066ONCE\u2069\u202c SESSION`)).toBe(
      "ALLOWDENYONCE SESSION",
    );
  });

  it("preserves the existing C0/C1 control-byte stripping contract", () => {
    const strippedControls = [
      ...Array.from({ length: 9 }, (_, code) => String.fromCharCode(code)),
      ...Array.from({ length: 21 }, (_, index) => String.fromCharCode(index + 0x0b)),
      ...Array.from({ length: 33 }, (_, index) => String.fromCharCode(index + 0x7f)),
    ].join("");

    expect(stripControl(`left${strippedControls}right\t\n`)).toBe("leftright\t\n");
  });

  it("removes arbitrary bidi-control sequences from fixed-order approval copy", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...BIDI_CONTROLS), { minLength: 1, maxLength: 64 }),
        (controls) => {
          const injected = controls.join("");
          expect(oneLineText(`review ${injected}ALLOW${injected} DENY${injected}`)).toBe(
            "review ALLOW DENY",
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
