import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { paletteCommands } from "./commands.js";
import { graphemeSpans } from "./display-cells.js";
import { emptyInput, inputReduce, type InputState, type Key } from "./input.js";

// type a string char-by-char through the reducer
function type(text: string, start = emptyInput()) {
  let s = start;
  for (const ch of text) s = inputReduce(s, { kind: "char", value: ch }).state;
  return s;
}

describe("input state machine", () => {
  it("bounds and sanitizes seeded history while preserving stable duplicates", () => {
    const secret = "sk-ant-api03-supersecretvalue1234567890ABCDEF";
    const history = [
      "",
      "   ",
      ...Array.from({ length: 101 }, (_, index) => `task-${index}`),
      `unsafe${String.fromCharCode(27)}[2J`,
      `use ${secret}`,
      "duplicate",
      "duplicate",
    ];

    const state = emptyInput(history);

    expect(state.history).toHaveLength(100);
    expect(state.history[0]).toBe("task-5");
    expect(state.history).toContain("unsafe[2J");
    expect(state.history.some((entry) => entry.includes("[redacted:"))).toBe(true);
    expect(state.history.join("\n")).not.toContain(secret);
    expect(state.history.slice(-2)).toEqual(["duplicate", "duplicate"]);
  });

  it("types characters into the buffer", () => {
    expect(type("hello").buffer).toBe("hello");
  });

  it("opens the / palette and tracks the query as you type", () => {
    const s = type("/se");
    expect(s.buffer).toBe("/se");
    expect(s.overlay).toEqual({ kind: "palette", query: "/se" });
  });

  it("opens ? help on an empty buffer without inserting the char", () => {
    const s = inputReduce(emptyInput(), { kind: "char", value: "?" }).state;
    expect(s.buffer).toBe("");
    expect(s.overlay).toEqual({ kind: "help" });
    // ? in a non-empty buffer is a normal character
    const s2 = type("what?");
    expect(s2.buffer).toBe("what?");
    expect(s2.overlay).toBeUndefined();
  });

  it("backspace deletes, and closes the palette when the buffer stops being a command", () => {
    let s = type("/x");
    expect(s.overlay?.kind).toBe("palette");
    s = inputReduce(s, { kind: "backspace" }).state; // "/"
    expect(s.overlay?.kind).toBe("palette");
    s = inputReduce(s, { kind: "backspace" }).state; // ""
    expect(s.buffer).toBe("");
    expect(s.overlay).toBeUndefined();
    // backspace on empty is a no-op
    expect(inputReduce(s, { kind: "backspace" }).state.buffer).toBe("");
  });

  it("enter on a normal line submits it, records history, and clears the buffer", () => {
    const r = inputReduce(type("fix the bug"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "line", text: "fix the bug" });
    expect(r.state.buffer).toBe("");
    expect(r.state.history).toEqual(["fix the bug"]);
  });

  it("submits exact text but retains only a redacted history copy", () => {
    const secret = "sk-ant-api03-supersecretvalue1234567890ABCDEF";
    const prompt = `use ${secret}`;
    const r = inputReduce(type(prompt), { kind: "enter" });

    expect(r.action).toEqual({ kind: "line", text: prompt });
    expect(r.state.history).toHaveLength(1);
    expect(r.state.history[0]).toContain("[redacted:");
    expect(r.state.history[0]).not.toContain(secret);
  });

  it("keeps live prompt history bounded after many submissions", () => {
    let state = emptyInput();
    for (let index = 0; index < 125; index++) {
      state = inputReduce(type(`task-${index}`, state), { kind: "enter" }).state;
    }

    expect(state.history).toHaveLength(100);
    expect(state.history[0]).toBe("task-25");
    expect(state.history.at(-1)).toBe("task-124");
  });

  it("enter while the palette is open runs the top filtered command", () => {
    const r = inputReduce(type("/cap"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "command", name: "/capabilities" });
    expect(r.state.buffer).toBe("");
    expect(r.state.overlay).toBeUndefined();
  });

  it("complete-command fills the top slash palette match without running it", () => {
    const r = inputReduce(type("/cap"), { kind: "complete-command" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("/capabilities");
    expect(r.state.cursor).toBe("/capabilities".length);
    expect(r.state.overlay).toEqual({ kind: "palette", query: "/capabilities" });
  });

  it("keeps overlay selection bounded and completes the selected command instead of history", () => {
    const count = paletteCommands("").length;
    let s = type("/", emptyInput(["previous task"]));
    s = inputReduce(s, { kind: "select-overlay", delta: 1, count }).state;
    expect(s.histIndex).toBeNull();
    expect(s.selection).toBe(1);

    const completed = inputReduce(s, { kind: "complete-command" });
    expect(completed.action).toBeUndefined();
    expect(completed.state.buffer).toBe("/diff");

    s = inputReduce(s, { kind: "select-overlay", delta: 100, count }).state;
    expect(s.selection).toBe(count - 1);
    s = inputReduce(s, { kind: "select-overlay", delta: -100, count }).state;
    expect(s.selection).toBe(0);
  });

  it("submits the selected palette command and resets selection when the filter changes", () => {
    let s = type("/");
    s = inputReduce(s, {
      kind: "select-overlay",
      delta: 1,
      count: paletteCommands("").length,
    }).state;
    const submitted = inputReduce(s, { kind: "enter" });
    expect(submitted.action).toEqual({ kind: "command", name: "/diff" });

    s = inputReduce(s, { kind: "char", value: "g" }).state;
    expect(s.selection).toBeUndefined();
  });

  it.each([
    ["/go", "/goal"],
    ["/loo", "/loop"],
    ["/pol", "/policies"],
    ["/rev", "/reviews"],
  ])("complete-command fills launch slash prefix %s as %s", (prefix, completed) => {
    const r = inputReduce(type(prefix), { kind: "complete-command" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe(completed);
    expect(r.state.cursor).toBe(completed.length);
    expect(r.state.overlay).toEqual({ kind: "palette", query: completed });
  });

  it("enter on a hidden legacy slash command handles it locally instead of sending a model prompt", () => {
    const r = inputReduce(type("/session"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "command", name: "/session" });
    expect(r.state.buffer).toBe("");
    expect(r.state.overlay).toBeUndefined();
  });

  it("enter on an exact slash command with args preserves the args for wired commands", () => {
    const r = inputReduce(type('/goal Ship 2.12 --check "pnpm test"'), { kind: "enter" });
    expect(r.action).toEqual({
      kind: "command",
      name: "/goal",
      args: 'Ship 2.12 --check "pnpm test"',
    });
    expect(r.state.buffer).toBe("");
    expect(r.state.overlay).toBeUndefined();
  });

  it("enter on a palette with no matching command emits a local command notice action", () => {
    const r = inputReduce(type("/zzz explain this"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "command", name: "/zzz", args: "explain this" });
    expect(r.state.buffer).toBe("");
    expect(r.state.overlay).toBeUndefined();
  });

  it("enter on an urgent verb emits an urgent command carrying its instruction in args (§4.10)", () => {
    const r = inputReduce(type("/now stop touching the database"), { kind: "enter" });
    expect(r.action).toEqual({
      kind: "command",
      name: "/now",
      args: "stop touching the database",
    });
    expect(r.state.buffer).toBe("");
    expect(r.state.overlay).toBeUndefined();
  });

  it("recognizes a bare urgent verb (no instruction → no args)", () => {
    const r = inputReduce(type("/stop-after-current"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "command", name: "/stop-after-current" });
  });

  it("does not mistake a palette prefix of an urgent verb for the verb (/now still fuzzy until exact)", () => {
    // "/no" is not the verb "/now" — it falls through to the normal fuzzy palette (no command
    // selection guard, so it just clears with no action rather than firing an urgent steering.
    const r = inputReduce(type("/no"), { kind: "enter" });
    expect(r.action).toBeUndefined();
  });

  it("still accepts an exact density command that shares an urgent prefix", () => {
    const r = inputReduce(type("/normal"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "command", name: "/normal" });
  });

  it("up/down recall history", () => {
    const base = emptyInput(["first", "second"]);
    let s = inputReduce(base, { kind: "up" }).state;
    expect(s.buffer).toBe("second");
    s = inputReduce(s, { kind: "up" }).state;
    expect(s.buffer).toBe("first");
    s = inputReduce(s, { kind: "down" }).state;
    expect(s.buffer).toBe("second");
    s = inputReduce(s, { kind: "down" }).state; // past the end → live empty buffer
    expect(s.buffer).toBe("");
  });

  it("restores the unsent draft after browsing submitted history", () => {
    let s = type("half-written prompt", emptyInput(["first", "second"]));
    s = inputReduce(s, { kind: "up" }).state;
    expect(s.buffer).toBe("second");
    s = inputReduce(s, { kind: "down" }).state;
    expect(s.buffer).toBe("half-written prompt");
    expect(s.histIndex).toBeNull();
  });

  it("replaces the draft from an external editor result, preserving newlines and stripping controls", () => {
    const r = inputReduce(type("before"), {
      kind: "set-buffer",
      text: `edited\nbody${String.fromCharCode(27)}[2J`,
    });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("edited\nbody[2J");
    expect(r.state.cursor).toBe("edited\nbody[2J".length);
    expect(r.state.histIndex).toBeNull();
  });

  it("escape closes an overlay; with none open it interrupts", () => {
    const closed = inputReduce(type("/x"), { kind: "escape" });
    expect(closed.state.overlay).toBeUndefined();
    expect(closed.action).toBeUndefined();
    const interrupt = inputReduce(emptyInput(), { kind: "escape" });
    expect(interrupt.action).toEqual({ kind: "interrupt" });
  });

  it("ctrl-c always interrupts", () => {
    expect(inputReduce(type("half typed"), { kind: "interrupt" }).action).toEqual({
      kind: "interrupt",
    });
  });
});

describe("multi-line input (Epic 1.23 slice 3)", () => {
  it("Ctrl-J (newline) inserts a literal newline without submitting", () => {
    const r = inputReduce(type("abc"), { kind: "newline" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("abc\n");
  });
  it("a trailing backslash + Enter continues the line (newline inserted, no submit)", () => {
    const r = inputReduce(type("line one\\"), { kind: "enter" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("line one\n");
  });
  it("Enter submits a multi-line buffer whole (no trailing backslash)", () => {
    let s = type("first");
    s = inputReduce(s, { kind: "newline" }).state;
    s = type("second", s);
    const r = inputReduce(s, { kind: "enter" });
    expect(r.action).toEqual({ kind: "line", text: "first\nsecond" });
  });
  it("backslash-continuation then more text then Enter submits the joined multi-line text", () => {
    let s = inputReduce(type("a\\"), { kind: "enter" }).state; // continuation → "a\n"
    s = type("b", s);
    const r = inputReduce(s, { kind: "enter" });
    expect(r.action).toEqual({ kind: "line", text: "a\nb" });
    expect(r.state.history).toContain("a\nb"); // the multi-line entry is recalled by ↑ history
  });
});

describe("multi-line input — QC hardening (Epic 1.23 slice 3)", () => {
  it("an EVEN trailing backslash run SUBMITS with the backslashes intact (escape hatch; old rule ate them)", () => {
    // `"path\\\\"` in source is `path` + TWO literal backslashes — an even run → submit, not continue.
    const r = inputReduce(type("path\\\\"), { kind: "enter" });
    expect(r.action).toEqual({ kind: "line", text: "path\\\\" });
    expect(r.state.buffer).toBe("");
  });

  it("an ODD>1 trailing backslash run continues, dropping ONLY the escaping backslash", () => {
    // `"x\\\\\\"` is `x` + THREE backslashes — odd → continuation: drop one → two literal + newline.
    const r = inputReduce(type("x\\\\\\"), { kind: "enter" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("x\\\\\n"); // x + two backslashes + newline
  });

  it("a whitespace-only multi-line buffer is a NO-OP — never submits a blank model turn", () => {
    let s = inputReduce(emptyInput(), { kind: "newline" }).state; // "\n"
    s = inputReduce(s, { kind: "newline" }).state; // "\n\n"
    const r = inputReduce(s, { kind: "enter" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("");
  });

  it("Ctrl-J (newline) is IGNORED while the command palette is open (a slash-command query is single-line)", () => {
    const s = type("/se");
    expect(s.overlay?.kind).toBe("palette");
    const r = inputReduce(s, { kind: "newline" });
    expect(r.state.buffer).toBe("/se"); // no newline injected into the query
    expect(r.state.overlay?.kind).toBe("palette");
    expect(r.action).toBeUndefined();
  });

  // The continuation rule must NEVER silently lose typed content: for any real (non-blank, non-palette)
  // line, Enter continues iff the trailing backslash run is odd, else submits the buffer VERBATIM.
  it("property: Enter continues on an odd trailing backslash run, else submits verbatim (no content lost)", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.trim() !== "" && !s.startsWith("/")),
        fc.nat({ max: 6 }),
        (base, n) => {
          const body = base.replace(/\\+$/, "x"); // ensure the trailing run is EXACTLY n backslashes
          const buffer = body + "\\".repeat(n);
          const r = inputReduce(
            { buffer, cursor: buffer.length, history: [], histIndex: null, kill: "" },
            { kind: "enter" },
          );
          if (n % 2 === 1) {
            expect(r.action).toBeUndefined(); // odd → continuation
            expect(r.state.buffer).toBe(body + "\\".repeat(n - 1) + "\n");
          } else {
            expect(r.action).toEqual({ kind: "line", text: buffer }); // even → submit verbatim
          }
        },
      ),
    );
  });
});

describe("reverse-search over history (Epic 1.23 slice 3b)", () => {
  const HIST = ["write the readme", "run the tests", "fix the parser", "run the tests again"];

  it("Ctrl-R opens reverse-search with an empty query and no match", () => {
    const r = inputReduce(emptyInput(HIST), { kind: "reverse-search" });
    expect(r.action).toBeUndefined();
    expect(r.state.overlay).toEqual({ kind: "reverse-search", query: "" }); // no `match` until one is found
    expect(r.state.search).toEqual({ query: "", index: null });
    expect(r.state.buffer).toBe(""); // the buffer is untouched while searching
  });

  it("typing matches the MOST-RECENT history entry containing the query (chars go to the query, not the buffer)", () => {
    let s = inputReduce(emptyInput(HIST), { kind: "reverse-search" }).state;
    for (const ch of "test") s = inputReduce(s, { kind: "char", value: ch }).state;
    expect(s.search?.query).toBe("test");
    expect(s.overlay).toEqual({
      kind: "reverse-search",
      query: "test",
      match: "run the tests again", // the newest of the two "test" entries
    });
    expect(s.buffer).toBe(""); // buffer still untouched
  });

  it("Ctrl-R again steps to the next-older match, then stops at the oldest (no wrap)", () => {
    let s = inputReduce(emptyInput(HIST), { kind: "reverse-search" }).state;
    for (const ch of "test") s = inputReduce(s, { kind: "char", value: ch }).state;
    s = inputReduce(s, { kind: "reverse-search" }).state; // step older
    expect(s.overlay).toMatchObject({ match: "run the tests" });
    const stuck = inputReduce(s, { kind: "reverse-search" }).state; // no older match → no-op
    expect(stuck.overlay).toMatchObject({ match: "run the tests" });
  });

  it("Enter ACCEPTS the current match into the buffer WITHOUT submitting (a recalled prompt is re-runnable)", () => {
    let s = inputReduce(emptyInput(HIST), { kind: "reverse-search" }).state;
    for (const ch of "parser") s = inputReduce(s, { kind: "char", value: ch }).state;
    const r = inputReduce(s, { kind: "enter" });
    expect(r.action).toBeUndefined(); // accept ≠ submit; the user reviews then presses Enter again
    expect(r.state.buffer).toBe("fix the parser");
    expect(r.state.search).toBeUndefined();
    expect(r.state.overlay).toBeUndefined();
  });

  it("Enter with NO match exits search leaving the prior buffer unchanged", () => {
    const s0 = type("draft", emptyInput(HIST)); // a pre-search buffer
    let s = inputReduce(s0, { kind: "reverse-search" }).state;
    for (const ch of "zzz-nomatch") s = inputReduce(s, { kind: "char", value: ch }).state;
    expect(s.overlay).toEqual({ kind: "reverse-search", query: "zzz-nomatch" }); // no match field
    const r = inputReduce(s, { kind: "enter" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("draft"); // the pre-search buffer is preserved
    expect(r.state.search).toBeUndefined();
  });

  it("backspace narrows the query and re-matches; emptying it clears the match", () => {
    let s = inputReduce(emptyInput(HIST), { kind: "reverse-search" }).state;
    for (const ch of "parser") s = inputReduce(s, { kind: "char", value: ch }).state;
    expect(s.overlay).toMatchObject({ match: "fix the parser" });
    s = inputReduce(s, { kind: "backspace" }).state; // "parse"
    expect(s.search?.query).toBe("parse");
    expect(s.overlay).toMatchObject({ match: "fix the parser" });
    for (let i = 0; i < 5; i++) s = inputReduce(s, { kind: "backspace" }).state; // → ""
    expect(s.search?.query).toBe("");
    expect(s.overlay).toEqual({ kind: "reverse-search", query: "" }); // match cleared
  });

  it("reverse-search Backspace removes one whole extended grapheme from the query", () => {
    const grapheme = "👩🏽‍💻";
    let s = inputReduce(emptyInput([`find ${grapheme}`]), { kind: "reverse-search" }).state;
    s = inputReduce(s, { kind: "char", value: grapheme }).state;
    expect(s.search?.query).toBe(grapheme);

    s = inputReduce(s, { kind: "backspace" }).state;
    expect(s.search?.query).toBe("");
    expect(s.overlay).toEqual({ kind: "reverse-search", query: "" });
  });

  it("Escape cancels reverse-search and restores the prior buffer + its overlay (no interrupt)", () => {
    const s0 = type("/ses", emptyInput(HIST)); // a palette buffer
    expect(s0.overlay?.kind).toBe("palette");
    let s = inputReduce(s0, { kind: "reverse-search" }).state; // search takes over the overlay
    expect(s.overlay?.kind).toBe("reverse-search");
    for (const ch of "test") s = inputReduce(s, { kind: "char", value: ch }).state;
    const r = inputReduce(s, { kind: "escape" });
    expect(r.action).toBeUndefined(); // escape backs out of the sub-mode, does NOT interrupt the agent
    expect(r.state.buffer).toBe("/ses"); // the pre-search buffer is restored
    expect(r.state.overlay).toEqual({ kind: "palette", query: "/ses" }); // its overlay recomputed
    expect(r.state.search).toBeUndefined();
  });

  it("Ctrl-C cancels reverse-search instead of interrupting the agent", () => {
    let s = inputReduce(emptyInput(HIST), { kind: "reverse-search" }).state;
    for (const ch of "test") s = inputReduce(s, { kind: "char", value: ch }).state;
    const r = inputReduce(s, { kind: "interrupt" });
    expect(r.action).toBeUndefined(); // no agent interrupt while backing out of the sub-mode
    expect(r.state.search).toBeUndefined();
    expect(r.state.overlay).toBeUndefined();
  });

  it("up / down / newline COMMIT the current match and exit search", () => {
    for (const key of [{ kind: "up" }, { kind: "down" }, { kind: "newline" }] as const) {
      let s = inputReduce(emptyInput(HIST), { kind: "reverse-search" }).state;
      for (const ch of "test") s = inputReduce(s, { kind: "char", value: ch }).state;
      const r = inputReduce(s, key);
      expect(r.action).toBeUndefined();
      expect(r.state.buffer).toBe("run the tests again");
      expect(r.state.search).toBeUndefined();
    }
  });

  it("Ctrl-R walks DUPLICATE matches by index, strictly older each step, then stops (no skip, no wrap)", () => {
    // three entries all containing "x" (indices 0, 2, 3) — stepping must visit them newest→oldest by
    // INDEX (not collapse the duplicate "x" strings), then no-op at the oldest.
    const dup = ["x", "y", "x", "x"];
    let s = inputReduce(emptyInput(dup), { kind: "reverse-search" }).state;
    s = inputReduce(s, { kind: "char", value: "x" }).state;
    expect(s.search?.index).toBe(3); // newest match
    s = inputReduce(s, { kind: "reverse-search" }).state;
    expect(s.search?.index).toBe(2); // strictly older
    s = inputReduce(s, { kind: "reverse-search" }).state;
    expect(s.search?.index).toBe(0); // skips index 1 ("y", no match), lands on the oldest "x"
    const stuck = inputReduce(s, { kind: "reverse-search" }).state;
    expect(stuck.search?.index).toBe(0); // no wrap — stays at the oldest match
    expect(stuck).toBe(s); // a referential no-op
  });

  it("Ctrl-R with empty history opens an inert search (no match, no crash; next-older is a no-op)", () => {
    let s = inputReduce(emptyInput([]), { kind: "reverse-search" }).state;
    for (const ch of "anything") s = inputReduce(s, { kind: "char", value: ch }).state;
    expect(s.overlay).toEqual({ kind: "reverse-search", query: "anything" }); // no match
    const r = inputReduce(s, { kind: "reverse-search" }); // next-older with no current match
    expect(r.state).toEqual(s); // a clean no-op
  });

  // The match is ALWAYS the newest history entry that contains the query as a substring — proven over
  // arbitrary histories + a query sliced from a real entry (so a match is guaranteed to exist).
  it("property: accepting a found query yields the newest history entry containing it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 }),
        fc.nat(),
        (history, pick) => {
          const entry = history[pick % history.length]!; // non-empty (minLength 1)
          const start = pick % entry.length;
          const query = entry.slice(start, start + 1 + (pick % 3)); // length ≥ 1
          let s = inputReduce(emptyInput(history), { kind: "reverse-search" }).state;
          for (const ch of query) s = inputReduce(s, { kind: "char", value: ch }).state;
          const expected = [...history].reverse().find((h) => h.includes(query));
          expect(inputReduce(s, { kind: "enter" }).state.buffer).toBe(expected);
        },
      ),
    );
  });
});

describe("readline line editing (Epic 1.23 slice 4a)", () => {
  it("tracks the cursor at the end of the buffer as you type", () => {
    expect(type("abc").cursor).toBe(3);
    expect(emptyInput().cursor).toBe(0);
  });

  it("left/right move the cursor one char, clamped to [0, len]", () => {
    let s = type("abc"); // cursor 3
    s = inputReduce(s, { kind: "left" }).state;
    expect(s.cursor).toBe(2);
    s = inputReduce(s, { kind: "right" }).state;
    expect(s.cursor).toBe(3);
    for (let i = 0; i < 9; i++) s = inputReduce(s, { kind: "left" }).state; // over-left
    expect(s.cursor).toBe(0); // clamped at start
    for (let i = 0; i < 9; i++) s = inputReduce(s, { kind: "right" }).state; // over-right
    expect(s.cursor).toBe(3); // clamped at end
  });

  it("cursor motion steps over a surrogate pair (astral char), never splitting it (slice 6)", () => {
    let s = type("a😀b"); // 😀 is 2 UTF-16 units → buffer length 4, cursor 4
    s = inputReduce(s, { kind: "left" }).state; // over 'b' → cursor 3
    expect(s.cursor).toBe(3);
    s = inputReduce(s, { kind: "left" }).state; // over the WHOLE '😀' (2 units) → cursor 1, not 2
    expect(s.cursor).toBe(1);
    s = inputReduce(s, { kind: "right" }).state; // over '😀' → cursor 3
    expect(s.cursor).toBe(3);
  });

  it("treats a lone (unpaired) surrogate as a single unit — malformed UTF-16, no crash (slice 6)", () => {
    const start = {
      buffer: "a\uD83Db",
      cursor: 3,
      history: [] as string[],
      histIndex: null,
      kill: "",
    };
    let s = inputReduce(start, { kind: "left" }).state; // over 'b'
    expect(s.cursor).toBe(2);
    s = inputReduce(s, { kind: "left" }).state; // over the lone high surrogate as ONE unit (not a pair)
    expect(s.cursor).toBe(1);
    s = inputReduce(s, { kind: "right" }).state; // forward, single unit
    expect(s.cursor).toBe(2);
    s = inputReduce(s, { kind: "backspace" }).state; // removes the lone surrogate
    expect(s.buffer).toBe("ab");
  });

  it("backspace removes a whole astral char, never a lone surrogate (slice 6)", () => {
    let s = type("a😀"); // cursor 3
    s = inputReduce(s, { kind: "backspace" }).state;
    expect(s.buffer).toBe("a"); // the emoji is removed whole (no dangling \uD83D)
    expect(s.cursor).toBe(1);
  });

  it("home/end jump the cursor to start/end", () => {
    let s = type("hello");
    s = inputReduce(s, { kind: "home" }).state;
    expect(s.cursor).toBe(0);
    s = inputReduce(s, { kind: "end" }).state;
    expect(s.cursor).toBe(5);
  });

  it("Ctrl-A/E/U/K operate only on the current logical line of a multiline draft", () => {
    const buffer = "alpha\nbravo charlie\nomega";
    const middle = {
      buffer,
      cursor: "alpha\nbravo".length,
      history: [] as string[],
      histIndex: null,
      kill: "prior",
    };

    expect(inputReduce(middle, { kind: "home" }).state).toMatchObject({
      buffer,
      cursor: "alpha\n".length,
    });
    expect(inputReduce(middle, { kind: "end" }).state).toMatchObject({
      buffer,
      cursor: "alpha\nbravo charlie".length,
    });
    expect(inputReduce(middle, { kind: "killToStart" }).state).toMatchObject({
      buffer: "alpha\n charlie\nomega",
      cursor: "alpha\n".length,
      kill: "bravo",
    });
    expect(inputReduce(middle, { kind: "killToEnd" }).state).toMatchObject({
      buffer: "alpha\nbravo\nomega",
      cursor: "alpha\nbravo".length,
      kill: " charlie",
    });

    const nextLineStart = { ...middle, cursor: "alpha\nbravo charlie\n".length };
    expect(inputReduce(nextLineStart, { kind: "home" }).state.cursor).toBe(
      "alpha\nbravo charlie\n".length,
    );
    expect(inputReduce(nextLineStart, { kind: "end" }).state.cursor).toBe(buffer.length);
  });

  it("inserts a typed char AT the cursor, not the end", () => {
    let s = type("ac");
    s = inputReduce(s, { kind: "left" }).state; // cursor 1 (between a and c)
    s = inputReduce(s, { kind: "char", value: "b" }).state;
    expect(s.buffer).toBe("abc");
    expect(s.cursor).toBe(2); // just after the inserted 'b'
  });

  it("backspace deletes the char BEFORE the cursor; at position 0 it is a no-op", () => {
    let s = type("abc");
    s = inputReduce(s, { kind: "left" }).state; // cursor 2 (before 'c')
    s = inputReduce(s, { kind: "backspace" }).state; // delete 'b'
    expect(s.buffer).toBe("ac");
    expect(s.cursor).toBe(1);
    s = inputReduce(s, { kind: "home" }).state; // cursor 0
    expect(inputReduce(s, { kind: "backspace" }).state).toBe(s); // no-op at start
  });

  it("forward Delete removes the grapheme under the cursor and is a no-op at buffer end", () => {
    let s = type("abc");
    expect(inputReduce(s, { kind: "deleteForward" }).state).toBe(s);
    s = inputReduce(s, { kind: "home" }).state;
    s = inputReduce(s, { kind: "deleteForward" }).state;
    expect(s).toMatchObject({ buffer: "bc", cursor: 0 });
  });

  it.each([
    ["combining mark", "e\u0301"],
    ["flag", "🇺🇳"],
    ["skin tone", "👍🏽"],
    ["ZWJ emoji", "👩🏽‍💻"],
    ["Devanagari conjunct", "क्‍ष"],
    ["Devanagari spacing mark", "कि"],
    ["tab", "\t"],
    ["newline", "\n"],
  ])(
    "moves across and deletes one whole %s grapheme without rewriting adjacent payload",
    (_label, grapheme) => {
      const buffer = `A${grapheme}B`;
      const start = 1;
      const end = start + grapheme.length;
      const before = {
        buffer,
        cursor: start,
        history: [] as string[],
        histIndex: null,
        kill: "",
      };
      const after = { ...before, cursor: end };

      expect(inputReduce(after, { kind: "left" }).state).toMatchObject({ buffer, cursor: start });
      expect(inputReduce(before, { kind: "right" }).state).toMatchObject({ buffer, cursor: end });
      expect(inputReduce(after, { kind: "backspace" }).state).toMatchObject({
        buffer: "AB",
        cursor: start,
      });
      expect(inputReduce(before, { kind: "deleteForward" }).state).toMatchObject({
        buffer: "AB",
        cursor: start,
      });
    },
  );

  it("inserts a newline (Ctrl-J) at the cursor", () => {
    let s = type("ab");
    s = inputReduce(s, { kind: "left" }).state; // cursor 1
    s = inputReduce(s, { kind: "newline" }).state;
    expect(s.buffer).toBe("a\nb");
    expect(s.cursor).toBe(2);
  });

  it("Alt-B / Alt-F move by whitespace-delimited word", () => {
    let s = type("foo bar baz"); // cursor 11 (end)
    s = inputReduce(s, { kind: "wordLeft" }).state;
    expect(s.cursor).toBe(8); // start of "baz"
    s = inputReduce(s, { kind: "wordLeft" }).state;
    expect(s.cursor).toBe(4); // start of "bar"
    s = inputReduce(s, { kind: "wordRight" }).state;
    expect(s.cursor).toBe(7); // end of "bar" (cursor now sits ON the space at index 7)
    s = inputReduce(s, { kind: "wordRight" }).state;
    expect(s.cursor).toBe(11); // from whitespace, skip it then the next word → end of "baz"
  });

  it("Ctrl-K kills from the cursor to end into the kill-ring", () => {
    let s = type("hello world");
    s = inputReduce(s, { kind: "home" }).state;
    for (let i = 0; i < 6; i++) s = inputReduce(s, { kind: "right" }).state; // cursor 6 (before "world")
    s = inputReduce(s, { kind: "killToEnd" }).state;
    expect(s.buffer).toBe("hello ");
    expect(s.cursor).toBe(6);
    expect(s.kill).toBe("world");
  });

  it("Ctrl-U kills from start to the cursor into the kill-ring", () => {
    let s = type("hello world");
    s = inputReduce(s, { kind: "home" }).state;
    for (let i = 0; i < 6; i++) s = inputReduce(s, { kind: "right" }).state; // cursor 6
    s = inputReduce(s, { kind: "killToStart" }).state;
    expect(s.buffer).toBe("world");
    expect(s.cursor).toBe(0);
    expect(s.kill).toBe("hello ");
  });

  it("Ctrl-W kills the whitespace-delimited word before the cursor", () => {
    let s = type("foo bar baz"); // cursor 11
    s = inputReduce(s, { kind: "killWord" }).state;
    expect(s.buffer).toBe("foo bar ");
    expect(s.cursor).toBe(8);
    expect(s.kill).toBe("baz");
  });

  it("Ctrl-Y yanks the kill-ring at the cursor; the ring persists for re-yank", () => {
    let s = inputReduce(type("hello world"), { kind: "killWord" }).state; // kill "world"
    expect(s.buffer).toBe("hello ");
    s = inputReduce(s, { kind: "yank" }).state;
    expect(s.buffer).toBe("hello world");
    expect(s.cursor).toBe(11);
    s = inputReduce(s, { kind: "yank" }).state; // ring still holds "world"
    expect(s.buffer).toBe("hello worldworld");
  });

  it("Ctrl-Y with an empty kill-ring is a no-op", () => {
    const s = type("abc");
    expect(inputReduce(s, { kind: "yank" }).state).toBe(s);
  });

  it("a kill of nothing (at the boundary) does NOT clobber a non-empty kill-ring", () => {
    let s = type("hi"); // cursor 2 (end)
    s = inputReduce(s, { kind: "killToEnd" }).state; // kills "" — ring stays empty
    expect(s.kill).toBe("");
    s = inputReduce(s, { kind: "killToStart" }).state; // kills "hi"
    expect(s.kill).toBe("hi");
    s = inputReduce(s, { kind: "killToEnd" }).state; // nothing to kill (empty buffer)
    expect(s.kill).toBe("hi"); // preserved, not clobbered with ""
  });

  it("a logical-line kill round-trips through yank without touching earlier lines", () => {
    let s = type("a");
    s = inputReduce(s, { kind: "newline" }).state; // "a\n", cursor 2
    s = type("bc", s); // "a\nbc", cursor 4
    s = inputReduce(s, { kind: "killToStart" }).state;
    expect(s.buffer).toBe("a\n");
    expect(s.cursor).toBe(2);
    expect(s.kill).toBe("bc");
    s = inputReduce(s, { kind: "yank" }).state;
    expect(s.buffer).toBe("a\nbc");
    expect(s.cursor).toBe(4); // cursor lands after the whole yanked (multi-line) text
  });

  it("a kill that removes the leading '/' drops the command palette overlay", () => {
    let s = type("/help"); // palette overlay open
    expect(s.overlay?.kind).toBe("palette");
    s = inputReduce(s, { kind: "home" }).state; // cursor 0
    s = inputReduce(s, { kind: "right" }).state; // cursor 1 (just past the '/')
    s = inputReduce(s, { kind: "killToStart" }).state; // kill "/" → buffer "help"
    expect(s.buffer).toBe("help");
    expect(s.overlay).toBeUndefined(); // overlay recomputed by the kill chokepoint
    expect(s.kill).toBe("/");
  });

  it("history recall puts the cursor at the end of the recalled line", () => {
    const s = inputReduce(emptyInput(["first task"]), { kind: "up" }).state;
    expect(s.buffer).toBe("first task");
    expect(s.cursor).toBe(10);
  });

  it("history browsing restores the exact unsent draft cursor, not only its text", () => {
    let s = type("draft 👩🏽‍💻", emptyInput(["prior task"]));
    s = inputReduce(s, { kind: "home" }).state;
    s = inputReduce(s, { kind: "right" }).state;
    expect(s.cursor).toBe(1);

    s = inputReduce(s, { kind: "up" }).state;
    expect(s.buffer).toBe("prior task");
    s = inputReduce(s, { kind: "down" }).state;
    expect(s).toMatchObject({ buffer: "draft 👩🏽‍💻", cursor: 1, histIndex: null });
  });

  it("accepting a reverse search with no match preserves the exact draft cursor", () => {
    let s = type("draft", emptyInput(["prior task"]));
    s = inputReduce(s, { kind: "home" }).state;
    s = inputReduce(s, { kind: "right" }).state;
    s = inputReduce(s, { kind: "reverse-search" }).state;
    s = inputReduce(s, { kind: "char", value: "no-match" }).state;

    const accepted = inputReduce(s, { kind: "enter" }).state;
    expect(accepted).toMatchObject({ buffer: "draft", cursor: 1 });
  });

  it.each([
    ["cancelled", { kind: "escape" } as const],
    ["accepted without a match", { kind: "enter" } as const],
  ])("keeps the unsent draft recoverable when history-browse search is %s", (_label, exitKey) => {
    let s = type("draft 👩🏽‍💻", emptyInput(["prior task"]));
    s = inputReduce(s, { kind: "home" }).state;
    s = inputReduce(s, { kind: "right" }).state;
    s = inputReduce(s, { kind: "up" }).state;
    expect(s).toMatchObject({
      buffer: "prior task",
      histIndex: 0,
      draft: "draft 👩🏽‍💻",
      draftCursor: 1,
    });

    s = inputReduce(s, { kind: "reverse-search" }).state;
    s = inputReduce(s, { kind: "char", value: "no-match" }).state;
    s = inputReduce(s, exitKey).state;
    expect(s).toMatchObject({
      buffer: "prior task",
      histIndex: 0,
      draft: "draft 👩🏽‍💻",
      draftCursor: 1,
    });

    s = inputReduce(s, { kind: "down" }).state;
    expect(s).toMatchObject({ buffer: "draft 👩🏽‍💻", cursor: 1, histIndex: null });
  });

  it("a motion/edit key while reverse-searching commits the match and exits search", () => {
    let s = inputReduce(emptyInput(["fix the bug"]), { kind: "reverse-search" }).state;
    for (const ch of "bug") s = inputReduce(s, { kind: "char", value: ch }).state; // match "fix the bug"
    const r = inputReduce(s, { kind: "left" }); // a motion key commits + exits search
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("fix the bug");
    expect(r.state.search).toBeUndefined();
  });

  // The cursor is an index into the buffer at all times — never out of range, for any key stream.
  it("property: the cursor stays within [0, buffer.length] after every keystroke", () => {
    const NOARG = [
      "enter",
      "newline",
      "backspace",
      "deleteForward",
      "up",
      "down",
      "escape",
      "reverse-search",
      "interrupt",
      "left",
      "right",
      "home",
      "end",
      "wordLeft",
      "wordRight",
      "killToStart",
      "killToEnd",
      "killWord",
      "yank",
    ] as const;
    // `char` values include MULTI-codepoint + astral (surrogate-pair) strings — a real input path
    // (Ink delivers a paste as one multi-char `input`), and the one most likely to break a
    // cursor-vs-length relationship via `cursor + value.length`. fullUnicodeString covers it.
    const arbKey: fc.Arbitrary<Key> = fc.oneof<fc.Arbitrary<Key>[]>(
      fc
        .fullUnicodeString({ minLength: 1, maxLength: 3 })
        .map((value) => ({ kind: "char", value })),
      fc.fullUnicodeString({ maxLength: 5 }).map((text) => ({ kind: "paste", text })), // 4b paste op
      fc.constantFrom(...NOARG).map((kind) => ({ kind })),
    );
    fc.assert(
      fc.property(fc.array(arbKey, { maxLength: 50 }), (keys) => {
        let s = emptyInput(["alpha", "beta gamma"]);
        for (const k of keys) {
          s = inputReduce(s, k).state;
          expect(s.cursor).toBeGreaterThanOrEqual(0);
          expect(s.cursor).toBeLessThanOrEqual(s.buffer.length);
        }
      }),
    );
  });

  it("property: grapheme motion and deletion always leave the cursor on a shared boundary", () => {
    const initial = "A|e\u0301|🇺🇳|👍🏽|👩🏽‍💻|क्‍ष|कि|\t|\n|Z";
    const operations = fc.array(
      fc.constantFrom<Key>(
        { kind: "left" },
        { kind: "right" },
        { kind: "backspace" },
        { kind: "deleteForward" },
      ),
      { maxLength: 100 },
    );

    fc.assert(
      fc.property(operations, (keys) => {
        let s: InputState = {
          buffer: initial,
          cursor: initial.length,
          history: [] as string[],
          histIndex: null,
          kill: "",
        };
        for (const key of keys) {
          s = inputReduce(s, key).state;
          const boundaries = new Set([0, ...graphemeSpans(s.buffer).map((span) => span.end)]);
          expect(boundaries.has(s.cursor)).toBe(true);
        }
      }),
    );
  });
});

describe("bracketed paste (Epic 1.23 slice 4b)", () => {
  it("inserts pasted text atomically AT the cursor, advancing past it, with NO submit", () => {
    let s = type("ad");
    s = inputReduce(s, { kind: "left" }).state; // cursor 1 (between a and d)
    const r = inputReduce(s, { kind: "paste", text: "bc" });
    expect(r.action).toBeUndefined(); // a paste never submits
    expect(r.state.buffer).toBe("abcd");
    expect(r.state.cursor).toBe(3); // just after the inserted paste
  });

  it("a MULTI-LINE paste keeps its newlines in the buffer and does NOT submit", () => {
    const r = inputReduce(emptyInput(), { kind: "paste", text: "line one\nline two\nline three" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("line one\nline two\nline three");
    expect(r.state.cursor).toBe("line one\nline two\nline three".length);
  });

  it("a MULTI-LINE paste delivered with lone CR line breaks (real terminal bracketed paste) keeps its lines", () => {
    // A real terminal / tmux delivers a bracketed paste's line breaks as lone CR (0x0d), NOT LF —
    // proven byte-for-byte: pasting `alpha\nbravo` arrives as `alpha\x0dbravo`. The paste must
    // preserve those line boundaries as newlines, not silently join every line into one.
    const r = inputReduce(emptyInput(), { kind: "paste", text: "line one\rline two\rline three" });
    expect(r.action).toBeUndefined();
    expect(r.state.buffer).toBe("line one\nline two\nline three");
    expect(r.state.cursor).toBe("line one\nline two\nline three".length);
  });

  it("sanitizes control bytes from a paste (ER-020): drops ESC/C0/C1, normalizes \\r\\n, keeps \\n and \\t", () => {
    // a pasted blob with a screen-clear CSI, a BEL, a CRLF, and a tab
    const r = inputReduce(emptyInput(), { kind: "paste", text: "a\x1b[2J\x07b\r\nc\td" });
    // the dangerous ESC byte is removed (so `[2J` is now inert text, not a screen-clear command), BEL
    // and \r are removed, \n and \t are preserved — matches stripControl's documented ER-020 behavior.
    expect(r.state.buffer).toBe("a[2Jb\nc\td");
    // no raw control bytes survive (the real ER-020 guard) — checked via includes to avoid a
    // control-char regex literal
    expect(r.state.buffer.includes("\x1b")).toBe(false);
    expect(r.state.buffer.includes("\x07")).toBe(false);
    expect(r.state.buffer.includes("\r")).toBe(false);
  });

  it("a paste does NOT open the command palette, even when it starts with '/' (no flicker)", () => {
    const r = inputReduce(emptyInput(), { kind: "paste", text: "/usr/local/bin\nnext" });
    expect(r.state.buffer).toBe("/usr/local/bin\nnext");
    expect(r.state.overlay).toBeUndefined(); // bulk paste is literal text, never a command query
  });

  it("a pasted slash command still resolves locally on Enter instead of becoming a model prompt", () => {
    let s = inputReduce(emptyInput(), {
      kind: "paste",
      text: '/goal Confirm the TUI tests still pass --check "pnpm vitest run\npackages/kernel/src/tui/conversation-block.test.ts --reporter=dot --maxWorkers=4"',
    }).state;
    expect(s.overlay).toBeUndefined();

    const r = inputReduce(s, { kind: "enter" });
    expect(r.action).toEqual({
      kind: "command",
      name: "/goal",
      args: 'Confirm the TUI tests still pass --check "pnpm vitest run\npackages/kernel/src/tui/conversation-block.test.ts --reporter=dot --maxWorkers=4"',
    });
    expect(r.state.buffer).toBe("");

    s = inputReduce(emptyInput(), { kind: "paste", text: "/autopilot" }).state;
    expect(s.overlay).toBeUndefined();
    expect(inputReduce(s, { kind: "enter" }).action).toEqual({
      kind: "command",
      name: "/autopilot",
    });

    s = inputReduce(emptyInput(), { kind: "paste", text: "/usr/local/bin\nnext" }).state;
    expect(inputReduce(s, { kind: "enter" }).action).toEqual({
      kind: "line",
      text: "/usr/local/bin\nnext",
    });
  });

  it("a paste while reverse-searching commits the match AND inserts the paste (no data loss)", () => {
    let s = inputReduce(emptyInput(["prior line"]), { kind: "reverse-search" }).state;
    for (const ch of "prior") s = inputReduce(s, { kind: "char", value: ch }).state; // matches "prior line"
    const r = inputReduce(s, { kind: "paste", text: "X" });
    expect(r.state.search).toBeUndefined(); // search committed
    expect(r.state.buffer).toBe("prior lineX"); // match accepted (cursor at end), then the paste inserted
  });
});

describe("@file path completion (Epic 1.23 slice 5)", () => {
  it("typing an @token opens an at-complete overlay tracking the query after the @", () => {
    expect(type("explain @src/in").overlay).toEqual({ kind: "at-complete", query: "src/in" });
    expect(type("@").overlay).toEqual({ kind: "at-complete", query: "" }); // bare @ → list root
  });

  it("the at-complete overlay closes when the cursor leaves the @token (e.g. a trailing space)", () => {
    let s = type("@src");
    expect(s.overlay?.kind).toBe("at-complete");
    s = type(" ", s); // a space ends the @token
    expect(s.overlay).toBeUndefined();
  });

  it("an @ mid-word (not starting the token) does NOT open at-complete", () => {
    expect(type("email@host").overlay).toBeUndefined(); // the @ does not start the whitespace-token
  });

  it("a leading / still opens the command palette when there is no @token at the cursor", () => {
    expect(type("/he").overlay).toEqual({ kind: "palette", query: "/he" });
  });

  it("detects the @token mid-buffer when the cursor sits at its end", () => {
    let s = type("a @sr more"); // cursor at end (10)
    for (let i = 0; i < 5; i++) s = inputReduce(s, { kind: "left" }).state; // cursor 5 — just after "@sr"
    expect(s.overlay).toEqual({ kind: "at-complete", query: "sr" });
  });

  it("complete-path replaces the @token at the cursor with the chosen path (keeping the @)", () => {
    const s = type("explain @src/in");
    const r = inputReduce(s, { kind: "complete-path", path: "src/index.ts" });
    expect(r.state.buffer).toBe("explain @src/index.ts");
    expect(r.state.cursor).toBe("explain @src/index.ts".length);
  });

  it("complete-path preserves text after the cursor", () => {
    let s = type("see @sr here"); // cursor 12 (end)
    for (let i = 0; i < 5; i++) s = inputReduce(s, { kind: "left" }).state; // cursor 7 — after "@sr"
    const r = inputReduce(s, { kind: "complete-path", path: "src/" });
    expect(r.state.buffer).toBe("see @src/ here");
  });

  it("complete-path with the cursor MID-token replaces the WHOLE token (no dangling tail) (QC M1)", () => {
    let s = type("@src"); // cursor 4 (end)
    s = inputReduce(s, { kind: "left" }).state; // cursor 3 — inside the token, after "sr", before "c"
    expect(s.overlay).toEqual({ kind: "at-complete", query: "src" }); // the FULL token, not "sr" (QC M2)
    const r = inputReduce(s, { kind: "complete-path", path: "src/index.ts" });
    expect(r.state.buffer).toBe("@src/index.ts"); // the trailing "c" is NOT left dangling
    expect(r.state.cursor).toBe("@src/index.ts".length);
  });

  it("complete-path with no @token at the cursor is a no-op", () => {
    const s = type("no token here");
    expect(inputReduce(s, { kind: "complete-path", path: "x" }).state).toBe(s);
  });

  it("escape dismisses at-complete without changing the prompt, and the next edit may reopen it", () => {
    const s = type("explain @src");
    const r = inputReduce(s, { kind: "escape" });
    expect(r.action).toBeUndefined(); // not an interrupt
    expect(r.state.buffer).toBe("explain @src"); // the prompt is preserved
    expect(r.state.cursor).toBe(s.cursor);
    expect(r.state.overlay).toBeUndefined();

    const edited = inputReduce(r.state, { kind: "char", value: "/" }).state;
    expect(edited.buffer).toBe("explain @src/");
    expect(edited.overlay).toEqual({ kind: "at-complete", query: "src/" });
  });
});

// keep the Key type referenced
const _exhaustive: Key = { kind: "enter" };
void _exhaustive;
