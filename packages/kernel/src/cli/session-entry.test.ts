import { describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir as systemTmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExecutorPort,
  ModelPort,
  ModelTurnInput,
  PrincipalT,
  SideEffectT,
  SimulatorScriptT,
  UserInput,
  UiGitStatus,
  ViewModel,
} from "@keel/shared";
import {
  AnyAuditRecord,
  Goal,
  LIFECYCLE_MANIFEST_VERSION,
  LifecycleManifest,
  RUN_CONTROL_SCHEMA_VERSION,
  SIDE_EFFECT_TAXONOMY_VERSION,
  publicKeyFromSecretKey,
} from "@keel/shared";
import { ScriptedModel } from "@keel/simulator";
import { AuditChainWriter, buildEvidenceBundle } from "@keel/warden";
import { LocalExecutor } from "../local-executor.js";
import { SessionStore, readSession, SessionCorruptError } from "../session/store.js";
import { listSessions } from "../session/list.js";
import { sessionPath } from "../session/paths.js";
import { rebuild } from "../session/resume.js";
import {
  DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
  MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
  MAX_PRESTOP_CHECK_TIMEOUT_MS,
} from "../prestop-check.js";
import { renderFrame, HeadlessUI } from "../tui/headless.js";
import { InkUI } from "../tui/ink/ink-ui.js";
import { INPUT_HISTORY_SEED } from "../tui/input-history.js";
import { InputQueue } from "./input-queue.js";
import { saveProjectAutopilotMode } from "../autopilot/mode-store.js";
import { saveTrustDecision } from "../trust/trust-store.js";
import {
  HELP_TEXT,
  KEEL_RUN_SESSION_ID_ENV,
  assertFreshRunSessionIdAvailable,
  buildUI,
  freshRunSessionIdFromEnv,
  parseKeelArgs,
  productionAcceptanceContract,
  productionLoopSafety,
  productionLoopSafetyWithAcceptance,
  productionModelParams,
  resolveResumeId,
  runKeelCommand,
  runKeelSession,
  runAuditVerifyCommand,
  selectRenderer,
} from "./session-entry.js";
import {
  EVAL_BASH_MAX_TIMEOUT_ENV,
  EVAL_BASH_TIMEOUT_ACK,
  EVAL_BASH_TIMEOUT_ACK_ENV,
} from "./eval-executor-gate.js";
import type { ProductionWardenStartOptions } from "../warden/runtime.js";

const tmpdir = (): string => realpathSync(systemTmpdir());
const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const ROOT = process.cwd();
const BUILD_GLOBAL = "__KEEL_EVAL_DIRECT_EXEC_BUILD__";
// Generous real-warden handshake budget: tsx cold-start under full-suite fork-pool load can exceed a
// 5s budget (a host-load flake, not a logic failure); 15s stays under vitest's 20s testTimeout.
const REAL_WARDEN_HANDSHAKE_TIMEOUT_MS = 15_000;
const requireFromWarden = createRequire(join(ROOT, "packages/warden/src/bin.ts"));
const TSX_ESM_LOADER = pathToFileURL(requireFromWarden.resolve("tsx/esm")).href;
const WARDEN_RPC_SERVER_URL = pathToFileURL(join(ROOT, "packages/warden/src/rpc-server.ts")).href;
const WARDEN_SESSION_LOG_URL = pathToFileURL(
  join(ROOT, "packages/warden/src/audit/session-log.ts"),
).href;
const WARDEN_POLICY_URL = pathToFileURL(join(ROOT, "packages/warden/src/policy.ts")).href;

/** A test UIPort: records the latest view; its inputs() is a shared InputQueue the test feeds.
 *  `awaitRender` resolves once a rendered view matches a predicate — so a multi-turn test can wait
 *  until a turn has finished (the idle prompt) before feeding the NEXT prompt, fully deterministically. */
