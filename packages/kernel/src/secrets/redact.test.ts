import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, readSession } from "../session/store.js";
import { sessionPath } from "../session/paths.js";

// The pure `redactText` filter is implemented + unit-tested in @keel/shared (one redaction
// implementation, reused). This kernel test proves SEC-014 at the kernel boundary: secrets are
// redacted at the SINGLE session-write chokepoint (`SessionStore.append`).

describe("SEC-014 — secrets are redacted at the single session-write chokepoint (append)", () => {
  it("a planted key in tool output never appears in the persisted session JSONL", () => {
    const home = mkdtempSync(join(tmpdir(), "keel-redact-"));
    const env: NodeJS.ProcessEnv = { KEEL_HOME: home };
    const key = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const store = SessionStore.create({ cwd: "/ws" }, env);
    store.append({
      type: "tool_result",
      v: 1,
      ts: new Date().toISOString(),
      toolCallId: "call_1",
      name: "bash",
      output: `env shows ANTHROPIC_API_KEY=${key} in the output`,
    });
    store.close();

    // the raw bytes on disk contain the key NOWHERE, but a redaction marker is present + parseable
    const raw = readFileSync(sessionPath(store.id, env), "utf8");
    expect(raw).not.toContain(key);
    expect(raw).toContain("[redacted:anthropic-key]");

    // and the ledger still reads back as valid, structured events (no corruption)
    const { events } = readSession(store.id, env);
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr?.type).toBe("tool_result");
    expect((tr as { output: string }).output).toContain("[redacted:anthropic-key]");
    expect((tr as { output: string }).output).not.toContain(key);
  });

  // F1 integrity (structured-redaction regression): a capped search result whose high-entropy hits are joined by newlines
  // produced a `tool_result` line that was INVALID JSON — the redaction matched a run beginning at
  // the `n` of an escaped `\n`, leaving an orphan `\` (an invalid `\[` escape). A strict parser then
  // SILENTLY DROPPED that line. The persisted line MUST always be exactly one valid JSON value.
  it("a capped search result with high-entropy hits separated by newlines stays valid JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "keel-redact-f1-"));
    const env: NodeJS.ProcessEnv = { KEEL_HOME: home };
    // Mirror the real trajectory: a grep-hit line (high-entropy token + an escaped-quote tail),
    // repeated, joined by newlines, large enough to be a realistic capped result.
    const secret = "riGp58WAmdX3a5IDnOdcdbWB2dC4DSDC6Lc1mxLpQ2y9abcDEF"; // 49 chars, high-entropy
    const hit = `${secret}.json:5:22:    "sources": "s3://bucket/commoncrawl_paths.txt.gz",`;
    const output = Array.from({ length: 400 }, () => hit).join("\n");

    const store = SessionStore.create({ cwd: "/ws" }, env);
    store.append({
      type: "tool_result",
      v: 1,
      ts: new Date().toISOString(),
      toolCallId: "call_f1",
      name: "search",
      output,
    });
    store.close();

    // EVERY non-empty line on disk must parse under a strict JSON parser (jq / json.loads parity).
    const raw = readFileSync(sessionPath(store.id, env), "utf8");
    for (const line of raw.split("\n").filter((l) => l.length > 0)) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
    // and the secret was actually redacted (defense-in-depth held, not bypassed for validity)
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[redacted:high-entropy]");

    // tolerant reader recovers the event (it is NOT a torn/dropped final line)
    const { events } = readSession(store.id, env);
    const tr = events.find((e) => e.type === "tool_result");
    expect((tr as { output: string }).output).not.toContain(secret);
  });
});
