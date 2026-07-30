import { describe, expect, it } from "vitest";
import { LIVE_ASSISTANT_PREVIEW_LINES, assistantStreamingProjection } from "./assistant-prose.js";
import {
  appendAssistantStream,
  beginAssistantStream,
  projectAssistantStream,
} from "./stream-projection.js";

describe("reducer-owned assistant stream projection", () => {
  it("keeps coalesced updates bounded after more than 64 provider deltas", () => {
    const prefix = Array.from({ length: 4_000 }, (_, index) => `settled row ${index}\n`).join("");
    let message = beginAssistantStream(prefix);
    let cached = projectAssistantStream(message, 80);
    const retainFromLine = Math.max(0, cached.projection.totalLines - LIVE_ASSISTANT_PREVIEW_LINES);

    for (let index = 0; index < 256; index += 1) {
      message = appendAssistantStream(message, `new-${index}\n`);
    }
    cached = projectAssistantStream(message, 80, cached, retainFromLine);
    const cold = assistantStreamingProjection(message.content, 80);

    expect(cached.projection.lines).toEqual(cold.lines.slice(cached.projection.lineOffset));
    expect(cached.projection.source.length).toBeLessThan(3_000);
  });

  it("falls back safely when an external rewrite drops reducer-owned append provenance", () => {
    const original = beginAssistantStream("original content");
    const cached = projectAssistantStream(original, 80);
    const rewritten = { ...original, content: "rewritten content" };

    expect(projectAssistantStream(rewritten, 80, cached).projection).toEqual(
      assistantStreamingProjection(rewritten.content, 80),
    );
  });
});
