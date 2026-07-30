import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import type { ModelStreamChunkT, ModelTurnInput } from "@keel/shared";
import { VercelModelPort, mergeProviderOptions } from "./vercel-model-port.js";
import type { StreamTextFn, StreamTextOptions } from "./vercel-model-port.js";
import { CAPABILITIES, type ProviderId } from "./capabilities.js";

/**
 * Slice-5: cache-stable assembly wired into the port. These exercise the SAME adapter core
 * through a mock transport that captures the `streamText` options, proving:
 *   - the anthropic message-level cacheControl reaches streamText on the leading system message;
 *   - reasoning (slice 4, call-level) and the anthropic cache breakpoint (message-level) COEXIST;
 *   - the call-level providerOptions deep-merge (cache ⊕ reasoning) never clobbers either side;
 *   - `allowSystemInMessages: true` is set so the SDK's system-in-messages warning is suppressed.
 *
 * Note: per-turn `cacheKey` plumbing into `openai-cache-key` is NOT wired in this slice — that
 * would require adding a field to the FROZEN `ModelTurnInput.params` (model-port.ts, FROZEN
 * before Phase 1 — an ADR/stop-and-ask). The openai key PATH is fully proven at the unit level
 * in context.test.ts; the deep-merge that would combine it with reasoning is proven directly via
 * `mergeProviderOptions` below (no clobber), so the merge is honest even before a key source exists.
 */

function fakeModel(id: string): LanguageModel {
  return { __fakeModelId: id } as unknown as LanguageModel;
}

function capturingStreamText(): { fn: StreamTextFn; captured: () => StreamTextOptions } {
  let seen: StreamTextOptions | undefined;
  const fn: StreamTextFn = (opts) => {
    seen = opts;
    return {
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop", totalUsage: {} };
      })(),
    };
  };
  return {
    fn,
    captured: () => {
      if (seen === undefined) throw new Error("streamText was not called");
      return seen;
    },
  };
}

function portFor(id: ProviderId, streamText: StreamTextFn): VercelModelPort {
  return new VercelModelPort(
    { defaultModelId: `${id}-default`, buildModel: fakeModel, capability: CAPABILITIES[id] },
    { streamText },
  );
}

async function drain(port: VercelModelPort, input: ModelTurnInput): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const c of port.stream(input)) out.push(c);
  return out;
}

/** A [system, user] turn (the leading system is the stable prefix). */
const SYS_USER: ModelTurnInput = {
  messages: [
    { role: "system", content: "You are keel." },
    { role: "user", content: "hi" },
  ],
};

describe("VercelModelPort — anthropic message-level cacheControl reaches streamText", () => {
  it("attaches cacheControl {type:'ephemeral'} to the leading system message", async () => {
    const t = capturingStreamText();
    const port = portFor("anthropic", t.fn);
    await drain(port, SYS_USER);
    const opts = t.captured();
    expect(opts.messages[0]).toEqual({
      role: "system",
      content: "You are keel.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    // No CALL-level cache directive for anthropic (it is message-level only).
    expect("providerOptions" in opts).toBe(false);
  });

  it("sets allowSystemInMessages:true so the SDK system-in-messages warning is suppressed", async () => {
    const t = capturingStreamText();
    const port = portFor("anthropic", t.fn);
    await drain(port, SYS_USER);
    expect(t.captured().allowSystemInMessages).toBe(true);
  });

  it("attaches cacheControl to the LAST settled message too — conversation-prefix breakpoint #2, end-to-end", async () => {
    // The whole point of the cache-breakpoint fix: mark the LAST message of the settled conversation (not just
    // the system head), so next turn the entire prior conversation reads from cache (~0.1×) instead of
    // re-sending uncached. This proves breakpoint #2 actually reaches streamText through the port — the
    // pure assembler is unit-tested in context.test.ts; this is the missing integration assertion.
    const t = capturingStreamText();
    const port = portFor("anthropic", t.fn);
    await drain(port, {
      messages: [
        { role: "system", content: "You are keel." },
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    });
    const opts = t.captured();
    const last = opts.messages[opts.messages.length - 1];
    expect(last).toMatchObject({
      role: "user",
      content: "second",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    // ≤2 breakpoints: a MIDDLE message carries no cache directive (only system head + last message).
    expect(opts.messages[1]).not.toHaveProperty("providerOptions");
  });
});

describe("VercelModelPort — openai/local emit no call-level cache directive without a key source", () => {
  it("openai: no call-level providerOptions (cacheKey is not threaded in this slice)", async () => {
    const t = capturingStreamText();
    const port = portFor("openai", t.fn);
    await drain(port, SYS_USER);
    expect("providerOptions" in t.captured()).toBe(false);
  });
});

describe("VercelModelPort — reasoning ⊕ caching coexist (the integration proof)", () => {
  it("anthropic: reasoning is call-level, cacheControl is message-level → both survive on their own object", async () => {
    const t = capturingStreamText();
    const port = portFor("anthropic", t.fn);
    await drain(port, { ...SYS_USER, params: { reasoningEffort: "medium" } });
    const opts = t.captured();
    // Reasoning lives call-level...
    expect(opts.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 8192 } },
    });
    // ...and the cache breakpoint lives on the leading system message (no collision).
    expect(opts.messages[0]).toEqual({
      role: "system",
      content: "You are keel.",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});

describe("mergeProviderOptions — deep per-provider-key merge (cache ⊕ reasoning, no clobber)", () => {
  it("merges two distinct fragments under the SAME provider key without losing either", () => {
    const reasoning = { openai: { reasoningEffort: "high" } };
    const cache = { openai: { promptCacheKey: "sess-7" } };
    expect(mergeProviderOptions(reasoning, cache)).toEqual({
      openai: { reasoningEffort: "high", promptCacheKey: "sess-7" },
    });
  });

  it("keeps fragments under DIFFERENT provider keys side by side", () => {
    const a = { openai: { reasoningEffort: "high" } };
    const b = { anthropic: { somethingCallLevel: true } };
    expect(mergeProviderOptions(a, b)).toEqual({
      openai: { reasoningEffort: "high" },
      anthropic: { somethingCallLevel: true },
    });
  });

  it("returns undefined when BOTH sides are undefined (no empty {} key under exactOptionalPropertyTypes)", () => {
    expect(mergeProviderOptions(undefined, undefined)).toBeUndefined();
  });

  it("returns the present side verbatim when the other is undefined", () => {
    const only = { openai: { reasoningEffort: "low" } };
    expect(mergeProviderOptions(only, undefined)).toEqual(only);
    expect(mergeProviderOptions(undefined, only)).toEqual(only);
  });

  it("the right side wins on a true leaf collision (cache directive is applied last)", () => {
    // A pathological same-leaf collision: the cache fragment (right) takes precedence. This
    // never happens in practice (reasoning and cache write disjoint leaves), but the rule must
    // be defined, not accidental.
    const left = { openai: { promptCacheKey: "old" } };
    const right = { openai: { promptCacheKey: "new" } };
    expect(mergeProviderOptions(left, right)).toEqual({ openai: { promptCacheKey: "new" } });
  });
});
