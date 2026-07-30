import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ModelMessageT } from "@keel/shared";
import { assembleContext } from "./context.js";
import { toSdkMessages } from "./messages.js";

/**
 * Slice-5 cache-stable assembly (design §8/§16): `assembleContext` orders messages so the
 * leading system prefix stays byte-stable across turns and marks the per-provider cache
 * directive. *Deciding what goes in each tier* (compaction) is Epic 1.6 — this unit only
 * orders + marks. These tests assert the VALUE content (exact shapes), not just structure,
 * to kill "always returns {}" / "drops the marker" mutants.
 */

const SYSTEM_MSG: ModelMessageT = { role: "system", content: "You are keel." };

/** Turn 1: [system, user]. */
const TURN_1: ModelMessageT[] = [SYSTEM_MSG, { role: "user", content: "hi" }];

/** Turn N: the SAME stable prefix, with a grown conversation tail. */
const TURN_N: ModelMessageT[] = [
  SYSTEM_MSG,
  { role: "user", content: "hi" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "read", args: { path: "/a" } }],
  },
  { role: "tool", content: "file body", toolCallId: "c1", name: "read" },
  { role: "user", content: "now do the next thing" },
];

/** How many leading SDK messages are the stable prefix (the system message(s) only). */
function leadingSystemCount(messages: readonly { role: string }[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "system") n += 1;
    else break;
  }
  return n;
}

