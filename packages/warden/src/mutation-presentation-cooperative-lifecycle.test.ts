import { PassThrough } from "node:stream";
import { MutationPresentationV1, type MutationPresentationV1T } from "@keel/shared";
import { describe, expect, it } from "vitest";
import {
  MUTATION_PRESENTATION_PENDING_RETRY_MS,
  MUTATION_PRESENTATION_PENDING_TTL_MS,
  createMutationPresentationWalkingSkeletonTransport,
  type MutationPresentationConstructionControl,
  type WardenMutationPresentationCandidate,
} from "./mutation-presentation-walking-skeleton.js";
import { runStdioWardenServer } from "./rpc-server.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

type CooperativeTransport = ReturnType<typeof createMutationPresentationWalkingSkeletonTransport>;

class ManualScheduler {
  readonly #waiters: Array<() => void> = [];

  readonly yieldControl = (): Promise<void> =>
    new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });

  get pending(): number {
    return this.#waiters.length;
  }

  async releaseOne(): Promise<void> {
    const resume = this.#waiters.shift();
    if (resume === undefined) throw new Error("expected a scheduled cooperative yield");
    resume();
    await settleMicrotasks();
  }
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function candidate(options: {
  readonly toolCallId: string;
  readonly auditSeq: number;
  readonly marker?: string;
}): WardenMutationPresentationCandidate {
  const before = `${options.marker ?? "before"}-before\n`;
  const after = `${options.marker ?? "after"}-after\n`;
  return {
    operation: "edit",
    displayPath: `${options.marker ?? options.toolCallId}.txt`,
    observedBefore: {
      content: before,
      sha256: `sha256:${"a".repeat(64)}`,
      bytes: Buffer.byteLength(before),
      mode: 0o600,
    },
    verifiedInstalledAfter: {
      content: after,
      sha256: `sha256:${"b".repeat(64)}`,
      bytes: Buffer.byteLength(after),
      mode: 0o600,
    },
    sessionId: SESSION_ID,
    toolCallId: options.toolCallId,
    auditSeq: options.auditSeq,
  };
}

function summaryArtifact(input: WardenMutationPresentationCandidate): MutationPresentationV1T {
  const text = (value: string) => ({
    segments: [{ kind: "literal" as const, text: value }],
    redactionCount: 0,
  });
  return MutationPresentationV1.parse({
    schemaVersion: "mutation-presentation/v1",
    producer: "warden-typed-mutation",
    operation: input.operation,
    auditSeq: input.auditSeq,
    displayPath: text(input.displayPath),
    pathIdentity: `opaque-${input.auditSeq}`,
    observedBefore: {
      status: "file-observed",
      sha256: input.observedBefore.sha256,
      bytes: input.observedBefore.bytes,
      mode: input.observedBefore.mode,
      contentClass: "text",
      finalNewline: true,
    },
    verifiedInstalledAfter: {
      status: "file-observed",
      sha256: input.verifiedInstalledAfter.sha256,
      bytes: input.verifiedInstalledAfter.bytes,
      mode: input.verifiedInstalledAfter.mode,
      contentClass: "text",
      finalNewline: true,
    },
    transitionBinding: "not-atomic",
    concurrentMutation: "not-excluded",
    comparison: {
      coverage: "summary-only",
      totals: {
        observedBeforeLines: "unknown",
        installedAfterLines: "unknown",
        shownLines: 0,
        hiddenLines: "unknown",
      },
      hunks: [],
      redactionCount: 0,
    },
    freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
  });
}

function reserveAndFinalize(
  transport: CooperativeTransport,
  input: WardenMutationPresentationCandidate,
): void {
  const admission = transport.reserve(
    { sessionId: input.sessionId, toolCallId: input.toolCallId },
    {
      observedBeforeBytes: Buffer.byteLength(input.observedBefore.content),
      verifiedInstalledAfterBytes: Buffer.byteLength(input.verifiedInstalledAfter.content),
    },
  );
  if (admission.status !== "reserved") throw new Error("expected presentation reservation");
  transport.finalize({ kind: "candidate", reservation: admission.reservation, candidate: input });
}

