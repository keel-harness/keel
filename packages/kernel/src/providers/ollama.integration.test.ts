/**
 * Env-gated Ollama integration test — SKIPPED by default.
 *
 * This file is skipped in all normal runs (CI, PRs, local without the env var) via
 * `describe.skipIf(!process.env.KEEL_OLLAMA_E2E)`. A fully-skipped describe block
 * contributes zero uncovered lines and does NOT touch the network.
 *
 * To run against a live local Ollama:
 *   1. `ollama serve` (Ollama running on localhost:11434)
 *   2. `ollama pull llama3.2:1b` (or another tiny model)
 *   3. `KEEL_OLLAMA_E2E=1 pnpm --filter @keel/kernel exec vitest run ollama.integration`
 *
 * NOTE: The nightly CI job that runs Ollama-as-a-service (GitHub Actions service container +
 * pulled tiny model) is deferred to the benchmark-CI wiring (design §6.5 / Epic 1.11). This
 * slice scaffolds the test; hermetic PR runs remain mock-only via `factory.test.ts`.
 */

import { describe, expect, it } from "vitest";
import type { ModelStreamChunkT } from "@keel/shared";
import { createOpenAICompatibleModelPort } from "./factory.js";

// ---------------------------------------------------------------------------
// Env gate — the entire suite is skipped unless KEEL_OLLAMA_E2E=1 is set.
// This is the ONLY live-network test; all other factory tests use mock streamText.
// ---------------------------------------------------------------------------
describe.skipIf(!process.env["KEEL_OLLAMA_E2E"])(
  "Ollama integration — live local Ollama (KEEL_OLLAMA_E2E=1 required)",
  () => {
    const OLLAMA_BASE_URL = process.env["KEEL_OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1";
    const OLLAMA_MODEL = process.env["KEEL_OLLAMA_MODEL"] ?? "llama3.2:1b";

    it("streams text-delta chunks and a terminal finish from a real Ollama endpoint", async () => {
      const port = createOpenAICompatibleModelPort({
        model: OLLAMA_MODEL,
        baseURL: OLLAMA_BASE_URL,
        name: "ollama",
      });

      const chunks: ModelStreamChunkT[] = [];
      for await (const chunk of port.stream({
        messages: [{ role: "user", content: "Reply with one word: hello" }],
      })) {
        chunks.push(chunk);
      }

      // Must yield at least one text-delta (a real response).
      const textDeltas = chunks.filter((c) => c.type === "text-delta");
      expect(textDeltas.length).toBeGreaterThan(0);

      // The last chunk must be the terminal (finish or error — we assert finish here).
      const last = chunks[chunks.length - 1];
      expect(last).toBeDefined();
      expect(last!.type).toBe("finish");
    }, 30_000); // Allow up to 30 seconds for a local model cold-start inference.
  },
);
