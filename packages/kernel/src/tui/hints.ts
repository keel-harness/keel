import type { ViewModel } from "@keel/shared";

/**
 * The contextual hint footer — the "never wonder what key to press" line (lazygit/helix). It
 * changes by context so the next action is always discoverable. Pure (gated); both renderers
 * draw the returned string.
 */
export function hintFooter(view: ViewModel): string {
  if (view.overlay?.kind === "palette") return "⇥ complete   ⏎ select   esc cancel";
  if (view.overlay?.kind === "help") return "esc close";
  if (view.overlay?.kind === "reverse-search")
    return "type to search   ⏎ accept   ^R older   esc cancel";
  if (view.overlay?.kind === "at-complete") return "⇥ complete   type to filter   space ends";
  // Mid-run = the assistant is streaming text OR a tool is actively running (Epic 1.5c). Both are
  // moments where interrupt/steering is the relevant next action — the running window is exactly when
  // a long `bash` makes the user want to interrupt or queue a course-correction (§4.10 / §8.6), so the
  // footer must not regress to the idle hint while a tool runs.
  if (view.streaming) return "esc interrupt   /now urgent   type to queue";
  const toolRunning = view.items.some((it) => it.kind === "tool" && it.status === "running");
  if (toolRunning) return "esc interrupt   /now urgent   type to queue";
  // Idle between turns in the multi-turn REPL (Epic 1.23): surface that the session stayed open and
  // how to leave it (exit was otherwise only discoverable in the `/` palette).
  if (view.awaitingInput === true) return "type to continue   ^G editor   ↑ history   /exit quit";
  return "/ commands   ^G editor   ↑ history   ? help";
}
