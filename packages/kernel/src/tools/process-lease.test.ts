import { describe, expect, it, vi } from "vitest";
import { ProcessLeaseRegistry, readProcessStartIdentity } from "./process-lease.js";

describe("ProcessLeaseRegistry", () => {
  it("creates leases only from executor-provided owner tool-call identity and records PID start identity", () => {
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: (pid) => `start:${String(pid)}`,
      signalProcessGroup: () => {},
      sleep: async () => {},
    });

    const lease = registry.create({
      kind: "service",
      ownerToolCallId: "call_service",
      command: "python3 -m http.server 8000",
      pid: 1234,
      logPath: "/tmp/keel-http.log",
      scope: "until-verifier-handoff",
      healthCommand: "curl -fsS http://127.0.0.1:8000/",
    });

    expect(lease.id).toMatch(/^lease_/);
    expect(lease).toMatchObject({
      kind: "service",
      ownerToolCallId: "call_service",
      command: "python3 -m http.server 8000",
      pid: 1234,
      processGroupId: 1234,
      startIdentity: "start:1234",
      logPath: "/tmp/keel-http.log",
      scope: "until-verifier-handoff",
      cleanupOwner: "kernel",
      healthCommand: "curl -fsS http://127.0.0.1:8000/",
    });

    expect(registry.active()).toEqual([lease]);
  });

  it("can use default ids without an injected id hook", () => {
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: (pid) => `start:${String(pid)}`,
      signalProcessGroup: () => {},
      sleep: async () => {},
    });

    const lease = registry.create({
      kind: "job",
      ownerToolCallId: "call_default",
      command: "node -e 'setInterval(() => {}, 1000)'",
      pid: 9876,
      logPath: "/tmp/keel-default.log",
      scope: "until-verifier-handoff",
    });

    expect(lease.id).toMatch(/^lease_[0-9a-f]+$/u);
    expect(lease.startIdentity).toBe("start:9876");
    expect(readProcessStartIdentity(-1)).toBeUndefined();
  });

  it("uses default cleanup helpers without failing on an already-missing process group", async () => {
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: (pid) => `start:${String(pid)}`,
      killGraceMs: 1,
    });
    const lease = registry.create({
      kind: "job",
      ownerToolCallId: "call_default_cleanup",
      command: "john hash.txt",
      pid: 999_999_999,
      logPath: "/tmp/keel-missing.log",
      scope: "until-verifier-handoff",
    });

    await expect(registry.cleanup(lease.id)).resolves.toEqual({
      id: lease.id,
      status: "cleaned",
    });
  });

  it("derives process start identity from proc stat before falling back to ps output", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      readFileSync: vi.fn(
        () => "1234 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242",
      ),
    }));
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
      execFileSync: vi.fn(() => "Thu Jul  2 10:00:00 2026\n"),
    }));
    const procModule = await import("./process-lease.js");
    expect(procModule.readProcessStartIdentity(1234)).toBe("proc:424242");

    vi.resetModules();
    vi.doMock("node:fs", async () => ({
      ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
      readFileSync: vi.fn(() => "malformed stat"),
    }));
    vi.doMock("node:child_process", async () => ({
      ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
      execFileSync: vi.fn(() => "Thu Jul  2 10:00:00 2026\n"),
    }));
    const psModule = await import("./process-lease.js");
    expect(psModule.readProcessStartIdentity(1234)).toBe("ps:Thu Jul  2 10:00:00 2026");

    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("rejects lease creation without a non-empty executor-provided owner tool-call id", () => {
    const registry = new ProcessLeaseRegistry();

    expect(() =>
      registry.create({
        kind: "service",
        ownerToolCallId: "",
        command: "python3 -m http.server 8000",
        pid: 1234,
        logPath: "/tmp/keel-http.log",
        scope: "until-verifier-handoff",
      }),
    ).toThrow(/executor-provided owner tool call id/i);
  });

  it("rejects invalid pids and reports missing cleanup ids without signaling", async () => {
    const registry = new ProcessLeaseRegistry();

    expect(() =>
      registry.create({
        kind: "service",
        ownerToolCallId: "call_service",
        command: "python3 -m http.server 8000",
        pid: 0,
        logPath: "/tmp/keel-http.log",
        scope: "until-verifier-handoff",
      }),
    ).toThrow(/pid must be positive/i);
    await expect(registry.cleanup("lease_missing")).resolves.toEqual({
      id: "lease_missing",
      status: "missing",
    });
  });

  it("fails closed when process start identity is unavailable", () => {
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: () => undefined,
    });

    expect(() =>
      registry.create({
        kind: "service",
        ownerToolCallId: "call_service",
        command: "python3 -m http.server 8000",
        pid: 1234,
        logPath: "/tmp/keel-http.log",
        scope: "until-verifier-handoff",
      }),
    ).toThrow(/start identity unavailable/i);
  });

  it("cleans up by process group and waits for TERM before KILL", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const sleeps: number[] = [];
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: () => "same-start",
      signalProcessGroup: (pgid, signal) => signals.push([pgid, signal]),
      isProcessAlive: () => false,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      killGraceMs: 25,
    });
    const lease = registry.create({
      kind: "job",
      ownerToolCallId: "call_job",
      command: "john hash.txt",
      pid: 4321,
      logPath: "/tmp/keel-john.log",
      scope: "until-verifier-handoff",
      statusCommand: "john --show hash.txt",
    });

    const result = await registry.cleanup(lease.id);

    expect(result).toEqual({ id: lease.id, status: "cleaned" });
    expect(signals).toEqual([
      [4321, "SIGTERM"],
      [4321, "SIGKILL"],
    ]);
    expect(sleeps).toEqual([25]);
    expect(registry.active()).toEqual([]);
  });

  it("keeps the lease retryable when process-group signaling fails", async () => {
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: () => "same-start",
      signalProcessGroup: () => {
        throw new Error("EPERM");
      },
      sleep: async () => {},
    });
    const lease = registry.create({
      kind: "service",
      ownerToolCallId: "call_service",
      command: "python3 -m http.server 8000",
      pid: 1234,
      logPath: "/tmp/keel-http.log",
      scope: "until-verifier-handoff",
    });

    await expect(registry.cleanup(lease.id)).resolves.toEqual({
      id: lease.id,
      status: "signal-failed",
      error: "EPERM",
    });
    expect(registry.active()).toEqual([lease]);
  });

  it("keeps the lease retryable when the process remains observable after cleanup signals", async () => {
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: () => "same-start",
      signalProcessGroup: () => {},
      isProcessAlive: () => true,
      sleep: async () => {},
    });
    const lease = registry.create({
      kind: "job",
      ownerToolCallId: "call_job",
      command: "john hash.txt",
      pid: 4321,
      logPath: "/tmp/keel-john.log",
      scope: "until-verifier-handoff",
    });

    await expect(registry.cleanup(lease.id)).resolves.toEqual({
      id: lease.id,
      status: "still-running",
    });
    expect(registry.active()).toEqual([lease]);
  });

  it("refuses to signal a reused pid when recorded start identity no longer matches", async () => {
    let reads = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const registry = new ProcessLeaseRegistry({
      readStartIdentity: () => {
        reads += 1;
        return reads === 1 ? "original-start" : "reused-start";
      },
      signalProcessGroup: (pgid, signal) => signals.push([pgid, signal]),
      sleep: async () => {},
    });
    const lease = registry.create({
      kind: "service",
      ownerToolCallId: "call_service",
      command: "python3 -m http.server 8000",
      pid: 1234,
      logPath: "/tmp/keel-http.log",
      scope: "until-verifier-handoff",
    });

    const result = await registry.cleanup(lease.id);

    expect(result).toEqual({ id: lease.id, status: "identity-mismatch" });
    expect(signals).toEqual([]);
    expect(registry.active()).toEqual([]);
  });
});
