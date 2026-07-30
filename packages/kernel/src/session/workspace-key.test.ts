import { describe, expect, it } from "vitest";
import { redactText } from "../secrets/redact.js";
import { workspaceKey } from "./workspace-key.js";

describe("workspaceKey (ADR-0054 — one-way workspace identity for --continue)", () => {
  it("is deterministic for the same path", () => {
    expect(workspaceKey("/Users/me/proj")).toBe(workspaceKey("/Users/me/proj"));
  });

  it("is distinct for distinct paths after path-aware redaction preserves ordinary provenance", () => {
    // Absolute paths are now redacted component-by-component, so ordinary deep workspace labels no
    // longer collapse to one marker. The hash remains the authoritative one-way identity regardless.
    const a = "/Users/alice/Documents/Code/2024_q3_migration_v2";
    const b = "/Users/jenny/repos/acme-platform/services/auth2";
    expect(redactText(a)).not.toBe(redactText(b));
    expect(workspaceKey(a)).not.toBe(workspaceKey(b));
  });

  it("is lowercase hex and survives the redaction filter unchanged (so it round-trips through the ledger)", () => {
    const key = workspaceKey("/Users/alice/Documents/Code/2024_q3_migration_v2");
    expect(key).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    // hex is spared by looksLikeSecret, so redactJsonLine leaves it intact rather than redacting the
    // identity key itself to a useless `[redacted:high-entropy]`.
    expect(redactText(key)).toBe(key);
  });

  it("is one-way — the key does not leak the path it was derived from", () => {
    expect(workspaceKey("/Users/secret-token/workspace9")).not.toContain("secret-token");
  });
});
