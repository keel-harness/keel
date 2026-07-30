import { describe, expect, it } from "vitest";
import { JUNK, assertRejects, assertRoundTrips } from "../testing/property.js";
import { DateOnly, Ed25519Sig, IsoTimestamp, MemId, Sha256, SessionId } from "./formats.js";

// A valid Ed25519 signature fixture: 86 base64 chars + "==" padding (88 base64 chars = 64 bytes).
// 'A' × 86 encodes 64 zero-bytes in base64.
const VALID_ED25519_SIG =
  "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

describe("common formats", () => {
  it("round-trip + reject malformed", () => {
    // DateOnly round-trips safely: the harness has a dedicated fc.date()-based
    // arbitrary override for it (a raw regex generator would emit shape-valid but
    // impossible dates like month 13 that the calendar refine rejects). Calendar
    // accept/reject correctness is additionally pinned by explicit cases below.
    for (const s of [IsoTimestamp, DateOnly, SessionId, MemId, Sha256, Ed25519Sig]) {
      assertRoundTrips(s);
    }
    expect(SessionId.parse("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeTruthy();
    expect(MemId.safeParse("mem_01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(true);
    assertRejects(SessionId, [...JUNK, "ses_", "abc", "mem_01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    assertRejects(MemId, [
      ...JUNK,
      "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "mem_01ARZ3NDEKTSV4RRFFQ69G5FA", // 25 chars — too short
      "mem_01ARZ3NDEKTSV4RRFFQ69G5FAVV", // 27 chars — too long
    ]);
    assertRejects(Sha256, [...JUNK, "sha256:zz", "abcd", "sha1:0000"]);
    assertRejects(DateOnly, [...JUNK, "2026-6-1", "2026/06/01", "not-a-date"]);
  });

  describe("Ed25519Sig (N1) — pinned to 64-byte / 88-char canonical base64", () => {
    it("accepts a real-shape 88-char sig (86 base64 chars + ==)", () => {
      expect(Ed25519Sig.safeParse(VALID_ED25519_SIG).success).toBe(true);
    });

    it("rejects too-short sig ed25519:A", () => {
      expect(Ed25519Sig.safeParse("ed25519:A").success).toBe(false);
    });

    it("rejects wrong padding ed25519:abc====", () => {
      expect(Ed25519Sig.safeParse("ed25519:abc====").success).toBe(false);
    });

    it("rejects no padding (88 chars but no ==)", () => {
      // 88 base64 chars but no trailing ==
      const nopadding =
        "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      expect(Ed25519Sig.safeParse(nopadding).success).toBe(false);
    });

    it("rejects single = padding (should be ==)", () => {
      // 87 base64 chars + single =
      const onePad =
        "ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      expect(Ed25519Sig.safeParse(onePad).success).toBe(false);
    });
  });

  describe("DateOnly (N2) — calendar-valid dates only", () => {
    it("accepts valid calendar dates", () => {
      expect(DateOnly.safeParse("2026-06-13").success).toBe(true);
      expect(DateOnly.safeParse("2024-02-29").success).toBe(true); // leap year
      expect(DateOnly.safeParse("2000-01-01").success).toBe(true);
      expect(DateOnly.safeParse("9999-12-31").success).toBe(true);
    });

    it("rejects impossible month 13", () => {
      expect(DateOnly.safeParse("2026-13-45").success).toBe(false);
    });

    it("rejects impossible day 30 in February", () => {
      expect(DateOnly.safeParse("2026-02-30").success).toBe(false);
    });

    it("rejects zero month/day", () => {
      expect(DateOnly.safeParse("0000-00-00").success).toBe(false);
    });

    it("rejects non-leap Feb 29", () => {
      expect(DateOnly.safeParse("2023-02-29").success).toBe(false);
    });

    it("still rejects shape-invalid dates", () => {
      assertRejects(DateOnly, [...JUNK, "2026-6-1", "2026/06/01", "not-a-date"]);
    });
  });
});
