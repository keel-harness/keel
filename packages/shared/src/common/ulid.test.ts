import { describe, expect, it } from "vitest";
import { ulid, newSessionId, newMemId } from "./ulid.js";
import { SessionId, MemId } from "./formats.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  it("is 26 Crockford-base32 chars", () => {
    expect(ulid()).toMatch(CROCKFORD);
  });

  it("newSessionId/newMemId satisfy their formats", () => {
    expect(() => SessionId.parse(newSessionId())).not.toThrow();
    expect(() => MemId.parse(newMemId())).not.toThrow();
  });

  it("is time-ordered: a later timestamp sorts after an earlier one", () => {
    expect(ulid(1000) < ulid(2000)).toBe(true);
  });

  it("encodes the timestamp in the first 10 chars (same ms ⇒ same prefix)", () => {
    expect(ulid(123456789).slice(0, 10)).toBe(ulid(123456789).slice(0, 10));
  });

  it("randomness differs across calls at the same timestamp", () => {
    expect(ulid(123456789)).not.toBe(ulid(123456789));
  });
});
