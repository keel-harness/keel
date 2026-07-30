/**
 * Secret redaction (SEC-014, §3.2(6)). The implementation now lives in `@keel/shared` so it is the
 * ONE redaction filter shared by every keel write chokepoint — the kernel's `SessionStore.append`
 * here AND the benchmark trajectory/report/scoreboard store in `@keel/eval` (Epic 1.11 QR-4). There
 * must never be a second, drift-prone redaction implementation; this re-export keeps `@keel/kernel`'s
 * public surface (`redactText`) and the SEC-014 session-write chokepoint unchanged while making the
 * same filter reusable. See `@keel/shared/src/secrets/redact.ts` for the catalog, the entropy
 * heuristic, and the documented (honest) blind spots.
 */
export { redactJsonLine, redactText } from "@keel/shared";
