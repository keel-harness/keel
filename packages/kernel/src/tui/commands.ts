import type { UiDensity } from "@keel/shared";

/** A slash command shown in the `/` palette and `?` help. */
export type CommandGroupId =
  | "common"
  | "work"
  | "protections"
  | "inspect"
  | "control"
  | "density"
  | "advanced"
  | "future"
  | "danger";

export type CommandRoute = "panel" | "local-action" | "starts-turn" | "notice" | "exit";
export type CommandContext = "idle" | "running" | "review";

export interface Command {
  readonly name: string;
  readonly description: string;
  readonly group: CommandGroupId;
  readonly availability: string;
  readonly result: string;
  readonly route: CommandRoute;
  /** Hidden from the empty first-run palette, but still searchable and exact-match runnable. */
  readonly promoted?: boolean;
  /** Renders with a ⚠ marker; reserved for genuinely consequential commands. */
  readonly danger?: boolean;
}

export interface CommandGroup {
  readonly id: CommandGroupId;
  readonly label: string;
  readonly commands: readonly Command[];
}

const GROUP_ORDER: readonly CommandGroupId[] = [
  "common",
  "work",
  "protections",
  "inspect",
  "control",
  "density",
  "advanced",
  "future",
  "danger",
];
const GROUP_LABEL: Readonly<Record<CommandGroupId, string>> = {
  common: "common actions",
  work: "work controls",
  protections: "protections",
  inspect: "inspect",
  control: "control",
  density: "density",
  advanced: "advanced diagnostics",
  future: "future",
  danger: "danger",
};

/** Slash commands shown in the default `/` palette. Launch-visible commands are implemented here and
 *  avoid internal enforcement jargon; hidden legacy commands still resolve through `commandByName`
 *  below so a typed `/session`/`/yolo` never leaks to the model as a prompt. */
export const COMMANDS: readonly Command[] = [
  {
    name: "/help",
    description: "opens help and shortcuts",
    group: "common",
    availability: "available now",
    result: "opens help",
    route: "panel",
  },
  {
    name: "/diff",
    description: "toggles detail; /diff review inspects changes",
    group: "common",
    availability: "available now",
    result: "changes detail or opens focused review",
    route: "local-action",
  },
  {
    name: "/policies",
    description: "shows active protections",
    group: "protections",
    availability: "available now",
    result: "opens protections",
    route: "panel",
  },
  {
    name: "/reviews",
    description: "shows review history",
    group: "protections",
    availability: "available now",
    result: "opens review queue",
    route: "panel",
  },
  {
    name: "/policy",
    description: "shows active protections",
    group: "protections",
    availability: "available now",
    result: "opens protections",
    route: "panel",
    promoted: false,
  },
  {
    name: "/context",
    description: "shows session details",
    group: "inspect",
    availability: "available now",
    result: "opens context panel",
    route: "panel",
  },
  {
    name: "/model",
    description: "shows model selection details",
    group: "inspect",
    availability: "available now",
    result: "opens model panel",
    route: "panel",
  },
  {
    name: "/capabilities",
    description: "shows what keel can do here",
    group: "inspect",
    availability: "available now",
    result: "opens capabilities",
    route: "panel",
  },
  {
    name: "/about",
    description: "shows product basics",
    group: "inspect",
    availability: "available now",
    result: "opens about",
    route: "panel",
  },
  {
    name: "/exit",
    description: "ends session",
    group: "control",
    availability: "available now",
    result: "quits keel",
    route: "exit",
  },
  {
    name: "/quit",
    description: "ends session",
    group: "control",
    availability: "available now",
    result: "quits keel",
    route: "exit",
    promoted: false,
  },
  {
    name: "/quiet",
    description: "hides routine successful tools",
    group: "density",
    availability: "available now",
    result: "sets quiet density",
    route: "local-action",
  },
  {
    name: "/normal",
    description: "uses standard detail",
    group: "density",
    availability: "available now",
    result: "sets normal density",
    route: "local-action",
    promoted: false,
  },
  {
    name: "/verbose",
    description: "shows fuller tool detail",
    group: "density",
    availability: "available now",
    result: "sets verbose density",
    route: "local-action",
  },
  {
    name: "/plan",
    description: "previews or approves a next-task plan",
    group: "control",
    availability: "needs arguments",
    result: "opens plan action",
    route: "notice",
    promoted: false,
  },
  {
    name: "/approve",
    description: "approves the active review",
    group: "protections",
    availability: "when review is waiting",
    result: "approves review",
    route: "notice",
    promoted: false,
  },
  {
    name: "/deny",
    description: "denies the active review",
    group: "protections",
    availability: "when review is waiting",
    result: "denies review",
    route: "notice",
    promoted: false,
  },
  {
    name: "/why",
    description: "explains the active review",
    group: "protections",
    availability: "when review is waiting",
    result: "explains review",
    route: "local-action",
    promoted: false,
  },
  {
    name: "/goal",
    description: "sets what keel should keep working toward",
    group: "work",
    availability: "needs --check",
    result: "starts a goal run",
    route: "starts-turn",
  },
  {
    name: "/loop",
    description: "continues under current protections; bounded check",
    group: "work",
    availability: "needs --until",
    result: "starts a loop run",
    route: "starts-turn",
  },
  {
    name: "/answer",
    description: "bounds next answer; opens original",
    group: "work",
    availability: "idle · 40..2000, clear, full",
    result: "arms next task or opens original",
    route: "local-action",
  },
  {
    name: "/compact",
    description: "previews a shorter session summary",
    group: "advanced",
    availability: "advanced",
    result: "opens summary preview",
    route: "panel",
    promoted: false,
  },
  {
    name: "/debug",
    description: "shows renderer diagnostics",
    group: "advanced",
    availability: "advanced",
    result: "sets debug density",
    route: "local-action",
    promoted: false,
  },
];

