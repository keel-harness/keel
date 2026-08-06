import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ModelMessageT,
  ModelPort,
  ModelStreamChunkT,
  ModelTurnInput,
  ToolSpecT,
} from "@keel/shared";
import { HeadlessUI } from "../tui/headless.js";
import { runKeelCommand } from "./session-entry.js";
import { readSession } from "../session/store.js";
import { rebuild } from "../session/resume.js";
import type { ProductionWardenStartOptions } from "../warden/runtime.js";

const ROOT = process.cwd();
// Generous real-warden handshake budget: tsx cold-start under full-suite fork-pool load can exceed a
// 5s budget (a host-load flake, not a logic failure); 15s stays under vitest's 20s testTimeout.
const REAL_WARDEN_HANDSHAKE_TIMEOUT_MS = 15_000;
const requireFromWarden = createRequire(join(ROOT, "packages/warden/src/bin.ts"));
const TSX_ESM_LOADER = pathToFileURL(requireFromWarden.resolve("tsx/esm")).href;
const WARDEN_RPC_SERVER_URL = pathToFileURL(join(ROOT, "packages/warden/src/rpc-server.ts")).href;
const WARDEN_SESSION_LOG_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/audit/session-log.ts"),
).href;

/** Recover the (single) session id the run wrote under <home>/sessions (runKeelCommand owns the store). */
const latestSessionId = (home: string): string => {
  const f = readdirSync(join(home, "sessions")).find((n) => n.endsWith(".jsonl"));
  if (f === undefined) throw new Error("no session file written");
  return f.replace(/\.jsonl$/, "");
};

// A separate KEEL_HOME (never the workspace cwd, or the config-dir guard would deny the workspace).
const dirs = (): { cwd: string; home: string } => ({
  cwd: mkdtempSync(join(tmpdir(), "keel-cwd-")),
  home: mkdtempSync(join(tmpdir(), "keel-home-")),
});

function fakeBashWarden(auditDir: string): ProductionWardenStartOptions {
  return {
    command: process.execPath,
    args: [
      "--import",
      TSX_ESM_LOADER,
      "--conditions=@keel/source",
      "--input-type=module",
      "-e",
      `
        import { readFileSync } from "node:fs";
        import { join } from "node:path";
        import { runStdioWardenServer } from ${JSON.stringify(WARDEN_RPC_SERVER_URL)};
        import { SessionAuditLog } from ${JSON.stringify(WARDEN_SESSION_LOG_URL)};

        const auditLog = new SessionAuditLog({
          auditDir: process.env.KEEL_WARDEN_AUDIT_DIR,
          principal: {
            osUser: "compaction-wiring-test",
            configuredId: null,
            authProvider: "local",
            assurance: "local-os-user"
          }
        });

        runStdioWardenServer({
          auditWriter: auditLog,
          auditDir: process.env.KEEL_WARDEN_AUDIT_DIR,
          workspaceRoot: process.env.KEEL_WARDEN_WORKSPACE_ROOT,
          workspaceTrusted: process.env.KEEL_WARDEN_WORKSPACE_TRUSTED === "1",
          sandbox: {
            status: () => ({
              available: true,
              backend: "fake-compaction-sandbox",
              enforcementTier: "sandbox:fake"
            }),
            execute: async (invocation) => {
              const match = /^cat ([ab]\\.txt)$/u.exec(invocation.command);
              const stdout = match === null
                ? ""
                : readFileSync(join(process.env.KEEL_WARDEN_WORKSPACE_ROOT, match[1]), "utf8");
              return { exitCode: 0, signal: null, stdout, stderr: "" };
            }
          },
          onShutdown: () => {
            auditLog.close();
            setImmediate(() => process.exit(0));
          }
        });
      `,
    ],
    env: { FORCE_COLOR: "0", KEEL_WARDEN_AUDIT_DIR: auditDir },
    requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
  };
}

// ~800 identical lines (~18 KB ≈ 4600 tok) — big enough that two reads cross the window threshold
// while one does not, and highly compressible (consecutive-duplicate collapse) so the pass shrinks it.
const BIG = (tag: string): string =>
  Array.from({ length: 800 }, () => `${tag} duplicate log line`).join("\n");