function takeParams(input: WardenMutationPresentationCandidate) {
  return {
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    auditSeq: input.auditSeq,
  };
}

function literalDisplayPath(artifact: MutationPresentationV1T): string | undefined {
  const segment = artifact.displayPath.segments[0];
  return segment?.kind === "literal" ? segment.text : undefined;
}

describe("Epic 3.10 Slice 2B-S5C1 cooperative presentation lifecycle", () => {
  it("schedules exactly one constructor, returns immediate non-consuming pending, and advances FIFO", async () => {
    const scheduler = new ManualScheduler();
    const starts: string[] = [];
    const finishes: string[] = [];
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        starts.push(input.toolCallId);
        await control.checkpoint();
        finishes.push(input.toolCallId);
        return summaryArtifact(input);
      },
    });
    const first = candidate({ toolCallId: "edit-cooperative-first", auditSeq: 101 });
    const second = candidate({ toolCallId: "edit-cooperative-second", auditSeq: 102 });

    reserveAndFinalize(transport, first);
    reserveAndFinalize(transport, second);

    expect(MUTATION_PRESENTATION_PENDING_RETRY_MS).toBe(25);
    expect(starts).toEqual([]);
    expect(scheduler.pending).toBe(1);
    expect(transport.take(takeParams(first))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });
    expect(transport.take(takeParams(first))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });
    expect(transport.take({ ...takeParams(first), toolCallId: "wrong-key" })).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });

    await scheduler.releaseOne();
    expect(starts).toEqual([first.toolCallId]);
    expect(finishes).toEqual([]);
    expect(scheduler.pending).toBe(1);
    expect(transport.take(takeParams(second))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });

    await scheduler.releaseOne();
    expect(finishes).toEqual([first.toolCallId]);
    expect(starts).toEqual([first.toolCallId]);
    expect(scheduler.pending).toBe(1);
    expect(transport.take(takeParams(first))).toMatchObject({ status: "available" });
    expect(transport.take(takeParams(second))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });

    await scheduler.releaseOne();
    expect(starts).toEqual([first.toolCallId, second.toolCallId]);
    expect(scheduler.pending).toBe(1);
    await scheduler.releaseOne();
    expect(finishes).toEqual([first.toolCallId, second.toolCallId]);
    expect(transport.take(takeParams(second))).toMatchObject({ status: "available" });
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });

    await transport.clear();
  });

  it("expires a queued generation at the exact monotonic TTL and never runs it", async () => {
    let now = 0;
    let constructions = 0;
    const scheduler = new ManualScheduler();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      cooperativeYield: scheduler.yieldControl,
      async construct(input) {
        constructions += 1;
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "edit-queued-expiry", auditSeq: 201 });

    reserveAndFinalize(transport, input);
    expect(transport.take(takeParams(input))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });

    now = MUTATION_PRESENTATION_PENDING_TTL_MS;
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "capture-budget",
    });
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });

    await scheduler.releaseOne();
    expect(constructions).toBe(0);
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    await transport.clear();
  });

  it("keeps queued and active producer bytes out of transport reflection and JSON", async () => {
    const scheduler = new ManualScheduler();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });
    const input = candidate({
      toolCallId: "PRIVATE-PENDING-TOOL-CALL",
      auditSeq: 250,
      marker: "PRIVATE-PRODUCER-BYTES",
    });

    reserveAndFinalize(transport, input);
    expect(JSON.stringify(transport)).toBe('{"advertiseTestCapability":true}');
    expect(JSON.stringify(transport)).not.toContain("PRIVATE");

    await scheduler.releaseOne();
    expect(JSON.stringify(transport)).toBe('{"advertiseTestCapability":true}');
    expect(JSON.stringify(transport)).not.toContain("PRIVATE");

    const clearing = transport.clear();
    await scheduler.releaseOne();
    await clearing;
  });

  it("keeps an expired active generation accounted and pending until its next cooperative yield", async () => {
    let now = 0;
    const scheduler = new ManualScheduler();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      now: () => now,
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "edit-active-expiry", auditSeq: 301 });
    const rawBytes = input.observedBefore.bytes + input.verifiedInstalledAfter.bytes;

    reserveAndFinalize(transport, input);
    await scheduler.releaseOne();
    expect(scheduler.pending).toBe(1);

    now = MUTATION_PRESENTATION_PENDING_TTL_MS;
    expect(transport.take(takeParams(input))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });
    expect(transport.pendingUsage()).toEqual({ candidates: 1, bytes: rawBytes });

    await scheduler.releaseOne();
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "capture-budget",
    });
    await transport.clear();
  });

  it("invalidates a superseded active generation without releasing its bytes early or resurrecting it", async () => {
    const scheduler = new ManualScheduler();
    const starts: string[] = [];
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control: MutationPresentationConstructionControl) {
        starts.push(input.displayPath);
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });
    const oldGeneration = candidate({
      toolCallId: "edit-generation",
      auditSeq: 401,
      marker: "old",
    });
    const newGeneration = candidate({
      toolCallId: "edit-generation",
      auditSeq: 401,
      marker: "new",
    });

    reserveAndFinalize(transport, oldGeneration);
    await scheduler.releaseOne();
    reserveAndFinalize(transport, newGeneration);

    expect(starts).toEqual(["old.txt"]);
    expect(transport.pendingUsage().candidates).toBe(2);
    expect(transport.take(takeParams(newGeneration))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });

    await scheduler.releaseOne();
    expect(transport.pendingUsage().candidates).toBe(1);
    expect(scheduler.pending).toBe(1);
    expect(transport.take(takeParams(newGeneration))).toEqual({
      status: "pending",
      retryAfterMs: MUTATION_PRESENTATION_PENDING_RETRY_MS,
    });

    await scheduler.releaseOne();
    expect(starts).toEqual(["old.txt", "new.txt"]);
    await scheduler.releaseOne();
    const result = transport.take(takeParams(newGeneration));
    expect(result.status).toBe("available");
    if (result.status === "available") expect(literalDisplayPath(result.artifact)).toBe("new.txt");
    expect(transport.take(takeParams(oldGeneration))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    await transport.clear();
  });

  it("drops a superseded queued generation before construction and retains only the replacement", async () => {
    const scheduler = new ManualScheduler();
    const starts: string[] = [];
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input) {
        starts.push(input.displayPath);
        return summaryArtifact(input);
      },
    });
    const oldGeneration = candidate({
      toolCallId: "edit-queued-generation",
      auditSeq: 450,
      marker: "old",
    });
    const newGeneration = candidate({
      toolCallId: "edit-queued-generation",
      auditSeq: 450,
      marker: "new",
    });

    reserveAndFinalize(transport, oldGeneration);
    reserveAndFinalize(transport, newGeneration);
    expect(transport.pendingUsage().candidates).toBe(1);
    expect(starts).toEqual([]);

    await scheduler.releaseOne();
    expect(starts).toEqual([]);
    expect(scheduler.pending).toBe(1);
    await scheduler.releaseOne();
    expect(starts).toEqual(["new.txt"]);
    const result = transport.take(takeParams(newGeneration));
    expect(result.status).toBe("available");
    if (result.status === "available") expect(literalDisplayPath(result.artifact)).toBe("new.txt");
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    await transport.clear();
  });

  it("lets a newer sanitized disposition supersede an active generation without early byte release", async () => {
    const scheduler = new ManualScheduler();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "edit-disposition-supersedes-active", auditSeq: 475 });
    const rawBytes = input.observedBefore.bytes + input.verifiedInstalledAfter.bytes;
    reserveAndFinalize(transport, input);
    await scheduler.releaseOne();

    transport.finalize({
      kind: "unavailable",
      params: takeParams(input),
      reason: "capture-unavailable",
    });
    expect(transport.pendingUsage()).toEqual({ candidates: 1, bytes: rawBytes });
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "capture-unavailable",
    });

    await scheduler.releaseOne();
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });
    await transport.clear();
  });

  it("settles constructor and scheduler failures only as sanitized unavailable dispositions", async () => {
    const constructorScheduler = new ManualScheduler();
    const constructorFailure = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: constructorScheduler.yieldControl,
      async construct() {
        throw new Error("SECRET-CONSTRUCTOR-FAILURE");
      },
    });
    const failed = candidate({ toolCallId: "edit-constructor-failure", auditSeq: 501 });
    reserveAndFinalize(constructorFailure, failed);
    expect(constructorFailure.take(takeParams(failed))).toMatchObject({ status: "pending" });
    await constructorScheduler.releaseOne();
    const constructorResult = constructorFailure.take(takeParams(failed));
    expect(constructorResult).toEqual({
      status: "unavailable",
      reason: "redaction-failed",
    });
    expect(JSON.stringify(constructorResult)).not.toContain("SECRET-CONSTRUCTOR-FAILURE");

    const schedulerFailure = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: async () => {
        throw new Error("SECRET-SCHEDULER-FAILURE");
      },
      async construct(input) {
        return summaryArtifact(input);
      },
    });
    const notStarted = candidate({ toolCallId: "edit-scheduler-failure", auditSeq: 502 });
    reserveAndFinalize(schedulerFailure, notStarted);
    await settleMicrotasks();
    const schedulerResult = schedulerFailure.take(takeParams(notStarted));
    expect(schedulerResult).toEqual({
      status: "unavailable",
      reason: "redaction-failed",
    });
    expect(JSON.stringify(schedulerResult)).not.toContain("SECRET-SCHEDULER-FAILURE");

    await constructorFailure.clear();
    await schedulerFailure.clear();
  });

  it("makes server close await active-constructor cancellation and exact accounting release", async () => {
    const scheduler = new ManualScheduler();
    const transport = createMutationPresentationWalkingSkeletonTransport({
      cooperativeYield: scheduler.yieldControl,
      async construct(input, control) {
        await control.checkpoint();
        return summaryArtifact(input);
      },
    });
    const input = candidate({ toolCallId: "edit-shutdown-drain", auditSeq: 601 });
    reserveAndFinalize(transport, input);
    await scheduler.releaseOne();

    const server = runStdioWardenServer({
      input: new PassThrough(),
      output: new PassThrough(),
      mutationPresentation: transport,
    });
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await settleMicrotasks();

    expect(closed).toBe(false);
    expect(transport.pendingUsage().candidates).toBe(1);
    expect(transport.take(takeParams(input))).toEqual({
      status: "unavailable",
      reason: "not-found-or-consumed",
    });

    await scheduler.releaseOne();
    await closing;
    expect(closed).toBe(true);
    expect(transport.pendingUsage()).toEqual({ candidates: 0, bytes: 0 });
    expect(transport.terminalUsage()).toEqual({
      artifacts: 0,
      artifactBytes: 0,
      dispositions: 0,
      dispositionBytes: 0,
    });
    await transport.clear();
  });

  it("keeps repeated server close non-throwing when an injected presentation cleanup rejects", async () => {
    let clearCalls = 0;
    const base = createMutationPresentationWalkingSkeletonTransport({
      async construct(input) {
        return summaryArtifact(input);
      },
    });
    const transport: CooperativeTransport = {
      ...base,
      async clear() {
        clearCalls += 1;
        throw new Error("SECRET-PRESENTATION-CLEANUP-FAILURE");
      },
    };
    const server = runStdioWardenServer({
      input: new PassThrough(),
      output: new PassThrough(),
      mutationPresentation: transport,
    });

    await expect(server.close()).resolves.toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    expect(clearCalls).toBe(1);

    await base.clear();
  });
});