const HIDDEN_COMMANDS: readonly Command[] = [
  {
    name: "/session",
    description: "session management is available from the CLI",
    group: "control",
    availability: "CLI route",
    result: "shows resume command",
    route: "notice",
  },
  {
    name: "/memory",
    description: "memory changes are unavailable in this TUI",
    group: "future",
    availability: "unavailable here",
    result: "shows limitation",
    route: "notice",
  },
  {
    name: "/yolo",
    description: "unavailable in this TUI",
    group: "danger",
    availability: "unavailable here",
    result: "shows limitation",
    route: "notice",
    danger: true,
  },
  {
    name: "/autopilot",
    description: "use CLI flags or approved plans; not a chat command",
    group: "danger",
    availability: "unavailable here",
    result: "shows limitation",
    route: "notice",
    danger: true,
  },
];

/**
 * Palette commands that END the interactive multi-turn session (Epic 1.23). The driver (`runRepl`)
 * breaks its loop when one is entered at the prompt; they are also in `COMMANDS` so the palette shows
 * and emits them. Single source of truth so the driver and the palette never drift.
 */
export const EXIT_COMMANDS: ReadonlySet<string> = new Set(["/exit", "/quit"]);

const DENSITY_COMMANDS: Readonly<Record<string, UiDensity>> = {
  "/quiet": "quiet",
  "/normal": "normal",
  "/verbose": "verbose",
  "/debug": "debug",
};

export function densityForCommand(name: string): UiDensity | undefined {
  return DENSITY_COMMANDS[name];
}

/** Brief UI-only acknowledgement for a presentation change; it carries no autonomy claim. */
export function densityNotice(density: UiDensity): string {
  return `density: ${density}`;
}

/** Brief UI-only acknowledgement for a `/diff` toggle; carries no autonomy claim. Mirrors
 *  `densityNotice` so the toggle is not a silent change — the footer only labels `full`, so the
 *  `compact` default would otherwise have no visible confirmation. */
export function diffNotice(mode: "compact" | "full"): string {
  return `diff detail: ${mode}`;
}

/** Filter the palette by a substring of the command name (a leading `/` is ignored). A fuller
 *  fuzzy ranking is deliberately small: all query chars must appear in order in the command name.
 *  Dangerous commands stay in their own group via `commandGroups`. */
