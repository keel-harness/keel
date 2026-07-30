import { describe, expect, it } from "vitest";
import type { ModelMessageT } from "@keel/shared";
import { assembleActiveContext } from "./assemble.js";

const toolMsg = (id: string, chars: number): ModelMessageT => ({
  role: "tool",
  toolCallId: id,
  name: "bash",
  content: `result ${id}: ` + "x".repeat(chars),
});

describe("assembleActiveContext (§4.7.4 budget-driven tool-result clearing)", () => {
  it("returns the conversation unchanged when it fits the budget", () => {
    const msgs: ModelMessageT[] = [
      { role: "system", content: "prompt" },
      { role: "user", content: "go" },
      { role: "assistant", content: "ok" },
    ];
    expect(
      assembleActiveContext({ messages: msgs, budgetTokens: 10_000, headroomTokens: 0 }),
    ).toEqual(msgs);
  });

  it("over budget: clears the OLDEST clearable tool bodies first, keeping structure", () => {
    const msgs: ModelMessageT[] = [
      { role: "system", content: "system prompt (pinned)" },
      { role: "user", content: "do it" },
      toolMsg("old1", 800), // ~200 tok, oldest → cleared first
      toolMsg("old2", 800),
      { role: "assistant", content: "thinking" },
      { role: "user", content: "recent turn" }, // last 2 are recent_verbatim
      { role: "assistant", content: "latest" },
    ];
    const out = assembleActiveContext({
      messages: msgs,
      budgetTokens: 200,
      headroomTokens: 0,
      recentVerbatimTurns: 2,
    });
    // oldest tool body cleared, with structure retained (id + name + ledger note)
    const o1 = out.find((m) => m.toolCallId === "old1")!;
    expect(o1.content).toMatch(/cleared/i);
    expect(o1.content).toMatch(/ledger/i);
    expect(o1.name).toBe("bash"); // structure kept — the call still happened
    // pinned + the recent verbatim turns are untouched
    expect(out[0]).toEqual(msgs[0]);
    expect(out.at(-1)).toEqual(msgs.at(-1));
    expect(out.at(-2)).toEqual(msgs.at(-2));
  });

  it("never clears a tool result inside the recent_verbatim window, even when over budget", () => {
    const msgs: ModelMessageT[] = [
      { role: "user", content: "go" },
      toolMsg("recent", 4000), // huge, but it's the most recent → verbatim
    ];
    const out = assembleActiveContext({
      messages: msgs,
      budgetTokens: 10,
      headroomTokens: 0,
      recentVerbatimTurns: 6,
    });
    expect(out.find((m) => m.toolCallId === "recent")!.content).toBe(msgs[1]!.content); // untouched
  });

  it("reserves output headroom: clearing is driven by (budget − headroom)", () => {
    const msgs: ModelMessageT[] = [{ role: "user", content: "go" }, toolMsg("old", 800)];
    // budget 10_000 but headroom 9_950 → target ~50 tok → the old tool body must be cleared
    const out = assembleActiveContext({
      messages: msgs,
      budgetTokens: 10_000,
      headroomTokens: 9_950,
      recentVerbatimTurns: 0,
    });
    expect(out.find((m) => m.toolCallId === "old")!.content).toMatch(/cleared/i);
  });
});
