import { describe, expect, it } from "vitest";
import type { ViewModel } from "@keel/shared";
import { HeadlessUI, renderFrame } from "./headless.js";
import { ALL_OFF_POSTURE } from "./view-model.js";

const status = { tokens: 0, posture: ALL_OFF_POSTURE };

// A `keel run -p` view: a leading SYSTEM preamble (system prompt + env snapshot), then the conversation.
const withPreamble: ViewModel = {
  items: [
    { kind: "message", role: "system", content: "BIG SYSTEM PROMPT — phase protocol instructions" },
    { kind: "message", role: "system", content: "# Environment\nnode 20 · pnpm" },
    { kind: "message", role: "user", content: "fix the bug" },
    { kind: "message", role: "assistant", content: "fixed it" },
  ],
  status,
  streaming: false,
};

describe("headless --verbose preamble gating (Epic 1.23 slice 1b / DX bug a)", () => {
  it("renderFrame hides the leading system preamble when NOT verbose, keeping the conversation", () => {
    const out = renderFrame(withPreamble, false);
    expect(out).not.toContain("BIG SYSTEM PROMPT");
    expect(out).not.toContain("# Environment");
    expect(out).toContain("you  fix the bug");
    expect(out).toContain("fixed it");
  });

  it("renderFrame shows the preamble when verbose — and verbose is the DEFAULT (all goldens unchanged)", () => {
    expect(renderFrame(withPreamble, true)).toContain("BIG SYSTEM PROMPT");
    expect(renderFrame(withPreamble)).toContain("BIG SYSTEM PROMPT"); // default == verbose
  });

  it("hides ONLY the leading preamble — a system NOTICE after the conversation stays visible (honesty)", () => {
    const v: ViewModel = {
      items: [
        { kind: "message", role: "system", content: "PREAMBLE" },
        { kind: "message", role: "user", content: "go" },
        { kind: "message", role: "assistant", content: "done" },
        {
          kind: "message",
          role: "system",
          content: "⚠ run ended — the model/provider returned an error",
        },
      ],
      status,
      streaming: false,
    };
    const out = renderFrame(v, false);
    expect(out).not.toContain("PREAMBLE");
    expect(out).toContain("⚠ run ended"); // a failure notice must NEVER be hidden, even in non-verbose
    expect(out).toContain("done");
  });

  it("does not hide first-run UI panels that are represented as leading system messages", () => {
    const v: ViewModel = {
      items: [
        {
          kind: "message",
          role: "system",
          content: "compact proposal\n  status: review only",
        },
      ],
      status,
      streaming: false,
      firstRun: true,
    };
    const out = renderFrame(v, false);
    expect(out).toContain("compact proposal");
    expect(out).toContain("review only");
  });

  it("a view with NO preamble is unaffected by the verbose flag", () => {
    const v: ViewModel = {
      items: [
        { kind: "message", role: "user", content: "go" },
        { kind: "message", role: "assistant", content: "done" },
      ],
      status,
      streaming: false,
    };
    expect(renderFrame(v, false)).toBe(renderFrame(v, true));
  });

  it("the STREAMING sink also omits the preamble when not verbose", () => {
    const chunks: string[] = [];
    const ui = new HeadlessUI((c) => chunks.push(c), false);
    ui.render(withPreamble);
    ui.finalize();
    const out = chunks.join("");
    expect(out).not.toContain("BIG SYSTEM PROMPT");
    expect(out).toContain("you  fix the bug");
    expect(out).toContain("fixed it");
  });

  it("the streaming sink with verbose (default) stays byte-identical to renderFrame (preamble shown)", () => {
    const chunks: string[] = [];
    const ui = new HeadlessUI((c) => chunks.push(c)); // default verbose
    ui.render(withPreamble);
    ui.finalize();
    expect(chunks.join("")).toBe(renderFrame(withPreamble) + "\n");
  });

  it("the streaming sink (not verbose) equals renderFrame(view,false)+newline — the two paths agree", () => {
    const chunks: string[] = [];
    const ui = new HeadlessUI((c) => chunks.push(c), false);
    ui.render(withPreamble);
    ui.finalize();
    expect(chunks.join("")).toBe(renderFrame(withPreamble, false) + "\n");
  });
});