describe("assembleContext — stable-prefix byte-equality across turns", () => {
  it("the leading system prefix (message + anthropic cache marker) is byte-identical on turn 1 and turn N", () => {
    const a = assembleContext({ messages: TURN_1, cacheStrategy: "anthropic-breakpoint" });
    const b = assembleContext({ messages: TURN_N, cacheStrategy: "anthropic-breakpoint" });

    const aPrefix = a.messages.slice(0, leadingSystemCount(a.messages));
    const bPrefix = b.messages.slice(0, leadingSystemCount(b.messages));

    // Exactly one system message leads, and it carries the cache marker.
    expect(aPrefix).toHaveLength(1);
    expect(bPrefix).toHaveLength(1);
    // Byte-identical prefix across turns — the cache-hit precondition.
    expect(aPrefix).toEqual(bPrefix);
    expect(aPrefix[0]).toEqual({
      role: "system",
      content: "You are keel.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("the growing conversation lives ONLY in the trailing messages, never in the stable prefix", () => {
    const b = assembleContext({ messages: TURN_N, cacheStrategy: "anthropic-breakpoint" });
    const prefixLen = leadingSystemCount(b.messages);
    const tail = b.messages.slice(prefixLen);
    // No system message hides in the tail; the prefix is system-only.
    expect(tail.some((m) => m.role === "system")).toBe(false);
    // The tail carries the full grown conversation in order (user, assistant, tool, user).
    expect(tail.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("prefix stays byte-stable across turns for a non-anthropic strategy too (no marker, same prefix)", () => {
    const a = assembleContext({ messages: TURN_1, cacheStrategy: "google-implicit" });
    const b = assembleContext({ messages: TURN_N, cacheStrategy: "google-implicit" });
    const aPrefix = a.messages.slice(0, leadingSystemCount(a.messages));
    const bPrefix = b.messages.slice(0, leadingSystemCount(b.messages));
    expect(aPrefix).toEqual(bPrefix);
    // No marker for google-implicit — the system message is the plain mapped shape.
    expect(aPrefix[0]).toEqual({ role: "system", content: "You are keel." });
  });
});

describe("assembleContext — per-strategy directives (exact shapes)", () => {
  it("anthropic-breakpoint: marks the leading system AND the last (settled) message; middle unmarked", () => {
    const r = assembleContext({ messages: TURN_N, cacheStrategy: "anthropic-breakpoint" });
    const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };
    // Breakpoint 1: the leading system message (stable tools→system prefix).
    expect(r.messages[0]).toEqual({
      role: "system",
      content: "You are keel.",
      providerOptions: EPHEMERAL,
    });
    // Breakpoint 2: the LAST message of the settled conversation (caches the growing prefix next turn).
    const last = r.messages[r.messages.length - 1]!;
    expect(last.providerOptions).toEqual(EPHEMERAL);
    // Middle messages carry NO marker (≤2 breakpoints).
    expect(r.messages[1]!.providerOptions).toBeUndefined();
    expect(r.messages[2]!.providerOptions).toBeUndefined();
    // CONTENT is never mutated — caching is metadata-only (a content change would alter behavior).
    expect(toSdkMessages(TURN_N).map((m) => m.content)).toEqual(r.messages.map((m) => m.content));
    // Anthropic caching is message-level only — no call-level providerOptions.
    expect(r.providerOptions).toBeUndefined();
  });

  it("anthropic-breakpoint marks only the FIRST leading system (not later system msgs) + the last message", () => {
    const twoSystem: ModelMessageT[] = [
      { role: "system", content: "core" },
      { role: "system", content: "extra" },
      { role: "user", content: "hi" },
    ];
    const r = assembleContext({ messages: twoSystem, cacheStrategy: "anthropic-breakpoint" });
    const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };
    expect(r.messages[0]).toEqual({ role: "system", content: "core", providerOptions: EPHEMERAL });
    expect(r.messages[1]).toEqual({ role: "system", content: "extra" }); // a non-head system: unmarked
    expect(r.messages[2]).toEqual({ role: "user", content: "hi", providerOptions: EPHEMERAL }); // last
  });

  it("openai-cache-key WITH a cacheKey: call-level providerOptions.openai.promptCacheKey === cacheKey; no message marker", () => {
    const r = assembleContext({
      messages: TURN_1,
      cacheStrategy: "openai-cache-key",
      cacheKey: "sess-abc",
    });
    expect(r.providerOptions).toEqual({ openai: { promptCacheKey: "sess-abc" } });
    // The system message is the plain mapped shape (no message-level marker for openai).
    expect(r.messages[0]).toEqual({ role: "system", content: "You are keel." });
  });

  it("openai-cache-key WITHOUT a cacheKey: NO directive at all (rely on automatic prefix caching)", () => {
    const r = assembleContext({ messages: TURN_1, cacheStrategy: "openai-cache-key" });
    expect(r.providerOptions).toBeUndefined();
    expect(r.messages[0]).toEqual({ role: "system", content: "You are keel." });
  });

  it("google-implicit: no directive + provider isolation (no anthropic marker on ANY message)", () => {
    const r = assembleContext({
      messages: TURN_1,
      cacheStrategy: "google-implicit",
      cacheKey: "x",
    });
    expect(r.providerOptions).toBeUndefined();
    expect(r.messages[0]).toEqual({ role: "system", content: "You are keel." });
    // Provider isolation: the conversation breakpoint is Anthropic-only — the last message is NOT marked.
    expect(r.messages.every((m) => m.providerOptions === undefined)).toBe(true);
  });

  it("none: no directive at all (local provider has no cache)", () => {
    const r = assembleContext({ messages: TURN_1, cacheStrategy: "none", cacheKey: "x" });
    expect(r.providerOptions).toBeUndefined();
    expect(r.messages[0]).toEqual({ role: "system", content: "You are keel." });
  });

  it("anthropic-breakpoint with an EMPTY message list: no breakpoints, no directive (degenerate guard)", () => {
    const r = assembleContext({ messages: [], cacheStrategy: "anthropic-breakpoint" });
    expect(r.messages).toEqual([]);
    expect(r.providerOptions).toBeUndefined();
  });

  it("anthropic-breakpoint with NO system message: still caches the conversation prefix (last message marked)", () => {
    const noSystem: ModelMessageT[] = [{ role: "user", content: "hi" }];
    const r = assembleContext({ messages: noSystem, cacheStrategy: "anthropic-breakpoint" });
    // No system to mark, but the last (only) message still gets the conversation breakpoint.
    expect(r.messages).toEqual([
      {
        role: "user",
        content: "hi",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
    expect(r.providerOptions).toBeUndefined();
  });
});

describe("assembleContext — rolling breakpoints survive the 20-block cache lookback (heavy fan-out)", () => {
  // Anthropic's prompt cache walks back AT MOST 20 content blocks from a breakpoint to find a prior
  // entry (shared/prompt-caching.md "20-block lookback window"). A single agentic turn can append far
  // more than 20 blocks (one assistant message + many parallel tool results), so a fixed head+tail
  // pair leaves a >20-block gap and the WHOLE conversation prefix misses cache next turn. These tests
  // pin the fix: rolling breakpoints spaced inside the lookback window, using the full 4-breakpoint
  // budget. They FAIL on the old head+tail strategy (only 2 breakpoints, one ~N blocks from the tail).

  const ANTHROPIC_MAX_BREAKPOINTS = 4;
  const CACHE_LOOKBACK_BLOCKS = 20;

  /** Blocks an SDK message occupies on the Anthropic wire: string content = 1; array = its length. */
  const blockCount = (m: { content: unknown }): number =>
    typeof m.content === "string" ? 1 : Math.max(1, (m.content as unknown[]).length);

  /** Indices of messages carrying the anthropic ephemeral cache marker, in order. */
  const markedIndices = (msgs: readonly { providerOptions?: unknown }[]): number[] =>
    msgs.flatMap((m, i) => (m.providerOptions !== undefined ? [i] : []));

  /** Sum of block counts for messages in (a, b] — the distance a lookback travels from b back to a. */
  const blockGap = (msgs: readonly { content: unknown }[], a: number, b: number): number => {
    let n = 0;
    for (let i = a + 1; i <= b; i++) n += blockCount(msgs[i]!);
    return n;
  };

  /** [system, user, then `pairs` × (assistant-with-1-tool-call, tool-result)] — a long single-block suffix. */
  const fanOut = (pairs: number): ModelMessageT[] => {
    const msgs: ModelMessageT[] = [SYSTEM_MSG, { role: "user", content: "go" }];
    for (let i = 0; i < pairs; i++) {
      msgs.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: `c${i}`, name: "read", args: { n: i } }],
      });
      msgs.push({ role: "tool", content: `r${i}`, toolCallId: `c${i}`, name: "read" });
    }
    return msgs;
  };

  it("places >2 breakpoints when the suffix exceeds the lookback window (rolling kicks in)", () => {
    const r = assembleContext({ messages: fanOut(20), cacheStrategy: "anthropic-breakpoint" });
    const marks = markedIndices(r.messages);
    // A 42-message single-block suffix: the old head+tail pair (2) leaves a ~41-block gap → miss.
    expect(marks.length).toBeGreaterThan(2);
    expect(marks.length).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS);
  });

  it("pins the stable system head AND the last settled message", () => {
    const r = assembleContext({ messages: fanOut(20), cacheStrategy: "anthropic-breakpoint" });
    const marks = markedIndices(r.messages);
    expect(marks).toContain(0); // system head — always-readable stable prefix
    expect(marks).toContain(r.messages.length - 1); // tail — newest write point
  });

  it("keeps consecutive rolling breakpoints within the 20-block lookback (the cache-hit guarantee)", () => {
    const r = assembleContext({ messages: fanOut(20), cacheStrategy: "anthropic-breakpoint" });
    // Rolling marks = everything except the pinned head at index 0.
    const rolling = markedIndices(r.messages).filter((i) => i !== 0);
    expect(rolling.length).toBeGreaterThanOrEqual(2);
    for (let k = 1; k < rolling.length; k++) {
      const gap = blockGap(r.messages, rolling[k - 1]!, rolling[k]!);
      expect(gap).toBeLessThanOrEqual(CACHE_LOOKBACK_BLOCKS);
    }
  });

  it("never exceeds Anthropic's 4-breakpoint cap, even on a very long conversation", () => {
    const r = assembleContext({ messages: fanOut(100), cacheStrategy: "anthropic-breakpoint" });
    expect(markedIndices(r.messages).length).toBeLessThanOrEqual(ANTHROPIC_MAX_BREAKPOINTS);
  });

  it("collapses to exactly 2 breakpoints (head + tail) for a short conversation", () => {
    // Below the lookback window there is no >20-block gap to bridge — no extra breakpoints needed.
    const r = assembleContext({ messages: fanOut(2), cacheStrategy: "anthropic-breakpoint" });
    expect(markedIndices(r.messages)).toEqual([0, r.messages.length - 1]);
  });

  it("property: any conversation yields ≤4 breakpoints with rolling gaps inside the lookback window", () => {
    const msg = fc.record({
      role: fc.constantFrom("user" as const, "assistant" as const),
      content: fc.string(),
    });
    fc.assert(
      fc.property(fc.array(msg, { minLength: 0, maxLength: 80 }), (convo) => {
        const r = assembleContext({
          messages: [SYSTEM_MSG, ...convo],
          cacheStrategy: "anthropic-breakpoint",
        });
        const marks = markedIndices(r.messages);
        if (marks.length > ANTHROPIC_MAX_BREAKPOINTS) return false;
        const rolling = marks.filter((i) => i !== 0);
        for (let k = 1; k < rolling.length; k++) {
          if (blockGap(r.messages, rolling[k - 1]!, rolling[k]!) > CACHE_LOOKBACK_BLOCKS)
            return false;
        }
        return true;
      }),
    );
  });
});

describe("assembleContext — cache TTL (KEEL_CACHE_TTL lever; default 5m == omit)", () => {
  const markers = (msgs: readonly { providerOptions?: unknown }[]): unknown[] =>
    msgs.flatMap((m) => (m.providerOptions !== undefined ? [m.providerOptions] : []));

  it("default (no cacheTtl): markers are { type:'ephemeral' } with NO ttl field (byte-identical to before)", () => {
    const r = assembleContext({ messages: TURN_N, cacheStrategy: "anthropic-breakpoint" });
    for (const po of markers(r.messages)) {
      expect(po).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    }
  });

  it("cacheTtl '5m' is treated as the default — still NO ttl field on the wire-bound marker", () => {
    const r = assembleContext({
      messages: TURN_N,
      cacheStrategy: "anthropic-breakpoint",
      cacheTtl: "5m",
    });
    for (const po of markers(r.messages)) {
      expect(po).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    }
  });

  it("cacheTtl '1h': every breakpoint carries { type:'ephemeral', ttl:'1h' }", () => {
    const r = assembleContext({
      messages: TURN_N,
      cacheStrategy: "anthropic-breakpoint",
      cacheTtl: "1h",
    });
    const ms = markers(r.messages);
    expect(ms.length).toBeGreaterThanOrEqual(2); // head + tail at minimum
    for (const po of ms) {
      expect(po).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
    }
  });

  it("cacheTtl '1h' applies to ALL rolling breakpoints on a long fan-out (uniform TTL)", () => {
    const msgs: ModelMessageT[] = [SYSTEM_MSG];
    for (let i = 0; i < 40; i++) msgs.push({ role: "user", content: `m${i}` });
    const r = assembleContext({
      messages: msgs,
      cacheStrategy: "anthropic-breakpoint",
      cacheTtl: "1h",
    });
    const ms = markers(r.messages);
    expect(ms.length).toBeGreaterThan(2); // rolling kicked in
    for (const po of ms) {
      expect(po).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } });
    }
  });

  it("cacheTtl is ignored by non-anthropic strategies (no markers regardless)", () => {
    const r = assembleContext({
      messages: TURN_1,
      cacheStrategy: "google-implicit",
      cacheTtl: "1h",
    });
    expect(r.messages.every((m) => m.providerOptions === undefined)).toBe(true);
  });
});

describe("assembleContext — message mapping delegates to toSdkMessages (only cache markers added)", () => {
  it("the MIDDLE messages are byte-identical to the plain mapping; only system + last gain a marker", () => {
    const r = assembleContext({ messages: TURN_N, cacheStrategy: "anthropic-breakpoint" });
    const plain = toSdkMessages(TURN_N);
    const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const lastIdx = plain.length - 1;
    // Middle messages (between the leading system and the last) are untouched.
    expect(r.messages.slice(1, lastIdx)).toEqual(plain.slice(1, lastIdx));
    // System (head) and the last message each gain ONLY the cache marker (content preserved).
    expect(r.messages[0]).toEqual({ ...plain[0], providerOptions: EPHEMERAL });
    expect(r.messages[lastIdx]).toEqual({ ...plain[lastIdx], providerOptions: EPHEMERAL });
  });
});
