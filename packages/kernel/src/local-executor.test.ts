import { describe, expect, it } from "vitest";
import { LocalExecutor } from "./local-executor.js";
import { KERNEL_STRINGS } from "./strings.js";
import { toolPresentationOutcome } from "./tool-presentation-outcome.js";

describe("LocalExecutor", () => {
  it("runs a registered handler and returns ok", async () => {
    const exec = new LocalExecutor({ echo: (args) => JSON.stringify(args) });
    const r = await exec.execute({ id: "c1", name: "echo", args: { text: "hi" } });
    expect(r).toEqual({ ok: true, output: '{"text":"hi"}' });
  });

  it("returns a structured error (not a throw) for an unknown tool", async () => {
    const exec = new LocalExecutor();
    const r = await exec.execute({ id: "c1", name: "missing", args: {} });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("missing");
  });

  it("forwards opts.onOutput through to the handler (Epic 1.5c liveness)", async () => {
    let seen: ((c: string) => void) | undefined;
    const exec = new LocalExecutor({
      probe: (_args, opts) => {
        seen = opts?.onOutput;
        return "ok";
      },
    });
    const sink = (_c: string): void => {};
    await exec.execute({ id: "c0", name: "probe", args: {} }, { onOutput: sink });
    expect(seen).toBe(sink);
  });

  it("passes the executor-provided tool call id to handlers for control-plane-owned resources", async () => {
    let seen: string | undefined;
    const exec = new LocalExecutor({
      probe: (_args, opts) => {
        seen = opts?.toolCallId;
        return "ok";
      },
    });

    await expect(exec.execute({ id: "call_lease", name: "probe", args: {} })).resolves.toEqual({
      ok: true,
      output: "ok",
    });

    expect(seen).toBe("call_lease");
  });

  it("converts a handler throw into a structured error result", async () => {
    const exec = new LocalExecutor({
      boom: () => {
        throw new Error("kaboom");
      },
    });
    const r = await exec.execute({ id: "c1", name: "boom", args: {} });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("kaboom");
  });

  it("supports register() after construction", async () => {
    const exec = new LocalExecutor();
    exec.register("echo", (args) => JSON.stringify(args));
    const r = await exec.execute({ id: "c1", name: "echo", args: { a: 1 } });
    expect(r).toEqual({ ok: true, output: '{"a":1}' });
  });

  it("converts a non-Error throw into a structured error result (String fallback)", async () => {
    const exec = new LocalExecutor({
      weird: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercising the non-Error fallback
        throw "stringy failure";
      },
    });
    const r = await exec.execute({ id: "c1", name: "weird", args: {} });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("stringy failure");
  });

  it("short-circuits an already-aborted signal without running the handler", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const exec = new LocalExecutor({
      echo: () => {
        ran = true;
        return "ran";
      },
    });
    const r = await exec.execute(
      { id: "c1", name: "echo", args: {} },
      { signal: controller.signal },
    );
    expect(ran).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.output).toBe(KERNEL_STRINGS.toolAborted);
    expect(toolPresentationOutcome(r)).toBe("stopped");
  });

  it("keeps an abort raised by a running handler distinct from a tool failure", async () => {
    const controller = new AbortController();
    const exec = new LocalExecutor({
      wait: () => {
        controller.abort();
        throw new Error("operation aborted");
      },
    });

    const result = await exec.execute(
      { id: "c1", name: "wait", args: {} },
      { signal: controller.signal },
    );

    expect(result).toEqual({ ok: false, output: KERNEL_STRINGS.toolAborted });
    expect(toolPresentationOutcome(result)).toBe("stopped");
  });

  it("exposes the honest-YOLO banner from strings", () => {
    expect(new LocalExecutor().banner).toBe(KERNEL_STRINGS.yoloBanner);
    expect(KERNEL_STRINGS.yoloBanner).toContain("NO ENFORCEMENT");
  });
});
