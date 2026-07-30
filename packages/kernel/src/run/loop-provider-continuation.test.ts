import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorPort, ModelPort, UIPort, UserInput, ViewModel } from "@keel/shared";
import { LoopConfig, RUN_CONTROL_SCHEMA_VERSION } from "@keel/shared";
import {
  createAnthropicModelPort,
  createGoogleModelPort,
  createOpenAICompatibleModelPort,
  createOpenAIModelPort,
} from "../providers/factory.js";
import type { StreamTextFn, StreamTextOptions } from "../providers/vercel-model-port.js";
import { rebuild } from "../session/resume.js";
import { SessionStore, readSession } from "../session/store.js";
import { renderFrame } from "../tui/headless.js";
import { initialView } from "../tui/view-model.js";
import { loopContinuationContent } from "./loop-continuation.js";
import { runBoundedLoopSession } from "./loop-session.js";

const CONTROLLER_PREFIX = "Keel loop controller · exit check failed";

class CapturingUI implements UIPort {
  latest: ViewModel | undefined;

  render(view: ViewModel): void {
    this.latest = view;
  }

  async *inputs(): AsyncIterable<UserInput> {}

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function assertLeadingSystemPrefix(messages: StreamTextOptions["messages"]): void {
  let conversationStarted = false;
  for (const message of messages) {
    if (message.role === "system") {
      if (conversationStarted) {
        throw new Error("provider rejected non-leading system message");
      }
      continue;
    }
    conversationStarted = true;
  }
}

type ProviderFactory = (streamText: StreamTextFn) => ModelPort;

const providers: readonly (readonly [string, ProviderFactory])[] = [
  [
    "anthropic",
    (streamText) =>
      createAnthropicModelPort({
        model: "claude-test",
        apiKey: "test-anthropic-key",
        streamText,
      }),
  ],
  [
    "openai",
    (streamText) =>
      createOpenAIModelPort({ model: "gpt-test", apiKey: "test-openai-key", streamText }),
  ],
  [
    "google",
    (streamText) =>
      createGoogleModelPort({ model: "gemini-test", apiKey: "test-google-key", streamText }),
  ],
  [
    "openai-compatible",
    (streamText) =>
      createOpenAICompatibleModelPort({
        model: "local-test",
        baseURL: "http://127.0.0.1:11434/v1",
        apiKey: "test-local-key",
        streamText,
      }),
  ],
];

const loop = LoopConfig.parse({
  schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
  id: "loop_provider_continuation",
  prompt: "increment the counter until the check passes",
  until: {
    kind: "command",
    check: { argv: ["node", "loop-check.mjs"] },
    satisfiedWhen: "exitZero",
  },
  bounds: { maxIterations: 3 },
  requireProgressEachIteration: true,
});

describe("Epic 3.15 provider-valid bounded-loop continuation", () => {
  it.each(providers)(
    "continues through iteration two via the %s adapter with a replayable leading-system history",
    async (_provider, createPort) => {
      const captured: StreamTextOptions[] = [];
      const streamText: StreamTextFn = (options) => {
        captured.push(options);
        assertLeadingSystemPrefix(options.messages);
        const providerRequest = captured.length;
        return {
          fullStream: (async function* () {
            if (providerRequest === 1) {
              yield {
                type: "tool-call",
                toolCallId: "iteration-one-read",
                toolName: "read",
                input: { path: "loop-counter.txt" },
              };
              yield {
                type: "finish",
                finishReason: "tool-calls",
                totalUsage: { inputTokens: 1, outputTokens: 1 },
              };
              return;
            }
            yield {
              type: "text-delta",
              text:
                providerRequest === 2
                  ? "iteration one tool result synthesized"
                  : "completed iteration two",
            };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        };
      };
      const model = createPort(streamText);
      const testEnv: NodeJS.ProcessEnv = {
        KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-loop-provider-")),
      };
      const store = SessionStore.create({ cwd: "/workspace" }, testEnv);
      const ui = new CapturingUI();
      let checks = 0;
      let toolExecutions = 0;
      const executor: ExecutorPort = {
        execute: (call) => {
          if (call.name === "read") {
            toolExecutions += 1;
            return Promise.resolve({ ok: true, output: "counter=1" });
          }
          if (call.name !== "bash") {
            return Promise.resolve({ ok: false, output: `unexpected tool: ${call.name}` });
          }
          checks += 1;
          return Promise.resolve({
            ok: true,
            output: JSON.stringify({
              exitCode: checks === 1 ? 1 : 0,
              signal: null,
              stdout: checks === 1 ? "counter=1" : "counter=2",
              stderr: "",
            }),
          });
        },
      };

      const outcome = await runBoundedLoopSession({
        model,
        executor,
        ui,
        store,
        seed: [
          { role: "system", content: "stable keel system prompt" },
          { role: "system", content: "stable trusted workspace context" },
          { role: "user", content: "increment the counter from zero to two" },
        ],
        env: testEnv,
        loop,
        tools: [{ name: "read", description: "Read a workspace file." }],
      });

      store.close();
      expect(captured).toHaveLength(3);
      expect(toolExecutions).toBe(1);
      expect(checks).toBe(2);
      for (const request of captured.slice(1)) {
        expect(request.messages.slice(0, 2)).toEqual(captured[0]!.messages.slice(0, 2));
      }
      expect(captured[2]!.messages.map((message) => message.role)).toEqual([
        "system",
        "system",
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
      ]);
      expect(captured[2]!.messages[3]).toEqual({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "iteration-one-read",
            toolName: "read",
            input: { path: "loop-counter.txt" },
          },
        ],
      });
      expect(captured[2]!.messages[4]).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "iteration-one-read",
            toolName: "read",
            output: { type: "text", value: "counter=1" },
          },
        ],
      });
      expect(captured[2]!.messages[5]).toEqual({
        role: "assistant",
        content: "iteration one tool result synthesized",
      });
      expect(
        captured[2]!.messages.filter(
          (message) => message.role === "user" && message.content === loopContinuationContent(2),
        ),
      ).toHaveLength(1);
      expect(
        captured[2]!.messages.some((message, index) => message.role === "system" && index >= 2),
      ).toBe(false);
      expect(outcome.finalMessages).toEqual([
        { role: "system", content: "stable keel system prompt" },
        { role: "system", content: "stable trusted workspace context" },
        { role: "user", content: "increment the counter from zero to two" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "iteration-one-read",
              name: "read",
              args: { path: "loop-counter.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: "counter=1",
          toolCallId: "iteration-one-read",
          name: "read",
        },
        { role: "assistant", content: "iteration one tool result synthesized" },
        { role: "user", content: loopContinuationContent(2) },
        { role: "assistant", content: "completed iteration two" },
      ]);
      expect(renderFrame(outcome.finalView)).toContain("iterations · 2/3");
      expect(renderFrame(outcome.finalView)).toMatch(/loop succeeded/iu);

      const session = readSession(store.id, testEnv);
      expect(
        session.events.some(
          (event) => event.type === "user" && event.content.startsWith(CONTROLLER_PREFIX),
        ),
      ).toBe(false);
      expect(
        session.events.some(
          (event) => event.type === "system" && event.content.startsWith(CONTROLLER_PREFIX),
        ),
      ).toBe(false);
      expect(renderFrame(outcome.finalView)).not.toContain(`you  ${CONTROLLER_PREFIX}`);
      expect(renderFrame(outcome.finalView)).toContain(`note\n  ${CONTROLLER_PREFIX}`);

      const rebuilt = rebuild(session).messages;
      expect(rebuilt).toEqual(outcome.finalMessages);
      const rebuiltWithFollowUp = [
        ...rebuilt,
        { role: "user" as const, content: "summarize the bounded result" },
      ];
      const rebuiltFrame = renderFrame(initialView(rebuilt));
      expect(rebuiltFrame).not.toContain(`you  ${CONTROLLER_PREFIX}`);
      expect(rebuiltFrame).toContain(`note\n  ${CONTROLLER_PREFIX}`);
      let followUpChunks = 0;
      for await (const chunk of model.stream({ messages: rebuiltWithFollowUp })) {
        void chunk;
        followUpChunks += 1;
      }
      expect(followUpChunks).toBe(2);
      expect(captured).toHaveLength(4);
      assertLeadingSystemPrefix(captured[3]!.messages);
      expect(captured[3]!.messages.slice(0, 2)).toEqual(captured[0]!.messages.slice(0, 2));
    },
  );

  it("migrates the exact legacy tail-system record but does not trust lookalike user text", () => {
    const testEnv: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-loop-provider-legacy-")),
    };
    const legacy = SessionStore.create({ cwd: "/workspace" }, testEnv);
    const content = loopContinuationContent(2);
    legacy.append({
      type: "loop_iteration",
      v: 1,
      ts: "2026-07-29T12:00:00.000Z",
      loopId: "loop_legacy_continuation",
      iteration: 1,
      status: "exit-check-failed",
      evidenceRefs: ["tool_result:loop_legacy_continuation_exit_1"],
    });
    legacy.append({
      type: "loop_iteration",
      v: 1,
      ts: "2026-07-29T12:00:01.000Z",
      loopId: "loop_legacy_continuation",
      iteration: 2,
      status: "running",
      evidenceRefs: [],
    });
    legacy.append({
      type: "system",
      v: 1,
      ts: "2026-07-29T12:00:02.000Z",
      content,
    });
    legacy.close();

    const migrated = rebuild(readSession(legacy.id, testEnv)).messages;
    expect(migrated.filter((message) => message.content === content)).toEqual([
      { role: "user", content },
    ]);
    const migratedFrame = renderFrame(initialView(migrated));
    expect(migratedFrame).toContain(`note\n  ${CONTROLLER_PREFIX}`);
    expect(migratedFrame).not.toContain(`you  ${CONTROLLER_PREFIX}`);

    const lookalike = [{ role: "user" as const, content }];
    const lookalikeFrame = renderFrame(initialView(lookalike));
    expect(lookalikeFrame).toContain(`you  ${CONTROLLER_PREFIX}`);
    expect(lookalikeFrame).not.toContain(`note\n  ${CONTROLLER_PREFIX}`);
  });

  it("does not synthesize a continuation from stale failed-check state", () => {
    const testEnv: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-loop-provider-stale-")),
    };
    const malformed = SessionStore.create({ cwd: "/workspace" }, testEnv);
    malformed.append({
      type: "loop_iteration",
      v: 1,
      ts: "2026-07-29T12:00:00.000Z",
      loopId: "loop_stale_continuation",
      iteration: 1,
      status: "exit-check-failed",
      evidenceRefs: ["tool_result:loop_stale_continuation_exit_1"],
    });
    malformed.append({
      type: "loop_iteration",
      v: 1,
      ts: "2026-07-29T12:00:01.000Z",
      loopId: "loop_stale_continuation",
      iteration: 1,
      status: "exit-check-passed",
      evidenceRefs: ["tool_result:loop_stale_continuation_exit_1"],
    });
    malformed.append({
      type: "loop_iteration",
      v: 1,
      ts: "2026-07-29T12:00:02.000Z",
      loopId: "loop_stale_continuation",
      iteration: 2,
      status: "running",
      evidenceRefs: [],
    });
    malformed.close();

    const rebuilt = rebuild(readSession(malformed.id, testEnv)).messages;
    expect(rebuilt.some((message) => message.content.startsWith(CONTROLLER_PREFIX))).toBe(false);
  });
});
