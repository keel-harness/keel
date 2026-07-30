import { describe, expect, it } from "vitest";
import {
  SEMANTIC_TOKENS,
  THEME,
  TEXT_HIERARCHY,
  TUI_SPACING,
  TOOL_COLOR,
  SPINNER_FRAMES,
  limitedTerminalMode,
  plainTerminalMode,
} from "./theme.js";

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("theme tokens (brand hierarchy + semantic color — tui-principles §4.1 / ADR-0055)", () => {
  it("defines one small named spacing scale for rails, nested evidence, and section rhythm", () => {
    expect(TUI_SPACING).toEqual({
      inset: 1,
      nested: 2,
      labelGap: 2,
      sectionRows: 1,
    });
  });

  it("maps semantic state roles to colors while keeping compatibility aliases", () => {
    expect(THEME.state).toEqual({
      success: "green",
      warning: "yellow",
      danger: "red",
      info: "blue",
    });
    expect(THEME).toMatchObject({
      success: THEME.state.success,
      warning: THEME.state.warning,
      danger: THEME.state.danger,
      info: THEME.state.info,
      accent: "cyan",
    });
  });

  it("defines an ocean-teal brand token that is WCAG AA on black and white terminals", () => {
    expect(THEME.brand).toBe("#00838f");
    expect(contrastRatio(THEME.brand, "#000000")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(THEME.brand, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps brand identity separate from state color (brand is not success/warning/danger/info)", () => {
    expect(Object.values(THEME.state)).not.toContain(THEME.brand);
    expect(THEME.brand).not.toBe(THEME.success);
    expect(THEME.brand).not.toBe(THEME.warning);
    expect(THEME.brand).not.toBe(THEME.danger);
    expect(THEME.brand).not.toBe(THEME.info);
  });

  it("defines a text-safe assistant identity cue separate from user and outcome colors", () => {
    expect(THEME.identity.assistant).not.toBe(THEME.accent);
    expect(THEME.identity.assistant).not.toBe(THEME.surface.responseText);
    expect(Object.values(THEME.state)).not.toContain(THEME.identity.assistant);
    expect(contrastRatio(THEME.identity.assistant, THEME.surface.response)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(THEME.identity.assistant, "#000000")).toBeGreaterThanOrEqual(4.5);
    expect(SEMANTIC_TOKENS.roles.assistant).toEqual({
      label: "keel",
      color: THEME.identity.assistant,
    });
  });

  it("keeps the answer reading surface restrained and high-contrast", () => {
    expect(THEME.surface.response).not.toBe(THEME.brand);
    expect(Object.values(THEME.state)).not.toContain(THEME.surface.response);
    expect(
      contrastRatio(THEME.surface.response, THEME.surface.responseText),
    ).toBeGreaterThanOrEqual(7);
  });

  it("gives focused decisions a restrained neutral surface distinct from answers and state colors", () => {
    expect(THEME.surface.decision).not.toBe(THEME.surface.response);
    expect(THEME.surface.decision).not.toBe(THEME.brand);
    expect(Object.values(THEME.state)).not.toContain(THEME.surface.decision);
    expect(
      contrastRatio(THEME.surface.decision, THEME.surface.decisionText),
    ).toBeGreaterThanOrEqual(7);
  });

  it("defines launch-ready semantic role, state, hierarchy, and composer tokens", () => {
    expect(SEMANTIC_TOKENS.roles).toMatchObject({
      user: { label: "you" },
      assistant: { label: "keel" },
      reasoning: { label: "reasoning" },
      tool: { label: "tool" },
      result: { label: "result" },
      diff: { label: "diff" },
      receipt: { label: "receipt" },
      status: { label: "status" },
      composer: { label: "input" },
      panel: { label: "panel" },
      hint: { label: "hint" },
    });
    expect(SEMANTIC_TOKENS.states).toMatchObject({
      running: { label: "running" },
      queued: { label: "queued" },
      stopping: { label: "stopping" },
      review: { label: "review needed" },
      denied: { label: "denied" },
      failed: { label: "failed" },
      blocked: { label: "blocked" },
      verified: { label: "verified" },
      "not-verified": { label: "not verified" },
      done: { label: "done" },
      danger: { label: "danger" },
    });
    expect(SEMANTIC_TOKENS.hierarchy).toMatchObject({
      primary: { emphasis: "primary" },
      secondary: { emphasis: "secondary" },
      muted: { emphasis: "muted" },
      border: { emphasis: "border" },
      divider: { emphasis: "divider" },
      focus: { emphasis: "focus" },
    });
    expect(SEMANTIC_TOKENS.composer).toMatchObject({
      idle: { label: "type to continue" },
      running: { label: "type to queue" },
      review: { label: "review needed" },
      stopping: { label: "stopping" },
      slash: { label: "commands" },
      file: { label: "file match" },
      paste: { label: "paste" },
      editor: { label: "editor" },
    });
  });

  it("keeps brand/accent tokens out of safety, enforcement, and danger state roles", () => {
    const reservedStateKeys = [
      "done",
      "verified",
      "not-verified",
      "review",
      "denied",
      "failed",
      "blocked",
      "danger",
    ] as const;
    for (const key of reservedStateKeys) {
      const token = SEMANTIC_TOKENS.states[key];
      expect(token.color).not.toBe(THEME.brand);
      expect(token.color).not.toBe(THEME.accent);
    }
  });

  it("defines the text hierarchy and future risk/diff roles without implying enforcement", () => {
    expect(TEXT_HIERARCHY).toEqual({
      brand: { color: THEME.brand, bold: true },
      primary: {},
      secondary: { dimColor: true },
      dim: { dimColor: true },
    });
    expect(THEME.risk).toEqual({
      low: THEME.state.info,
      medium: THEME.state.warning,
      high: THEME.state.danger,
      critical: THEME.state.danger,
    });
    expect(THEME.diff).toEqual({
      add: THEME.state.success,
      remove: THEME.state.danger,
      context: "gray",
      addSurface: "#0f2d1f",
      addText: "#d8fbe4",
      addEmphasisSurface: "#23633d",
      addEmphasisText: "#ffffff",
      removeSurface: "#35181d",
      removeText: "#ffe3e7",
      removeEmphasisSurface: "#7a2734",
      removeEmphasisText: "#ffffff",
    });
    expect(THEME.surface).toEqual({
      prompt: "#303030",
      response: "#182126",
      responseText: "#e6edf3",
      decision: "#211f18",
      decisionText: "#f4f1e8",
    });
    expect(Object.values(THEME.state)).not.toContain(THEME.surface.prompt);
    expect(THEME.surface.prompt).not.toBe(THEME.brand);
  });

  it("keeps extended diff text and emphasized text at readable contrast on their surfaces", () => {
    expect(contrastRatio(THEME.diff.addText, THEME.diff.addSurface)).toBeGreaterThanOrEqual(7);
    expect(
      contrastRatio(THEME.diff.addEmphasisText, THEME.diff.addEmphasisSurface),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(THEME.diff.removeText, THEME.diff.removeSurface)).toBeGreaterThanOrEqual(
      7,
    );
    expect(
      contrastRatio(THEME.diff.removeEmphasisText, THEME.diff.removeEmphasisSurface),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("a running tool is info/in-progress (blue), not warning — the §4.1 reconciliation", () => {
    // Epic 1.5 hardcoded `running: "yellow"`; a running tool is *in progress*, not a warning.
    expect(TOOL_COLOR.running).toBe(THEME.info);
    expect(TOOL_COLOR.ok).toBe(THEME.success);
    expect(TOOL_COLOR.error).toBe(THEME.danger);
  });

  it("provides distinct, non-empty braille spinner frames for the liveness indicator (Epic 1.5c)", () => {
    expect(SPINNER_FRAMES.length).toBeGreaterThanOrEqual(4);
    expect(SPINNER_FRAMES.every((f) => typeof f === "string" && f.length > 0)).toBe(true);
    expect(new Set(SPINNER_FRAMES).size).toBe(SPINNER_FRAMES.length); // all frames distinct (real motion)
  });

  it("detects plain terminal mode from standard no-color or dumb-terminal env", () => {
    expect(plainTerminalMode({ NO_COLOR: "1" })).toBe(true);
    expect(plainTerminalMode({ FORCE_COLOR: "0" })).toBe(true);
    expect(plainTerminalMode({ TERM: "dumb" })).toBe(true);
    expect(plainTerminalMode({ TERM: "DUMB" })).toBe(true);
    expect(plainTerminalMode({})).toBe(false);
    expect(plainTerminalMode({ FORCE_COLOR: "1", TERM: "xterm-256color" })).toBe(false);
  });

  it("reserves structural fallback for genuinely limited terminals, not monochrome ones", () => {
    expect(limitedTerminalMode({ TERM: "dumb" })).toBe(true);
    expect(limitedTerminalMode({ TERM: "DUMB", NO_COLOR: "1" })).toBe(true);
    expect(limitedTerminalMode({ TERM: "xterm-256color", NO_COLOR: "1" })).toBe(false);
    expect(limitedTerminalMode({ TERM: "xterm-256color", FORCE_COLOR: "0" })).toBe(false);
    expect(limitedTerminalMode({})).toBe(false);
  });

  it("defaults to process.env when no env map is supplied", () => {
    const previous = {
      NO_COLOR: process.env["NO_COLOR"],
      FORCE_COLOR: process.env["FORCE_COLOR"],
      TERM: process.env["TERM"],
    };
    try {
      delete process.env["NO_COLOR"];
      process.env["FORCE_COLOR"] = "0";
      process.env["TERM"] = "xterm-256color";

      expect(plainTerminalMode()).toBe(true);
    } finally {
      if (previous.NO_COLOR === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = previous.NO_COLOR;
      if (previous.FORCE_COLOR === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = previous.FORCE_COLOR;
      if (previous.TERM === undefined) delete process.env["TERM"];
      else process.env["TERM"] = previous.TERM;
    }
  });
});
