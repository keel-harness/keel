import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  commandByName,
  commandRoute,
  commandGroups,
  diffNotice,
  filterCommands,
  noticeForCommand,
  paletteEnterHint,
} from "./commands.js";

const LAUNCH_SURFACE_FORBIDDEN =
  /not wired|use CLI today|\/yolo|danger|warden|Plan Autopilot|exact resource|posture|egress|grant|Phase 3/i;

describe("command registry", () => {
  it("every command has a leading slash and a description", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    for (const c of COMMANDS) {
      expect(c.name.startsWith("/")).toBe(true);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("visible commands avoid unfinished/internal launch-surface copy", () => {
    const paletteText = commandGroups("")
      .flatMap((g) => [g.label, ...g.commands.map((c) => `${c.name} ${c.description}`)])
      .join("\n");
    expect(paletteText).not.toMatch(LAUNCH_SURFACE_FORBIDDEN);
  });

  it("includes /diff to toggle the diff disclosure mode", () => {
    expect(COMMANDS.find((c) => c.name === "/diff")?.description).toMatch(/review/i);
  });

  it("diffNotice acknowledges the resulting disclosure level in plain, autonomy-free copy", () => {
    // Mirrors densityNotice: a one-line UI-only ack of the new state, so a /diff toggle is not a
    // silent change (the footer only labels `full`; `compact` is the unlabeled default there).
    expect(diffNotice("full")).toBe("diff detail: full");
    expect(diffNotice("compact")).toBe("diff detail: compact");
  });

  it("includes public run-control constructors", () => {
    const goal = COMMANDS.find((c) => c.name === "/goal");
    const loop = COMMANDS.find((c) => c.name === "/loop");
    expect(goal?.description).toMatch(/keep.*working|goal/i);
    expect(goal?.availability).toContain("--check");
    expect(goal?.promoted).not.toBe(false);
    expect(loop?.description).toMatch(/current protections|bounded/i);
    expect(loop?.availability).toContain("--until");
    expect(loop?.promoted).not.toBe(false);
  });

  it("includes /model as a model selection inspection command", () => {
    expect(COMMANDS.find((c) => c.name === "/model")?.description).toMatch(/model/i);
    expect(noticeForCommand("/model")).not.toMatch(/not wired/i);
    expect(noticeForCommand("/model")).toMatch(/\/model why|\/model preview/i);
  });

  it("includes /reviews as a read-only pending review inspection command", () => {
    expect(COMMANDS.find((c) => c.name === "/reviews")?.description).toBe("shows review history");
    expect(noticeForCommand("/reviews")).not.toMatch(/not wired/i);
    expect(noticeForCommand("/reviews")).toMatch(/does not approve/i);
  });

  it("registers /why as the live-review explanation route without promoting it at launch", () => {
    const command = commandByName("/why");
    expect(command).toMatchObject({
      name: "/why",
      route: "local-action",
      availability: "when review is waiting",
      promoted: false,
    });
    expect(command?.description).toMatch(/explain.*active review/i);
    expect(noticeForCommand("/why")).toMatch(/works only while a review is waiting/i);
    expect(filterCommands("").map((candidate) => candidate.name)).not.toContain("/why");
    expect(filterCommands("/why").map((candidate) => candidate.name)).toEqual(["/why"]);
  });

  it("includes /policies and /policy as read-only protection inspection commands", () => {
    for (const name of ["/policies", "/policy"]) {
      const command = COMMANDS.find((c) => c.name === name);
      expect(command?.description).toMatch(/protection/i);
      expect(command?.route).toBe("panel");
      expect(command?.result).toMatch(/protection/i);
      expect(noticeForCommand(name)).not.toMatch(/not wired|approve|grant/i);
    }
  });

  it("includes /plan as a next-task plan preview/approval command", () => {
    expect(COMMANDS.find((c) => c.name === "/plan")?.description).toMatch(/plan/i);
    expect(noticeForCommand("/plan")).not.toMatch(/not wired/i);
    expect(noticeForCommand("/plan")).toMatch(/idle-only.*plain task/i);
  });

  it("an empty query (or just '/') returns promoted commands", () => {
    const promoted = COMMANDS.filter((c) => c.promoted !== false);
    expect(filterCommands("")).toEqual(promoted);
    expect(filterCommands("/")).toEqual(promoted);
  });

  it("filters by substring of the command name", () => {
    expect(filterCommands("/go").map((c) => c.name)).toEqual(["/goal"]);
    expect(filterCommands("/loo").map((c) => c.name)).toEqual(["/loop"]);
    expect(filterCommands("/mod").map((c) => c.name)).toEqual(["/model"]);
    expect(filterCommands("comp").map((c) => c.name)).toEqual(["/compact"]);
    expect(filterCommands("cap").map((c) => c.name)).toEqual(["/capabilities"]);
    expect(filterCommands("/pol").map((c) => c.name)).toEqual(["/policies", "/policy"]);
    expect(filterCommands("/rev").map((c) => c.name)).toEqual(["/reviews"]);
    expect(filterCommands("/nope")).toEqual([]);
  });

  it("groups launch-visible commands by user workflow and keeps hidden clutter searchable", () => {
    const groups = commandGroups("");
    expect(groups.map((g) => g.label)).toEqual([
      "common actions",
      "work controls",
      "protections",
      "inspect",
      "control",
      "density",
    ]);
    expect(groups.find((g) => g.label === "common actions")?.commands.map((c) => c.name)).toEqual([
      "/help",
      "/diff",
    ]);
    expect(groups.find((g) => g.label === "work controls")?.commands.map((c) => c.name)).toEqual([
      "/goal",
      "/loop",
    ]);
    expect(groups.find((g) => g.label === "protections")?.commands.map((c) => c.name)).toEqual([
      "/policies",
      "/reviews",
    ]);
    expect(groups.find((g) => g.label === "inspect")?.commands.map((c) => c.name)).toEqual([
      "/context",
      "/model",
      "/capabilities",
      "/about",
    ]);
    expect(groups.find((g) => g.label === "control")?.commands.map((c) => c.name)).toEqual([
      "/exit",
    ]);
    expect(groups.find((g) => g.label === "density")?.commands.map((c) => c.name)).toEqual([
      "/quiet",
      "/verbose",
    ]);
    const visible = groups.flatMap((g) => g.commands.map((c) => c.name));
    expect(visible).toEqual(
      expect.arrayContaining([
        "/goal",
        "/loop",
        "/policies",
        "/reviews",
        "/diff",
        "/context",
        "/model",
        "/capabilities",
        "/about",
      ]),
    );
    expect(visible).not.toContain("/quit");
    expect(visible).not.toContain("/normal");
    expect(visible).not.toContain("/yolo");
    expect(visible).not.toContain("/debug");
  });

  it("keeps advanced diagnostics searchable without promoting them in the empty palette", () => {
    expect(commandGroups("").map((g) => g.label)).not.toContain("advanced diagnostics");
    const debugGroups = commandGroups("/debug");
    expect(debugGroups.map((g) => g.label)).toEqual(["advanced diagnostics"]);
    expect(debugGroups[0]?.commands.map((c) => c.name)).toEqual(["/debug"]);
  });

  it("each visible command declares an observable result and availability", () => {
    for (const c of COMMANDS) {
      const command = c as typeof c & {
        readonly availability?: string;
        readonly result?: string;
        readonly route?: string;
      };
      expect(command.availability, c.name).toMatch(/\S/);
      expect(command.result, c.name).toMatch(/\S/);
      expect(command.route, c.name).toMatch(/^(panel|local-action|starts-turn|notice|exit)$/);
    }
  });

  it("supports fuzzy palette matching without exposing hidden commands", () => {
    expect(filterCommands("ctx").map((c) => c.name)).toEqual(["/context"]);
    expect(commandGroups("yo")).toEqual([]);
    expect(filterCommands("/ses")).toEqual([]);
  });

  it("handles hidden slash commands locally without exposing unfinished palette copy", () => {
    expect(commandByName("/session")?.name).toBe("/session");
    expect(commandByName("/memory")?.name).toBe("/memory");
    expect(commandByName("/autopilot")?.name).toBe("/autopilot");
    expect(commandByName("/yolo")?.name).toBe("/yolo");
    expect(filterCommands("/session")).toEqual([]);
    expect(filterCommands("/autopilot")).toEqual([]);
    expect(noticeForCommand("/session")).toMatch(/keel --continue|keel --resume <id>/i);
    expect(noticeForCommand("/memory")).toMatch(/unavailable in this TUI/i);
    expect(noticeForCommand("/autopilot")).toMatch(/not a chat command|CLI flags/i);
    expect(noticeForCommand("/yolo")).toMatch(/unavailable in this TUI/i);
    expect(
      [
        noticeForCommand("/session"),
        noticeForCommand("/memory"),
        noticeForCommand("/autopilot"),
        noticeForCommand("/yolo"),
      ].join("\n"),
    ).not.toMatch(/not wired|use CLI today|Autopilot keeps enforcement on|Phase 3/i);
  });

  it("describes palette Enter behavior from the command route, not generic run copy", () => {
    expect(paletteEnterHint("/cap")).toBe("Tab completes · Enter opens · Esc cancels");
    expect(paletteEnterHint("/quiet")).toBe("Tab completes · Enter applies · Esc cancels");
    expect(paletteEnterHint("/goal write docs")).toBe("Tab completes · Enter starts · Esc cancels");
    expect(paletteEnterHint("/approve")).toBe("Tab completes · Enter shows notice · Esc cancels");
    expect(paletteEnterHint("/session")).toBe("Tab completes · Enter shows notice · Esc cancels");
    expect(paletteEnterHint("/exit")).toBe("Tab completes · Enter quits · Esc cancels");
    expect(paletteEnterHint("/zzz")).toBe("no matching command · Esc cancels");
    expect(
      [
        paletteEnterHint("/cap"),
        paletteEnterHint("/quiet"),
        paletteEnterHint("/goal write docs"),
        paletteEnterHint("/approve"),
        paletteEnterHint("/exit"),
      ].join("\n"),
    ).not.toMatch(/approved|grant|trusted|safe by/i);
  });

  it("describes the route that is actually available in idle, running, and review contexts", () => {
    expect(commandRoute("/goal", "idle")).toBe("starts-turn");
    expect(commandRoute("/goal", "running")).toBe("notice");
    expect(commandRoute("/help", "running")).toBe("notice");
    expect(commandRoute("/exit", "running")).toBe("notice");
    expect(commandRoute("/policies", "running")).toBe("panel");
    expect(commandRoute("/quiet", "running")).toBe("local-action");
    expect(commandRoute("/approve", "running")).toBe("notice");
    expect(commandRoute("/approve", "review")).toBe("local-action");
    expect(commandRoute("/deny", "review")).toBe("local-action");
    expect(commandRoute("/why", "review")).toBe("local-action");

    expect(paletteEnterHint("/goal write docs", "running")).toContain("Enter closes");
    expect(paletteEnterHint("/help", "running")).toContain("Enter closes");
    expect(paletteEnterHint("/exit", "running")).toContain("Enter closes");
    expect(paletteEnterHint("/policies", "running")).toContain("Enter opens");
    expect(paletteEnterHint("/approve", "review")).toContain("Enter applies");

    const runningPanels = new Set([
      "/context",
      "/policies",
      "/policy",
      "/model",
      "/compact",
      "/reviews",
    ]);
    const runningActions = new Set(["/diff", "/quiet", "/normal", "/verbose", "/debug"]);
    for (const command of COMMANDS) {
      const expected = runningPanels.has(command.name)
        ? "panel"
        : runningActions.has(command.name)
          ? "local-action"
          : "notice";
      expect(commandRoute(command.name, "running"), command.name).toBe(expected);
    }
  });
});