// A single ~4000-char line (< the 4096-byte generic budget) — the deterministic PASS cannot shrink it
// (never-enlarge guard skips it), so the model FOLD is what acts: it drops the aged body into the
// derived facts summary. This drives the production fold path (deterministicFactsSummary) end-to-end.
const INCOMPRESSIBLE = (tag: string): string => tag + "x".repeat(4000);
const GOVERNED_TOOLS = ["bash", "process.run", "read", "search", "write", "edit"];

/** A 3-turn model: bash-cat a.txt, bash-cat b.txt, then stop. Captures each turn's advertised tools + messages
 *  so a test can assert what reached the model (post-compaction) on the re-drive. */
class BashCatModel implements ModelPort {
  readonly turns: ModelMessageT[][] = [];
  readonly tools: (readonly ToolSpecT[] | undefined)[] = [];
  #t = 0;
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.turns.push(input.messages.map((m) => ({ ...m })));
    this.tools.push(input.tools);
    this.#t += 1;
    if (this.#t === 1) {
      yield { type: "tool-call", id: "cat-a", name: "bash", args: { command: "cat a.txt" } };
      yield { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2 } };
    } else if (this.#t === 2) {
      yield { type: "tool-call", id: "cat-b", name: "bash", args: { command: "cat b.txt" } };
      yield { type: "finish", reason: "tool-calls", usage: { inputTokens: 10, outputTokens: 2 } };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop", usage: { inputTokens: 5, outputTokens: 1 } };
    }
  }
}

const baseEnv = (home: string): NodeJS.ProcessEnv => ({
  KEEL_HOME: home,
  KEEL_TRUST: "1",
  KEEL_NO_SNAPSHOT: "1",
  KEEL_PROVIDER: "openai", // cacheReadWeight 1.0 → the cache guard always accepts a shrinking pass
  KEEL_CONTEXT_WINDOW: "11000", // one big read stays under soft; two cross hard → fires at turn 3
  KEEL_COMPACTION_RECENT: "1", // recentVerbatimTurns=1 → the first read body ages → gets compressed
});

describe("Epic 1.6c PR-d slice 5 — production flip wiring proof (runKeelCommand, KEEL_COMPACTION)", () => {
  it("flip ON: a large governed-bash output run fires compaction without advertising local retrieve", async () => {
    const { cwd, home } = dirs();
    writeFileSync(join(cwd, "a.txt"), INCOMPRESSIBLE("AAA"));
    writeFileSync(join(cwd, "b.txt"), INCOMPRESSIBLE("BBB"));
    const model = new BashCatModel();
    await runKeelCommand("read the files", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: { ...baseEnv(home), KEEL_COMPACTION: "1", KEEL_CONTEXT_WINDOW: "6100" },
      warden: fakeBashWarden(mkdtempSync(join(tmpdir(), "keel-compaction-audit-"))),
    });

    const file = readSession(latestSessionId(home), { KEEL_HOME: home });

    // (1) it FIRED: the production in-loop compactor emitted a fold event.
    const folds = file.events.filter((e) => e.type === "compaction");
    expect(folds.length).toBeGreaterThanOrEqual(1);

    // (2) the ledger still holds the FULL original output (SEC-023 — compress the view, not the record)
    expect(file.events.some((e) => e.type === "tool_result" && e.output.includes("AAA"))).toBe(
      true,
    );

    // (3) governed mode advertises only warden-hosted product tools; retrieve is still withheld.
    expect((model.tools[0] ?? []).map((t) => t.name)).toEqual(GOVERNED_TOOLS);

    // (4) the model drove the re-driven turn from the typed summary, NOT the raw aged body.
    const lastTurn = model.turns.at(-1)!;
    expect(lastTurn.some((m) => m.content.includes("# Compacted Session State"))).toBe(true);
    expect(lastTurn.some((m) => m.content.includes("AAA" + "x".repeat(2000)))).toBe(false);
  });

  it("flip OFF (default): identical governed-bash run emits NO compression events, does NOT advertise `retrieve`, and never compresses the body", async () => {
    const { cwd, home } = dirs();
    writeFileSync(join(cwd, "a.txt"), BIG("AAA"));
    writeFileSync(join(cwd, "b.txt"), BIG("BBB"));
    const model = new BashCatModel();
    await runKeelCommand("read the files", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: baseEnv(home), // KEEL_COMPACTION unset → flip OFF
      warden: fakeBashWarden(mkdtempSync(join(tmpdir(), "keel-compaction-audit-"))),
    });

    const file = readSession(latestSessionId(home), { KEEL_HOME: home });
    expect(
      file.events.some((e) => e.type === "context_compression" || e.type === "compaction"),
    ).toBe(false);
    expect((model.tools[0] ?? []).map((t) => t.name)).toEqual(GOVERNED_TOOLS);
    // the model saw the FULL body on every turn — nothing was compressed
    const sawFull = model.turns.some((t) =>
      t.some((m) => m.role === "tool" && m.content.includes("AAA duplicate")),
    );
    expect(sawFull).toBe(true);
  });
});

