import { describe, expect, it } from "vitest";
import type { ViewModel } from "@keel/shared";
import { hintFooter } from "./hints.js";

const base: ViewModel = {
  items: [],
  status: { tokens: 0, posture: { sandbox: false, egress: false, audit: false } },
  streaming: false,
};

describe("hintFooter (contextual — never wonder what to press)", () => {
  it("idle: offers commands, history, help", () => {
    expect(hintFooter(base)).toBe("/ commands   ^G editor   ↑ history   ? help");
  });
  it("idle between turns (awaitingInput): surfaces continue + how to exit (Epic 1.23)", () => {
    const footer = hintFooter({ ...base, awaitingInput: true });
    expect(footer).toContain("type to continue");
    expect(footer).toContain("^G editor");
    expect(footer).toContain("/exit"); // exit must be discoverable in the footer, not just the palette
  });
  it("mid-run: offers interrupt, urgent, queue", () => {
    expect(hintFooter({ ...base, streaming: true })).toBe(
      "esc interrupt   /now urgent   type to queue",
    );
  });
  it("a running tool is also mid-run: offers interrupt/urgent/queue even when not text-streaming (1.5c)", () => {
    const running: ViewModel = {
      ...base,
      items: [{ kind: "tool", id: "c0", name: "bash", status: "running", summary: "" }],
    };
    expect(hintFooter(running)).toBe("esc interrupt   /now urgent   type to queue");
  });
  it("palette open: offers completion, selection, and cancel", () => {
    const footer = hintFooter({ ...base, overlay: { kind: "palette", query: "" } });
    expect(footer).toContain("complete");
    expect(footer).toContain("select");
    expect(footer).toContain("esc cancel");
  });
  it("help open: offers close", () => {
    expect(hintFooter({ ...base, overlay: { kind: "help" } })).toContain("esc close");
  });
  it("reverse-search open: offers accept, step-older, and cancel (Epic 1.23 slice 3b)", () => {
    const footer = hintFooter({ ...base, overlay: { kind: "reverse-search", query: "te" } });
    expect(footer).toContain("accept");
    expect(footer).toContain("older"); // ^R steps to the next-older match
    expect(footer).toContain("esc cancel");
  });
  it("at-complete open: offers complete + filter (Epic 1.23 slice 5)", () => {
    const footer = hintFooter({ ...base, overlay: { kind: "at-complete", query: "src/" } });
    expect(footer).toContain("complete");
    expect(footer).toContain("filter");
  });
});
