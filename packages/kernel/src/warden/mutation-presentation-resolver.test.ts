import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTrajectory, type TrajectoryT } from "@keel/eval";
import { type MutationPresentationV1T, type ToolResultT } from "@keel/shared";
import { AuditChainWriter } from "@keel/warden";
import { SessionStore } from "../session/store.js";
import {
  associateMutationPresentationResolver,
  mutationPresentationResolverFor,
} from "./mutation-presentation-resolver.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRODUCER_ONLY = "PRODUCER_ONLY_PREIMAGE_7a20f4";
const CANONICAL_PATH = "/private/tmp/keel-secret-workspace/private.txt";
const SHA = `sha256:${"a".repeat(64)}` as const;

const artifact: MutationPresentationV1T = {
  schemaVersion: "mutation-presentation/v1",
  producer: "warden-typed-mutation",
  operation: "edit",
  auditSeq: 7,
  displayPath: {
    segments: [{ kind: "literal", text: "private.txt" }],
    redactionCount: 0,
  },
  pathIdentity: "path_opaque_fixture",
  observedBefore: {
    status: "file-observed",
    sha256: SHA,
    bytes: 31,
    mode: 0o600,
    contentClass: "text",
    finalNewline: true,
  },
  verifiedInstalledAfter: {
    status: "file-observed",
    sha256: SHA,
    bytes: 8,
    mode: 0o600,
    contentClass: "text",
    finalNewline: true,
  },
  transitionBinding: "not-atomic",
  concurrentMutation: "not-excluded",
  comparison: {
    coverage: "complete",
    totals: { observedBeforeLines: 1, installedAfterLines: 1, shownLines: 2, hiddenLines: 0 },
    hunks: [
      {
        observedBeforeStart: 1,
        observedBeforeLines: 1,
        installedAfterStart: 1,
        installedAfterLines: 1,
        lines: [
          {
            kind: "observed-before",
            observedBeforeLine: 1,
            segments: [{ kind: "literal", text: `${PRODUCER_ONLY}:${CANONICAL_PATH}` }],
            redactionCount: 0,
          },
          {
            kind: "installed-after",
            installedAfterLine: 1,
            segments: [{ kind: "literal", text: "replaced" }],
            redactionCount: 0,
          },
        ],
      },
    ],
    redactionCount: 0,
  },
  freshness: { basis: "warden-observation", currentWorkspace: "not-observed" },
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("module-private mutation-presentation resolver isolation", () => {
  it("keeps the resolver and producer-only artifact bytes out of JSON, session, audit, and eval", async () => {
    const root = mkdtempSync(join(tmpdir(), "keel-presentation-isolation-"));
    roots.push(root);
    const result: ToolResultT = { ok: true, output: "edited private.txt" };
    let resolutions = 0;
    associateMutationPresentationResolver(result, async () => {
      resolutions += 1;
      return { status: "available", artifact };
    });

    expect(resolutions).toBe(0);
    expect(Reflect.ownKeys(result)).toEqual(["ok", "output"]);
    expect(JSON.stringify(result)).not.toContain(PRODUCER_ONLY);
    expect(JSON.stringify(result)).not.toContain(CANONICAL_PATH);
    expect(mutationPresentationResolverFor({ ok: true, output: result.output })).toBeUndefined();
    expect(() =>
      associateMutationPresentationResolver(result, async () => ({
        status: "available",
        artifact,
      })),
    ).toThrow(/already associated/);

    const resolver = mutationPresentationResolverFor(result);
    expect(resolver).toBeDefined();
    const firstPromise = resolver!();
    const secondPromise = resolver!();
    expect(firstPromise).toBe(secondPromise);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first).toBe(second);
    expect(first).toEqual({ status: "available", artifact });
    expect(resolutions).toBe(1);

    const sessionEnv = { KEEL_HOME: join(root, "keel-home") };
    const session = SessionStore.create({ cwd: "/workspace", id: SESSION_ID }, sessionEnv);
    session.append({
      type: "tool_result",
      v: 1,
      ts: "2026-07-22T00:00:00.000Z",
      toolCallId: "tc_1",
      name: "edit",
      output: result.output,
    });
    session.close();
    const sessionBytes = readFileSync(
      join(sessionEnv.KEEL_HOME, "sessions", `${SESSION_ID}.jsonl`),
      "utf8",
    );

    const auditPath = join(root, "audit.jsonl");
    const audit = AuditChainWriter.open({
      path: auditPath,
      principal: {
        osUser: "compat",
        configuredId: null,
        authProvider: "local",
        assurance: "local-os-user",
      },
      now: () => "2026-07-22T00:00:00.000Z",
    });
    audit.append({
      eventType: "session.start",
      sessionId: SESSION_ID,
      payload: { result: result.output },
    });
    audit.close();
    const auditBytes = readFileSync(auditPath, "utf8");

    const trajectory: TrajectoryT = {
      schemaVersion: 1,
      runId: "run_isolation",
      task: "presentation-isolation",
      suite: "epic-310",
      model: "fixture",
      startedAt: "2026-07-22T00:00:00.000Z",
      events: [{ type: "tool-result", id: "tc_1", ok: true, content: result.output }],
      outcome: "resolved",
      totals: { turns: 1, toolCalls: 1, wallClockMs: 0, inputTokens: 0, outputTokens: 0 },
    };
    const trajectoryRoot = join(root, "trajectories");
    mkdirSync(trajectoryRoot);
    const trajectoryPath = await writeTrajectory(trajectoryRoot, trajectory);
    const trajectoryBytes = readFileSync(trajectoryPath, "utf8");

    for (const bytes of [sessionBytes, auditBytes, trajectoryBytes]) {
      expect(bytes).not.toContain(PRODUCER_ONLY);
      expect(bytes).not.toContain(CANONICAL_PATH);
      expect(bytes).not.toContain("mutation-presentation/v1");
      expect(bytes).not.toContain("path_opaque_fixture");
      expect(bytes).not.toContain(SHA);
    }
  });
});
