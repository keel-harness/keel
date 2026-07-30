import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  ExecutorPort,
  ModelMessageT,
  ModelPort,
  MutationPresentationV1T,
  SimulatorScriptT,
  UIPort,
  UserInput,
  ViewModel,
} from "@keel/shared";
import type { z } from "zod";
import {
  JsonRpcSuccessResponse,
  MutationPresentationTakeResultV1,
  MutationPresentationV1,
  PROTOCOL_VERSION,
  WARDEN_METHODS,
  type MutationPresentationTakeParamsV1T,
} from "@keel/shared";
import {
  AuditChainWriter,
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_PATH_BYTES,
  createMutationPresentationWalkingSkeletonTransport,
  createSandboxTypedMutationRunner,
  redactMutationPresentationLines,
  runStdioWardenServer,
  type PolicyPort,
  type SandboxPort,
} from "@keel/warden";
import { ScriptedModel } from "@keel/simulator";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { sessionPath } from "../session/paths.js";
import { SessionStore } from "../session/store.js";
import { associateMutationPresentationResolver } from "../warden/mutation-presentation-resolver.js";
import { WardenExecutor, type WardenExecuteClient } from "../warden/executor.js";
import { HeadlessUI } from "./headless.js";
import { App } from "./ink/app.js";
import {
  associateMutationPresentationActivity,
  mutationPresentationActivityForEvent,
  resolveMutationPresentationActivity,
} from "./mutation-presentation.js";
import { runSession } from "./runner.js";

const REQUEST_OLD = "REQUEST-OLD-MUST-NOT-RENDER";
const REQUEST_NEW = "REQUEST-NEW-MUST-NOT-RENDER";
const OBSERVED_ONLY = "OBSERVED-BY-WARDEN-ONLY";
const INSTALLED_ONLY = "VERIFIED-BY-WARDEN-ONLY";
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRODUCER_CONTEXT = "PRODUCER-ONLY-WARDEN-CONTEXT";
const WARDEN_BEFORE = `${PRODUCER_CONTEXT}\n${OBSERVED_ONLY}\nomega\n`;
const WARDEN_AFTER = `${PRODUCER_CONTEXT}\n${INSTALLED_ONLY}\nomega\n`;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

type ExecuteParams = z.infer<(typeof WARDEN_METHODS)["warden.execute"]["params"]>;
type ExecuteResult = z.infer<(typeof WARDEN_METHODS)["warden.execute"]["result"]>;
type ResolveReviewParams = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["params"]>;
type ResolveReviewResult = z.infer<(typeof WARDEN_METHODS)["warden.resolveReview"]["result"]>;

class RpcLines {
  readonly #lines: string[] = [];
  readonly #waiters: Array<(line: string) => void> = [];
  #buffer = "";

  constructor(output: PassThrough) {
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        const waiter = this.#waiters.shift();
        if (waiter === undefined) this.#lines.push(line);
        else waiter(line);
      }
    });
  }

  next(): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}

class InProcessWardenClient implements WardenExecuteClient {
  #nextId = 1;

  constructor(
    private readonly input: PassThrough,
    private readonly lines: RpcLines,
  ) {}

