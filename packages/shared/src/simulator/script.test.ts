import { describe, expect, it } from "vitest";
import { JUNK, assertRejects, assertRoundTrips } from "../testing/property.js";
import { ResultMatcher, SimulatorScript, SimulatorTurn } from "./script.js";

describe("simulator script (designed, §6.3)", () => {
  it("round-trips a multi-turn script with a result-matched branch", () => {
    expect(
      SimulatorScript.parse({
        turns: [
          { text: "I'll list files.", toolCalls: [{ name: "bash", args: { command: "ls" } }] },
          {
            branches: [{ match: { on: "toolResult", kind: "regex", pattern: "id_rsa" }, goto: 5 }],
          },
        ],
      }),
    ).toBeTruthy();
    assertRoundTrips(ResultMatcher);
    assertRoundTrips(SimulatorTurn);
    assertRoundTrips(SimulatorScript);
    assertRejects(SimulatorScript, [
      ...JUNK,
      {
        turns: [
          { branches: [{ match: { on: "toolResult", kind: "nope", pattern: "x" }, goto: 1 }] },
        ],
      },
    ]);
  });
});