export function filterCommands(query: string): Command[] {
  const q = query.replace(/^\//, "").toLowerCase();
  const matches = q === "" ? [...COMMANDS] : COMMANDS.filter((c) => commandMatches(c, q));
  return q === "" ? matches.filter((c) => c.promoted !== false) : matches;
}

export function commandByName(name: string): Command | undefined {
  return (
    COMMANDS.find((command) => command.name === name) ??
    HIDDEN_COMMANDS.find((command) => command.name === name)
  );
}

const RUNNING_PANEL_COMMANDS: ReadonlySet<string> = new Set([
  "/context",
  "/policies",
  "/policy",
  "/model",
  "/compact",
  "/reviews",
]);

const RUNNING_LOCAL_ACTION_COMMANDS: ReadonlySet<string> = new Set([
  "/diff",
  ...Object.keys(DENSITY_COMMANDS),
]);

const REVIEW_LOCAL_ACTION_COMMANDS: ReadonlySet<string> = new Set(["/approve", "/deny", "/why"]);

/**
 * Observable Enter behavior for the current interaction context. Idle commands use their registry
 * route. During a turn, only commands handled synchronously by the runner remain actionable; other
 * commands produce an honest notice instead of starting a nested turn or exiting behind the agent.
 * A live review additionally enables its exact local decision/explanation commands.
 */
export function commandRoute(name: string, context: CommandContext = "idle"): CommandRoute {
  const command = commandByName(name);
  if (command === undefined) return "notice";
  if (context === "idle") return command.route;
  if (context === "review" && REVIEW_LOCAL_ACTION_COMMANDS.has(name)) return "local-action";
  if (RUNNING_PANEL_COMMANDS.has(name)) return "panel";
  if (RUNNING_LOCAL_ACTION_COMMANDS.has(name)) return "local-action";
  return "notice";
}

function fuzzy(haystack: string, needle: string): boolean {
  let j = 0;
  for (const ch of haystack.toLowerCase()) {
    if (ch === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return needle.length === 0;
}

function commandMatches(c: Command, query: string): boolean {
  const name = c.name.slice(1).toLowerCase();
  return name.includes(query) || fuzzy(name, query);
}

export function commandGroups(query: string): CommandGroup[] {
  const matched = filterCommands(query);
  return GROUP_ORDER.flatMap((id) => {
    const commands = matched.filter((c) => c.group === id);
    return commands.length > 0 ? [{ id, label: GROUP_LABEL[id], commands }] : [];
  });
}

/** Canonical visual order for keyboard selection in both compact and grouped palettes. */
export function paletteCommands(query: string): Command[] {
  return commandGroups(query).flatMap((group) => group.commands);
}

export function commandRow(command: Command): string {
  return `${command.name}  ${command.description} · ${command.availability}`;
}

function commandToken(buffer: string): string {
  const trimmed = buffer.trim();
  const space = trimmed.search(/\s/u);
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

export function paletteEnterHint(
  query: string,
  context: CommandContext = "idle",
  selected = 0,
): string {
  const exact = commandByName(commandToken(query));
  const matched = paletteCommands(query);
  const command =
    exact ?? matched[Math.min(Math.max(0, selected), Math.max(0, matched.length - 1))];
  if (command === undefined) {
    if (URGENT_VERBS.has(commandToken(query))) return "Enter sends now · Esc cancels";
    return "no matching command · Esc cancels";
  }
  const route = commandRoute(command.name, context);
  const verb =
    route === "panel"
      ? "opens"
      : route === "local-action"
        ? "applies"
        : route === "starts-turn"
          ? "starts"
          : route === "notice"
            ? context === "idle"
              ? "shows notice"
              : "closes"
            : "quits";
  return `Tab completes · Enter ${verb} · Esc cancels`;
}

const COMMAND_NOTICE: Readonly<Record<string, string>> = {
  "/model": "↻ /model shows route status; use /model why or /model preview for detail",
  "/reviews": "↻ /reviews shows visible review requests and status; it does not approve anything",
  "/policies": "↻ /policies shows active protections; it is read-only and changes nothing",
  "/policy": "↻ /policy shows active protections; it is read-only and changes nothing",
  "/plan":
    "↻ /plan is idle-only: preview, approve, or clear listed resources for the next plain task line",
  "/answer": "↻ /answer is idle-only; use /answer 40..2000, /answer clear, or /answer full",
  "/approve": "↻ /approve works only while a review is waiting",
  "/deny": "↻ /deny works only while a review is waiting",
  "/why": "↻ /why works only while a review is waiting",
  "/session": "↻ continue sessions with keel --continue or keel --resume <id>",
  "/memory": "↻ /memory changes are unavailable in this TUI",
  "/yolo": "↻ /yolo is unavailable in this TUI. Current protection is shown in the status line.",
  "/autopilot":
    "↻ /autopilot is unavailable as a chat command. Use approved plans or CLI flags; current protection is shown in the status line.",
};

export function noticeForCommand(name: string): string {
  return COMMAND_NOTICE[name] ?? `↻ ${name} is not available in this TUI; type /help for commands`;
}

/**
 * §4.10 urgent-override verbs — applied before the next mutating action (vs. palette commands, which
 * configure the UI). Single source of truth: `input.ts` recognizes them to EMIT urgent steering and
 * `runner.ts` recognizes them to CLASSIFY it — a drift between the two would silently demote an
 * urgent input to an ignored palette command, so they share this one set.
 */
export const URGENT_VERBS: ReadonlySet<string> = new Set([
  "/now",
  "/before-next-edit",
  "/stop-after-current",
]);