class TestUI {
  latest: ViewModel | undefined;
  closes = 0;
  readonly queue = new InputQueue();
  seededInputHistory: readonly string[] = [];
  readonly [INPUT_HISTORY_SEED] = (history: readonly string[]): void => {
    this.seededInputHistory = history;
  };
  #renderWaiters: { pred: (v: ViewModel) => boolean; resolve: () => void }[] = [];
  render(view: ViewModel): void {
    this.latest = view;
    this.#renderWaiters = this.#renderWaiters.filter((w) => {
      if (w.pred(view)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }
  awaitRender(pred: (v: ViewModel) => boolean): Promise<void> {
    if (this.latest !== undefined && pred(this.latest)) return Promise.resolve();
    return new Promise((resolve) => this.#renderWaiters.push({ pred, resolve }));
  }
  inputs(): AsyncIterable<UserInput> {
    return this.queue;
  }
  close(): Promise<void> {
    this.closes += 1;
    this.queue.close();
    return Promise.resolve();
  }
}

const assistantSaid = (v: ViewModel, content: string): boolean =>
  v.items.some((it) => it.kind === "message" && it.role === "assistant" && it.content === content);

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
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { runStdioWardenServer } from ${JSON.stringify(WARDEN_RPC_SERVER_URL)};
        import { SessionAuditLog } from ${JSON.stringify(WARDEN_SESSION_LOG_URL)};
        import { defaultPolicyPackRef } from ${JSON.stringify(WARDEN_POLICY_URL)};

        const auditLog = new SessionAuditLog({
          auditDir: process.env.KEEL_WARDEN_AUDIT_DIR,
          principal: {
            osUser: "session-entry-test",
            configuredId: null,
            authProvider: "local",
            assurance: "local-os-user"
          },
          policyPack: defaultPolicyPackRef()
        });

        runStdioWardenServer({
          auditWriter: auditLog,
          auditDir: process.env.KEEL_WARDEN_AUDIT_DIR,
          workspaceRoot: process.env.KEEL_WARDEN_WORKSPACE_ROOT,
          workspaceTrusted: process.env.KEEL_WARDEN_WORKSPACE_TRUSTED === "1",
          sandbox: {
            status: () => ({
              available: true,
              backend: "srt:vendored",
              enforcementTier: "sandbox:srt",
              features: ["egress-address-guard/v1"]
            }),
            execute: async (invocation) => {
              if (invocation.command === "printf 'by keel' > made.txt") {
                writeFileSync(join(process.env.KEEL_WARDEN_WORKSPACE_ROOT, "made.txt"), "by keel");
              }
              return { exitCode: 0, signal: null, stdout: "", stderr: "" };
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

function delayedStartupWarden(delayMs: number): ProductionWardenStartOptions {
  const activeHash = `sha256:${"b".repeat(64)}`;
  return {
    command: process.execPath,
    args: [
      "-e",
      `
        const activeHash = ${JSON.stringify(activeHash)};
        const delayMs = ${JSON.stringify(delayMs)};
        let buffer = "";
        function send(id, result) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
        }
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "warden.hello") {
              setTimeout(() => send(req.id, {
                wardenVersion: "test",
                protocolVersion: req.params.protocolVersion,
                capabilities: [],
                enforcementTier: "sandbox:srt",
                policyPack: { name: "phase2a-starter-policy-pack", hash: activeHash }
              }), delayMs);
            } else if (req.method === "warden.status") {
              send(req.id, {
                enforcementTier: "sandbox:srt",
                sandboxBackend: "srt:vendored",
                policyPack: { name: "phase2a-starter-policy-pack", hash: activeHash },
                auditHead: { seq: 0, hash: activeHash },
                pendingReviews: 0
              });
            } else if (req.method === "warden.audit.append") {
              send(req.id, { auditSeq: 1 });
            } else if (req.method === "warden.shutdown") {
              send(req.id, { finalCheckpoint: "test" });
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    ],
    env: { FORCE_COLOR: "0" },
    requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
  };
}

function gatedStartupWarden(gatePath: string): ProductionWardenStartOptions {
  const activeHash = `sha256:${"c".repeat(64)}`;
  return {
    command: process.execPath,
    args: [
      "-e",
      `
        const {existsSync}=require("node:fs");
        const activeHash=${JSON.stringify(activeHash)};
        const gatePath=${JSON.stringify(gatePath)};
        let buffer="";
        function send(id,result){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");}
        function afterGate(callback){
          if(existsSync(gatePath)){callback();return;}
          const timer=setInterval(()=>{if(existsSync(gatePath)){clearInterval(timer);callback();}},5);
        }
        process.stdin.setEncoding("utf8");
        process.stdin.on("data",(chunk)=>{
          buffer+=chunk;
          for(;;){
            const index=buffer.indexOf("\\n");
            if(index===-1) break;
            const request=JSON.parse(buffer.slice(0,index));
            buffer=buffer.slice(index+1);
            if(request.method==="warden.hello") afterGate(()=>send(request.id,{
              wardenVersion:"test",protocolVersion:request.params.protocolVersion,capabilities:[],
              enforcementTier:"sandbox:srt",policyPack:{name:"phase2a-starter-policy-pack",hash:activeHash}
            }));
            else if(request.method==="warden.status") send(request.id,{
              enforcementTier:"sandbox:srt",sandboxBackend:"srt:vendored",
              policyPack:{name:"phase2a-starter-policy-pack",hash:activeHash},
              auditHead:{seq:0,hash:activeHash},pendingReviews:0
            });
            else if(request.method==="warden.audit.append") send(request.id,{auditSeq:1});
            else if(request.method==="warden.shutdown"){
              send(request.id,{finalCheckpoint:"test-checkpoint"});setImmediate(()=>process.exit(0));
            }
          }
        });
      `,
    ],
    env: { FORCE_COLOR: "0" },
    requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
  };
}

function failingStartupWarden(): ProductionWardenStartOptions {
  return {
    command: process.execPath,
    args: ["-e", "process.stderr.write('warden startup failed\\n'); process.exit(17)"],
    requestTimeoutMs: 1_000,
  };
}

function fakeAutopilotReviewWarden(review: {
  readonly reviewId: string;
  readonly summary: string;
  readonly allowCommand: string;
}): ProductionWardenStartOptions {
  const activeHash = `sha256:${"a".repeat(64)}`;
  return {
    command: process.execPath,
    args: [
      "-e",
      `
        const activeHash = ${JSON.stringify(activeHash)};
        const review = ${JSON.stringify(review)};
        const captured = [];
        let buffer = "";
        function send(id, result) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
        }
        function fail(id, message, code) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message, data: { code } }
          }) + "\\n");
        }
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          for (;;) {
            const idx = buffer.indexOf("\\n");
            if (idx === -1) break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const req = JSON.parse(line);
            if (req.method === "warden.hello") {
              send(req.id, {
                wardenVersion: "test",
                protocolVersion: req.params.protocolVersion,
                capabilities: ["egress-address-guard/v1"],
                enforcementTier: "sandbox:srt",
                policyPack: { name: "phase2a-starter-policy-pack", hash: activeHash }
              });
            } else if (req.method === "warden.status") {
              send(req.id, {
                enforcementTier: "sandbox:srt",
                sandboxBackend: "srt:vendored",
                policyPack: { name: "phase2a-starter-policy-pack", hash: activeHash },
                auditHead: { seq: 4, hash: activeHash },
                pendingReviews: 0
              });
            } else if (req.method === "warden.audit.append") {
              captured.push({ method: req.method, params: req.params });
              send(req.id, { auditSeq: 4 });
            } else if (req.method === "warden.execute") {
              captured.push({ method: req.method, params: req.params });
              send(req.id, {
                verdict: "review",
                review,
                auditSeq: 4
              });
            } else if (req.method === "warden.resolveReview") {
              captured.push({ method: req.method, params: req.params });
              if (req.params.scope === "project") {
                fail(
                  req.id,
                  "project command grants require active Project Autopilot",
                  "PROJECT_AUTOPILOT_REQUIRED_FOR_PROJECT_COMMAND_GRANT"
                );
              } else {
                send(req.id, {
                  verdict: "allow",
                  result: { exitCode: 0, signal: null, stdout: "runtime-autopilot-ok\\n", stderr: "" },
                  auditSeq: 5
                });
              }
            } else if (req.method === "warden.shutdown") {
              send(req.id, { finalCheckpoint: "test-checkpoint" });
              setImmediate(() => process.exit(0));
            }
          }
        });
      `,
    ],
    requestTimeoutMs: REAL_WARDEN_HANDSHAKE_TIMEOUT_MS,
  };
}

function fakeAutopilotCommandReviewWarden(): ProductionWardenStartOptions {
  return fakeAutopilotReviewWarden({
    reviewId: "command_review_1",
    summary:
      "command review for python3 in workspace /repo; exact command grant: python3 tools/check.py",
    allowCommand:
      "keel approve command_review_1 --scope once --command-key sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
}

function fakeAutopilotDomainReviewWarden(): ProductionWardenStartOptions {
  return fakeAutopilotReviewWarden({
    reviewId: "egress_review_1",
    summary: "egress to example.com requires review: curl https://example.com",
    allowCommand: "keel approve egress_review_1 --scope once --domain example.com",
  });
}

describe("selectRenderer (TTY/CI routing)", () => {
  it("a one-shot (-p), CI, or non-TTY all route to headless; an interactive TTY routes to Ink", () => {
    expect(selectRenderer({ isTTY: true, ci: false, oneShot: true })).toBe("headless"); // -p
    expect(selectRenderer({ isTTY: true, ci: true, oneShot: false })).toBe("headless"); // CI=true
    expect(selectRenderer({ isTTY: false, ci: false, oneShot: false })).toBe("headless"); // piped
    expect(selectRenderer({ isTTY: true, ci: false, oneShot: false })).toBe("ink"); // interactive
  });
});

describe("parseKeelArgs", () => {
  it("no args → interactive (untrusted by default)", () => {
    expect(parseKeelArgs([])).toEqual({ kind: "interactive", trust: false });
  });
  it("run -p <prompt> → a headless one-shot carrying the prompt", () => {
    expect(parseKeelArgs(["run", "-p", "fix the bug"])).toEqual({
      kind: "run",
      prompt: "fix the bug",
      trust: false,
    });
    expect(parseKeelArgs(["run", "--print", "go"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
    });
  });

  it("run -p accepts a prompt that starts with a dash (markdown bullet, diff, dash-number, flag-in-prose)", () => {
    // Real prompts legitimately begin with "-": a markdown bullet, a diff hunk, a dash-led phrase, or
    // a sentence that mentions a flag. These must parse AS the prompt, not be rejected as a forgotten
    // flag. (Regression: a bullet-led task prompt was auto-rejected before the agent could run.)
    expect(parseKeelArgs(["run", "-p", "- You are given a PyTorch state dict; fix it"])).toEqual({
      kind: "run",
      prompt: "- You are given a PyTorch state dict; fix it",
      trust: false,
    });
    expect(parseKeelArgs(["run", "-p", "-5 degrees: convert to celsius"])).toMatchObject({
      kind: "run",
      prompt: "-5 degrees: convert to celsius",
    });
    expect(parseKeelArgs(["run", "--print", "--verbose should show more detail"])).toMatchObject({
      kind: "run",
      prompt: "--verbose should show more detail",
    });
  });

  it("run -p still rejects a forgotten prompt where -p swallowed a real keel flag", () => {
    // Protection preserved: a bare keel flag or flag=value token that lands in the prompt slot is a
    // missing prompt, not a one-word prompt. Distinguishes `keel run -p --replay=x` (mistake) from
    // `-p "- bullet"` (a real prompt that merely starts with a dash).
    const key = `sha256:${"d".repeat(64)}`;
    // Bare-flag and flag=value tokens that reach the prompt slot → the precise "not a flag" guidance.
    // These four are NOT consumed as global flags first, so each exercises the flag-shape guard itself.
    for (const forgotten of [
      `--plan-command-key=${key}`,
      "--replay=rec.json",
      "--replay",
      "--plan-id",
    ]) {
      expect(parseKeelArgs(["run", "-p", forgotten])).toMatchObject({
        kind: "usage",
        message: "keel run -p requires a prompt, not a flag",
      });
    }
    // Globally-consumed flags (`--trust`, `--autopilot`, `-c`) leave -p with no value → still an error.
    for (const consumed of ["--trust", "--autopilot", "-c"]) {
      expect(parseKeelArgs(["run", "-p", consumed]).kind).toBe("usage");
    }
  });

  it("run accepts exact-resource Plan Autopilot flags without granting broad Autopilot", () => {
    const key = `sha256:${"a".repeat(64)}`;
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "fix the bug",
        "--trust",
        "--plan-id",
        "plan-auth-fix",
        "--plan-domain",
        "Example.COM",
        "--plan-command-key",
        key,
      ]),
    ).toEqual({
      kind: "run",
      prompt: "fix the bug",
      trust: true,
      planApproval: {
        planId: "plan-auth-fix",
        resources: [
          { kind: "domain", value: "example.com" },
          { kind: "command-key", value: key },
        ],
      },
    });
  });

  it("run accepts equals-form exact-resource Plan Autopilot flags", () => {
    const key = `sha256:${"b".repeat(64)}`;
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "fix the bug",
        "--trust",
        "--plan-id=plan-equals",
        "--plan-domain=example.com",
        `--plan-command-key=${key}`,
      ]),
    ).toEqual({
      kind: "run",
      prompt: "fix the bug",
      trust: true,
      planApproval: {
        planId: "plan-equals",
        resources: [
          { kind: "domain", value: "example.com" },
          { kind: "command-key", value: key },
        ],
      },
    });
  });

  it("run treats plan-looking prompt and run-control values as data, not approval flags", () => {
    const key = `sha256:${"c".repeat(64)}`;
    expect(parseKeelArgs(["run", "-p", `--plan-command-key=${key}`])).toMatchObject({
      kind: "usage",
      message: "keel run -p requires a prompt, not a flag",
    });
    const parsed = parseKeelArgs([
      "run",
      "-p",
      "go",
      `--goal=--plan-command-key=${key}`,
      "--goal-check=--plan-domain=example.com",
    ]);
    expect(parsed).toMatchObject({
      kind: "run",
      prompt: "go",
      trust: false,
      goal: {
        objective: `--plan-command-key=${key}`,
        doneWhen: [
          {
            id: "check-1",
            kind: "command",
            check: { argv: ["--plan-domain=example.com"] },
          },
        ],
      },
    });
    expect(parsed.kind === "run" ? parsed.planApproval : undefined).toBeUndefined();
  });

  it("mcp review <server> is an explicit local-stdio review command", () => {
    expect(parseKeelArgs(["mcp", "review", "fixture"])).toEqual({
      kind: "mcp-review",
      serverKey: "fixture",
    });
    expect(parseKeelArgs(["mcp", "review"])).toEqual({
      kind: "usage",
      message: "usage: keel mcp review <server>",
    });
  });
  it("run supports public goal constructors with explicit evidence checks", () => {
    const parsed = parseKeelArgs([
      "run",
      "-p",
      "ship 2.12",
      "--goal",
      "Ship 2.12",
      "--goal-check",
      "pnpm test",
      "--goal-max-turns",
      "8",
    ]);

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") throw new Error("expected run command");
    expect(parsed.goal?.objective).toBe("Ship 2.12");
    expect(parsed.goal?.doneWhen[0]).toEqual({
      id: "check-1",
      kind: "command",
      check: { argv: ["pnpm", "test"] },
    });
    expect(parsed.goal?.bounds).toEqual({ maxTurns: 8 });
  });

  it("run supports a bounded loop constructor and rejects goal plus loop together", () => {
    const parsed = parseKeelArgs([
      "run",
      "-p",
      "fix tests",
      "--loop-until",
      "pnpm test",
      "--loop-max-iterations",
      "2",
    ]);

    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run") throw new Error("expected run command");
    expect(parsed.loop?.prompt).toBe("fix tests");
    expect(parsed.loop?.bounds.maxIterations).toBe(2);
    expect(parsed.loop?.until.check.argv).toEqual(["pnpm", "test"]);

    expect(
      parseKeelArgs([
        "run",
        "-p",
        "go",
        "--goal",
        "Goal",
        "--goal-check",
        "pnpm test",
        "--loop-until",
        "pnpm test",
      ]).kind,
    ).toBe("usage");
  });

  it("keeps goal and loop run-control active during deterministic offline replay", () => {
    const goal = parseKeelArgs([
      "run",
      "-p",
      "prove it",
      "--replay",
      "recording.json",
      "--goal",
      "Prove replay goal control",
      "--goal-check",
      "echo replay-ok",
      "--goal-validation",
      "minimal",
    ]);
    expect(goal.kind).toBe("run");
    if (goal.kind !== "run") throw new Error("expected replay goal run command");
    expect(goal.replay).toBe("recording.json");
    expect(goal.goal?.objective).toBe("Prove replay goal control");
    expect(goal.goal?.validation).toEqual({ tier: "minimal" });

    const loop = parseKeelArgs([
      "run",
      "-p",
      "iterate",
      "--replay=recording.json",
      "--loop-until",
      "echo replay-ok",
      "--loop-max-iterations",
      "2",
    ]);
    expect(loop.kind).toBe("run");
    if (loop.kind !== "run") throw new Error("expected replay loop run command");
    expect(loop.replay).toBe("recording.json");
    expect(loop.loop?.prompt).toBe("iterate");
    expect(loop.loop?.bounds.maxIterations).toBe(2);
  });

  it("run-control flags fail closed on missing, duplicate, or schema-invalid values", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--goal-check", "pnpm test"])).toMatchObject({
      kind: "usage",
      message: "--goal requires an objective",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--goal", "Ship"]).kind).toBe("usage");
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "go",
        "--goal",
        "Ship",
        "--goal-check",
        "pnpm test",
        "--goal",
        "Other",
      ]),
    ).toMatchObject({ kind: "usage", message: "--goal may be provided once" });
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "go",
        "--goal",
        "Ship",
        "--goal-check",
        "pnpm test",
        "--goal-max-turns",
        "1001",
      ]).kind,
    ).toBe("usage");
    expect(parseKeelArgs(["run", "-p", "go", "--loop-max-iterations", "2"])).toMatchObject({
      kind: "usage",
      message: "--loop-until requires a command",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--loop-until"])).toMatchObject({
      kind: "usage",
      message: "--loop-until requires a value",
    });
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "go",
        "--loop-until",
        "pnpm test",
        "--loop-max-iterations",
        "1001",
      ]).kind,
    ).toBe("usage");
  });
  it("--trust is an explicit opt-in, accepted anywhere in argv (run or interactive)", () => {
    expect(parseKeelArgs(["--trust"])).toEqual({ kind: "interactive", trust: true });
    expect(parseKeelArgs(["run", "-p", "go", "--trust"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: true,
    });
    expect(parseKeelArgs(["run", "--trust", "-p", "go"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: true,
    });
  });
  it("--autopilot is an explicit human opt-in for trusted run or interactive sessions", () => {
    const expectedAutopilot = {
      mode: "autopilot",
      source: "human",
      userConfirmed: true,
      reason: "cli --autopilot",
    };

    expect(parseKeelArgs(["--trust", "--autopilot"])).toEqual({
      kind: "interactive",
      trust: true,
      autonomy: expectedAutopilot,
    });
    expect(parseKeelArgs(["run", "-p", "go", "--trust", "--autopilot"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: true,
      autonomy: expectedAutopilot,
    });
    expect(
      parseKeelArgs(["run", "-p", "go", "--trust", "--autopilot", "--replay", "rec.json"]),
    ).toEqual({
      kind: "run",
      prompt: "go",
      trust: true,
      autonomy: expectedAutopilot,
      replay: "rec.json",
    });
    expect(parseKeelArgs(["--continue", "--trust", "--autopilot"])).toEqual({
      kind: "interactive",
      trust: true,
      autonomy: expectedAutopilot,
      resume: { kind: "latest" },
    });
    expect(parseKeelArgs(["--resume", "ses_abc", "--trust", "--autopilot"])).toEqual({
      kind: "interactive",
      trust: true,
      autonomy: expectedAutopilot,
      resume: { kind: "id", id: "ses_abc" },
    });
  });
  it("--autopilot without --trust is parsed but remains runtime-gated to Guided", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--autopilot"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
      autonomy: {
        mode: "autopilot",
        source: "human",
        userConfirmed: true,
        reason: "cli --autopilot",
      },
    });
  });
  it("--autopilot is rejected outside interactive and run forms", () => {
    for (const args of [
      ["doctor", "--autopilot"],
      ["audit", "verify", "/tmp/bundle", "--autopilot"],
      ["sessions", "list", "--autopilot"],
      ["auth", "list", "--autopilot"],
      ["mcp", "review", "local-server", "--autopilot"],
    ]) {
      expect(parseKeelArgs(args).kind, args.join(" ")).toBe("usage");
    }
  });
  it("run rejects combining broad --autopilot with an exact-resource plan envelope", () => {
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "go",
        "--trust",
        "--autopilot",
        "--plan-command-key",
        `sha256:${"a".repeat(64)}`,
      ]),
    ).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "keel run cannot combine --autopilot with --plan-* exact-resource approval",
    });
  });
  it("autopilot grants/mode/plan commands parse without a model run", () => {
    const key = `sha256:${"a".repeat(64)}`;
    expect(parseKeelArgs(["autopilot", "grants", "list"])).toEqual({
      kind: "autopilot-grants",
      args: ["list"],
    });
    expect(parseKeelArgs(["autopilot", "mode", "status"])).toEqual({
      kind: "autopilot-mode",
      args: ["status"],
    });
    expect(parseKeelArgs(["autopilot", "mode", "set", "project-autopilot"])).toEqual({
      kind: "autopilot-mode",
      args: ["set", "project-autopilot"],
    });
    expect(parseKeelArgs(["autopilot", "mode", "clear"])).toEqual({
      kind: "autopilot-mode",
      args: ["clear"],
    });
    expect(parseKeelArgs(["autopilot", "grants", "revoke", "--domain", "example.com"])).toEqual({
      kind: "autopilot-grants",
      args: ["revoke", "--domain", "example.com"],
    });
    expect(parseKeelArgs(["autopilot", "grants", "revoke", "--command-key", key])).toEqual({
      kind: "autopilot-grants",
      args: ["revoke", "--command-key", key],
    });
    expect(parseKeelArgs(["autopilot", "plan", "preview", "--domain", "example.com"])).toEqual({
      kind: "autopilot-plan",
      args: ["preview", "--domain", "example.com"],
    });
    expect(parseKeelArgs(["autopilot", "grants"])).toEqual({
      kind: "usage",
      message: "usage: keel autopilot grants <list|revoke>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "mode"])).toEqual({
      kind: "usage",
      message: "usage: keel autopilot mode <status|set|clear>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "mode", "frob"])).toEqual({
      kind: "usage",
      message: "usage: keel autopilot mode <status|set|clear>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "plan"])).toEqual({
      kind: "usage",
      message: "usage: keel autopilot plan <preview>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "plan", "frob"])).toEqual({
      kind: "usage",
      message: "usage: keel autopilot plan <preview>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "grants", "list", "--trust"])).toEqual({
      kind: "usage",
      message:
        "--trust is only valid for the interactive and run commands. usage: keel autopilot grants <list|revoke>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "mode", "status", "--trust"])).toEqual({
      kind: "usage",
      message:
        "--trust is only valid for the interactive and run commands. usage: keel autopilot mode <status|set|clear>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "grants", "list", "--autopilot"])).toEqual({
      kind: "usage",
      message:
        "--autopilot is only valid for the interactive and run commands. usage: keel autopilot grants <list|revoke>",
      exitCode: 1,
    });
    expect(parseKeelArgs(["autopilot", "mode", "status", "--autopilot"])).toEqual({
      kind: "usage",
      message:
        "--autopilot is only valid for the interactive and run commands. usage: keel autopilot mode <status|set|clear>",
      exitCode: 1,
    });
    expect(
      parseKeelArgs(["autopilot", "plan", "preview", "--domain", "example.com", "--autopilot"]),
    ).toEqual({
      kind: "usage",
      message:
        "--autopilot is only valid for the interactive and run commands. usage: keel autopilot plan <preview>",
      exitCode: 1,
    });
    expect(
      parseKeelArgs(["autopilot", "plan", "preview", "--domain", "example.com", "--trust"]),
    ).toEqual({
      kind: "usage",
      message:
        "--trust is only valid for the interactive and run commands. usage: keel autopilot plan <preview>",
      exitCode: 1,
    });
  });

  it("egress exception commands parse without a model run", () => {
    expect(parseKeelArgs(["egress", "exception", "list", "--workspace", "/tmp/work"])).toEqual({
      kind: "egress-exception",
      args: ["list", "--workspace", "/tmp/work"],
    });
    expect(
      parseKeelArgs([
        "egress",
        "exception",
        "add",
        "--workspace=/tmp/work",
        "--host=private.example",
        "--cidr=10.20.0.0/16",
        "--port=443",
      ]),
    ).toMatchObject({ kind: "egress-exception" });
    for (const args of [
      ["egress"],
      ["egress", "exception"],
      ["egress", "exception", "frob"],
      ["egress", "other", "list"],
    ]) {
      expect(parseKeelArgs(args)).toMatchObject({
        kind: "usage",
        message: "usage: keel egress exception <add|list|remove>",
      });
    }
  });
  it("run with no prompt → usage", () => {
    expect(parseKeelArgs(["run", "-p"]).kind).toBe("usage");
    expect(parseKeelArgs(["run"]).kind).toBe("usage");
  });
  it("run fails closed on unsupported flags before provider setup", () => {
    expect(parseKeelArgs(["run", "--trust", "--yolo", "-p", "say hi"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "unsupported keel run flag: --yolo",
    });
    expect(parseKeelArgs(["run", "--definitely-not-a-real-flag", "-p", "say hi"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "unsupported keel run flag: --definitely-not-a-real-flag",
    });
    expect(parseKeelArgs(["run", "-p", "say hi", "extra"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "unexpected keel run argument: extra",
    });
  });
  it("parses an explicit Plan Autopilot confirmation pause for exact-resource runs", () => {
    const key = `sha256:${"b".repeat(64)}`;

    expect(
      parseKeelArgs([
        "run",
        "-p",
        "ship the fix",
        "--plan-confirm",
        "--plan-id",
        "auth-fix",
        "--plan-domain",
        "Example.COM",
        "--plan-command-key",
        key,
      ]),
    ).toEqual({
      kind: "run",
      prompt: "ship the fix",
      trust: false,
      planApproval: {
        planId: "auth-fix",
        confirm: true,
        resources: [
          { kind: "domain", value: "example.com" },
          { kind: "command-key", value: key },
        ],
      },
    });

    expect(parseKeelArgs(["run", "-p", "go", "--plan-confirm"])).toEqual({
      kind: "usage",
      message: "keel run --plan-confirm requires --plan-domain or --plan-command-key",
      exitCode: 1,
    });
    expect(parseKeelArgs(["run", "-p", "do --plan-confirm literally"])).toEqual({
      kind: "run",
      prompt: "do --plan-confirm literally",
      trust: false,
    });
  });
  it("sessions → delegated to the sessions CLI with its args", () => {
    expect(parseKeelArgs(["sessions", "list"])).toEqual({ kind: "sessions", args: ["list"] });
  });
  it("an unknown command → usage", () => {
    expect(parseKeelArgs(["bogus"]).kind).toBe("usage");
  });
  it("usage prominently names the bare-keel interactive path (DX discoverability, bug b)", () => {
    const u = parseKeelArgs(["bogus"]);
    if (u.kind !== "usage") throw new Error("expected usage");
    expect(u.message).toMatch(/interactive session/i); // a clear hint, not a buried parenthetical
  });
  it("doctor → the environment preflight command", () => {
    expect(parseKeelArgs(["doctor"])).toEqual({ kind: "doctor" });
  });
  it("run --replay <file> carries the recording path (offline replay)", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--replay", "rec.json"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
      replay: "rec.json",
    });
    expect(parseKeelArgs(["run", "--replay", "rec.json", "-p", "go", "--trust"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: true,
      replay: "rec.json",
    });
  });
  it("run without --replay has no replay field", () => {
    expect(parseKeelArgs(["run", "-p", "go"])).toEqual({ kind: "run", prompt: "go", trust: false });
  });
  it("parses the explicit task-scoped final answer word contract", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--final-max-words", "40"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
      finalAnswer: { version: 1, maxWords: 40 },
    });
    expect(parseKeelArgs(["run", "--final-max-words=2000", "-p", "go"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
      finalAnswer: { version: 1, maxWords: 2000 },
    });
  });
  it.each(["39", "2001", "40.5", "nope", "01", "+40"])(
    "rejects invalid --final-max-words value %j before provider setup",
    (value) => {
      const token = `--final-max-words=${value}`;
      const result = parseKeelArgs(["run", "-p", "go", token]);
      expect(result.kind).toBe("usage");
      expect(result.kind === "usage" ? result.message : "").toMatch(
        /--final-max-words.*integer.*40\.\.2000/i,
      );
    },
  );
  it("rejects a missing or duplicate final answer contract", () => {
    const missing = parseKeelArgs(["run", "-p", "go", "--final-max-words"]);
    expect(missing.kind).toBe("usage");
    expect(missing.kind === "usage" ? missing.message : "").toMatch(/--final-max-words.*value/i);

    const empty = parseKeelArgs(["run", "-p", "go", "--final-max-words="]);
    expect(empty.kind).toBe("usage");
    expect(empty.kind === "usage" ? empty.message : "").toMatch(/--final-max-words.*value/i);

    const duplicate = parseKeelArgs([
      "run",
      "-p",
      "go",
      "--final-max-words",
      "40",
      "--final-max-words=80",
    ]);
    expect(duplicate.kind).toBe("usage");
    expect(duplicate.kind === "usage" ? duplicate.message : "").toMatch(/--final-max-words.*once/i);
  });
  it("run --verbose sets verbose:true (show the -p system preamble); absent → no verbose flag (default hidden, DX bug a)", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--verbose"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
      verbose: true,
    });
    const noFlag = parseKeelArgs(["run", "-p", "go"]);
    expect(noFlag.kind === "run" && noFlag.verbose).toBeFalsy(); // absent unless explicitly asked
  });
  it("--replay with no path (or a following flag) → usage (not a silent no-op)", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--replay"]).kind).toBe("usage");
    expect(parseKeelArgs(["run", "-p", "go", "--replay", "-x"]).kind).toBe("usage");
  });
  it("--replay=<file> (equals form) carries the path — never silently a live run (money-safety)", () => {
    // A mistyped `=` must NOT drop replay and fall through to a paid live run (QC final review B-F2).
    expect(parseKeelArgs(["run", "-p", "go", "--replay=rec.json"])).toEqual({
      kind: "run",
      prompt: "go",
      trust: false,
      replay: "rec.json",
    });
    // empty value after `=` → usage, not a silent live run
    expect(parseKeelArgs(["run", "-p", "go", "--replay="]).kind).toBe("usage");
  });
  it("run plan approval flags fail closed on missing resources, missing values, or replay mixing", () => {
    expect(parseKeelArgs(["run", "-p", "go", "--plan-id", "plan-only"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "keel run plan approval requires --plan-domain or --plan-command-key",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--plan-domain"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "--plan-domain requires a value",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--plan-domain="])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "--plan-domain requires a value",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--plan-command-key="])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "--plan-command-key requires a value",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--plan-confirm=true"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "keel run --plan-confirm takes no value",
    });
    expect(
      parseKeelArgs([
        "run",
        "-p",
        "go",
        "--plan-confirm",
        "--plan-confirm",
        "--plan-domain",
        "example.com",
      ]),
    ).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "keel run --plan-confirm may be provided once",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--plan-domain", "*"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "keel run plan approval rejected domain *: domain must be an exact host",
    });
    expect(parseKeelArgs(["run", "-p", "go", "--plan-command-key", "sha256:nope"])).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message:
        "keel run plan approval rejected command-key sha256:nope: command-key must be sha256:<64 lowercase hex>",
    });
    expect(
      parseKeelArgs(["run", "-p", "go", "--replay", "rec.json", "--plan-domain", "example.com"]),
    ).toMatchObject({
      kind: "usage",
      exitCode: 1,
      message: "keel run cannot combine --replay with --plan-* exact-resource approval",
    });
  });
  it("--version / -v → the version command (anywhere in argv)", () => {
    expect(parseKeelArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseKeelArgs(["-v"])).toEqual({ kind: "version" });
    expect(parseKeelArgs(["run", "-p", "go", "--version"])).toEqual({ kind: "version" });
    expect(parseKeelArgs(["--autopilot", "--version"])).toEqual({ kind: "version" });
  });
  it("--help / -h → the help command (anywhere in argv, no model/key/workspace needed)", () => {
    expect(parseKeelArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseKeelArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseKeelArgs(["run", "-p", "go", "--help"])).toEqual({ kind: "help" });
    expect(parseKeelArgs(["--autopilot", "--help"])).toEqual({ kind: "help" });
  });
  it("help text lists the command surface and stays Phase-2A honest (ER-030a)", () => {
    expect(HELP_TEXT).toContain("keel [--trust] [--autopilot]");
    expect(HELP_TEXT).toContain("keel run -p <prompt> [--trust] [--autopilot]");
    expect(HELP_TEXT).toContain("--replay <recording.json>");
    expect(HELP_TEXT).toContain("offline deterministic replay; no provider credential or network");
    // P1-17: the interactive resume flags the TUI advertises must appear in `keel --help`.
    expect(HELP_TEXT).toContain("--continue | -c");
    expect(HELP_TEXT).toContain("--resume <id> | -r <id>");
    // P1-17: internal phase numerals ("phase 2.5" / "Phase-2B") dropped from the help surface.
    expect(HELP_TEXT).not.toMatch(/phase\s*2\.5|Phase-2B/i);
    expect(HELP_TEXT).toContain("--goal <objective> --goal-check <cmd>");
    expect(HELP_TEXT).toContain("--loop-until <cmd>");
    expect(HELP_TEXT).toContain("--final-max-words <40..2000>");
    expect(HELP_TEXT).toContain(
      "[--plan-id <id>] (--plan-domain <domain> | --plan-command-key <sha256:key>) ...",
    );
    expect(HELP_TEXT).toContain("exact-resource Plan Autopilot run envelope");
    expect(HELP_TEXT).toContain("--plan-confirm");
    expect(HELP_TEXT).toContain('require typing "approve" before execution');
    expect(HELP_TEXT).toContain("cannot combine with --autopilot or --replay");
    expect(HELP_TEXT).toContain("keel audit export <session>");
    expect(HELP_TEXT).toContain("keel audit verify <bundle>");
    expect(HELP_TEXT).toContain("keel autopilot plan preview [--plan-id <id>] [--step <text> ...]");
    expect(HELP_TEXT).toContain("preview exact Plan Autopilot resources; grants nothing");
    expect(HELP_TEXT).toContain("keel sessions <command>");
    expect(HELP_TEXT).toContain("keel auth <command>");
    expect(HELP_TEXT).toContain("keel doctor");
    expect(HELP_TEXT).toContain("keel --help | -h");
    expect(HELP_TEXT).toContain("--autopilot");
    expect(HELP_TEXT).toContain("warden still asks on boundary expansion");
    expect(HELP_TEXT).toContain("reviewed local-stdio MCP route through the warden");
    expect(HELP_TEXT).toContain("unreviewed tools fail closed");
    expect(HELP_TEXT).not.toMatch(/secure by construction|approved|yolo|skip all prompts/i);
  });
  it("parses keel audit verify for offline evidence-bundle verification", () => {
    expect(parseKeelArgs(["audit", "verify", "/tmp/bundle_ses_x"])).toEqual({
      kind: "audit-verify",
      bundlePath: "/tmp/bundle_ses_x",
    });
    expect(parseKeelArgs(["audit", "verify"]).kind).toBe("usage");
    expect(parseKeelArgs(["audit", "verify", "/tmp/bundle", "--extra"]).kind).toBe("usage");
  });
  it("keel audit verify prints the signer key and authenticity caveat", () => {
    const auditDir = mkdtempSync(join(tmpdir(), "keel-audit-verify-"));
    const logPath = join(auditDir, "audit.jsonl");
    const outDir = join(auditDir, "exports");
    const sessionId = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const secretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 31);
    const publicKey = publicKeyFromSecretKey(secretKey);
    const policyPack = {
      name: "default",
      hash: `sha256:${"a".repeat(64)}`,
      files: { "starter.rego": "package keel\n" },
    };
    const principal: PrincipalT = {
      osUser: "alice",
      configuredId: null,
      authProvider: "local",
      assurance: "local-os-user",
    };
    const writer = AuditChainWriter.open({
      path: logPath,
      principal,
      now: () => "2026-06-26T14:00:00.000Z",
      policyPack: { name: policyPack.name, hash: policyPack.hash },
      checkpoint: { cadence: 1, secretKey },
    });
    writer.append({ eventType: "session.start", sessionId, payload: {} });
    writer.close();
    const records = readFileSync(logPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
    const result = buildEvidenceBundle(
      {
        sessionId,
        records,
        checkpointPublicKey: publicKey,
        policyPack,
        config: {
          enforcementTier: "none",
          sandboxBackend: "srt:vendored",
          egressAllowlist: [],
        },
      },
      { outDir, now: () => "2026-06-26T14:00:00.000Z" },
    );

    const output = runAuditVerifyCommand({ bundlePath: result.bundlePath });

    expect(output).toContain(
      `signer checkpoint key: ed25519:${Buffer.from(publicKey).toString("base64")}`,
    );
    expect(output).toContain("Compare the signer checkpoint key");
    expect(output).toContain("out-of-band");
  });
  it("--continue / -c → interactive resuming the LATEST session (Epic 1.23 slice 2)", () => {
    expect(parseKeelArgs(["--continue"])).toEqual({
      kind: "interactive",
      trust: false,
      resume: { kind: "latest" },
    });
    expect(parseKeelArgs(["-c"])).toEqual({
      kind: "interactive",
      trust: false,
      resume: { kind: "latest" },
    });
  });
  it("--resume <id> / -r <id> → interactive resuming THAT session", () => {
    expect(parseKeelArgs(["--resume", "ses_abc"])).toEqual({
      kind: "interactive",
      trust: false,
      resume: { kind: "id", id: "ses_abc" },
    });
    expect(parseKeelArgs(["-r", "ses_abc"])).toEqual({
      kind: "interactive",
      trust: false,
      resume: { kind: "id", id: "ses_abc" },
    });
  });
  it("resume composes with --trust", () => {
    expect(parseKeelArgs(["--continue", "--trust"])).toEqual({
      kind: "interactive",
      trust: true,
      resume: { kind: "latest" },
    });
  });
  it("--resume with no id → usage (a flag that needs a value never silently degrades)", () => {
    expect(parseKeelArgs(["--resume"]).kind).toBe("usage");
    expect(parseKeelArgs(["-r", "--trust"]).kind).toBe("usage");
  });
});

describe("resolveResumeId (which session does --continue / --resume target)", () => {
  it("by id: returns the id when the session exists, undefined otherwise (fail closed)", () => {
    const e = env();
    const s = SessionStore.create({ cwd: "/w" }, e);
    s.close();
    expect(resolveResumeId({ kind: "id", id: s.id }, "/w", e)).toBe(s.id);
    expect(resolveResumeId({ kind: "id", id: "ses_missing" }, "/w", e)).toBeUndefined();
  });
  it("latest: the most recent session for THIS cwd; ignores other workspaces; undefined when none", async () => {
    const e = env();
    expect(resolveResumeId({ kind: "latest" }, "/w", e)).toBeUndefined(); // nothing yet
    const other = SessionStore.create({ cwd: "/other" }, e);
    other.close();
    expect(resolveResumeId({ kind: "latest" }, "/w", e)).toBeUndefined(); // a different cwd doesn't count
    const older = SessionStore.create({ cwd: "/w" }, e);
    older.close();
    await new Promise((r) => setTimeout(r, 10)); // distinct createdAt (ISO ms)
    const newer = SessionStore.create({ cwd: "/w" }, e);
    newer.close();
    expect(resolveResumeId({ kind: "latest" }, "/w", e)).toBe(newer.id); // most recent in /w
  });
  it("does NOT cross-resolve workspaces whose REDACTED cwd collides (ADR-0054 — matches cwdHash, not the lossy cwd)", () => {
    const e = env();
    // Two distinct deep paths that BOTH collapse to the SAME `[redacted:high-entropy]` literal in the
    // ledger's stored (redacted) cwd — the collision that let --continue resume/cross-write the WRONG
    // workspace. Matching on the one-way cwdHash (not the lossy redacted cwd) keeps them distinct.
    const a = "/Users/alice/Documents/Code/2024_q3_migration_v2";
    const b = "/Users/jenny/repos/acme-platform/services/auth2";
    const sa = SessionStore.create({ cwd: a }, e);
    sa.close();
    // --continue in workspace B (which has NO session of its own) resolves to NOTHING — never to A's
    // session, despite their identical stored redacted cwds.
    expect(resolveResumeId({ kind: "latest" }, b, e)).toBeUndefined();
    // --continue in A still resolves A's own session (the same path hashes the same).
    expect(resolveResumeId({ kind: "latest" }, a, e)).toBe(sa.id);
  });
});

describe("productionLoopSafety (INT-1 — a real run is guarded, not just turn-capped)", () => {
  it("always enables loop detection + a per-tool infra deadline", () => {
    const s = productionLoopSafety({});
    expect(s.loopDetection).toMatchObject({
      highBurnOutcomeRepeats: 2,
      highBurnOutputBytes: 4096,
      highBurnToolRepeats: 2,
      highBurnToolStepTokens: 50_000,
      recoverWithEvidence: true,
      stopOnRepeatedSuccessEvidence: true,
    });
    expect(s.loopDetection.highBurnOutcomeStepTokens).toBeUndefined();
    expect(s.loopDetection.maxNumericVectorStallTurns).toBeUndefined();
    expect(s.infraTimeout.toolMs).toBeGreaterThan(0);
    expect(s.stop).toBeUndefined(); // no token budget unless KEEL_MAX_TOKENS is set
  });

  it("keeps the infra backstop above the eval-only bash ceiling when structurally gated", () => {
    const g = globalThis as Record<string, unknown>;
    const had = BUILD_GLOBAL in g;
    const prev = g[BUILD_GLOBAL];
    g[BUILD_GLOBAL] = true;
    try {
      expect(
        productionLoopSafety({
          [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
          [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000",
        }).infraTimeout.toolMs,
      ).toBe(10_860_000);
      expect(
        productionLoopSafety({
          [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
          [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800001",
        }).infraTimeout.toolMs,
      ).toBe(660_000);
    } finally {
      if (had) g[BUILD_GLOBAL] = prev;
      else delete g[BUILD_GLOBAL];
    }

    expect(productionLoopSafety({}).infraTimeout.toolMs).toBe(660_000);
    expect(
      productionLoopSafety({
        [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
        [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000",
      }).infraTimeout.toolMs,
    ).toBe(660_000);
  });

  it("leaves the pre-completion verification interceptor OFF by default (default-on measured net-negative)", () => {
    // A 2026-06-18 head-to-head (verify-ON vs verify-OFF, identical budget/model/infra) found default-on
    // amplifies over-editing: clean model-stops became budget churn, 2 passing tasks regressed, 0
    // recovered. The capability stays wired + tested (below) but must be opted into, not defaulted.
    expect(productionLoopSafety({}).verification).toBeUndefined();
  });

  it("KEEL_VERIFY opts IN to verification (for a STOP-biased redesign or an A/B measurement)", () => {
    for (const on of ["1", "true", "yes"]) {
      // genericSkip defaults OFF (F6, fail-safe) — the gate recognizes ONLY keel's own banner unless
      // KEEL_GENERIC_SKIP is set, so the generic recognizer can't silence a gate-fire by default.
      expect(productionLoopSafety({ KEEL_VERIFY: on }).verification).toEqual({
        genericSkip: false,
      });
    }
    // a non-truthy value leaves verification OFF (default)
    expect(productionLoopSafety({ KEEL_VERIFY: "0" }).verification).toBeUndefined();
  });

  it("KEEL_GENERIC_SKIP=1 opts IN to the generic pytest-pass recognizer (F6 opt-in)", () => {
    for (const on of ["1", "true", "yes"]) {
      expect(
        productionLoopSafety({ KEEL_VERIFY: "1", KEEL_GENERIC_SKIP: on }).verification,
      ).toEqual({ genericSkip: true });
    }
    // a non-truthy opt-in value leaves the generic recognizer OFF (the fail-safe default)
    expect(productionLoopSafety({ KEEL_VERIFY: "1", KEEL_GENERIC_SKIP: "0" }).verification).toEqual(
      { genericSkip: false },
    );
    // the opt-in is inert when verification itself is off
    expect(productionLoopSafety({ KEEL_GENERIC_SKIP: "1" }).verification).toBeUndefined();
  });

  it("KEEL_PRESTOP_CHECK_CMD is ignored unless KEEL_VERIFY=1", () => {
    expect(
      productionLoopSafety({ KEEL_PRESTOP_CHECK_CMD: "python -m pytest -q" }).verification,
    ).toBeUndefined();

    expect(
      productionLoopSafety({
        KEEL_VERIFY: "1",
        KEEL_PRESTOP_CHECK_CMD: " python -m pytest -q ",
      }).verification,
    ).toEqual({
      genericSkip: false,
      preStop: {
        check: {
          command: "python -m pytest -q",
          timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
        },
      },
    });
  });

  it("KEEL_VERIFY_MODE=prestop fails closed instead of falling back to the prompt gate", () => {
    expect(() => productionLoopSafety({ KEEL_VERIFY: "1", KEEL_VERIFY_MODE: "prestop" })).toThrow(
      /KEEL_PRESTOP_CHECK_CMD/,
    );

    expect(() =>
      productionLoopSafety({
        KEEL_VERIFY: "1",
        KEEL_VERIFY_MODE: "prestop",
        KEEL_PRESTOP_CHECK_CMD: "   ",
      }),
    ).toThrow(/KEEL_PRESTOP_CHECK_CMD/);

    expect(
      productionLoopSafety({
        KEEL_VERIFY: "1",
        KEEL_VERIFY_MODE: "prestop",
        KEEL_PRESTOP_CHECK_CMD: "python -m pytest -q",
      }).verification?.preStop?.check.command,
    ).toBe("python -m pytest -q");
  });

  it("KEEL_PRESTOP_CHECK timeout/output env values are positive integers and clamped", () => {
    expect(
      productionLoopSafety({
        KEEL_VERIFY: "1",
        KEEL_PRESTOP_CHECK_CMD: "pytest",
        KEEL_PRESTOP_CHECK_TIMEOUT_MS: "2500",
        KEEL_PRESTOP_CHECK_MAX_OUTPUT_BYTES: "4096",
      }).verification?.preStop?.check,
    ).toMatchObject({ timeoutMs: 2500, maxOutputBytes: 4096 });

    expect(
      productionLoopSafety({
        KEEL_VERIFY: "1",
        KEEL_PRESTOP_CHECK_CMD: "pytest",
        KEEL_PRESTOP_CHECK_TIMEOUT_MS: "999999999",
        KEEL_PRESTOP_CHECK_MAX_OUTPUT_BYTES: "999999999",
      }).verification?.preStop?.check,
    ).toMatchObject({
      timeoutMs: MAX_PRESTOP_CHECK_TIMEOUT_MS,
      maxOutputBytes: MAX_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
    });

    expect(
      productionLoopSafety({
        KEEL_VERIFY: "1",
        KEEL_PRESTOP_CHECK_CMD: "pytest",
        KEEL_PRESTOP_CHECK_TIMEOUT_MS: "2.5",
        KEEL_PRESTOP_CHECK_MAX_OUTPUT_BYTES: "lots",
      }).verification?.preStop?.check,
    ).toMatchObject({
      timeoutMs: DEFAULT_PRESTOP_CHECK_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_PRESTOP_CHECK_MAX_OUTPUT_BYTES,
    });
  });

  it("KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS builds an explicit artifact contract without enabling the prompt verifier", () => {
    expect(
      productionAcceptanceContract({
        KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: " answer.txt, artifacts/report.html ",
      }),
    ).toMatchObject({
      source: "operator-config",
      confidence: "explicit",
      requiredArtifacts: [
        {
          path: "answer.txt",
          source: "operator-config",
          confidence: "explicit",
        },
        {
          path: "artifacts/report.html",
          source: "operator-config",
          confidence: "explicit",
        },
      ],
    });
    expect(
      productionLoopSafety({ KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt" }).verification,
    ).toBeUndefined();
    const readArtifact = async () => ({ exists: false as const });
    const artifactReaderFactory = vi.fn(() => readArtifact);
    const acceptanceOnly = productionLoopSafetyWithAcceptance(
      { KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt", KEEL_PRESTOP_CHECK_CMD: "exit 42" },
      { cwd: "/workspace/task", workspaceTrusted: true, artifactReaderFactory },
    );
    expect(artifactReaderFactory).toHaveBeenCalledWith("/workspace/task");
    expect(acceptanceOnly.verification?.acceptance).toMatchObject({
      contract: {
        source: "operator-config",
        confidence: "explicit",
        requiredArtifacts: [{ path: "answer.txt" }],
      },
    });
    expect(acceptanceOnly.verification?.preStop).toBeUndefined();

    const deniedReaderFactory = vi.fn(() => readArtifact);
    expect(() =>
      productionLoopSafetyWithAcceptance(
        { KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt" },
        {
          cwd: "/workspace/task",
          workspaceTrusted: false,
          artifactReaderFactory: deniedReaderFactory,
        },
      ),
    ).toThrow(/requires a trusted workspace/i);
    expect(deniedReaderFactory).not.toHaveBeenCalled();

    expect(() =>
      productionAcceptanceContract({
        KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "/tests/hidden/grade.py",
      }),
    ).toThrow(/hidden/i);
    expect(() =>
      productionAcceptanceContract({ KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "artifacts/*.html" }),
    ).toThrow(/glob/i);
  });

  it("loop-breaker escalation is OFF by default; KEEL_LOOP_ESCALATION=1 opts IN (F7)", () => {
    // Default (fail-safe): the advisory loop-breaker stays FLAT — no escalateGuidance on the config.
    expect(productionLoopSafety({}).loopDetection.escalateGuidance).toBeUndefined();
    expect(productionLoopSafety({ KEEL_LOOP_ESCALATION: "0" }).loopDetection.escalateGuidance).toBe(
      undefined,
    );
    // Opt-in: escalateGuidance is set so successive advisory trips escalate the nudge.
    for (const on of ["1", "true", "yes"]) {
      const loopDetection = productionLoopSafety({ KEEL_LOOP_ESCALATION: on }).loopDetection;
      expect(loopDetection.escalateGuidance).toBe(true);
      expect(loopDetection.highBurnOutcomeRepeats).toBe(2);
    }
  });

  it("enables a cumulative token budget only when KEEL_MAX_TOKENS is a positive integer", () => {
    expect(productionLoopSafety({ KEEL_MAX_TOKENS: "500000" }).stop?.budget?.maxTokens).toBe(
      500000,
    );
    // invalid values do not silently truncate a real run
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      expect(productionLoopSafety({ KEEL_MAX_TOKENS: bad }).stop).toBeUndefined();
    }
  });

  it("sets a wall-clock run budget (ms) only when KEEL_MAX_WALL_SEC is a positive integer (ADR-0051)", () => {
    expect(productionLoopSafety({ KEEL_MAX_WALL_SEC: "840" }).stop?.maxWallMs).toBe(840_000);
    expect(productionLoopSafety({}).stop?.maxWallMs).toBeUndefined();
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      expect(productionLoopSafety({ KEEL_MAX_WALL_SEC: bad }).stop?.maxWallMs).toBeUndefined();
    }
  });

  it("parses the gross backstop + output guard (KEEL_MAX_GROSS_TOKENS / KEEL_MAX_OUTPUT_TOKENS)", () => {
    const s = productionLoopSafety({
      KEEL_MAX_TOKENS: "400000",
      KEEL_MAX_GROSS_TOKENS: "1200000",
      KEEL_MAX_OUTPUT_TOKENS: "80000",
    });
    expect(s.stop?.budget?.maxGrossTokens).toBe(1200000);
    expect(s.stop?.budget?.grossWarnThresholds).toEqual([0.8]);
    expect(s.stop?.budget?.maxOutputTokens).toBe(80000);
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      const t = productionLoopSafety({ KEEL_MAX_GROSS_TOKENS: bad, KEEL_MAX_OUTPUT_TOKENS: bad });
      expect(t.stop).toBeUndefined(); // no valid cap of any kind → no budget at all
    }
  });

  it("any one of the three caps enables the budget (none of them required to be set together)", () => {
    expect(
      productionLoopSafety({ KEEL_MAX_GROSS_TOKENS: "1200000" }).stop?.budget?.maxGrossTokens,
    ).toBe(1200000);
    expect(
      productionLoopSafety({ KEEL_MAX_OUTPUT_TOKENS: "80000" }).stop?.budget?.maxOutputTokens,
    ).toBe(80000);
  });

  it("a gross-only budget (KEEL_MAX_GROSS_TOKENS without KEEL_MAX_TOKENS) omits the effective cap", () => {
    // The matrix variant-A shape: the budget must carry maxGrossTokens but NO maxTokens, so the loop
    // caps on RAW gross with no cache discount (a true pre-ADR-0044 cap).
    const b = productionLoopSafety({ KEEL_MAX_GROSS_TOKENS: "400000" }).stop?.budget;
    expect(b?.maxGrossTokens).toBe(400000);
    expect(b?.grossWarnThresholds).toEqual([0.8]);
    expect(b?.maxTokens).toBeUndefined();
  });

  it("plumbs the provider's cacheReadWeight into the budget (anthropic 0.1× by default, others 1.0×)", () => {
    // The effective-cost cap is cost-true only with the provider's cache-read multiplier — read
    // from the capability table (ADR-0044), not hard-coded in the loop. Default provider = anthropic.
    expect(productionLoopSafety({ KEEL_MAX_TOKENS: "400000" }).stop?.budget?.cacheReadWeight).toBe(
      0.1,
    );
    expect(
      productionLoopSafety({ KEEL_MAX_TOKENS: "400000", KEEL_PROVIDER: "openai" }).stop?.budget
        ?.cacheReadWeight,
    ).toBe(1.0);
  });

  it("an unknown KEEL_PROVIDER fails safe to 1.0× (the safety-defaults function never throws)", () => {
    // resolveModelConfig owns provider validation (it throws on a bad provider). This guard must
    // not — a budget should still be installed, with the conservative full-price cache weight.
    expect(
      productionLoopSafety({ KEEL_MAX_TOKENS: "400000", KEEL_PROVIDER: "bogus" }).stop?.budget
        ?.cacheReadWeight,
    ).toBe(1.0);
  });

  it("wires KEEL_MAX_TURNS into stop.maxTurns (the matrix turn-cap knob, ER-038)", () => {
    // The cost-aware runway (matrix variants B/C) is otherwise silently clamped by
    // DEFAULT_MAX_TURNS=50 — so the matrix would test ~1.8× runway, not the budget itself. This
    // knob lets the operator raise the turn cap so the BUDGET is what binds for the cost-aware variants.
    expect(productionLoopSafety({ KEEL_MAX_TURNS: "120" }).stop?.maxTurns).toBe(120);
    expect(productionLoopSafety({ KEEL_MAX_TURNS: "120" }).stop?.maxFinalizeTurns).toBe(2);
    // invalid values never silently truncate a real run with a guessed cap (same discipline as the token caps)
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      expect(productionLoopSafety({ KEEL_MAX_TURNS: bad }).stop?.maxTurns).toBeUndefined();
    }
  });

  it("KEEL_MAX_FINALIZE_TURNS overrides the tiny progress-aware turn-cap grace window", () => {
    expect(
      productionLoopSafety({ KEEL_MAX_TURNS: "120", KEEL_MAX_FINALIZE_TURNS: "1" }).stop
        ?.maxFinalizeTurns,
    ).toBe(1);
    expect(productionLoopSafety({ KEEL_MAX_FINALIZE_TURNS: "3" }).stop).toMatchObject({
      maxFinalizeTurns: 3,
    });
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      expect(productionLoopSafety({ KEEL_MAX_FINALIZE_TURNS: bad }).stop).toBeUndefined();
    }
  });

  it("KEEL_MAX_TURNS enables stop even with NO token budget (a turn cap is not a money cap)", () => {
    const s = productionLoopSafety({ KEEL_MAX_TURNS: "120" });
    expect(s.stop?.maxTurns).toBe(120);
    expect(s.stop?.maxFinalizeTurns).toBe(2);
    expect(s.stop?.budget).toBeUndefined(); // no token cap set → no budget triad, just the turn cap
  });

  it("carries maxTurns alongside the budget triad when both are set", () => {
    const s = productionLoopSafety({ KEEL_MAX_TOKENS: "400000", KEEL_MAX_TURNS: "120" });
    expect(s.stop?.maxTurns).toBe(120);
    expect(s.stop?.maxFinalizeTurns).toBe(2);
    expect(s.stop?.budget?.maxTokens).toBe(400000);
  });

  it("enables progress runway only when explicitly configured with a token budget", () => {
    expect(
      productionLoopSafety({ KEEL_MAX_PROGRESS_RUNWAY_TURNS: "2" }).stop?.maxProgressRunwayTurns,
    ).toBeUndefined();

    const s = productionLoopSafety({
      KEEL_MAX_TOKENS: "400000",
      KEEL_MAX_PROGRESS_RUNWAY_TURNS: "2",
    });
    expect(s.stop?.budget?.maxTokens).toBe(400000);
    expect(s.stop?.maxProgressRunwayTurns).toBe(2);
  });

  it("accepts any budget rail as the progress-runway cost gate", () => {
    expect(
      productionLoopSafety({
        KEEL_MAX_GROSS_TOKENS: "1200000",
        KEEL_MAX_PROGRESS_RUNWAY_TURNS: "1",
      }).stop?.maxProgressRunwayTurns,
    ).toBe(1);
    expect(
      productionLoopSafety({
        KEEL_MAX_OUTPUT_TOKENS: "80000",
        KEEL_MAX_PROGRESS_RUNWAY_TURNS: "1",
      }).stop?.maxProgressRunwayTurns,
    ).toBe(1);
  });

  it("wires progress-runway wall seconds only when runway turns are enabled", () => {
    expect(
      productionLoopSafety({
        KEEL_MAX_PROGRESS_RUNWAY_TURNS: "2",
        KEEL_MAX_PROGRESS_RUNWAY_WALL_SEC: "60",
      }).stop?.maxProgressRunwayWallMs,
    ).toBeUndefined();

    expect(
      productionLoopSafety({
        KEEL_MAX_TOKENS: "400000",
        KEEL_MAX_PROGRESS_RUNWAY_TURNS: "2",
        KEEL_MAX_PROGRESS_RUNWAY_WALL_SEC: "60",
      }).stop?.maxProgressRunwayWallMs,
    ).toBe(60_000);
  });

  it("ignores invalid progress-runway values instead of guessing a cap", () => {
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      const s = productionLoopSafety({
        KEEL_MAX_TOKENS: "400000",
        KEEL_MAX_PROGRESS_RUNWAY_TURNS: bad,
        KEEL_MAX_PROGRESS_RUNWAY_WALL_SEC: bad,
      });
      expect(s.stop?.maxProgressRunwayTurns).toBeUndefined();
      expect(s.stop?.maxProgressRunwayWallMs).toBeUndefined();
      expect(s.stop?.budget?.maxTokens).toBe(400000);
    }
  });
});

describe("productionModelParams", () => {
  it("requests a sane per-response output budget by default", () => {
    expect(productionModelParams({}).maxOutputTokens).toBe(16_384);
  });

  it("allows KEEL_MAX_RESPONSE_TOKENS to override the per-response output budget", () => {
    expect(productionModelParams({ KEEL_MAX_RESPONSE_TOKENS: "4096" }).maxOutputTokens).toBe(4096);
  });

  it("keeps the default when KEEL_MAX_RESPONSE_TOKENS is invalid", () => {
    for (const bad of ["0", "-5", "abc", "1.5", ""]) {
      expect(productionModelParams({ KEEL_MAX_RESPONSE_TOKENS: bad }).maxOutputTokens).toBe(16_384);
    }
  });
});

describe("buildUI", () => {
  it("builds a HeadlessUI or an InkUI per the selected renderer", () => {
    const q = new InputQueue();
    expect(buildUI("headless", q)).toBeInstanceOf(HeadlessUI);
    expect(buildUI("ink", q)).toBeInstanceOf(InkUI);
  });
});

describe("runKeelCommand (bin orchestration: build runtime + store, run, dispose)", () => {
  it("validates the env-only fresh-run session pin used by reviewed headless console grants", () => {
    const id = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";

    expect(freshRunSessionIdFromEnv({ [KEEL_RUN_SESSION_ID_ENV]: id })).toBe(id);
    expect(freshRunSessionIdFromEnv({ [KEEL_RUN_SESSION_ID_ENV]: "" })).toBeUndefined();
    expect(() => freshRunSessionIdFromEnv({ [KEEL_RUN_SESSION_ID_ENV]: "not-a-session" })).toThrow(
      "KEEL_RUN_SESSION_ID must be ses_<ULID>",
    );
    expect(() =>
      freshRunSessionIdFromEnv({ [KEEL_RUN_SESSION_ID_ENV]: id }, { kind: "latest" }),
    ).toThrow("KEEL_RUN_SESSION_ID can only be used for fresh runs");

    const e = env();
    SessionStore.create({ cwd: "/w", id }, e).close();
    expect(() => assertFreshRunSessionIdAvailable(id, e)).toThrow(
      "KEEL_RUN_SESSION_ID must name a fresh session",
    );
  });

  it("honors the validated fresh-run session pin when creating the ledger", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-pinned-session-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-pinned-session-home-")),
      [KEEL_RUN_SESSION_ID_ENV]: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);

    await runKeelCommand("noop", {
      model,
      ui,
      cwd,
      env: e,
    });

    const session = readSession("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", e);
    expect(session.meta.id).toBe("ses_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(listSessions(e).map((entry) => entry.id)).toEqual(["ses_01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
  });

  it("fails closed before model or warden use when the pinned fresh-run session id already exists", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-pinned-session-collision-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-pinned-session-collision-home-")),
      [KEEL_RUN_SESSION_ID_ENV]: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    SessionStore.create({ cwd, id: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }, e).close();
    let modelCalled = false;
    const model: ModelPort = {
      async *stream() {
        modelCalled = true;
        yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    await expect(
      runKeelCommand("noop", {
        model,
        ui: new HeadlessUI(),
        cwd,
        env: e,
      }),
    ).rejects.toThrow("KEEL_RUN_SESSION_ID must name a fresh session");
    expect(modelCalled).toBe(false);
  });

  it("threads the default per-response output budget into model turns", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-max-response-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    let capturedParams: ModelTurnInput["params"] | undefined;
    const model: ModelPort = {
      async *stream(input) {
        capturedParams = input.params;
        yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    await runKeelCommand("noop", {
      model,
      ui: new HeadlessUI(),
      cwd,
      env: e,
    });

    expect(capturedParams?.maxOutputTokens).toBe(16_384);
  });

  it("threads the resolved model label into the HUD (deps.modelLabel → status line)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-hud-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);
    await runKeelCommand("noop", {
      model,
      ui,
      cwd,
      env: e,
      modelLabel: "anthropic/claude-sonnet-4-6",
    });
    expect(ui.frame()).toContain("anthropic/claude-sonnet-4-6"); // HUD names the resolved model
  });

  it("wraps the configured model in the governed routing gateway and records a route decision", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-route-product-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-route-home-")) };
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);

    await runKeelCommand("noop", {
      model,
      ui,
      cwd,
      env: e,
      modelLabel: "anthropic/claude-sonnet-4-6",
    });

    expect(ui.frame()).toContain("anthropic/claude-sonnet-4-6");
    const session = listSessions(e)[0];
    expect(session).toBeDefined();
    const file = readSession(session!.id, e);
    const route = file.events.find((event) => event.type === "model_route");
    expect(route).toMatchObject({
      type: "model_route",
      decision: {
        status: "selected",
        mode: "locked",
        selected: { ref: "anthropic/claude-sonnet-4-6@local-current" },
      },
    });
  });

  it("threads cwd-scoped recent sessions into the interactive first-run view before creating the new session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-recent-cwd-"));
    const other = mkdtempSync(join(tmpdir(), "keel-recent-other-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-recent-home-")) };

    const prior = SessionStore.create({ cwd }, e);
    prior.append({ type: "user", v: 1, ts: "2026-06-22T00:00:00.000Z", content: "fix prior bug" });
    prior.append({
      type: "run_status",
      v: 1,
      ts: new Date().toISOString(),
      reason: "model-stop",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    prior.close();
    const wrongWorkspace = SessionStore.create({ cwd: other }, e);
    wrongWorkspace.append({
      type: "user",
      v: 1,
      ts: "2026-06-22T00:00:00.000Z",
      content: "other workspace task",
    });
    wrongWorkspace.append({
      type: "run_status",
      v: 1,
      ts: new Date().toISOString(),
      reason: "model-stop",
      usage: { inputTokens: 9_000, outputTokens: 1_000 },
    });
    wrongWorkspace.close();

    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
    });
    await ui.awaitRender((v) => v.awaitingInput === true && v.firstRun === true);
    ui.queue.close();
    await run;

    expect(ui.latest?.recentSessions?.map((s) => s.summary)).toEqual(["fix prior bug"]);
    expect(ui.latest?.recentSessions?.[0]).toMatchObject({ tokens: 1_000, outcome: "done" });
    expect(ui.latest?.recentSessions?.[0]?.resumeCommand).toContain(prior.id);
    expect(ui.latest?.recentSessions?.some((s) => s.summary.includes("other workspace"))).toBe(
      false,
    );
    expect(ui.latest?.usageDigest).toEqual({
      scope: "workspace",
      windows: [
        { label: "24h", tokens: 1_000, runs: 1 },
        { label: "7d", tokens: 1_000, runs: 1 },
      ],
    });
    expect(listSessions(e)).toHaveLength(3); // two priors + the fresh session just opened
  });

  it("paints an honest interactive first-run shell before slow warden startup completes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-early-paint-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-early-paint-home-")),
    };
    const ui = new TestUI();

    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
      modelLabel: "anthropic/claude-sonnet-4-6",
      warden: delayedStartupWarden(300),
    });
    const earlyPainted = await Promise.race([
      ui
        .awaitRender((v) => {
          const frame = renderFrame(v);
          return (
            v.awaitingInput === true &&
            v.firstRun === true &&
            frame.includes("protection: starting · input waits") &&
            !frame.includes("status not reported")
          );
        })
        .then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 75)),
    ]);
    ui.queue.close();
    await run;

    expect(earlyPainted).toBe(true);
  });

  it("overlaps the trusted fresh-run backup with warden startup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-overlap-backup-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-overlap-backup-home-")),
      KEEL_TRUST: "1",
    };
    const ui = new TestUI();
    const wardenGate = join(e["KEEL_HOME"]!, "allow-warden-startup");
    let resolveBackupStarted!: () => void;
    const backupStarted = new Promise<void>((resolve) => {
      resolveBackupStarted = resolve;
    });

    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
      warden: gatedStartupWarden(wardenGate),
      backupWorkspace: async () => {
        resolveBackupStarted();
        return undefined;
      },
    });
    await backupStarted;
    writeFileSync(wardenGate, "ready");
    ui.queue.close();
    await run;

    expect(ui.latest).toBeDefined();
  });

  it("overlaps trusted git status with warden startup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-overlap-git-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-overlap-git-home-")),
      KEEL_TRUST: "1",
      KEEL_NO_SNAPSHOT: "1",
    };
    const ui = new TestUI();
    const wardenGate = join(e["KEEL_HOME"]!, "allow-warden-startup");
    let resolveGitStarted!: () => void;
    const gitStarted = new Promise<void>((resolve) => {
      resolveGitStarted = resolve;
    });

    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
      warden: gatedStartupWarden(wardenGate),
      readGitStatus: async () => {
        resolveGitStarted();
        return { branch: "main", added: 0, modified: 0, deleted: 0 };
      },
    });
    await gitStarted;
    writeFileSync(wardenGate, "ready");
    ui.queue.close();
    await run;

    expect(ui.latest).toBeDefined();
  });

  it("does not let an unresolved cosmetic git probe delay governed input readiness", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-nonblocking-git-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-nonblocking-git-home-")),
      KEEL_TRUST: "1",
      KEEL_NO_SNAPSHOT: "1",
    };
    const ui = new TestUI();
    let releaseGit!: () => void;
    const unresolvedGit = new Promise<UiGitStatus | undefined>((resolve) => {
      releaseGit = () => resolve(undefined);
    });
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
      readGitStatus: () => unresolvedGit,
    });

    await ui.awaitRender(
      (view) => view.awaitingInput === true && view.status.startup === undefined,
    );
    releaseGit();
    ui.queue.close();
    await run;

    expect(ui.latest?.status.git).toBeUndefined();
    expect(ui.latest?.status.protectionRoute).toBe("governed");
  });

  it("does not probe git after workspace trust is declined", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-untrusted-git-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-untrusted-git-home-")),
      KEEL_NO_SNAPSHOT: "1",
    };
    const ui = new TestUI();
    const readGitStatus = vi.fn(async () => ({
      branch: "must-not-render",
      added: 0,
      modified: 0,
      deleted: 0,
    }));

    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
      isTTY: true,
      promptTrust: async () => false,
      readGitStatus,
    });
    await ui.awaitRender((view) => view.awaitingInput === true);
    ui.queue.close();
    await run;

    expect(readGitStatus).not.toHaveBeenCalled();
    expect(ui.latest?.status.git).toBeUndefined();
    expect(ui.latest?.status.workspaceTrust).toBe("untrusted");
  });

  it("preserves input entered while the warden is still starting", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-startup-input-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-startup-input-home-")),
      KEEL_NO_SNAPSHOT: "1",
    };
    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "queued input received" }] }),
      ui,
      cwd,
      env: e,
      warden: delayedStartupWarden(300),
    });

    await ui.awaitRender((view) => view.status.startup?.phase === "starting-protections");
    ui.queue.push({ kind: "line", text: "answer this after protections start" });
    await ui.awaitRender((view) => assistantSaid(view, "queued input received"));
    ui.queue.close();
    await run;

    expect(assistantSaid(ui.latest!, "queued input received")).toBe(true);
  });

  it("restores the UI before joining an in-flight backup on failed startup", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-failed-startup-backup-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-failed-startup-backup-home-")),
      KEEL_TRUST: "1",
    };
    const ui = new TestUI();
    let releaseBackup!: () => void;
    const backupBlocked = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    let settled = false;
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "unused" }] }),
      ui,
      cwd,
      env: e,
      warden: failingStartupWarden(),
      backupWorkspace: async () => {
        await backupBlocked;
        return undefined;
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    void run.then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(ui.closes).toBe(1), { timeout: 1_000 });
    expect(settled).toBe(false);
    releaseBackup();
    expect(await run).toBeInstanceOf(Error);
    expect(ui.closes).toBe(1);
  });

  it("closes the early-painted interactive UI exactly once when warden startup fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-early-paint-failure-cwd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-early-paint-failure-home-")),
    };
    const ui = new TestUI();

    await expect(
      runKeelCommand(undefined, {
        model: new ScriptedModel({ turns: [{ text: "unused" }] }),
        ui,
        cwd,
        env: e,
        modelLabel: "anthropic/claude-sonnet-4-6",
        warden: failingStartupWarden(),
      }),
    ).rejects.toThrow(/warden|unavailable|exited|closed/i);

    expect(renderFrame(ui.latest!)).toContain("protection: starting · input waits");
    expect(ui.closes).toBe(1);
  });

  it("constructs the governed bash runtime + session, runs the prompt, and cleans up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
    };
    const auditDir = mkdtempSync(join(tmpdir(), "keel-cmd-audit-"));
    const ui = new HeadlessUI();
    const model = new ScriptedModel({
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "printf 'by keel' > made.txt" } }] },
        { text: "wrote made.txt" },
      ],
    } satisfies SimulatorScriptT);

    await runKeelCommand("create made.txt", {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      warden: fakeBashWarden(auditDir),
    });

    // the governed bash tool ran (file on disk) and a session was persisted + closed
    expect(readFileSync(join(cwd, "made.txt"), "utf8")).toBe("by keel");
    const sessions = listSessions(e);
    expect(sessions).toHaveLength(1);
    const auditRecords = readFileSync(join(auditDir, `${sessions[0]!.id}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
    expect(auditRecords.every((record) => record.policyPack !== undefined)).toBe(true);
    const frame = ui.frame();
    expect(frame).toContain("wrote made.txt");
    expect(frame).toContain("sandbox on");
    expect(frame).toContain("egress guard on");
    expect(frame).toContain("policy Guided · phase2a-starter-policy-pack@");
    expect(frame).not.toContain("no enforcement");

    // the §4.7 system prompt was seeded as the conversation's first (system) message
    const msgs = rebuild(readSession(sessions[0]!.id, e)).messages;
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toMatch(/governance-native coding agent/);
  });

  it("threads human CLI Autopilot into the production warden runtime only after trust", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-autopilot-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
    };
    const auditDir = mkdtempSync(join(tmpdir(), "keel-cmd-autopilot-audit-"));
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);

    await runKeelCommand("noop", {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      autonomy: {
        mode: "autopilot",
        source: "human",
        userConfirmed: true,
        reason: "cli --autopilot",
      },
      warden: fakeBashWarden(auditDir),
    });

    expect(ui.frame()).toContain("policy Autopilot · phase2a-starter-policy-pack@");
    const session = listSessions(e)[0]!;
    const records = readFileSync(join(auditDir, `${session.id}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
    expect(records.every((record) => record.policyPack !== undefined)).toBe(true);
  });

  it("persists Autopilot command auto-resolutions into the session ledger for receipts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-autopilot-receipt-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
      USER: "session-entry-user",
    };
    const ui = new HeadlessUI();
    const model = new ScriptedModel({
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
        { text: "checked" },
      ],
    } satisfies SimulatorScriptT);

    await runKeelCommand("run check", {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      autonomy: {
        mode: "autopilot",
        source: "human",
        userConfirmed: true,
        reason: "cli --autopilot",
      },
      warden: fakeAutopilotCommandReviewWarden(),
    });

    const events = readSession(listSessions(e)[0]!.id, e).events;
    const receiptEvent = events.find(
      (event): event is Extract<typeof event, { type: "warden_auto_resolved" }> =>
        (event as { readonly type: string }).type === "warden_auto_resolved",
    );

    expect(receiptEvent).toMatchObject({
      type: "warden_auto_resolved",
      source: "autopilot-command",
      resource: {
        kind: "command-key",
        value: `sha256:${"a".repeat(64)}`,
      },
      reviewId: "command_review_1",
      scope: "once",
      auditSeq: 5,
      verdict: "allow",
      toolCallId: "call_0_0",
      toolName: "bash",
    });
  });

  it("wires interactive review approval into the governed runtime without turning the answer into steering", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-interactive-review-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
      USER: "session-entry-user",
    };
    const ui = new TestUI();
    const model = new ScriptedModel({
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
        { text: "checked" },
      ],
    } satisfies SimulatorScriptT);
    const waitFor = async (label: string, pred: (view: ViewModel) => boolean): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for ${label}; latest frame: ${ui.latest === undefined ? "<none>" : renderFrame(ui.latest)}`,
              ),
            ),
          5_000,
        );
        void ui.awaitRender(pred).then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    };

    const done = runKeelCommand(undefined, {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      warden: fakeAutopilotCommandReviewWarden(),
    });
    ui.queue.push({ kind: "line", text: "run check" });
    await waitFor("first approval", (view) => renderFrame(view).includes("approval required"));
    ui.queue.push({ kind: "command", name: "/approve", args: "project" });
    await waitFor("project rejection", (view) => {
      const frame = renderFrame(view);
      return (
        frame.includes("project approval is unavailable") && frame.includes("Project Autopilot")
      );
    });
    ui.queue.push({ kind: "command", name: "/approve", args: "once" });
    await waitFor("warden confirmation", (view) =>
      renderFrame(view).includes("review decision confirmed by warden · verdict allow"),
    );
    await waitFor(
      "confirmed answer",
      (view) => view.awaitingInput === true && assistantSaid(view, "checked"),
    );
    ui.queue.push({ kind: "command", name: "/exit" });
    await done;

    const session = readSession(listSessions(e)[0]!.id, e);
    const toolResults = session.events.filter((event) => event.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ type: "tool_result" });
    expect(toolResults[0]?.isError).not.toBe(true);
    expect(toolResults[0]?.output).toContain("runtime-autopilot-ok");
    expect(rebuild(session).messages).not.toContainEqual({
      role: "user",
      content: "/approve once",
    });
    const finalFrame = renderFrame(ui.latest!);
    expect(finalFrame).toContain("approval settled · approved once");
    expect(finalFrame).toContain(
      "history · earlier approval-required block is historical/resolved",
    );
    expect(finalFrame).toContain(
      "authority · limited to that governed attempt; no reusable authority remains; repeating it requires a fresh review",
    );
    expect(finalFrame).toContain("detail · confirmed by warden");
    expect(finalFrame).toContain("checked");
    expect(finalFrame).not.toMatch(/actions:|\[[ads?]\]|allow: keel approve/i);
  });

  it("wires interactive /plan approve into the next governed runtime turn only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-interactive-plan-"));
    const commandKey = `sha256:${"a".repeat(64)}`;
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
      USER: "session-entry-user",
    };
    const ui = new TestUI();
    const model = new ScriptedModel({
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
        { text: "checked" },
      ],
    } satisfies SimulatorScriptT);

    const done = runKeelCommand(undefined, {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      warden: fakeAutopilotCommandReviewWarden(),
    });

    await ui.awaitRender((view) => view.awaitingInput === true);
    ui.queue.push({
      kind: "command",
      name: "/plan",
      args: `preview --plan-id interactive-fix --command-key ${commandKey}`,
    });
    await ui.awaitRender((view) => renderFrame(view).includes("Plan Autopilot preview"));
    ui.queue.push({
      kind: "command",
      name: "/plan",
      args: `approve --plan-id interactive-fix --command-key ${commandKey}`,
    });
    await ui.awaitRender((view) =>
      renderFrame(view).includes("approved for the next plain task line only"),
    );
    ui.queue.push({ kind: "line", text: "run check" });
    await ui.awaitRender((view) => view.awaitingInput === true && assistantSaid(view, "checked"));
    ui.queue.push({ kind: "command", name: "/exit" });
    await done;

    const frame = renderFrame(ui.latest!);
    expect(frame).toContain("checked");
    expect(frame).toContain("policy Guided · phase2a-starter-policy-pack@");
    expect(frame).not.toContain("policy Plan Autopilot");

    const session = readSession(listSessions(e)[0]!.id, e);
    const messages = rebuild(session).messages;
    expect(messages).toContainEqual({ role: "user", content: "run check" });
    expect(messages).toContainEqual({ role: "assistant", content: "checked" });
    expect(messages).not.toContainEqual({
      role: "user",
      content: `/plan approve --plan-id interactive-fix --command-key ${commandKey}`,
    });
    const receiptEvent = session.events.find(
      (event): event is Extract<typeof event, { type: "warden_auto_resolved" }> =>
        (event as { readonly type: string }).type === "warden_auto_resolved",
    );
    expect(receiptEvent).toMatchObject({
      type: "warden_auto_resolved",
      source: "plan-approval",
      planId: "interactive-fix",
      resource: {
        kind: "command-key",
        value: commandKey,
      },
      reviewId: "command_review_1",
      scope: "once",
      verdict: "allow",
      toolCallId: "call_0_0",
      toolName: "bash",
    });
  });

  it("wires interactive /plan approve domain resources into the governed runtime", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-interactive-plan-domain-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
      USER: "session-entry-user",
    };
    const ui = new TestUI();
    const model = new ScriptedModel({
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "curl https://example.com" } }] },
        { text: "fetched" },
      ],
    } satisfies SimulatorScriptT);

    const done = runKeelCommand(undefined, {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      warden: fakeAutopilotDomainReviewWarden(),
    });

    await ui.awaitRender((view) => view.awaitingInput === true);
    ui.queue.push({
      kind: "command",
      name: "/plan",
      args: "approve --plan-id domain-plan --domain example.com",
    });
    await ui.awaitRender((view) =>
      renderFrame(view).includes("approved for the next plain task line only"),
    );
    ui.queue.push({ kind: "line", text: "fetch example" });
    await ui.awaitRender((view) => view.awaitingInput === true && assistantSaid(view, "fetched"));
    ui.queue.push({ kind: "command", name: "/exit" });
    await done;

    const session = readSession(listSessions(e)[0]!.id, e);
    const messages = rebuild(session).messages;
    expect(messages).toContainEqual({ role: "user", content: "fetch example" });
    expect(messages).toContainEqual({ role: "assistant", content: "fetched" });
    expect(messages).not.toContainEqual({
      role: "user",
      content: "/plan approve --plan-id domain-plan --domain example.com",
    });
    const receiptEvent = session.events.find(
      (event): event is Extract<typeof event, { type: "warden_auto_resolved" }> =>
        (event as { readonly type: string }).type === "warden_auto_resolved",
    );
    expect(receiptEvent).toMatchObject({
      type: "warden_auto_resolved",
      source: "plan-approval",
      planId: "domain-plan",
      resource: {
        kind: "domain",
        value: "example.com",
      },
      reviewId: "egress_review_1",
      scope: "once",
      verdict: "allow",
      toolCallId: "call_0_0",
      toolName: "bash",
    });
  });

  it("threads exact-resource Plan Autopilot run approvals into the production warden runtime", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-plan-autopilot-"));
    const commandKey = `sha256:${"a".repeat(64)}`;
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
      USER: "session-entry-user",
    };
    const ui = new HeadlessUI();
    const model = new ScriptedModel({
      turns: [
        { toolCalls: [{ name: "bash", args: { command: "python3 tools/check.py" } }] },
        { text: "checked" },
      ],
    } satisfies SimulatorScriptT);

    await runKeelCommand("run check", {
      model,
      ui,
      cwd,
      env: e,
      trustFlag: true,
      planApproval: {
        planId: "plan-auth-fix",
        resources: [{ kind: "command-key", value: commandKey }],
      },
      warden: fakeAutopilotCommandReviewWarden(),
    });

    expect(ui.frame()).toContain("policy Plan Autopilot · phase2a-starter-policy-pack@");
    expect(ui.frame()).toContain("Plan Autopilot plan-auth-fix allowed bash");
    const events = readSession(listSessions(e)[0]!.id, e).events;
    const receiptEvent = events.find(
      (event): event is Extract<typeof event, { type: "warden_auto_resolved" }> =>
        (event as { readonly type: string }).type === "warden_auto_resolved",
    );

    expect(receiptEvent).toMatchObject({
      type: "warden_auto_resolved",
      source: "plan-approval",
      planId: "plan-auth-fix",
      resource: {
        kind: "command-key",
        value: commandKey,
      },
      reviewId: "command_review_1",
      scope: "once",
      auditSeq: 5,
      verdict: "allow",
      toolCallId: "call_0_0",
      toolName: "bash",
    });
  });

  it("refuses CLI Autopilot at the runtime boundary without workspace trust", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-autopilot-untrusted-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
    };
    const auditDir = mkdtempSync(join(tmpdir(), "keel-cmd-autopilot-untrusted-audit-"));
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);

    await runKeelCommand("noop", {
      model,
      ui,
      cwd,
      env: e,
      autonomy: {
        mode: "autopilot",
        source: "human",
        userConfirmed: true,
        reason: "cli --autopilot",
      },
      warden: fakeBashWarden(auditDir),
    });

    const frame = ui.frame();
    expect(frame).toContain("policy Guided · phase2a-starter-policy-pack@");
    expect(frame).not.toContain("Autopilot ·");

    const session = listSessions(e)[0]!;
    const records = readFileSync(join(auditDir, `${session.id}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
    expect(records.every((record) => record.policyPack !== undefined)).toBe(true);
    const modeChange = records.find((record) => record.eventType === "mode.change");
    expect(modeChange?.payload).toMatchObject({
      accepted: false,
      nextMode: "guided",
      reason: "Autopilot requires a trusted workspace",
      requestedMode: "autopilot",
      requestedSource: "human",
      requestReason: "cli --autopilot",
      trustedWorkspace: false,
    });
    expect(typeof modeChange?.payload["workspaceRoot"]).toBe("string");
  });

  it("loads persisted Project Autopilot mode from user config only after workspace trust", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-cmd-project-autopilot-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: join(cwd, ".keel"),
      KEEL_NO_SNAPSHOT: "1",
    };
    const auditDir = mkdtempSync(join(tmpdir(), "keel-cmd-project-autopilot-audit-"));
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);
    saveTrustDecision(cwd, "trusted", e);
    expect(saveProjectAutopilotMode(cwd, "project-autopilot", e)).toBe("saved");

    await runKeelCommand("noop", {
      model,
      ui,
      cwd,
      env: e,
      warden: fakeBashWarden(auditDir),
    });

    expect(ui.frame()).toContain("policy Project Autopilot · phase2a-starter-policy-pack@");

    const session = listSessions(e)[0]!;
    const records = readFileSync(join(auditDir, `${session.id}.jsonl`), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => AnyAuditRecord.parse(JSON.parse(line)));
    expect(records.every((record) => record.policyPack !== undefined)).toBe(true);
    const modeChange = records.find((record) => record.eventType === "mode.change");
    expect(modeChange?.payload).toMatchObject({
      accepted: true,
      nextMode: "project-autopilot",
      requestedMode: "project-autopilot",
      requestedSource: "human",
      requestReason: "persisted project Autopilot mode",
      trustedWorkspace: true,
    });
  });

  it("post-trust: gathers + seeds the environment snapshot as a system message after the prompt", async () => {
    // Epic 1.7: the snapshot is no longer injected by the bin — runKeelCommand gathers it through the
    // trust gate. KEEL_TRUST=1 is the explicit opt-in; the snapshot then reads the real (temp) cwd.
    const cwd = mkdtempSync(join(tmpdir(), "keel-env-cmd-"));
    writeFileSync(join(cwd, "package.json"), "{}");
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd, KEEL_TRUST: "1" };
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });
    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs[0]?.content).toMatch(/governance-native/); // system prompt first
    expect(msgs[1]?.role).toBe("system"); // environment snapshot second
    expect(msgs[1]?.content).toMatch(/# Environment/);
    expect(msgs[1]?.content).toMatch(/package\.json/); // read from the real cwd through the gate
  });

  it("untrusted (default): no environment snapshot is seeded — the agent runs with empty context", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-env-untrusted-"));
    writeFileSync(join(cwd, "package.json"), "{}");
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });
    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs[0]?.content).toMatch(/governance-native/); // system prompt still seeds
    expect(msgs.some((m) => m.content.includes("# Environment"))).toBe(false); // no project context
  });

  // Epic 1.16/1.19: a STOP-biased phrase shared by BOTH gate prompts (standard + the execution-grounded
  // "unverified" variant), so this e2e check is robust to which one the gate selects.
  const VERIFY_MARK = "the smallest fix for that specific failure, then stop";

  it("fires the pre-completion verification interceptor when KEEL_VERIFY=1 (opt-in, wired end-to-end)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-verify-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd, KEEL_VERIFY: "1" };
    // Turn 1 would model-stop → verification injects ONE verify turn → turn 2 then stops.
    const model = new ScriptedModel({
      turns: [{ text: "first attempt" }, { text: "verified, done" }],
    } satisfies SimulatorScriptT);
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });
    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs.some((m) => m.role === "user" && m.content.includes(VERIFY_MARK))).toBe(true);
  });

  it("does NOT fire the interceptor by default (no KEEL_VERIFY → no verify turn injected)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-noverify-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const model = new ScriptedModel({ turns: [{ text: "done" }] } satisfies SimulatorScriptT);
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });
    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs.some((m) => m.content.includes(VERIFY_MARK))).toBe(false);
  });

  it("runs an explicit pre-stop check from the task cwd, not the parent process cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-prestop-cwd-"));
    writeFileSync(join(cwd, "prestop-sentinel.txt"), "present");
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_VERIFY: "1",
      KEEL_VERIFY_MODE: "prestop",
      KEEL_PRESTOP_CHECK_CMD: "test -f prestop-sentinel.txt",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }, { text: "should not be needed" }],
    } satisfies SimulatorScriptT);

    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(
      msgs.some(
        (m) => m.role === "user" && m.content.includes("Fresh pre-stop verification failed"),
      ),
    ).toBe(false);
    expect(msgs.some((m) => m.content.includes("should not be needed"))).toBe(false);
  });

  it("runs an explicit required-artifact acceptance contract from the trusted task cwd without KEEL_VERIFY", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-acceptance-artifact-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_TRUST: "1",
      KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }, { text: "still missing" }],
    } satisfies SimulatorScriptT);

    const outcome = await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(
      msgs.some((m) => m.role === "user" && m.content.includes("Acceptance contract failed")),
    ).toBe(true);
    expect(msgs.some((m) => m.content.includes("answer.txt"))).toBe(true);
    expect(msgs.some((m) => m.content.includes(VERIFY_MARK))).toBe(false);
    expect(outcome.lastStop).toBe("error");
  });

  it("accepts a passing explicit required-artifact contract without KEEL_VERIFY or an extra prompt-verifier turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-acceptance-artifact-pass-"));
    writeFileSync(join(cwd, "answer.txt"), "42\n");
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_TRUST: "1",
      KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }, { text: "should not be needed" }],
    } satisfies SimulatorScriptT);

    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs.some((m) => m.role === "user" && m.content.includes("Before you finish"))).toBe(
      false,
    );
    expect(msgs.some((m) => m.content.includes(VERIFY_MARK))).toBe(false);
    expect(msgs.some((m) => m.content.includes("should not be needed"))).toBe(false);
  });

  it("accepts a passing explicit required-artifact contract before the KEEL_VERIFY prompt verifier", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-acceptance-artifact-pass-verify-"));
    writeFileSync(join(cwd, "answer.txt"), "42\n");
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_TRUST: "1",
      KEEL_VERIFY: "1",
      KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }, { text: "should not be needed" }],
    } satisfies SimulatorScriptT);

    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs.some((m) => m.content.includes(VERIFY_MARK))).toBe(false);
    expect(msgs.some((m) => m.content.includes("should not be needed"))).toBe(false);
  });

  it("keeps KEEL_PRESTOP_CHECK_CMD ignored when artifact acceptance is configured without KEEL_VERIFY", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-acceptance-artifact-no-prestop-"));
    writeFileSync(join(cwd, "answer.txt"), "42\n");
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_TRUST: "1",
      KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt",
      KEEL_PRESTOP_CHECK_CMD: "exit 42",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }, { text: "should not be needed" }],
    } satisfies SimulatorScriptT);

    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const msgs = rebuild(readSession(listSessions(e)[0]!.id, e)).messages;
    expect(msgs.some((m) => m.content.includes("Acceptance contract failed"))).toBe(false);
    expect(msgs.some((m) => m.content.includes(VERIFY_MARK))).toBe(false);
    expect(msgs.some((m) => m.content.includes("should not be needed"))).toBe(false);
  });

  it("refuses required-artifact acceptance in an untrusted workspace before project artifact reads", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-acceptance-artifact-untrusted-"));
    writeFileSync(join(cwd, "answer.txt"), "42\n");
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }],
    } satisfies SimulatorScriptT);

    await expect(
      runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e }),
    ).rejects.toThrow(/requires a trusted workspace/i);
    expect(listSessions(e)).toHaveLength(0);
  });

  it("refuses required-artifact acceptance after an explicit interactive trust decline", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-acceptance-artifact-declined-"));
    writeFileSync(join(cwd, "answer.txt"), "42\n");
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS: "answer.txt",
    };
    const model = new ScriptedModel({
      turns: [{ text: "done" }],
    } satisfies SimulatorScriptT);

    await expect(
      runKeelCommand("go", {
        model,
        ui: new HeadlessUI(),
        cwd,
        env: e,
        isTTY: true,
        promptTrust: async () => false,
      }),
    ).rejects.toThrow(/requires a trusted workspace/i);
    expect(listSessions(e)).toHaveLength(0);
  });

  it("builds the in-loop compactor when KEEL_COMPACTION=1 (wiring path stays covered)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-compact-on-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_COMPACTION: "1",
      KEEL_CONTEXT_WINDOW: "12345",
      KEEL_COMPACTION_RECENT: "2",
      KEEL_MAX_GROSS_TOKENS: "50000",
    };
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "done" }] } satisfies SimulatorScriptT);

    await runKeelCommand("go", { model, ui, cwd, env: e });

    expect(ui.frame()).toContain("done");
    expect(listSessions(e)).toHaveLength(1);
  });

  it("uses provider/model context-window metadata for the HUD and typed pressure denominator", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-context-window-"));
    const e: NodeJS.ProcessEnv = {
      KEEL_HOME: cwd,
      KEEL_PROVIDER: "openai-compatible",
      KEEL_MODEL: "laguna-fp8",
    };
    const ui = new HeadlessUI();
    const model: ModelPort = {
      async *stream() {
        yield { type: "text-delta", text: "done" };
        yield {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 131_000, outputTokens: 1 },
        };
      },
    };

    await runKeelCommand("go", {
      model,
      ui,
      cwd,
      env: e,
      modelLabel: "openai-compatible/laguna-fp8",
    });

    expect(ui.frame()).not.toContain("ctx n/a");
    expect(ui.frame()).toContain("131k tokens");
  });

  it("post-trust: retains a private faithful snapshot without disclosing its path to the model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-snap-cwd-"));
    const kh = mkdtempSync(join(tmpdir(), "keel-snap-home-"));
    chmodSync(kh, 0o755); // regression: a permissive pre-existing root must be tightened before copy
    writeFileSync(join(cwd, "main.db-wal"), "irreplaceable"); // the kind of input keel must not destroy
    writeFileSync(join(cwd, ".env"), "FAKE_SNAPSHOT_SECRET_NOT_FOR_MODEL");
    const e: NodeJS.ProcessEnv = { KEEL_HOME: kh, KEEL_TRUST: "1" };
    let modelInput: ModelTurnInput | undefined;
    const model: ModelPort = {
      async *stream(input) {
        modelInput = input;
        yield { type: "text-delta", text: "ok" } as const;
        yield {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        } as const;
      },
    };
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const sessionId = listSessions(e)[0]!.id;
    // the original survives in a read-only backup even if the run had destroyed the live file
    expect(readFileSync(join(kh, "snapshots", sessionId, "main.db-wal"), "utf8")).toBe(
      "irreplaceable",
    );
    expect(readFileSync(join(kh, "snapshots", sessionId, ".env"), "utf8")).toBe(
      "FAKE_SNAPSHOT_SECRET_NOT_FOR_MODEL",
    );
    expect(statSync(kh).mode & 0o777).toBe(0o700);
    // The model may know only that a private human-only snapshot exists. The concrete host path and
    // governed-tool recovery instructions are intentionally absent; Warden's whole-home deny remains.
    const msgs = rebuild(readSession(sessionId, e)).messages;
    const backupNote = msgs.find((m) => m.content.includes("Workspace backup"));
    expect(backupNote?.content).toMatch(/private.*human-only|human-only.*private/i);
    expect(backupNote?.content).not.toContain(join(kh, "snapshots", sessionId));
    expect(backupNote?.content).not.toMatch(/\bcp\b/);
    const providerContext = JSON.stringify(modelInput?.messages ?? []);
    expect(providerContext).not.toContain(join(kh, "snapshots", sessionId));
    expect(providerContext).not.toContain("FAKE_SNAPSHOT_SECRET_NOT_FOR_MODEL");
  });

  it("KEEL_NO_SNAPSHOT opts out: no backup dir is written and no backup note is seeded", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-noopt-cwd-"));
    const kh = mkdtempSync(join(tmpdir(), "keel-noopt-home-"));
    writeFileSync(join(cwd, "main.db-wal"), "x");
    const e: NodeJS.ProcessEnv = { KEEL_HOME: kh, KEEL_TRUST: "1", KEEL_NO_SNAPSHOT: "1" };
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const sessionId = listSessions(e)[0]!.id;
    expect(existsSync(join(kh, "snapshots", sessionId))).toBe(false);
    const msgs = rebuild(readSession(sessionId, e)).messages;
    expect(msgs.some((m) => m.content.includes("Workspace backup"))).toBe(false);
  });

  it("SEC-012 denied path: an UNTRUSTED run takes no workspace backup (no copy of an untrusted tree)", async () => {
    // The snapshot reads/copies workspace bytes — that must NOT happen before trust is granted
    // (SEC-012 trust-before-parse). With no KEEL_TRUST opt-in, no snapshot dir is written and no
    // backup note is seeded, even though a backup WOULD be taken for the same workspace once trusted.
    const cwd = mkdtempSync(join(tmpdir(), "keel-untrust-snap-cwd-"));
    const kh = mkdtempSync(join(tmpdir(), "keel-untrust-snap-home-"));
    writeFileSync(join(cwd, "main.db-wal"), "irreplaceable");
    const e: NodeJS.ProcessEnv = { KEEL_HOME: kh }; // NO KEEL_TRUST → untrusted
    const model = new ScriptedModel({ turns: [{ text: "ok" }] } satisfies SimulatorScriptT);
    await runKeelCommand("go", { model, ui: new HeadlessUI(), cwd, env: e });

    const sessionId = listSessions(e)[0]!.id;
    expect(existsSync(join(kh, "snapshots", sessionId))).toBe(false); // no copy of the untrusted tree
    const msgs = rebuild(readSession(sessionId, e)).messages;
    expect(msgs.some((m) => m.content.includes("Workspace backup"))).toBe(false);
  });
});

describe("runKeelCommand resume (Epic 1.23 slice 2 — --continue / --resume continue the SAME ledger)", () => {
  const asstSaid = (v: ViewModel, c: string): boolean =>
    v.items.some((it) => it.kind === "message" && it.role === "assistant" && it.content === c);

  it("threads durable failed-tool outcomes into the product resume view", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-outcome-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const store = SessionStore.create({ cwd }, e);
    const ts = new Date().toISOString();
    store.append({ type: "system", v: 1, ts, content: "SYSTEM-PREAMBLE-PRIVATE" });
    store.append({ type: "user", v: 1, ts, content: "try the write" });
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "",
      toolCalls: [{ id: "denied", name: "write", args: { path: "/outside" } }],
    });
    store.append({
      type: "tool_result",
      v: 1,
      ts,
      toolCallId: "denied",
      name: "write",
      output: "blocked by warden (not executed): POL-002 deny: outside workspace",
      isError: true,
    });
    store.append({ type: "assistant", v: 1, ts, content: "The write was blocked." });
    store.close();

    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [] }),
      ui,
      cwd,
      env: e,
      resume: { kind: "id", id: store.id },
    });
    await ui.awaitRender((v) => v.awaitingInput === true && asstSaid(v, "The write was blocked."));

    const frame = renderFrame(ui.latest!, false);
    expect(frame).toContain("what: blocked: write:");
    expect(frame).not.toContain("SYSTEM-PREAMBLE-PRIVATE");
    expect(frame).not.toContain("tool  ✓ write  done");

    ui.queue.close();
    await run;
  });

  it("loads the verified Warden audit receipt for spent once-only authority into the resume view only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-once-receipt-cwd-"));
    const keelState = mkdtempSync(join(tmpdir(), "keel-resume-once-receipt-home-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: keelState, KEEL_NO_SNAPSHOT: "1" };
    const store = SessionStore.create({ cwd }, e);
    const ts = "2026-07-27T00:00:00.000Z";
    store.append({ type: "user", v: 1, ts, content: "remove the file" });
    store.append({
      type: "assistant",
      v: 1,
      ts,
      content: "The reviewed removal completed.",
    });
    store.close();

    const auditDir = join(keelState, "audit");
    mkdirSync(auditDir, { recursive: true });
    const principal: PrincipalT = {
      osUser: "operator",
      configuredId: null,
      authProvider: "local",
      assurance: "local-os-user",
    };
    const commandKey = `sha256:${"a".repeat(64)}`;
    const sideEffect: SideEffectT = {
      taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
      staticCapability: { toolName: "bash", effectEnvelope: ["fs_write"], broad: true },
      dynamic: {
        effectKinds: ["fs_write"],
        scopes: ["workspace"],
        targets: [],
        modifiers: ["destructive"],
        composition: {
          kind: "atomic",
          segments: [
            {
              effectKinds: ["fs_write"],
              scopes: ["workspace"],
              targets: [],
              modifiers: ["destructive"],
            },
          ],
          edges: [],
        },
        classifier: { name: "test", version: "1", confidence: "exact", reasons: ["test"] },
      },
    };
    const audit = AuditChainWriter.open({
      path: join(auditDir, `${store.id}.jsonl`),
      principal,
      now: () => ts,
    });
    audit.append({
      eventType: "review.requested",
      sessionId: store.id,
      payload: {
        reviewId: "command_review_1",
        command: "rm review-delete.txt",
        commandGrant: {
          key: commandKey,
          scope: "once",
          kind: "once-only-command-review",
        },
      },
    });
    audit.append({
      eventType: "review.resolved",
      sessionId: store.id,
      payload: {
        reviewId: "command_review_1",
        approved: true,
        requestedApproval: true,
        requestedScope: "once",
        terminal: true,
        commandGrant: {
          key: commandKey,
          scope: "once",
          kind: "once-only-command-review",
          applied: false,
          authorizationRecorded: true,
          reviewId: "command_review_1",
        },
      },
    });
    audit.append({
      eventType: "tool.execute",
      sessionId: store.id,
      payload: {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "rm review-delete.txt" },
        commandGrant: {
          key: commandKey,
          scope: "once",
          kind: "once-only-command-review",
          applied: true,
          reviewId: "command_review_1",
        },
        execution: "requested",
      },
      sideEffect,
    });
    audit.close();

    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [] }),
      ui,
      cwd,
      env: e,
      resume: { kind: "id", id: store.id },
      warden: fakeBashWarden(auditDir),
    });
    await ui.awaitRender((view) => view.awaitingInput === true);
    const frame = renderFrame(ui.latest!, false);
    ui.queue.close();
    await run;

    expect(frame).toContain("Historic once-approval receipt · authority spent");
    expect(frame).toContain("Resume restored no authority");
    expect(JSON.stringify(readSession(store.id, e).events)).not.toContain("authority spent");
  });

  it("--continue resumes the latest session: the SAME ledger gains the new turn, no new session, no duplicated system prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };

    // Fresh interactive session: answer one turn, then exit (EOF).
    const ui1 = new TestUI();
    const run1 = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "first answer" }] }),
      ui: ui1,
      cwd,
      env: e,
    });
    ui1.queue.push({ kind: "line", text: "first task" });
    await ui1.awaitRender((v) => asstSaid(v, "first answer"));
    ui1.queue.close();
    await run1;

    expect(listSessions(e)).toHaveLength(1);
    const sid = listSessions(e)[0]!.id;

    // Resume the latest and continue with a follow-up.
    const ui2 = new TestUI();
    const run2 = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "second answer" }] }),
      ui: ui2,
      cwd,
      env: e,
      resume: { kind: "latest" },
    });
    await ui2.awaitRender((view) => view.awaitingInput === true);
    expect(ui2.seededInputHistory).toEqual(["first task"]);
    ui2.queue.push({ kind: "line", text: "follow-up" });
    await ui2.awaitRender((v) => asstSaid(v, "second answer"));
    ui2.queue.close();
    await run2;

    // No NEW session — the same ledger continued (append-only continue, not branch).
    expect(listSessions(e)).toHaveLength(1);
    const msgs = rebuild(readSession(sid, e)).messages;
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "first task",
      "follow-up",
    ]);
    expect(msgs.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual([
      "first answer",
      "second answer",
    ]);
    // The original system prompt is present exactly once — the resume did NOT re-seed it.
    expect(
      msgs.filter((m) => m.role === "system" && m.content.includes("governance-native")),
    ).toHaveLength(1);
  });

  it("applies a still-pending queued comment on resume so a mid-run instruction is not lost (P1-3)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-steer-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const ts = "2026-07-13T00:00:00.000Z";

    // A prior session that ended with an UNAPPLIED queued comment (the run stopped before the
    // steering boundary applied it) — recorded pending in the ledger.
    const store = SessionStore.create({ cwd }, e);
    const sid = store.id;
    store.append({ type: "user", v: 1, ts, content: "start task" });
    store.append({ type: "assistant", v: 1, ts, content: "working" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_x",
      class: "queued",
      content: "also update the README",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.close();
    expect(rebuild(readSession(sid, e)).pendingSteering.map((s) => s.inputId)).toEqual(["inp_x"]);

    // Resume that session and exit immediately (EOF). The pending steering is applied and dispatched
    // during resume setup regardless — it must not depend on the user typing something first.
    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "resumed correction handled" }] }),
      ui,
      cwd,
      env: e,
      resume: { kind: "id", id: sid },
    });
    ui.queue.close();
    await run;

    // The queued comment is now applied: no longer pending, and present as a conversation message.
    const after = rebuild(readSession(sid, e));
    expect(after.pendingSteering).toEqual([]);
    expect(after.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "start task",
      "also update the README",
    ]);
    expect(after.messages).toContainEqual({
      role: "assistant",
      content: "resumed correction handled",
    });
  });

  it("applies pending urgent steering once on resume and preserves its class in the acknowledgement", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-urgent-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const ts = "2026-08-03T00:00:00.000Z";
    const store = SessionStore.create({ cwd }, e);
    const sid = store.id;
    store.append({ type: "user", v: 1, ts, content: "start task" });
    store.append({
      type: "steering",
      v: 1,
      ts,
      inputId: "inp_urgent",
      class: "urgent",
      content: "do not edit auth.ts",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    });
    store.close();

    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "urgent correction handled" }] }),
      ui,
      cwd,
      env: e,
      resume: { kind: "id", id: sid },
    });
    await ui.awaitRender(
      (view) =>
        view.awaitingInput === true &&
        view.items.some(
          (item) =>
            item.kind === "message" &&
            item.role === "system" &&
            /1 urgent correction re-applied and dispatched/i.test(item.content),
        ),
    );
    expect(
      ui.latest?.items.some(
        (item) => item.kind === "message" && /pending comment/u.test(item.content),
      ),
    ).toBe(false);
    ui.queue.close();
    await run;

    const after = rebuild(readSession(sid, e));
    expect(after.pendingSteering).toEqual([]);
    expect(after.messages.filter((message) => message.role === "user")).toContainEqual({
      role: "user",
      content: "do not edit auth.ts",
    });
    expect(
      readSession(sid, e).events.filter(
        (event) => event.type === "steering" && event.inputId === "inp_urgent",
      ),
    ).toHaveLength(2);
  });

  it("--resume <id> resumes that specific session; an unresolvable id falls back to a fresh session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-id-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };

    const ui1 = new TestUI();
    const run1 = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "a1" }] }),
      ui: ui1,
      cwd,
      env: e,
    });
    ui1.queue.push({ kind: "line", text: "t1" });
    await ui1.awaitRender((v) => asstSaid(v, "a1"));
    ui1.queue.close();
    await run1;
    const sid = listSessions(e)[0]!.id;

    // Resume by id → continues sid.
    const ui2 = new TestUI();
    const run2 = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "a2" }] }),
      ui: ui2,
      cwd,
      env: e,
      resume: { kind: "id", id: sid },
    });
    ui2.queue.push({ kind: "line", text: "t2" });
    await ui2.awaitRender((v) => asstSaid(v, "a2"));
    ui2.queue.close();
    await run2;
    expect(listSessions(e)).toHaveLength(1);
    expect(
      rebuild(readSession(sid, e))
        .messages.filter((m) => m.role === "user")
        .map((m) => m.content),
    ).toEqual(["t1", "t2"]);

    // An unresolvable id → fall back to a NEW fresh session (never fails / never continues the wrong one).
    const ui3 = new TestUI();
    const run3 = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "a3" }] }),
      ui: ui3,
      cwd,
      env: e,
      resume: { kind: "id", id: "ses_doesnotexist" },
    });
    ui3.queue.push({ kind: "line", text: "t3" });
    await ui3.awaitRender((v) => asstSaid(v, "a3"));
    ui3.queue.close();
    await run3;
    expect(listSessions(e)).toHaveLength(2); // a fresh session was created, sid untouched
  });

  // Corrupt a session's ledger with a non-final garbage line (a torn FINAL line is tolerated; this
  // is mid-file damage / external tampering) so `readSession` throws `SessionCorruptError`.
  const corrupt = (id: string, e: NodeJS.ProcessEnv): void => {
    const path = sessionPath(id, e);
    const meta = readFileSync(path, "utf8").split("\n")[0]; // the valid session_meta header line
    writeFileSync(path, meta + "\n" + "GARBAGE\n" + meta + "\n"); // GARBAGE is a corrupt NON-final line
  };

  it("--continue with a CORRUPT latest ledger starts FRESH (the unreadable session is skipped, dir not wedged)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-corrupt-c-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const s = SessionStore.create({ cwd }, e); // a session in THIS workspace…
    s.close();
    corrupt(s.id, e); // …whose ledger is then corrupted

    const ui = new TestUI();
    const run = runKeelCommand(undefined, {
      model: new ScriptedModel({ turns: [{ text: "fresh answer" }] }),
      ui,
      cwd,
      env: e,
      resume: { kind: "latest" },
    });
    ui.queue.push({ kind: "line", text: "go" });
    await ui.awaitRender((v) => asstSaid(v, "fresh answer")); // it ran (did not throw / wedge)
    ui.queue.close();
    await run;
    // listSessions skips the corrupt one and shows only the freshly-created session.
    const live = listSessions(e);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).not.toBe(s.id); // a NEW session — the corrupt one was NOT continued
  });

  it("--resume <id> of a CORRUPT ledger REFUSES honestly (throws SessionCorruptError — the user named THAT session)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "keel-resume-corrupt-id-"));
    const e: NodeJS.ProcessEnv = { KEEL_HOME: cwd };
    const s = SessionStore.create({ cwd }, e);
    s.close();
    corrupt(s.id, e);

    const ui = new TestUI();
    // No silent fresh-start for an explicitly named corrupt session: the read fails loudly (the bin
    // turns this into `corrupt session line N…` + a non-zero exit). Never resumes the wrong session.
    await expect(
      runKeelCommand(undefined, {
        model: new ScriptedModel({ turns: [{ text: "unreached" }] }),
        ui,
        cwd,
        env: e,
        resume: { kind: "id", id: s.id },
      }),
    ).rejects.toThrow(SessionCorruptError);
  });
});

describe("positiveIntEnv hardening (SF-3 — only an explicit base-10 safe integer enables a cap)", () => {
  it("rejects hex / scientific / signed / unsafe-magnitude values (no surprising coercion)", () => {
    // `Number("0x10")===16`, `Number("1e3")===1000`, `Number("1e21")` is a non-safe integer — all of
    // which would silently become a (tiny or unbounded) cap. They must be rejected like other junk.
    for (const bad of ["0x10", "1e3", "+10", "1_000", "99999999999999999999", " 5 5 "]) {
      expect(productionLoopSafety({ KEEL_MAX_TOKENS: bad }).stop).toBeUndefined();
    }
    // a plain base-10 integer still works (incl. surrounding whitespace, trimmed)
    expect(productionLoopSafety({ KEEL_MAX_TOKENS: " 400000 " }).stop?.budget?.maxTokens).toBe(
      400000,
    );
  });
});

describe("runKeelSession (entrypoint orchestration, simulator-driven)", () => {
  it("one-shot: a -p prompt is the seed; renders the answer and persists the ledger", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();
    const model = new ScriptedModel({ turns: [{ text: "done" }] } satisfies SimulatorScriptT);

    await runKeelSession({
      model,
      executor: new LocalExecutor({}),
      ui,
      store,
      env: e,
      prompt: "go",
    });
    store.close();

    expect(ui.frame()).toContain("you  go");
    expect(ui.frame()).toContain("done");
    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("one-shot: threads the parsed final-answer contract into one tools-disabled rewrite", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();
    const inputs: ModelTurnInput[] = [];
    const original = "oversized ".repeat(50).trim();
    const model: ModelPort = {
      async *stream(input) {
        inputs.push(input);
        const text = inputs.length === 1 ? original : "Bounded rewrite.";
        yield { type: "text-delta", text };
        yield { type: "finish", reason: "stop", usage: { inputTokens: 6, outputTokens: 8 } };
      },
    };

    await runKeelSession({
      model,
      executor: new LocalExecutor({}),
      ui,
      store,
      env: e,
      prompt: "go",
      finalAnswer: { contract: { version: 1, maxWords: 40 } },
    });
    store.close();

    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.tools).toBeUndefined();
    expect(ui.frame()).toContain("Bounded rewrite.");
    expect(ui.frame()).not.toContain(original);
    const resumed = rebuild(readSession(store.id, e));
    expect([...resumed.finalAnswerSettlements.values()]).toEqual([
      expect.objectContaining({ outcome: "accepted-rewrite" }),
    ]);
  });

  it("one-shot goal: threads the lifecycle manifest so the validation tier runs and completes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();
    const executed: string[] = [];
    const goal = Goal.parse({
      schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
      id: "goal_session_entry",
      objective: "ship via session-entry",
      doneWhen: [{ id: "c1", kind: "command", check: { argv: ["pnpm", "test"] } }],
      validation: { tier: "standard" },
      requiresCompletionAudit: true,
    });
    const lifecycleManifest = LifecycleManifest.parse({
      schemaVersion: LIFECYCLE_MANIFEST_VERSION,
      actions: { "test.unit": { argv: ["pnpm", "test"] } },
      validationTiers: { standard: { required: ["test.unit"] } },
    });

    await runKeelSession({
      model: new ScriptedModel({
        turns: [
          { toolCalls: [{ name: "bash", args: { command: "pnpm test" } }] },
          { text: "done" },
        ],
      }),
      executor: {
        execute: (call) => {
          executed.push(call.name);
          return Promise.resolve({ ok: true, output: "TEST SUMMARY (pnpm test): PASS" });
        },
      },
      ui,
      store,
      env: e,
      prompt: "go",
      goal,
      lifecycleManifest,
    });
    store.close();

    const events = readSession(store.id, e).events;
    expect(executed).toContain("lifecycle.run");
    const audit = events.find((ev) => ev.type === "goal_audit");
    expect(audit?.type === "goal_audit" && audit.audit.verdict).toBe("complete");
    expect(audit?.type === "goal_audit" && audit.audit.validation).toEqual({
      status: "passed",
      tier: "standard",
    });
  });

  it("one-shot: a bounded loop drives the runner until the executor-owned exit check passes", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new HeadlessUI();
    const parsed = parseKeelArgs([
      "run",
      "-p",
      "fix tests",
      "--loop-until",
      "pnpm test",
      "--loop-max-iterations",
      "2",
    ]);
    expect(parsed.kind).toBe("run");
    if (parsed.kind !== "run" || parsed.loop === undefined) {
      throw new Error("expected loop run command");
    }

    await runKeelSession({
      model: new ScriptedModel({ turns: [{ text: "attempt" }] } satisfies SimulatorScriptT),
      executor: { execute: () => Promise.resolve({ ok: true, output: "TEST SUMMARY: PASS" }) },
      ui,
      store,
      env: e,
      prompt: parsed.prompt,
      loop: parsed.loop,
    });
    store.close();

    expect(ui.frame()).toContain("loop succeeded");
    const events = readSession(store.id, e).events;
    expect(
      events.some((event) => event.type === "loop_stopped" && event.reason === "succeeded"),
    ).toBe(true);
  });

  it("interactive: STAYS OPEN across turns — answers a follow-up, then exits on EOF (multi-turn REPL)", async () => {
    // The keystone behavior change (Epic 1.23): the interactive entrypoint no longer exits after one
    // task. The first typed line is turn 1; once it completes the session returns to an idle prompt and
    // a second line is answered as a fresh turn; Ctrl-D/EOF exits. The ledger carries both turns.
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new TestUI();
    const executor: ExecutorPort = {
      execute: () => Promise.resolve({ ok: true, output: "" }),
    };
    const model = new ScriptedModel({
      turns: [{ text: "answer one" }, { text: "answer two" }],
    } satisfies SimulatorScriptT);

    const done = runKeelSession({ model, executor, ui, store, env: e });
    ui.queue.push({ kind: "line", text: "first" });
    // Turn 1 finishes and the REPL is idle at the prompt — it did NOT exit.
    await ui.awaitRender((v) => v.awaitingInput === true && assistantSaid(v, "answer one"));
    // A follow-up at the prompt is answered as turn 2.
    ui.queue.push({ kind: "line", text: "second" });
    await ui.awaitRender((v) => assistantSaid(v, "answer two"));
    ui.queue.close(); // Ctrl-D / EOF → the session exits
    await done;
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" },
    ]);
  });

  it("interactive: idle Ctrl-C warns once, then a second exits cleanly (no session content) (slice 7)", async () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const ui = new TestUI();
    const model = new ScriptedModel({ turns: [{ text: "unreached" }] } satisfies SimulatorScriptT);

    const done = runKeelSession({ model, executor: new LocalExecutor({}), ui, store, env: e });
    // Warn-then-exit (slice 7): the first idle Ctrl-C only warns (the session must not die to a stray
    // keypress); a SECOND consecutive Ctrl-C exits. Both before any prompt → nothing runs.
    ui.queue.push({ kind: "interrupt" });
    ui.queue.push({ kind: "interrupt" });
    await done;
    store.close();

    const r = rebuild(readSession(store.id, e));
    expect(r.messages).toEqual([]); // nothing ran
    expect(renderFrame(ui.latest as ViewModel)).not.toContain("unreached");
  });
});
