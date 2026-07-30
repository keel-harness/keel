/**
 * TUI color + hierarchy tokens (tui-principles §4.1, ADR-0055).
 *
 * Structure and a restrained ocean-teal brand encode identity + hierarchy; semantic colors still
 * encode state. Brand is deliberately separate from success/warning/danger/info so an accent can
 * never read as an enforcement guarantee. The headless surface has no color at all (mono by
 * construction), and every signal also carries a glyph/label so nothing relies on color alone.
 *
 * This one map is the seam a future theme swaps (`mono`/`high-contrast`/… — not built yet);
 * centralizing it also reconciles the Epic-1.5 hardcoded `running: yellow` — a running tool is *in
 * progress* (info), not a warning.
 */
const STATE_COLOR = {
  success: "green", // verified · ok · added
  warning: "yellow", // review · pending · partial · queued-input indicator · the caution marker
  danger: "red", // failed · blocked · removed
  info: "blue", // current · in-progress · information
} as const;

/** Small terminal layout scale. Names encode hierarchy rather than individual components. */
export const TUI_SPACING = {
  inset: 1,
  nested: 2,
  labelGap: 2,
  sectionRows: 1,
} as const;

export const THEME = {
  brand: "#00838f", // ocean teal, AA contrast on black and white terminal backgrounds
  identity: {
    // A lighter ocean teal for small text on the dark response surface. Identity only: never state.
    assistant: "#26a69a",
  },
  state: STATE_COLOR,
  risk: {
    low: STATE_COLOR.info, // advisory only; real risk verdicts arrive with policy/warden
    medium: STATE_COLOR.warning,
    high: STATE_COLOR.danger,
    critical: STATE_COLOR.danger,
  },
  diff: {
    add: STATE_COLOR.success,
    remove: STATE_COLOR.danger,
    context: "gray",
    // Extended-color terminals receive quiet, full-row surfaces; text remains deliberately pale
    // rather than saturated so large diffs read as source first and status second.
    addSurface: "#0f2d1f",
    addText: "#d8fbe4",
    addEmphasisSurface: "#23633d",
    addEmphasisText: "#ffffff",
    removeSurface: "#35181d",
    removeText: "#ffe3e7",
    removeEmphasisSurface: "#7a2734",
    removeEmphasisText: "#ffffff",
  },
  surface: {
    prompt: "#303030", // neutral user-turn highlight; not a state, brand, or trust signal
    response: "#182126", // quiet reading surface; never a status or enforcement signal
    responseText: "#e6edf3",
    decision: "#211f18", // neutral warm-black focus surface; state remains in the labeled border
    decisionText: "#f4f1e8",
  },
  accent: "cyan", // the user-input prompt · command names
  // Compatibility aliases for existing renderers. Prefer `state.*` / `diff.*` in new code.
  success: STATE_COLOR.success,
  warning: STATE_COLOR.warning,
  danger: STATE_COLOR.danger,
  info: STATE_COLOR.info,
} as const;

export const TEXT_HIERARCHY = {
  brand: { color: THEME.brand, bold: true },
  primary: {},
  secondary: { dimColor: true },
  dim: { dimColor: true },
} as const;

export const SEMANTIC_TOKENS = {
  roles: {
    user: { label: "you", color: THEME.accent },
    assistant: { label: "keel", color: THEME.identity.assistant },
    reasoning: { label: "reasoning", color: "gray" },
    tool: { label: "tool", color: THEME.state.info },
    result: { label: "result", color: "gray" },
    diff: { label: "diff", color: "gray" },
    receipt: { label: "receipt", color: THEME.state.info },
    status: { label: "status", color: "gray" },
    composer: { label: "input", color: THEME.accent },
    panel: { label: "panel", color: THEME.state.info },
    hint: { label: "hint", color: "gray" },
  },
  states: {
    running: { label: "running", color: THEME.state.info },
    queued: { label: "queued", color: THEME.state.warning },
    stopping: { label: "stopping", color: THEME.state.warning },
    review: { label: "review needed", color: THEME.state.warning },
    denied: { label: "denied", color: THEME.state.danger },
    failed: { label: "failed", color: THEME.state.danger },
    blocked: { label: "blocked", color: THEME.state.danger },
    verified: { label: "verified", color: THEME.state.success },
    "not-verified": { label: "not verified", color: THEME.state.warning },
    done: { label: "done", color: THEME.state.success },
    danger: { label: "danger", color: THEME.state.danger },
  },
  hierarchy: {
    primary: { emphasis: "primary" },
    secondary: { emphasis: "secondary" },
    muted: { emphasis: "muted" },
    border: { emphasis: "border" },
    divider: { emphasis: "divider" },
    focus: { emphasis: "focus" },
  },
  composer: {
    idle: { label: "type to continue" },
    running: { label: "type to queue" },
    review: { label: "review needed" },
    stopping: { label: "stopping" },
    slash: { label: "commands" },
    file: { label: "file match" },
    paste: { label: "paste" },
    editor: { label: "editor" },
  },
} as const;

