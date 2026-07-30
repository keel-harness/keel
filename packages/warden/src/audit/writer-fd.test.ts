import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PrincipalT, type SideEffectT } from "@keel/shared";

const fsProbe = vi.hoisted(() => ({
  auditPath: "",
  appendOpenCount: 0,
  auditFsyncCount: 0,
  auditFds: new Set<number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]) === fsProbe.auditPath && args[1] === "a") {
        fsProbe.appendOpenCount += 1;
        fsProbe.auditFds.add(fd);
      }
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (fsProbe.auditFds.has(fd)) fsProbe.auditFsyncCount += 1;
      return actual.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      fsProbe.auditFds.delete(fd);
      return actual.closeSync(fd);
    },
  };
});

const { AuditChainWriter, readAuditLog } = await import("./writer.js");

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

describe("AuditChainWriter append descriptor reuse", () => {
  it("keeps one append-mode audit fd open while fsyncing every appended record", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-audit-fd-"));
    const path = join(dir, "audit.jsonl");
    fsProbe.auditPath = path;
    fsProbe.appendOpenCount = 0;
    fsProbe.auditFsyncCount = 0;
    fsProbe.auditFds.clear();

    try {
      const writer = AuditChainWriter.open({ path, principal: PRINCIPAL, now: () => FIXED_TS });
      writer.append({ eventType: "session.start", sessionId: SESSION_ID, payload: {} });
      writer.append({
        eventType: "tool.execute",
        sessionId: SESSION_ID,
        payload: { command: "ls" },
        sideEffect: SIDE_EFFECT,
      });
      writer.append({ eventType: "session.end", sessionId: SESSION_ID, payload: {} });

      expect(fsProbe.appendOpenCount).toBe(1);
      expect(fsProbe.auditFsyncCount).toBe(3);
      expect(readAuditLog(path)).toHaveLength(3);

      writer.close();
      expect(fsProbe.auditFds.size).toBe(0);
      expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