describe("Epic 1.6c PR-d slice 5 — model-fold e2e + resume round-trip after compaction (test plan A/B/D)", () => {
  // Shared run: two reads of incompressible bodies + stop, small window, recentVerbatimTurns=1 → the
  // first read may cause soft pressure but stays below hard-fold pressure; the second read fires the
  // fold on turn 3 (the pass can't shrink the aged body; the fold drops it into the summary).
  const runFoldScenario = async (): Promise<{ home: string; turns: ModelMessageT[][] }> => {
    const { cwd, home } = dirs();
    writeFileSync(join(cwd, "a.txt"), INCOMPRESSIBLE("AAA"));
    writeFileSync(join(cwd, "b.txt"), INCOMPRESSIBLE("BBB"));
    const model = new BashCatModel();
    await runKeelCommand("read the files", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: {
        KEEL_HOME: home,
        KEEL_TRUST: "1",
        KEEL_NO_SNAPSHOT: "1",
        KEEL_COMPACTION: "1",
        KEEL_CONTEXT_WINDOW: "6100", // one dense body stays below hard; two cross it at turn 3
        KEEL_COMPACTION_RECENT: "1",
      },
      warden: fakeBashWarden(mkdtempSync(join(tmpdir(), "keel-compaction-audit-"))),
    });
    return { home, turns: model.turns };
  };

  it("the model FOLD fires through the real entrypoint (deterministicFactsSummary), shrinking the view, and the model resumes from the typed summary not the raw body", async () => {
    const { home, turns } = await runFoldScenario();
    const file = readSession(latestSessionId(home), { KEEL_HOME: home });

    const folds = file.events.filter((e) => e.type === "compaction");
    expect(folds.length).toBeGreaterThanOrEqual(1);
    const passed = folds.find((f) => f.type === "compaction" && f.validation !== "failed");
    expect(passed).toBeDefined(); // the wired deterministic summarizer produced a real, shrinking fold
    if (passed?.type === "compaction") expect(passed.tokensAfter).toBeLessThan(passed.tokensBefore);

    // the model drove the re-driven turn from the typed summary, NOT the raw aged body. (The summary
    // may carry a ~79-char first-line PREVIEW of the body as a fact, so we check the FULL body — a long
    // "AAA…" run unique to a.txt — is gone, not the short preview.)
    const lastTurn = turns.at(-1)!;
    expect(lastTurn.some((m) => m.content.includes("# Compacted Session State"))).toBe(true);
    const aFullBody = "AAA" + "x".repeat(2000);
    expect(lastTurn.some((m) => m.content.includes(aFullBody))).toBe(false); // raw aged body folded away
    // SEC-023: the full body still lives in the ledger (compress the view, never the record)
    expect(file.events.some((e) => e.type === "tool_result" && e.output.includes(aFullBody))).toBe(
      true,
    );
  });

  it("resume round-trip AFTER an in-loop compaction: rebuild yields VALID provider history from the canonical full ledger (ADR-0035 / ER-015)", async () => {
    const { home } = await runFoldScenario();
    const file = readSession(latestSessionId(home), { KEEL_HOME: home });

    // a compaction DID happen (precondition for the round-trip-after-compaction claim)
    expect(file.events.some((e) => e.type === "compaction")).toBe(true);

    const r = rebuild(file);
    // VALIDITY: every assistant tool call has exactly one matching tool result, no orphans
    const callIds = r.messages
      .flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []))
      .map((c) => c.id)
      .sort();
    const resultIds = r.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.toolCallId)
      .sort();
    expect(resultIds).toEqual(callIds);
    // rebuild skips the compaction event → the FULL pre-compaction history is canonical (needles intact)
    expect(
      r.messages.some((m) => m.role === "tool" && m.content.includes("AAA" + "x".repeat(2000))),
    ).toBe(true);
    expect(
      r.messages.some((m) => m.role === "tool" && m.content.includes("BBB" + "x".repeat(2000))),
    ).toBe(true);
  });
});
