import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createGuardianControl, spawnControlledTarget } from "./process-group-controller.mjs";
import { terminateProcessGroup } from "./process-group-cleanup.mjs";

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type SendCallback = (error: Error | null) => void;

class FakeGuardian extends EventEmitter {
  connected = true;
  sent: Array<Record<string, unknown>> = [];
  sendImplementation: (message: Record<string, unknown>, callback?: SendCallback) => boolean = (
    message,
    callback,
  ) => {
    this.sent.push(message);
    callback?.(null);
    return true;
  };

  send(message: Record<string, unknown>, callback?: SendCallback): boolean {
    return this.sendImplementation(message, callback);
  }
}

function deferredExit() {
  let resolve!: (exit: Exit) => void;
  const promise = new Promise<Exit>((resolveExit) => {
    resolve = resolveExit;
  });
  return { promise, resolve };
}

function controlFor(fake: FakeGuardian, exit = deferredExit(), timeoutMs = 50) {
  return {
    exit,
    control: createGuardianControl(fake as never, exit.promise, { timeoutMs }),
  };
}

describe("process-group guardian controller", () => {
  it("correlates an acknowledgement to the exact signal request id", async () => {
    const fake = new FakeGuardian();
    const { control } = controlFor(fake);
    const signaled = control.signalGroup("SIGTERM");
    const [{ id }] = fake.sent;
    let resolved = false;
    void signaled.then(() => {
      resolved = true;
    });

    fake.emit("message", { type: "signal-ack", id: Number(id) + 1 });
    await Promise.resolve();
    expect(resolved).toBe(false);
    fake.emit("message", { type: "signal-ack", id });

    await expect(signaled).resolves.toBeUndefined();
  });

  it("preserves guardian signal errors and their codes", async () => {
    const fake = new FakeGuardian();
    const { control } = controlFor(fake);
    const signaled = control.signalGroup("SIGTERM");
    const [{ id }] = fake.sent;

    fake.emit("message", {
      type: "signal-error",
      id,
      error: { message: "not permitted", code: "EPERM" },
    });

    await expect(signaled).rejects.toMatchObject({ message: "not permitted", code: "EPERM" });
  });

  it("commits KILL only after receiving readiness from the exact guardian", async () => {
    const fake = new FakeGuardian();
    const { control } = controlFor(fake);
    const signaled = control.signalGroup("SIGKILL");
    const [{ id }] = fake.sent;

    fake.emit("message", { type: "signal-ready", id });

    await expect(signaled).resolves.toBeUndefined();
    expect(fake.sent).toEqual([
      { type: "signal-group", id, signal: "SIGKILL" },
      { type: "signal-commit", id },
    ]);
  });

  it("rejects acknowledgements from the wrong protocol phase", async () => {
    const termGuardian = new FakeGuardian();
    const termControl = controlFor(termGuardian).control;
    const termSignal = termControl.signalGroup("SIGTERM");
    termGuardian.emit("message", { type: "signal-ready", id: termGuardian.sent[0]?.id });
    await expect(termSignal).rejects.toMatchObject({ code: "EBADMSG" });

    const killGuardian = new FakeGuardian();
    const killControl = controlFor(killGuardian).control;
    const killSignal = killControl.signalGroup("SIGKILL");
    killGuardian.emit("message", { type: "signal-ack", id: killGuardian.sent[0]?.id });
    await expect(killSignal).rejects.toMatchObject({ code: "EBADMSG" });
  });

  it("fails a send callback error, a synchronous send error, and a closed channel", async () => {
    const callbackFailure = new FakeGuardian();
    callbackFailure.sendImplementation = (_message, callback) => {
      callback?.(Object.assign(new Error("write failed"), { code: "EPIPE" }));
      return false;
    };
    await expect(controlFor(callbackFailure).control.signalGroup("SIGTERM")).rejects.toMatchObject({
      code: "EPIPE",
    });

    const thrownFailure = new FakeGuardian();
    thrownFailure.sendImplementation = () => {
      throw Object.assign(new Error("send threw"), { code: "EIO" });
    };
    await expect(controlFor(thrownFailure).control.signalGroup("SIGTERM")).rejects.toMatchObject({
      code: "EIO",
    });

    const disconnected = new FakeGuardian();
    disconnected.connected = false;
    await expect(controlFor(disconnected).control.signalGroup("SIGTERM")).rejects.toMatchObject({
      code: "EPIPE",
    });
  });

  it("bounds an unacknowledged request", async () => {
    const fake = new FakeGuardian();
    const { control } = controlFor(fake, deferredExit(), 2);

    await expect(control.signalGroup("SIGKILL")).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  it("rejects both pending control and target settlement when the exact guardian exits", async () => {
    const fake = new FakeGuardian();
    const { control, exit } = controlFor(fake);
    const signaled = control.signalGroup("SIGTERM");
    const targetExit = control.waitTargetExit();

    exit.resolve({ code: null, signal: "SIGKILL" });

    await expect(signaled).rejects.toMatchObject({ code: "EPIPE" });
    await expect(targetExit).rejects.toMatchObject({ code: "EPIPE" });
  });

  it("validates target exits and propagates target spawn errors", async () => {
    const valid = new FakeGuardian();
    const validControl = controlFor(valid).control;
    const validExit = validControl.waitTargetExit();
    valid.emit("message", { type: "target-exit", exit: { code: 0, signal: null } });
    await expect(validExit).resolves.toEqual({ code: 0, signal: null });

    for (const exit of [
      { code: "0", signal: null },
      { code: Number.NaN, signal: null },
      { code: 0, signal: "NOT_A_SIGNAL" },
      { code: 0, signal: "SIGTERM" },
      { code: null, signal: null },
    ]) {
      const malformed = new FakeGuardian();
      const malformedControl = controlFor(malformed).control;
      const malformedExit = malformedControl.waitTargetExit();
      malformed.emit("message", { type: "target-exit", exit });
      await expect(malformedExit, JSON.stringify(exit)).rejects.toMatchObject({ code: "EBADMSG" });
    }

    const failed = new FakeGuardian();
    const failedControl = controlFor(failed).control;
    const failedExit = failedControl.waitTargetExit();
    failed.emit("message", { type: "target-error", error: { message: "ENOENT", code: "ENOENT" } });
    await expect(failedExit).rejects.toMatchObject({ message: "ENOENT", code: "ENOENT" });
  });

  it("ignores unrelated messages and uses safe fallbacks for malformed remote errors", async () => {
    const fake = new FakeGuardian();
    const { control } = controlFor(fake);
    fake.emit("message", null);
    fake.emit("message", { type: 9 });
    fake.emit("message", { type: "unrelated" });
    const signaled = control.signalGroup("SIGTERM");
    const [{ id }] = fake.sent;
    fake.emit("message", { type: "signal-error", id, error: null });

    await expect(signaled).rejects.toMatchObject({
      message: "guardian signal request failed",
      code: "UNKNOWN",
    });
  });

  it.runIf(process.platform !== "win32")(
    "ignores unprepared and malformed KILL commits",
    async () => {
      const spawned = spawnControlledTarget(
        process.execPath,
        ["-e", 'process.stdout.write("ready\\n");setInterval(() => {}, 1000)'],
        {},
      );
      const ready = new Promise<void>((resolveReady) => {
        spawned.child.stdout?.once("data", () => resolveReady());
      });
      try {
        await ready;
        await new Promise<void>((resolveSend, rejectSend) => {
          spawned.child.send?.({ type: "signal-commit" }, (error) => {
            if (error == null) resolveSend();
            else rejectSend(error);
          });
        });
        await new Promise<void>((resolveSend, rejectSend) => {
          spawned.child.send?.({ type: "signal-commit", id: 999 }, (error) => {
            if (error == null) resolveSend();
            else rejectSend(error);
          });
        });

        await expect(
          terminateProcessGroup(spawned.processGroupLease!, spawned.guardianExit),
        ).resolves.toBe("reaped");
      } finally {
        await terminateProcessGroup(spawned.processGroupLease!, spawned.guardianExit);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "spawns the real detached guardian and reaps its exact child",
    async () => {
      const spawned = spawnControlledTarget(
        process.execPath,
        ["-e", 'process.stdout.write("ready\\n");setInterval(() => {}, 1000)'],
        {},
      );
      const ready = new Promise<void>((resolveReady) => {
        spawned.child.stdout?.once("data", () => resolveReady());
      });
      try {
        await ready;
        const targetExit = spawned.waitTargetExit();
        await expect(
          terminateProcessGroup(spawned.processGroupLease!, spawned.guardianExit),
        ).resolves.toBe("reaped");
        await expect(targetExit).resolves.toMatchObject({ signal: "SIGTERM" });
      } finally {
        await terminateProcessGroup(spawned.processGroupLease!, spawned.guardianExit);
      }
    },
  );
});
