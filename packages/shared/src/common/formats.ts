import { z } from "zod";

/** RFC 3339 / ISO-8601 timestamp (zod-fast-check generates these natively). */
export const IsoTimestamp = z.string().datetime();
export type IsoTimestampT = z.infer<typeof IsoTimestamp>;

/** Calendar date YYYY-MM-DD (used by memory validity windows).
 *  The shape regex (`\d{4}-\d{2}-\d{2}`) is checked first; the refine then verifies the
 *  date is real (i.e. it round-trips through `Date.UTC` unchanged), rejecting impossible
 *  values like `2026-13-45`, `2026-02-30`, and `0000-00-00`. */
export const DateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .refine(
    (s) => {
      // The regex above guarantees exactly three numeric segments; no fallback needed.
      const [y, m, d] = s.split("-").map(Number) as [number, number, number];
      const dt = new Date(Date.UTC(y, m - 1, d));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    },
    { message: "not a real calendar date" },
  );
export type DateOnlyT = z.infer<typeof DateOnly>;

/** Session id: `ses_` + 26-char Crockford-base32 ULID. */
export const SessionId = z.string().regex(/^ses_[0-9A-HJKMNP-TV-Z]{26}$/, "ses_<ULID>");
export type SessionIdT = z.infer<typeof SessionId>;

/** Memory entry id: `mem_` + 26-char Crockford-base32 ULID. */
export const MemId = z.string().regex(/^mem_[0-9A-HJKMNP-TV-Z]{26}$/, "mem_<ULID>");
export type MemIdT = z.infer<typeof MemId>;

/** Lowercase-hex SHA-256 digest, `sha256:` prefixed. */
export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<64 hex>");
export type Sha256T = z.infer<typeof Sha256>;

/** Ed25519 signature, `ed25519:` prefixed canonical base64.
 *  An Ed25519 signature is exactly 64 bytes → 88 base64 chars: 86 data chars + `==` padding.
 *  The regex pins the exact length and padding so short/over-padded values are rejected. */
export const Ed25519Sig = z
  .string()
  .regex(/^ed25519:[A-Za-z0-9+/]{86}==$/, "ed25519:<86 base64 chars + ==>");
export type Ed25519SigT = z.infer<typeof Ed25519Sig>;