/** Tool status → semantic token. `running` is info (in progress), `ok` success, `error` danger —
 *  the §4.1 reconciliation of the Epic-1.5 inline `{ running: "yellow", … }`. */
export const TOOL_COLOR = {
  running: THEME.state.info,
  ok: THEME.state.success,
  error: THEME.state.danger,
} as const;

export function plainTerminalMode(env: Record<string, string | undefined> = process.env): boolean {
  return (
    env["NO_COLOR"] !== undefined ||
    env["FORCE_COLOR"] === "0" ||
    (env["TERM"] ?? "").toLowerCase() === "dumb"
  );
}

export type TerminalColorCapability = "mono" | "basic" | "extended";

/** Conservative presentation capability for diffs. `NO_COLOR`, an explicit force-off, and a dumb
 * terminal always win. Extended surfaces require an affirmative 256/true-color signal; an unknown
 * terminal gets the portable foreground-only treatment. */
export function terminalColorCapability(
  env: Record<string, string | undefined> = process.env,
): TerminalColorCapability {
  if (plainTerminalMode(env)) return "mono";
  const forced = env["FORCE_COLOR"];
  const term = (env["TERM"] ?? "").toLowerCase();
  const colorTerm = (env["COLORTERM"] ?? "").toLowerCase();
  if (
    forced === "2" ||
    forced === "3" ||
    term.includes("256color") ||
    term.includes("truecolor") ||
    term.includes("direct") ||
    colorTerm === "truecolor" ||
    colorTerm === "24bit"
  ) {
    return "extended";
  }
  return "basic";
}

export interface DiffTextStyle {
  readonly color?: string;
  readonly backgroundColor?: string;
  readonly bold?: boolean;
  readonly underline?: boolean;
  readonly dimColor?: boolean;
}

/** One reviewed mapping from semantic diff state to Ink styling. Markers and gutters retain the
 * meaning in every mode; color is redundant. Basic terminals avoid arbitrary background palettes,
 * while monochrome output remains completely free of color/style escape sequences. */
export function diffStylePlan(
  kind: "context" | "add" | "del",
  capability: TerminalColorCapability,
  emphasized: boolean,
): DiffTextStyle {
  if (capability === "mono") return {};
  if (kind === "context") return { dimColor: true };
  if (capability === "basic") {
    return {
      color: kind === "add" ? THEME.diff.add : THEME.diff.remove,
      ...(emphasized ? { bold: true, underline: true } : {}),
    };
  }
  if (kind === "add") {
    return emphasized
      ? {
          color: THEME.diff.addEmphasisText,
          backgroundColor: THEME.diff.addEmphasisSurface,
          bold: true,
        }
      : { color: THEME.diff.addText, backgroundColor: THEME.diff.addSurface };
  }
  return emphasized
    ? {
        color: THEME.diff.removeEmphasisText,
        backgroundColor: THEME.diff.removeEmphasisSurface,
        bold: true,
      }
    : { color: THEME.diff.removeText, backgroundColor: THEME.diff.removeSurface };
}

/** Whether the terminal lacks the structural capabilities needed for a bounded decision box. Color
 * preferences are deliberately excluded: monochrome terminals still benefit from the box hierarchy. */
export function limitedTerminalMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env["TERM"] ?? "").toLowerCase() === "dumb";
}

/** Braille "dots" spinner frames for the running-tool liveness indicator (Epic 1.5c — purposeful
 *  liveness). Hand-rolled (no dependency, per the no-convenience-deps bar); the Ink renderer advances
 *  through them only while a tool is running, in the `running` (info/blue) color — motion encodes
 *  "work in progress", never decoration. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
