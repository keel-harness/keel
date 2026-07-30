import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupSandboxTempRootAfterReap,
  cleanupTypedMutationAndSandboxTempAfterReap,
  closeAuditLogForExit,
  closeTypedMutationRunnerForExit,
  installSandboxTempRootFromEnv,
} from "./bin.js";

describe("warden bin shutdown helpers", () => {
  it("closes the audit log cleanly without reporting an error", () => {
    const close = vi.fn();
    const onError = vi.fn();

    closeAuditLogForExit({ close }, onError);

    expect(close).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports audit close failures without throwing so shutdown can still exit", () => {
    const error = new Error("ENOSPC");
    const onError = vi.fn();

    expect(() =>
      closeAuditLogForExit(
        {
          close: () => {
            throw error;
          },
        },
        onError,
      ),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("replaces inherited SRT temp authority for the lifetime of the warden", () => {
    const inherited = "/private/tmp/untrusted-inherited-root";
    const env: NodeJS.ProcessEnv = {
      KEEL_WARDEN_SANDBOX: "srt",
      CLAUDE_CODE_TMPDIR: inherited,
      TMPDIR: "/private/tmp/untrusted-tmpdir",
    };

    const installed = installSandboxTempRootFromEnv(env);
    const owned = installed.declaredTempRoots[0]!;
    expect(owned).not.toBe(inherited);
    expect(env["CLAUDE_CODE_TMPDIR"]).toBe(owned);
    expect(existsSync(owned)).toBe(true);

    installed.cleanup();
    expect(existsSync(owned)).toBe(false);
    expect(env["CLAUDE_CODE_TMPDIR"]).toBe(inherited);
    expect(() => installed.cleanup()).not.toThrow();
  });

  it("does not allocate a sandbox temp root when SRT is disabled", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_TMPDIR: "/keep/existing" };
    const installed = installSandboxTempRootFromEnv(env);

    expect(installed.declaredTempRoots).toEqual([]);
    installed.cleanup();
    expect(env["CLAUDE_CODE_TMPDIR"]).toBe("/keep/existing");
  });

  it("leaves the private sandbox temp root intact when child reaping times out", () => {
    const cleanup = vi.fn();

    cleanupSandboxTempRootAfterReap({ cleanup }, false);
    expect(cleanup).not.toHaveBeenCalled();

    cleanupSandboxTempRootAfterReap({ cleanup }, true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports temp-root cleanup failure without disrupting deterministic shutdown", () => {
    const error = new Error("temp-root identity drift");
    const onError = vi.fn();

    expect(() =>
      cleanupSandboxTempRootAfterReap(
        {
          cleanup: () => {
            throw error;
          },
        },
        true,
        onError,
      ),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("reports retained typed-mutation cleanup debt without exposing cleanup error details", () => {
    const onPending = vi.fn();

    expect(() =>
      closeTypedMutationRunnerForExit(
        {
          close: () => {
            throw new Error("SECRET-PAYLOAD-PATH");
          },
        },
        onPending,
      ),
    ).not.toThrow();
    expect(onPending).toHaveBeenCalledWith(
      "keel-warden typed mutation temporary cleanup remains pending during shutdown",
    );
    expect(JSON.stringify(onPending.mock.calls)).not.toContain("SECRET-PAYLOAD-PATH");
  });

  it("production cleanup wiring preserves both roots until reap and then closes mutation state first", () => {
    const order: string[] = [];
    const runner = {
      close: () => {
        order.push("mutation");
        return { cleanup: "complete" as const };
      },
    };
    const sandboxTempRoot = {
      cleanup: () => {
        order.push("sandbox-temp");
      },
    };

    cleanupTypedMutationAndSandboxTempAfterReap(runner, sandboxTempRoot, false);
    expect(order).toEqual([]);

    cleanupTypedMutationAndSandboxTempAfterReap(runner, sandboxTempRoot, true);
    expect(order).toEqual(["mutation", "sandbox-temp"]);
  });
});
