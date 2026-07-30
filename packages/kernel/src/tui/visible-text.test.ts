import { describe, expect, it } from "vitest";
import { visibleTerminalText } from "./visible-text.js";

describe("visibleTerminalText", () => {
  it("renders C0, DEL, C1, separator, and lone-surrogate controls as explicit text", () => {
    expect(visibleTerminalText("\u0000\u001F\u007F\u0085\u2028\u2029\uD800")).toBe(
      "␀␟␡‹U+0085›‹U+2028›‹U+2029›‹U+D800›",
    );
  });

  it("makes orphaned marks and standalone joiners visible while preserving real graphemes", () => {
    expect(visibleTerminalText("\u0301\u200D")).toBe("‹U+0301›‹U+200D›");
    expect(visibleTerminalText("e\u0301 👩🏽‍💻 ✈️")).toBe("e\u0301 👩🏽‍💻 ✈️");
  });

  it("preserves tabs and printable ASCII", () => {
    expect(visibleTerminalText("alpha\tbeta ~")).toBe("alpha\tbeta ~");
  });
});
