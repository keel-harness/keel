import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGuardedProcessGroupLease, terminateProcessGroup } from "./process-group-cleanup.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const running = { exited: false } as const;
const killed = { exited: true, exit: { code: null, signal: "SIGKILL" } } as const;

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(`guardian ${code}`), { code });
}

function scriptedSettlements(
  ...settlements: Array<
    | { readonly exited: false }
    | {
        readonly exited: true;
        readonly exit: { readonly code: number | null; readonly signal: string | null };
      }
  >
) {
  let index = 0;
  return {
    settleGuardian: async () => settlements[Math.min(index++, settlements.length - 1)]!,
    termGraceMs: 2,
    killTimeoutMs: 2,
  };
}

describe("compiled-Warden guarded process-group cleanup", () => {
  it("routes TERM then KILL through the guardian and retires on its exact SIGKILL exit", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_242, {
      signalGroup: async (signal) => {
        signals.push(signal);
      },
    });

    await expect(
      terminateProcessGroup(
        lease,
        new Promise(() => {}),
        scriptedSettlements(running, running, killed),
      ),
    ).resolves.toBe("reaped");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(lease.state).toBe("reaped");
  });

  it("never signals a numeric PGID after the exact guardian already exited", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_243, {
      signalGroup: async (signal) => {
        signals.push(signal);
      },
    });

    await expect(
      terminateProcessGroup(
        lease,
        Promise.resolve({ code: 0, signal: null }),
        scriptedSettlements({ exited: true, exit: { code: 0, signal: null } }),
      ),
    ).rejects.toThrow(/guardian exited before cleanup/iu);
    expect(signals).toEqual([]);
    expect(lease.state).toBe("indeterminate");
  });

  it("does not KILL after the guardian unexpectedly exits during TERM grace", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_244, {
      signalGroup: async (signal) => {
        signals.push(signal);
      },
    });

    await expect(
      terminateProcessGroup(
        lease,
        new Promise(() => {}),
        scriptedSettlements(running, { exited: true, exit: { code: 0, signal: null } }),
      ),
    ).rejects.toThrow(/guardian exited during TERM cleanup/iu);
    expect(signals).toEqual(["SIGTERM"]);
    expect(lease.state).toBe("indeterminate");
  });

  it("fails closed on an EPERM guardian request without escalating", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_245, {
      signalGroup: async (signal) => {
        signals.push(signal);
        throw errno("EPERM");
      },
    });

    await expect(
      terminateProcessGroup(lease, new Promise(() => {}), scriptedSettlements(running)),
    ).rejects.toThrow(/guardian refused SIGTERM.*EPERM/iu);
    expect(signals).toEqual(["SIGTERM"]);
    expect(lease.state).toBe("indeterminate");
  });

  it("does not call KILL when the guardian reports ESRCH for TERM", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_246, {
      signalGroup: async (signal) => {
        signals.push(signal);
        throw errno("ESRCH");
      },
    });

    await expect(
      terminateProcessGroup(lease, new Promise(() => {}), scriptedSettlements(running)),
    ).rejects.toThrow(/guardian refused SIGTERM.*ESRCH/iu);
    expect(signals).toEqual(["SIGTERM"]);
    expect(lease.state).toBe("indeterminate");
  });

  it("fails closed when the guardian cannot accept KILL", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_247, {
      signalGroup: async (signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") throw errno("EPIPE");
      },
    });

    await expect(
      terminateProcessGroup(lease, new Promise(() => {}), scriptedSettlements(running, running)),
    ).rejects.toThrow(/guardian refused SIGKILL.*EPIPE/iu);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(lease.state).toBe("indeterminate");
  });

  it("fails the bounded cleanup if an acknowledged KILL does not reap the guardian", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_248, {
      signalGroup: async (signal) => {
        signals.push(signal);
      },
    });

    await expect(
      terminateProcessGroup(
        lease,
        new Promise(() => {}),
        scriptedSettlements(running, running, running),
      ),
    ).rejects.toThrow(/survived SIGKILL cleanup: 4248/iu);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(lease.state).toBe("indeterminate");
  });

  it("requires the guardian to exit specifically from SIGKILL", async () => {
    const lease = createGuardedProcessGroupLease(4_249, {
      signalGroup: async () => {},
    });

    await expect(
      terminateProcessGroup(
        lease,
        new Promise(() => {}),
        scriptedSettlements(running, running, {
          exited: true,
          exit: { code: 1, signal: null },
        }),
      ),
    ).rejects.toThrow(/guardian did not exit from SIGKILL/iu);
    expect(lease.state).toBe("indeterminate");
  });

  it("is idempotent after the guardian has been reaped", async () => {
    const signals: NodeJS.Signals[] = [];
    const lease = createGuardedProcessGroupLease(4_250, {
      signalGroup: async (signal) => {
        signals.push(signal);
      },
    });
    const guardianExit = new Promise(() => {});

    await terminateProcessGroup(lease, guardianExit, scriptedSettlements(running, running, killed));
    await expect(terminateProcessGroup(lease, guardianExit)).resolves.toBe("reaped");
    await expect(lease.signal("SIGTERM")).resolves.toBe(false);
    expect(() => lease.markReaped({ code: null, signal: "SIGKILL" })).not.toThrow();
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("uses the exact guardian exit promise for the default bounded settlement", async () => {
    let resolveGuardian!: (exit: { code: null; signal: "SIGKILL" }) => void;
    const guardianExit = new Promise<{ code: null; signal: "SIGKILL" }>((resolveExit) => {
      resolveGuardian = resolveExit;
    });
    const lease = createGuardedProcessGroupLease(4_251, {
      signalGroup: async (signal) => {
        if (signal === "SIGKILL") {
          setTimeout(() => resolveGuardian({ code: null, signal: "SIGKILL" }), 2);
        }
      },
    });

    await expect(
      terminateProcessGroup(lease, guardianExit, { termGraceMs: 2, killTimeoutMs: 50 }),
    ).resolves.toBe("reaped");
  });

  it("keeps the first indeterminate error stable across every later control path", async () => {
    const lease = createGuardedProcessGroupLease(4_252, {
      signalGroup: async () => {
        throw new Error("unclassified failure");
      },
    });

    const first = await terminateProcessGroup(
      lease,
      new Promise(() => {}),
      scriptedSettlements(running),
    ).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/guardian refused SIGTERM.*UNKNOWN/iu);
    await expect(lease.signal("SIGTERM")).rejects.toBe(first);
    await expect(terminateProcessGroup(lease, new Promise(() => {}))).rejects.toBe(first);
    expect(() => lease.markReaped({ code: null, signal: "SIGKILL" })).toThrow(first as Error);
  });

  it("rejects PGID 1 without invoking guardian control", () => {
    const signals: NodeJS.Signals[] = [];

    expect(() =>
      createGuardedProcessGroupLease(1, {
        signalGroup: async (signal) => {
          signals.push(signal);
        },
      }),
    ).toThrow(/greater than 1/iu);
    expect(() =>
      createGuardedProcessGroupLease(Number.NaN, {
        signalGroup: async () => {},
      }),
    ).toThrow(/greater than 1/iu);
    expect(() =>
      createGuardedProcessGroupLease(2, {
        signalGroup: undefined as never,
      }),
    ).toThrow(/guardian control is required/iu);
    expect(signals).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "keeps the executable resistant-descendant self-test as the carrier oracle",
    () => {
      const output = execFileSync(
        process.execPath,
        [join(repoRoot, "packaging", "smoke-compiled-warden.mjs"), "--self-test"],
        { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
      );

      expect(output).toContain("compiled warden evidence and lifecycle self-test passed");
      expect(output).toContain("process-group-reaped");
    },
  );
});
