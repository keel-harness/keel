import type { ViewModel } from "@keel/shared";
import { describe, expect, it } from "vitest";
import { renderFrame, renderStatus } from "./headless.js";
import { terminalDisplayWidth } from "./display-cells.js";
import {
  capabilitiesPanel,
  cockpitStatusLine,
  compactReview,
  compactStatusRows,
  contextPanel,
  initialView,
  protectionsPanel,
  welcomeText,
} from "./view-model.js";

const allOff = { sandbox: false, egress: false, audit: false } as const;
const allOn = { sandbox: true, egress: true, audit: true } as const;

function status(
  state: "starting" | "governed" | "deliberately-unenforced" | "unavailable" | "not-reported",
): ViewModel["status"] {
  const base = {
    model: "sonnet",
    cwd: "/workspace/keel",
    tokens: 12,
  } as const;
  switch (state) {
    case "starting":
      return {
        ...base,
        protectionRoute: "governed",
        startup: { phase: "starting-protections" },
        posture: allOn,
        policy: { active: true, label: "Project Autopilot · starter@abc123" },
      };
    case "governed":
      return {
        ...base,
        protectionRoute: "governed",
        posture: allOn,
        policy: { active: true, label: "Guided · starter@abc123" },
      };
    case "deliberately-unenforced":
      return {
        ...base,
        protectionRoute: "deliberately-unenforced",
        posture: allOff,
        policy: { active: true, label: "Project Autopilot · forged" },
      };
    case "unavailable":
      return {
        ...base,
        protectionRoute: "governed",
        startup: { phase: "protections-unavailable" },
        posture: allOn,
        policy: { active: true, label: "Autopilot · stale" },
      };
    case "not-reported":
      return {
        ...base,
        posture: { sandbox: true, egress: false, audit: false },
        policy: { active: true, label: "Guided · unbound" },
      };
  }
}

const EXPECTED_STATE_COPY = {
  starting: "starting",
  governed: "governed",
  "deliberately-unenforced": "unenforced",
  unavailable: "unavailable",
  "not-reported": "status not reported",
} as const;

describe("ADR-0080 runtime truth vocabulary", () => {
  it.each(Object.entries(EXPECTED_STATE_COPY))(
    "uses one controller-bound %s state across status, panels, and headless",
    (state, expected) => {
      const current = status(state as keyof typeof EXPECTED_STATE_COPY);
      const view: ViewModel = { items: [], status: current, streaming: false };
      const surfaces = [
        compactStatusRows(current).join("\n"),
        cockpitStatusLine(current),
        contextPanel(current),
        capabilitiesPanel(current),
        protectionsPanel(current),
        renderStatus(current),
        renderFrame(view),
      ];

      for (const surface of surfaces) expect(surface.toLowerCase()).toContain(expected);
    },
  );

  it("gives startup and unavailable lifecycle precedence over a governed route and stale posture", () => {
    const starting = [
      compactStatusRows(status("starting")).join("\n"),
      cockpitStatusLine(status("starting")),
      contextPanel(status("starting")),
      capabilitiesPanel(status("starting")),
      protectionsPanel(status("starting")),
    ].join("\n");
    const unavailable = [
      compactStatusRows(status("unavailable")).join("\n"),
      cockpitStatusLine(status("unavailable")),
      contextPanel(status("unavailable")),
      capabilitiesPanel(status("unavailable")),
      protectionsPanel(status("unavailable")),
    ].join("\n");

    expect(starting).toMatch(/starting/i);
    expect(starting).toMatch(/input waits|no tool actions can run/i);
    expect(starting).not.toMatch(/\bgoverned\b|sandbox on|audit on|autopilot/i);
    expect(unavailable).toMatch(/unavailable/i);
    expect(unavailable).toMatch(/tools halted|tool execution halted/i);
    expect(unavailable).not.toMatch(/\bgoverned\b|sandbox on|audit on|autopilot/i);
  });

  it("makes the deliberately unenforced route prominent and suppresses contradictory trust modes", () => {
    const current = status("deliberately-unenforced");
    const output = [
      compactStatusRows(current).join("\n"),
      cockpitStatusLine(current),
      contextPanel(current),
      capabilitiesPanel(current),
      protectionsPanel(current),
      renderFrame({ items: [], status: current, streaming: false }),
    ].join("\n");

    expect(output).toContain("UNENFORCED");
    expect(output).toMatch(/deliberately direct/i);
    expect(output).not.toMatch(/autopilot|guided|project autopilot/i);
  });

  it("does not promote an absent route and keeps separately reported control facts literal", () => {
    const current = status("not-reported");
    const line = compactStatusRows(current).join("\n");
    const panels = [
      contextPanel(current),
      capabilitiesPanel(current),
      protectionsPanel(current),
    ].join("\n");

    expect(line).toContain("protection: status not reported");
    expect(line).toContain("sbx:on");
    expect(line).toContain("net:off");
    expect(line).toContain("policy:on");
    expect(line).toContain("audit:unseen");
    expect(panels).toContain("sandbox on");
    expect(panels).toContain("egress guard off");
    expect(panels).toContain("policy: active");
    expect(panels).toContain("audit unseen");
    expect(`${line}\n${panels}`).toMatch(/do not infer enforcement/i);
    expect(`${line}\n${panels}`).not.toMatch(/autopilot|guided|project autopilot/i);
  });

  it("keeps every runtime state within a 40-cell compact status budget", () => {
    for (const state of Object.keys(EXPECTED_STATE_COPY) as (keyof typeof EXPECTED_STATE_COPY)[]) {
      const rows = compactStatusRows(status(state), { columns: 40 });
      expect(rows.length, state).toBeLessThanOrEqual(3);
      expect(
        rows.every((row) => terminalDisplayWidth(row) <= 40),
        state,
      ).toBe(true);
    }
  });

  it("preserves the governed policy mode across the 61-cell medium-layout boundary", () => {
    const current = status("governed");
    for (const columns of [61, 62, 64, 68, 72]) {
      const rows = compactStatusRows(current, { columns });
      expect(rows.join("\n"), `${columns} columns`).toContain("Guided");
      expect(
        rows.every((row) => terminalDisplayWidth(row) <= columns),
        `${columns} columns`,
      ).toBe(true);
    }
  });

  it("removes release-phase prophecy from every current truth surface", () => {
    const surfaces = Object.keys(EXPECTED_STATE_COPY).flatMap((stateName) => {
      const current = status(stateName as keyof typeof EXPECTED_STATE_COPY);
      return [
        compactStatusRows(current).join("\n"),
        cockpitStatusLine(current),
        contextPanel(current),
        capabilitiesPanel(current),
        protectionsPanel(current),
        renderFrame({ items: [], status: current, streaming: false }),
      ];
    });
    surfaces.push(welcomeText(), compactReview(initialView([], {})));

    expect(surfaces.join("\n")).not.toMatch(/\bphase\s*[12]\b|warden lands/i);
  });
});