  async #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = JsonRpcSuccessResponse.parse(JSON.parse(await this.lines.next()));
    expect(response.id).toBe(id);
    return response.result;
  }

  async hello(): Promise<void> {
    const result = WARDEN_METHODS["warden.hello"].result.parse(
      await this.#request("warden.hello", {
        kernelVersion: "0.0.0",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    expect(result.protocolVersion).toBe("1.1.0");
    expect(result.capabilities).toContain("mutation-presentation/v1");
  }

  async take(params: MutationPresentationTakeParamsV1T) {
    return MutationPresentationTakeResultV1.parse(
      await this.#request("warden.presentation.take", params),
    );
  }

  async call(method: "warden.execute", params: ExecuteParams): Promise<ExecuteResult>;
  async call(
    method: "warden.resolveReview",
    params: ResolveReviewParams,
  ): Promise<ResolveReviewResult>;
  async call(
    method: "warden.execute" | "warden.resolveReview",
    params: ExecuteParams | ResolveReviewParams,
  ): Promise<ExecuteResult | ResolveReviewResult> {
    if (method === "warden.execute") {
      return WARDEN_METHODS["warden.execute"].result.parse(await this.#request(method, params));
    }
    return WARDEN_METHODS["warden.resolveReview"].result.parse(await this.#request(method, params));
  }
}

const ALLOW_POLICY: PolicyPort = {
  packRef: { name: "walking-skeleton-allow", hash: `sha256:${"1".repeat(64)}` },
  evaluate: async () => ({ verdict: "allow", matchedRules: [] }),
};

const literal = (text: string) => ({
  segments: [{ kind: "literal" as const, text }],
  redactionCount: 0,
});

const artifact: MutationPresentationV1T = {
  schemaVersion: "mutation-presentation/v1",
  producer: "warden-typed-mutation",
  operation: "edit",
  auditSeq: 7,
  displayPath: { segments: [{ kind: "literal", text: "src/example.ts" }], redactionCount: 0 },
  pathIdentity: "test-only-opaque-path-identity",
  observedBefore: {
    status: "file-observed",
    sha256: `sha256:${"a".repeat(64)}`,
    bytes: 40,
    mode: 0o644,
    contentClass: "text",
    finalNewline: true,
  },
  verifiedInstalledAfter: {
    status: "file-observed",
    sha256: `sha256:${"b".repeat(64)}`,
    bytes: 41,
    mode: 0o644,
    contentClass: "text",
    finalNewline: true,
  },
  transitionBinding: "not-atomic",
  concurrentMutation: "not-excluded",
  comparison: {
    coverage: "complete",
    totals: {
      observedBeforeLines: 3,
      installedAfterLines: 3,
      shownLines: 4,
      hiddenLines: 0,
    },
    hunks: [
      {
        observedBeforeStart: 1,
        observedBeforeLines: 3,
        installedAfterStart: 1,
        installedAfterLines: 3,
        lines: [
          {
            kind: "context",
            observedBeforeLine: 1,
            installedAfterLine: 1,
            segments: [{ kind: "literal", text: "alpha" }],
            redactionCount: 0,
          },
          {
            kind: "observed-before",
            observedBeforeLine: 2,
            segments: [{ kind: "literal", text: OBSERVED_ONLY }],
            redactionCount: 0,
          },
          {
            kind: "installed-after",
            installedAfterLine: 2,
            segments: [{ kind: "literal", text: INSTALLED_ONLY }],
            redactionCount: 0,
          },
          {
            kind: "context",
            observedBeforeLine: 3,
            installedAfterLine: 3,
            segments: [{ kind: "literal", text: "omega" }],
            redactionCount: 0,
          },
        ],
      },
    ],
    redactionCount: 0,
  },
  freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
};

class CapturingHeadlessUI implements UIPort {
  readonly #headless = new HeadlessUI();
  latest: ViewModel | undefined;

  render(view: ViewModel): void {
    this.latest = view;
    this.#headless.render(view);
  }

  inputs(): AsyncIterable<UserInput> {
    return this.#headless.inputs();
  }

  async close(): Promise<void> {
    await this.#headless.close();
  }

  frame(): string {
    return this.#headless.frame();
  }
}

describe("Epic 3.10 Slice 2B mutation-presentation walking skeleton", () => {
  it("binds presentation state to one exact event occurrence and rejects reassociation", () => {
    const event = { type: "tool-result", id: "exact-event-occurrence" };
    const activity = {
      kind: "tool" as const,
      id: "exact-event-occurrence",
      name: "edit",
      status: "ok" as const,
      summary: "src/example.ts",
      mutationPresentation: { status: "pending" as const },
    };

    associateMutationPresentationActivity(event, activity);

    expect(mutationPresentationActivityForEvent(event)).toBe(activity);
    expect(mutationPresentationActivityForEvent({ ...event })).toBeUndefined();
    expect(() => associateMutationPresentationActivity(event, { ...activity })).toThrow(
      "mutation presentation activity already associated with this event",
    );
  });

  it("control-strips artifact path and comparison lines at the UI projection boundary", () => {
    const poisoned = {
      ...artifact,
      displayPath: literal(`src/example.ts${ESC}[2J\nforged-row`),
      comparison: {
        ...artifact.comparison,
        hunks: [
          {
            ...artifact.comparison.hunks[0]!,
            lines: [
              {
                kind: "context" as const,
                observedBeforeLine: 1,
                installedAfterLine: 1,
                ...literal(`safe${BEL}${ESC}[31m\nforged-diff-row`),
              },
            ],
          },
        ],
      },
    };

    const projected = resolveMutationPresentationActivity(
      {
        kind: "tool",
        id: "edit-poisoned",
        name: "edit",
        status: "ok",
        summary: "requested path",
        mutationPresentation: { status: "pending" },
      },
      { status: "available", artifact: MutationPresentationV1.parse(poisoned) },
    );

    expect(projected.summary).not.toContain(ESC);
    expect(projected.summary).not.toContain(BEL);
    expect(projected.summary).not.toContain("\n");
    expect(projected.diff?.[0]?.text).not.toContain(ESC);
    expect(projected.diff?.[0]?.text).not.toContain(BEL);
    expect(projected.diff?.[0]?.text).not.toContain("\n");
  });

  it("settles one safely redacted edit into Ink while headless stays summary-only", async () => {
    const secret = "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12";
    const control = {
      checkpoint: async () => undefined,
      account: async () => undefined,
    };
    const redactedPath = await redactMutationPresentationLines([`src/${secret}.ts`], {
      control,
      maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_PATH_BYTES,
    });
    const redactedComparison = await redactMutationPresentationLines(
      ["alpha", `${OBSERVED_ONLY} ${secret}`, `${INSTALLED_ONLY} ${ESC}[2J`, "omega"],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );
    const redactedArtifact = MutationPresentationV1.parse({
      ...artifact,
      displayPath: redactedPath.lines[0]!.text,
      comparison: {
        ...artifact.comparison,
        hunks: [
          {
            ...artifact.comparison.hunks[0]!,
            lines: artifact.comparison.hunks[0]!.lines.map((line, index) => ({
              ...line,
              ...redactedComparison.lines[index]!.text,
            })),
          },
        ],
        redactionCount: redactedComparison.redactionCount,
      },
    });
    const keelHome = mkdtempSync(join(tmpdir(), "keel-mutation-presentation-skeleton-"));
    const env: NodeJS.ProcessEnv = { KEEL_HOME: keelHome };
    const seed: ModelMessageT[] = [{ role: "user", content: "make the governed edit" }];
    const script: SimulatorScriptT = {
      turns: [
        {
          toolCalls: [
            {
              name: "edit",
              args: {
                path: "src/example.ts",
                oldString: REQUEST_OLD,
                newString: REQUEST_NEW,
              },
            },
          ],
        },
        { text: "done" },
      ],
    };
    const executor: ExecutorPort = {
      async execute() {
        const result = { ok: true as const, output: "edit: replaced 1 occurrence" };
        associateMutationPresentationResolver(result, async () => ({
          status: "available",
          artifact: redactedArtifact,
        }));
        return result;
      },
    };
    const store = SessionStore.create({ cwd: "/workspace" }, env);
    const ui = new CapturingHeadlessUI();

    const outcome = await runSession({
      model: new ScriptedModel(script),
      executor,
      ui,
      store,
      seed,
      view: { density: "verbose", diffMode: "full" },
    });

    expect(outcome.lastStop).toBe("model-stop");
    expect(ui.latest).toBeDefined();
    const tool = ui.latest?.items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      name: "edit",
      status: "ok",
      mutationPresentation: {
        status: "available",
        displayPath: "src/[redacted].ts",
        transitionBinding: "not-atomic",
        concurrentMutation: "not-excluded",
      },
    });
    expect(tool?.kind === "tool" ? tool.diff : undefined).toEqual([
      {
        kind: "context",
        text: "alpha",
        observedBeforeLine: 1,
        installedAfterLine: 1,
        hunkStart: true,
      },
      { kind: "del", text: `${OBSERVED_ONLY} [redacted]`, observedBeforeLine: 2 },
      { kind: "add", text: `${INSTALLED_ONLY} ␛[2J`, installedAfterLine: 2 },
      { kind: "context", text: "omega", observedBeforeLine: 3, installedAfterLine: 3 },
    ]);

    const headless = ui.frame();
    expect(headless).toContain("src/[redacted].ts");
    expect(headless).toContain("observed before");
    expect(headless).toContain("verified installed after");
    expect(headless).toContain("transition not atomic");
    expect(headless).not.toContain(OBSERVED_ONLY);
    expect(headless).not.toContain(INSTALLED_ONLY);
    expect(headless).not.toContain(REQUEST_OLD);
    expect(headless).not.toContain(REQUEST_NEW);
    expect(headless).not.toContain(secret);
    expect(headless).not.toContain(ESC);

    const ink = render(<App view={ui.latest!} />).lastFrame() ?? "";
    expect(ink).toContain("src/[redacted].ts");
    expect(ink).toContain("observed before");
    expect(ink).toContain("verified installed after");
    expect(ink).toContain("transition not atomic");
    expect(ink).toContain(OBSERVED_ONLY);
    expect(ink).toContain(INSTALLED_ONLY);
    expect(ink).toContain("[redacted]");
    expect(ink).toContain("␛[2J");
    expect(ink).toMatch(/2\s+-\s+OBSERVED-BY-WARDEN-ONLY/u);
    expect(ink).toMatch(/2\s+\+\s+VERIFIED-BY-WARDEN-ONLY/u);
    expect(ink).not.toContain(REQUEST_OLD);
    expect(ink).not.toContain(REQUEST_NEW);
    expect(ink).not.toContain(secret);
    expect(ink).not.toContain(ESC);

    const sessionJsonl = readFileSync(sessionPath(store.id, env), "utf8");
    expect(sessionJsonl).not.toContain(OBSERVED_ONLY);
    expect(sessionJsonl).not.toContain(INSTALLED_ONLY);
    expect(sessionJsonl).not.toContain(secret);
  });

  it("carries one real Warden-observed edit through WardenExecutor into headless and Ink", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-mutation-presentation-e2e-"));
    const workspace = join(root, "workspace");
    const privateRoot = join(root, "private");
    const auditPath = join(root, "audit.jsonl");
    mkdirSync(workspace);
    mkdirSync(privateRoot, { mode: 0o700 });
    writeFileSync(join(workspace, "example.ts"), WARDEN_BEFORE, { mode: 0o644 });

    const sandbox: SandboxPort = {
      status: () => ({
        available: true,
        backend: "srt:walking-skeleton",
        enforcementTier: "sandbox:srt",
      }),
      execute: async (invocation) => {
        const child = spawnSync(invocation.command, invocation.argv?.slice(1) ?? [], {
          cwd: invocation.cwd,
          encoding: "utf8",
        });
        return {
          exitCode: child.status,
          signal: child.signal,
          stdout: child.stdout,
          stderr: child.stderr,
        };
      },
    };
    const typedMutationRunner = createSandboxTypedMutationRunner({
      sandbox,
      declaredTempRoots: [],
      createPayloadRoot: () => ({
        path: privateRoot,
        assertOwned: () => undefined,
        cleanup: () => undefined,
      }),
    });
    if (typedMutationRunner === undefined) {
      throw new Error("expected contained typed-mutation runner");
    }
    const transport = createMutationPresentationWalkingSkeletonTransport({
      // This carrier/isolation fixture predates production polling and keeps construction local to
      // the response-settlement microtask. S5C1 pending/FIFO behavior is proved in Warden tests;
      // COVER/P owns the later 250 ms kernel polling implementation.
      cooperativeYield: async () => undefined,
      construct(candidate): MutationPresentationV1T {
        expect(candidate.observedBefore.content).toBe(WARDEN_BEFORE);
        expect(candidate.verifiedInstalledAfter.content).toBe(WARDEN_AFTER);
        return MutationPresentationV1.parse({
          schemaVersion: "mutation-presentation/v1",
          producer: "warden-typed-mutation",
          operation: "edit",
          auditSeq: candidate.auditSeq,
          displayPath: literal(candidate.displayPath),
          pathIdentity: "walking-skeleton-opaque-path",
          observedBefore: {
            status: "file-observed",
            sha256: candidate.observedBefore.sha256,
            bytes: candidate.observedBefore.bytes,
            mode: candidate.observedBefore.mode,
            contentClass: "text",
            finalNewline: true,
          },
          verifiedInstalledAfter: {
            status: "file-observed",
            sha256: candidate.verifiedInstalledAfter.sha256,
            bytes: candidate.verifiedInstalledAfter.bytes,
            mode: candidate.verifiedInstalledAfter.mode,
            contentClass: "text",
            finalNewline: true,
          },
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
          comparison: {
            coverage: "complete",
            totals: {
              observedBeforeLines: 3,
              installedAfterLines: 3,
              shownLines: 4,
              hiddenLines: 0,
            },
            hunks: [
              {
                observedBeforeStart: 1,
                observedBeforeLines: 3,
                installedAfterStart: 1,
                installedAfterLines: 3,
                lines: [
                  {
                    kind: "context",
                    observedBeforeLine: 1,
                    installedAfterLine: 1,
                    ...literal(PRODUCER_CONTEXT),
                  },
                  {
                    kind: "observed-before",
                    observedBeforeLine: 2,
                    ...literal(OBSERVED_ONLY),
                  },
                  {
                    kind: "installed-after",
                    installedAfterLine: 2,
                    ...literal(INSTALLED_ONLY),
                  },
                  {
                    kind: "context",
                    observedBeforeLine: 3,
                    installedAfterLine: 3,
                    ...literal("omega"),
                  },
                ],
              },
            ],
            redactionCount: 0,
          },
          freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
        });
      },
    });
    const audit = AuditChainWriter.open({
      path: auditPath,
      principal: {
        osUser: "walking-skeleton",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new InProcessWardenClient(input, new RpcLines(output));
    const server = runStdioWardenServer({
      input,
      output,
      sandbox,
      workspaceRoot: workspace,
      workspaceTrusted: true,
      policy: ALLOW_POLICY,
      auditWriter: audit,
      typedMutationRunner,
      mutationPresentation: transport,
    });

    try {
      await client.hello();
      await client.call("warden.execute", {
        sessionId: SESSION_ID,
        toolCall: { id: "read-1", name: "read", args: { path: "example.ts" } },
        provenanceContext: { inputTags: ["workspace"] },
      });
      const auditBeforePresentation = readFileSync(auditPath, "utf8").trim().split("\n");
      // The public preparatory read legitimately audits its result bytes. The isolation boundary is
      // the records appended after that read, when presentation-only capture begins.
      expect(auditBeforePresentation.join("\n")).toContain(PRODUCER_CONTEXT);
      const auditPresentationStart = auditBeforePresentation.length;
      const executor = new WardenExecutor({
        client,
        sessionId: SESSION_ID,
        takeMutationPresentation: (params) => client.take(params),
      });
      const keelHome = join(root, "keel-home");
      const env: NodeJS.ProcessEnv = { KEEL_HOME: keelHome };
      const store = SessionStore.create({ cwd: workspace }, env);
      const ui = new CapturingHeadlessUI();
      const script: SimulatorScriptT = {
        turns: [
          {
            toolCalls: [
              {
                name: "edit",
                args: {
                  path: "example.ts",
                  oldString: OBSERVED_ONLY,
                  newString: INSTALLED_ONLY,
                },
              },
            ],
          },
          { text: "done" },
        ],
      };
      const scriptedModel = new ScriptedModel(script);
      const modelInputs: string[] = [];
      const model: ModelPort = {
        async *stream(turn) {
          modelInputs.push(JSON.stringify(turn.messages));
          for await (const chunk of scriptedModel.stream(turn)) yield chunk;
        },
      };

      const outcome = await runSession({
        model,
        executor,
        ui,
        store,
        seed: [{ role: "user", content: "make the governed edit" }],
        view: { density: "verbose", diffMode: "full" },
        env,
      });

      expect(outcome.lastStop).toBe("model-stop");
      expect(readFileSync(join(workspace, "example.ts"), "utf8")).toBe(WARDEN_AFTER);
      const tool = ui.latest?.items.find((item) => item.kind === "tool");
      expect(tool).toMatchObject({
        kind: "tool",
        name: "edit",
        status: "ok",
        mutationPresentation: {
          status: "available",
          transitionBinding: "not-atomic",
          concurrentMutation: "not-excluded",
        },
      });
      const headless = ui.frame();
      expect(headless).toContain("observed before");
      expect(headless).toContain("verified installed after");
      expect(headless).not.toContain(PRODUCER_CONTEXT);
      expect(headless).not.toContain(OBSERVED_ONLY);
      expect(headless).not.toContain(INSTALLED_ONLY);
      const ink = render(<App view={ui.latest!} />).lastFrame() ?? "";
      expect(ink).toContain(PRODUCER_CONTEXT);
      expect(ink).toContain(OBSERVED_ONLY);
      expect(ink).toContain(INSTALLED_ONLY);

      expect(readFileSync(sessionPath(store.id, env), "utf8")).not.toContain(PRODUCER_CONTEXT);
      expect(modelInputs.join("\n")).not.toContain(PRODUCER_CONTEXT);
      const presentationWindowAudit = readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .slice(auditPresentationStart)
        .join("\n");
      expect(presentationWindowAudit).not.toContain(PRODUCER_CONTEXT);
    } finally {
      await server.close();
      audit.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
