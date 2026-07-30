import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrincipalT, SideEffectT } from "@keel/shared";
import { AuditChainWriter } from "./writer.js";
import { renderReplayHtml } from "./replay.js";

const PRINCIPAL: PrincipalT = {
  osUser: "alice",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXED_TS = "2026-06-26T14:00:00.000Z";

const SIDE_EFFECT: SideEffectT = {
  taxonomyVersion: "side-effect-taxonomy/v1",
  staticCapability: { toolName: "bash", effectEnvelope: ["fs_read"], broad: true },
  dynamic: {
    effectKinds: ["fs_read"],
    scopes: ["workspace"],
    targets: [],
    modifiers: [],
    composition: {
      kind: "atomic",
      segments: [{ effectKinds: ["fs_read"], scopes: ["workspace"], targets: [], modifiers: [] }],
      edges: [],
    },
    classifier: { name: "test-classifier", version: "1", confidence: "exact", reasons: [] },
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-replay-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writer() {
  return AuditChainWriter.open({
    path: join(dir, "a.jsonl"),
    principal: PRINCIPAL,
    now: () => FIXED_TS,
  });
}

describe("renderReplayHtml (Epic 2.7 — escaped by construction)", () => {
  it("renders a well-formed page with a row per record", () => {
    const w = writer();
    const start = w.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
    const exec = w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { command: "ls" },
      sideEffect: SIDE_EFFECT,
    });
    const html = renderReplayHtml({
      sessionId: SESSION_ID,
      records: [start, exec],
      rootHash: exec.hash,
    });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("session.start");
    expect(html).toContain("tool.execute");
    expect(html).toContain(SESSION_ID);
    expect(html).toContain(exec.hash);
  });

  it("escapes hostile record content (no raw HTML/script injection)", () => {
    const w = writer();
    const evil = w.append({
      eventType: "tool.execute",
      sessionId: SESSION_ID,
      payload: { note: "<script>alert(1)</script>", q: '"></td><img src=x onerror=alert(2)>' },
      sideEffect: SIDE_EFFECT,
    });
    const html = renderReplayHtml({ sessionId: SESSION_ID, records: [evil], rootHash: evil.hash });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(2)>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders the policy verdict when a record carries one", () => {
    const w = writer();
    const r = w.append({
      eventType: "tool.deny",
      sessionId: SESSION_ID,
      payload: { command: "rm -rf /" },
      sideEffect: SIDE_EFFECT,
      policy: {
        packName: "default",
        packHash: `sha256:${"a".repeat(64)}`,
        ruleIds: ["POL-002"],
        verdict: "deny",
      },
    });
    const html = renderReplayHtml({ sessionId: SESSION_ID, records: [r], rootHash: r.hash });
    expect(html).toContain("deny");
  });

  it("renders an empty session without rows", () => {
    const html = renderReplayHtml({
      sessionId: SESSION_ID,
      records: [],
      rootHash: `sha256:${"0".repeat(64)}`,
    });
    expect(html).toContain("0 records");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
});
