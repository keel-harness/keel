import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MutationPresentationV1T } from "@keel/shared";
import { mutationPresentationResolverFor } from "./mutation-presentation-resolver.js";
import { createProductionWardenRuntime } from "./runtime.js";

const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRODUCER_ONLY = "PRODUCTION_PRESENTATION_ONLY_0dd6a9";
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const SHA = `sha256:${"a".repeat(64)}` as const;

const artifact: MutationPresentationV1T = {
  schemaVersion: "mutation-presentation/v1",
  producer: "warden-typed-mutation",
  operation: "edit",
  auditSeq: 7,
  displayPath: {
    segments: [{ kind: "literal", text: "example.ts" }],
    redactionCount: 0,
  },
  pathIdentity: "path_production_fixture",
  observedBefore: {
    status: "file-observed",
    sha256: SHA,
    bytes: 7,
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
            segments: [{ kind: "literal", text: PRODUCER_ONLY }],
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

function productionFixtureScript(options: {
  readonly advertisePresentation: boolean;
  readonly takeCapturePath: string;
}): string {
  return `
    const { writeFileSync } = require("node:fs");
    const zeroHash = ${JSON.stringify(ZERO_HASH)};
    const artifact = ${JSON.stringify(artifact)};
    const advertisePresentation = ${JSON.stringify(options.advertisePresentation)};
    const takeCapturePath = ${JSON.stringify(options.takeCapturePath)};
    let buffer = "";
    function send(id, result) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line);
        if (request.method === "warden.hello") {
          send(request.id, {
            wardenVersion: "production-presentation-fixture",
            protocolVersion: "1.1.0",
            capabilities: advertisePresentation ? ["mutation-presentation/v1"] : [],
            enforcementTier: "sandbox:fixture",
            policyPack: { name: "fixture", hash: zeroHash }
          });
        } else if (request.method === "warden.status") {
          send(request.id, {
            enforcementTier: "sandbox:fixture",
            sandboxBackend: "fixture",
            policyPack: { name: "fixture", hash: zeroHash },
            auditHead: { seq: 0, hash: zeroHash },
            pendingReviews: 0
          });
        } else if (request.method === "warden.audit.append") {
          send(request.id, { auditSeq: 1 });
        } else if (request.method === "warden.execute") {
          send(request.id, { verdict: "allow", result: "edited example.ts", auditSeq: 7 });
        } else if (request.method === "warden.presentation.take") {
          writeFileSync(takeCapturePath, JSON.stringify(request.params));
          send(request.id, { status: "available", artifact });
        } else if (request.method === "warden.shutdown") {
          send(request.id, { finalCheckpoint: "test-checkpoint" });
          setImmediate(() => process.exit(0));
        }
      }
    });
  `;
}

async function productionRuntime(advertisePresentation: boolean) {
  const root = mkdtempSync(join(tmpdir(), "keel-production-presentation-"));
  roots.push(root);
  const takeCapturePath = join(root, "take.json");
  const runtime = await createProductionWardenRuntime({
    cwd: root,
    sessionId: SESSION_ID,
    workspaceTrusted: true,
    env: { KEEL_HOME: join(root, "home") },
    start: {
      command: process.execPath,
      args: ["-e", productionFixtureScript({ advertisePresentation, takeCapturePath })],
      requestTimeoutMs: 1_000,
    },
  });
  return { runtime, takeCapturePath };
}

describe("production Warden mutation-presentation negotiation", () => {
  it("injects the take closure only after hello advertises the exact capability", async () => {
    const { runtime, takeCapturePath } = await productionRuntime(true);
    try {
      const result = await runtime.executor.execute({
        id: "edit-production-presentation",
        name: "edit",
        args: { path: "example.ts", oldString: "before", newString: "after" },
      });

      expect(result).toEqual({ ok: true, output: "edited example.ts" });
      expect(Reflect.ownKeys(result)).toEqual(["ok", "output"]);
      expect(JSON.stringify(result)).not.toContain(PRODUCER_ONLY);
      const resolver = mutationPresentationResolverFor(result);
      expect(resolver).toBeDefined();
      await expect(resolver!()).resolves.toEqual({ status: "available", artifact });
      expect(JSON.parse(readFileSync(takeCapturePath, "utf8"))).toEqual({
        sessionId: SESSION_ID,
        toolCallId: "edit-production-presentation",
        auditSeq: 7,
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("does not manufacture a resolver or call take when the capability is absent", async () => {
    const { runtime, takeCapturePath } = await productionRuntime(false);
    try {
      const result = await runtime.executor.execute({
        id: "edit-no-presentation-capability",
        name: "edit",
        args: { path: "example.ts", oldString: "before", newString: "after" },
      });

      expect(result).toEqual({ ok: true, output: "edited example.ts" });
      expect(mutationPresentationResolverFor(result)).toBeUndefined();
      expect(existsSync(takeCapturePath)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
});
