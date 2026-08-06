import { describe, expect, it } from "vitest";
import type { ModelMessageT } from "@keel/shared";
import { selectCompressor } from "./router.js";

const tool = (name: string, content = "x"): ModelMessageT => ({
  role: "tool",
  name,
  toolCallId: "1",
  content,
});

describe("selectCompressor (name-based routing + bounded bash sniff)", () => {
  it("routes search → search", () => {
    expect(selectCompressor(tool("search")).kind).toBe("search");
  });

  it("routes read → generic", () => {
    expect(selectCompressor(tool("read")).kind).toBe("generic");
  });

  it("routes log-ish bash output → log (>=10 lines with an error/warn keyword)", () => {
    const logish = Array.from({ length: 20 }, (_, i) => `INFO step ${i}`)
      .concat("ERROR boom")
      .join("\n");
    expect(selectCompressor(tool("bash", logish)).kind).toBe("log");
  });

  it("routes short/plain bash output → generic (sniff fails)", () => {
    expect(selectCompressor(tool("bash", "ok done")).kind).toBe("generic");
  });

  it("routes long bash output with NO error keyword → log (successful build/package noise)", () => {
    const plainLong = Array.from({ length: 30 }, (_, i) => `building module ${i}`).join("\n");
    expect(selectCompressor(tool("bash", plainLong)).kind).toBe("log");
  });

  it("routes process.run through its structure-preserving generic compressor", () => {
    const selected = selectCompressor(tool("process.run", "plain"));
    expect(selected.kind).toBe("generic");
    expect(selected).not.toBe(selectCompressor(tool("read", "plain")));
  });

  it("routes unknown/other tools → generic", () => {
    expect(selectCompressor(tool("mystery")).kind).toBe("generic");
  });
});
