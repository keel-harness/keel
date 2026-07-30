import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalize } from "./canonicalize.js";

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), pinned by ADR-0006, over the
 * JSON-safe (`JsonValue`) subset used by audit records. The two transforms JCS
 * mandates for our subset: object KEYS sorted by UTF-16 code unit, arrays NOT
 * reordered, and ECMAScript number/string serialization (which `JSON.stringify`
 * already produces for finite values).
 */
describe("canonicalize (RFC 8785 / JCS)", () => {
  it("sorts object keys by code unit", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalize({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("preserves array element order (arrays are NOT reordered)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("sorts keys by UTF-16 code unit, not locale (ascii before non-ascii)", () => {
    const aAcute = String.fromCharCode(0x00e9); // 'é' = U+00E9
    // 'a' = U+0061 sorts before 'é' = U+00E9.
    expect(canonicalize({ [aAcute]: 1, a: 2 })).toBe(`{"a":2,${JSON.stringify(aAcute)}:1}`);
  });

  it("serializes finite numbers like ECMAScript Number::toString (what RFC 8785 mandates)", () => {
    expect(canonicalize(100)).toBe("100");
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(1e21)).toBe("1e+21");
    // -0 cannot appear in a JsonValue record, but JCS still maps it to "0".
    expect(canonicalize(-0)).toBe("0");
  });

  it("serializes strings with JSON-compatible minimal escaping; non-ascii preserved literally", () => {
    expect(canonicalize('a"b\\c\n')).toBe(JSON.stringify('a"b\\c\n'));
    const euro = String.fromCharCode(0x20ac);
    expect(canonicalize(euro)).toBe(JSON.stringify(euro));
  });

  it("orders keys by UTF-16 code unit incl. supplementary-plane vs BMP (RFC 8785 §3.2.3)", () => {
    // The JCS gotcha (RFC 8785 §3.2.3): a supplementary-plane key (U+1F600, lead surrogate
    // U+D83D = 55357) sorts BEFORE a higher BMP key (U+FB33 = 64307) because ordering is by
    // UTF-16 code unit, not code point. Built from char codes so the bytes are unambiguous.
    const one = "1"; // 49
    const oUmlaut = String.fromCharCode(0x00f6); // 246
    const euro = String.fromCharCode(0x20ac); // 8364
    const emoji = String.fromCodePoint(0x1f600); // lead surrogate U+D83D = 55357
    const dalet = String.fromCharCode(0xfb33); // 64307
    const input = { [euro]: "a", [one]: "b", [oUmlaut]: "c", [emoji]: "d", [dalet]: "e" };
    expect(canonicalize(input)).toBe(
      `{${JSON.stringify(one)}:"b",${JSON.stringify(oUmlaut)}:"c",${JSON.stringify(euro)}:"a",` +
        `${JSON.stringify(emoji)}:"d",${JSON.stringify(dalet)}:"e"}`,
    );
  });

  it("serializes literals", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
  });

  it("is invariant to object key insertion order (property)", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue() as fc.Arbitrary<unknown>), (obj) => {
        const keys = Object.keys(obj);
        const shuffled: Record<string, unknown> = {};
        for (const k of [...keys].reverse()) shuffled[k] = obj[k];
        // Reversed insertion order must canonicalize identically.
        expect(canonicalize(shuffled as never)).toBe(canonicalize(obj as never));
      }),
    );
  });

  it("round-trips back to an equal value (canonical output is valid JSON)", () => {
    fc.assert(
      fc.property(fc.jsonValue() as fc.Arbitrary<unknown>, (value) => {
        expect(JSON.parse(canonicalize(value as never))).toEqual(value);
      }),
    );
  });
});
