import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { JsonObjectT } from "@keel/shared";
import { parseArgs } from "./args.js";
import { ToolError } from "./errors.js";
import { staticCapability, type CoreTool } from "./registry.js";
import type {
  LeaseStartOptions,
  ProcessLeaseStartResult,
  RunResult,
  ShellSession,
} from "./shell-session.js";
import { summarizeTestOutput } from "./test-summary.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_MS = 600_000;

const BashLeaseArgs = z
  .object({
    kind: z.enum(["service", "job"]),
    scope: z.enum(["until-verifier-handoff"]),
    logPath: z.string().trim().min(1),
    healthCommand: z.string().trim().min(1).optional(),
    statusCommand: z.string().trim().min(1).optional(),
  })
  .strict();

export const BashArgs = z
  .object({
    command: z.string().trim().min(1), // blank rejected; runs trimmed
    timeoutMs: z.number().int().positive().optional(),
    lease: BashLeaseArgs.optional(),
    analysis: z.string().optional(), // extra A — scratchpad, captured in the trajectory, inert here
    plan: z.string().optional(),
  })
  .strict();

export const SPEC = {
  name: "bash",
  description:
    "Run a shell command in a persistent bash session (cwd and env persist across calls). stderr is " +
    "merged into stdout; output is truncated if very large. Optional `timeoutMs` is an idle-progress " +
    "timeout (default 120s, max 600s): it extends while command-owned output arrives, while the " +
    "absolute ceiling still bounds the command. Raise it for a slow build/install/download so it is " +
    "not cut off; a timeout terminates the command but keeps the shell when it can, so cwd/env survive. " +
    "Exit status is already included in the result; do not append `echo $?`, a status probe, or a " +
    "wrapper. When the operator requests an exact command, send it unchanged. A nonzero exit means " +
    "the command or process failed even when the structured tool call returned a result normally. " +
    "If that command was the requested task's sole substantive action, the requested task did not " +
    "succeed. If you followed the operator's requested procedure, you may say only that you executed " +
    "the command as requested; do not describe the requested task, command, its execution, " +
    "completion, or outcome as successful or partially successful. " +
    "Ordinary background jobs (`cmd &`) run inside this session and are TERMINATED when the run ends; " +
    "deliberately detached processes (for example `setsid`) are unmanaged unless started through the " +
    "structured `lease` argument. To leave a service/job running for a fresh verifier/handoff process, " +
    "use `lease` with a log path and health/status command; keel starts it detached, records pid " +
    "identity, preserves it across session dispose, and exposes explicit cleanup for the post-handoff owner. " +
    "Phase 1: NO sandbox — runs with your full privileges.",
  // Model-facing JSON Schema — mirrors `BashArgs` (a drift-guard test asserts the two agree).
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        minLength: 1,
        description:
          "Shell command to run. Preserve an operator-requested exact command unchanged after the documented outer trim.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        description:
          "Optional idle-progress timeout in milliseconds; command output extends it, and the absolute ceiling still applies.",
      },
      lease: {
        type: "object",
        description:
          "Optional detached service/job lease for work that must survive a fresh verifier/handoff process.",
        properties: {
          kind: {
            type: "string",
            enum: ["service", "job"],
            description:
              "Whether the detached process is a long-lived service or a background job.",
          },
          scope: {
            type: "string",
            enum: ["until-verifier-handoff"],
            description:
              "Preserve the lease across shell disposal for a fresh verifier/handoff process.",
          },
          logPath: {
            type: "string",
            minLength: 1,
            description:
              "Regular file path receiving process output; stdout/stderr/fd paths are rejected.",
          },
          healthCommand: {
            type: "string",
            minLength: 1,
            description:
              "Optional liveness command recorded for downstream verification; it is not run at start.",
          },
          statusCommand: {
            type: "string",
            minLength: 1,
            description:
              "Optional progress/status command recorded for downstream polling; it is not run at start.",
          },
        },
        required: ["kind", "scope", "logPath"],
        additionalProperties: false,
      },
      analysis: { type: "string", description: "Scratchpad reasoning (captured, not executed)." },
      plan: { type: "string", description: "Scratchpad plan (captured, not executed)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
} as const;

/** Values of an opt-out flag that disable a default-on hint. */
const TRUTHY = new Set(["1", "true", "yes"]);

/** True when the operator has disabled the post-wedge steering guidance (for ablation). Default-on:
 *  the guidance is purely additive. When suppressed, the message still tells the truth (a wedge, not a
 *  timeout) — only the safe-alternative steering is dropped, never the honesty. */
function hintSuppressed(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY.has((env["KEEL_NO_SHELL_RESET_HINT"] ?? "").toLowerCase());
}

/** True when the operator has disabled the daemon-survival guidance (for ablation). Default-on. */
function daemonHintSuppressed(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY.has((env["KEEL_NO_DAEMON_HINT"] ?? "").toLowerCase());
}

// F3 (keel59 trajectory review): a server the model launches as a SESSION CHILD (`nohup … &`,
// `setsid … &`, bare `&`) is frequently DEAD when the grader probes it from a SEPARATE process — the
// agent→grader process boundary reaps session children. This silently sank `pypi-server`, an sshd
// (`git-multibranch`), and a gRPC kv-store; the one task that passed used an init-managed
// `service nginx start`, which survives. So the grade hinges on an idiom the model picks by luck. One
// machine-readable line on the successful result steers it toward a survivable launch and a pre-finish
// listening check. GUIDANCE ONLY — the double-fork affordance and the pre-finalize port check are
// separate, deferred fixes; this is the emulation-independent advisory half.
const DAEMON_SURVIVAL_HINT =
  "note: a server backgrounded in this shell (`nohup &` / `setsid &` / `&`) may not survive into the " +
  "fresh verifier/handoff process — prefer the structured bash `lease` field " +
  '(`{"command":"python3 -m http.server <port>","lease":{"kind":"service","scope":"until-verifier-handoff","logPath":"/tmp/svc.log","healthCommand":"curl -fsS http://127.0.0.1:<port>/"}}`) ' +
  "or an init-managed service, and confirm the port is actually listening before you finish.";

// The eval-direct auto-lease note. Emitted (in eval mode only) when keel structurally promotes a
// backgrounded server to a verifier-handoff lease instead of merely advising the model to — so the
// service survives into the fresh verifier process rather than being reaped with the session group.
const AUTO_LEASE_NOTE =
  "note: keel auto-promoted this backgrounded service to a verifier-handoff lease (eval mode) so it " +
  "survives into the fresh verifier process; a plain backgrounded launch would have been terminated " +
  "with the shell at run end. The command was relaunched detached — confirm it is actually listening.";

// Conservative two-signal heuristic: fire ONLY when the command BOTH backgrounds AND names a
// server/listener. False negatives are cheaper than noise, so when unsure we stay silent.
//  · backgrounds — a `&` job-control token, or an explicit `nohup`/`setsid`/`disown` detacher.
//  · listens     — a known server program (`*-server`, `http.server`, `flask run`, `uvicorn`/
//                  `gunicorn`/`hypercorn`/`daphne`, `node …server…`, `sshd`, `pserve`) OR a generic
//                  listen/serve/bind/port token. Tuned to the observed daemon launches, not a parser.
const BACKGROUNDS = /(^|[^&|>])&\s*$|(^|\s)(nohup|setsid|disown)(\s|$)/;
const LISTENS =
  /(^|\s)\S*-server\b|\bhttp\.server\b|\bflask\s+run\b|\b(uvicorn|gunicorn|hypercorn|daphne)\b|\bnode\b[^|&]*\bserver|\bsshd\b|\b(serve|pserve)\b|--(port|bind|host|listen)\b|\b(listen|serve)\b/i;

/** True when `command` looks like a long-lived listener launched as a backgrounded session child —
 *  the F3 footgun. Conservative: BOTH a backgrounding token AND a server/listener signal. */
function startsBackgroundedServer(command: string): boolean {
  return BACKGROUNDS.test(command) && LISTENS.test(command);
}

/** From a backgrounded-service launch (e.g. `nohup python3 app.py > log 2>&1 &`), extract the
 *  foreground command to relaunch under a lease, or `undefined` when the command is too complex to
 *  rewrite safely — a pipeline, chained/compound statement, subshell, substitution, `disown`, or a
 *  second background job. Conservative by design: under-promotes (the caller falls back to the
 *  advisory) rather than risk mangling a command. Redirections (`>file`, `2>&1`, `&>file`) are
 *  preserved; redundant leading `nohup`/`setsid` are dropped (the lease already setsid-detaches).
 *  Exported for focused testing; used ONLY by the eval-gated auto-lease path in `createBashTool`. */
export function extractLeasableServiceCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed.endsWith("&")) return undefined; // require an explicit trailing job-control background
  let core = trimmed.slice(0, -1).trim();
  if (core === "") return undefined;
  // Reject multi-statement / pipeline / subshell / substitution / disown — unsafe to relaunch as one
  // leased command. Line terminators (`\n`/`\r`/Unicode/`\f`/`\v`) are statement separators too: a
  // leading state-mutating statement (`cd`, `export`, `VAR=…`) would otherwise be confined to the
  // detached lease subshell instead of persisting in the session shell. Simple redirections are
  // handled below, not here.
  if (/(?:&&|\|\||;|\||`|\$\(|[()]|[\r\n\f\v\u2028\u2029]|\bdisown\b)/u.test(core))
    return undefined;
  // Any `&` remaining after removing redirect-`&` tokens (`2>&1`, `>&2`, `&>`, `&>>`) is a second
  // background job → unsafe.
  const withoutRedirectAmps = core.replace(/\d*>&\d*/gu, "").replace(/&>>?/gu, "");
  if (withoutRedirectAmps.includes("&")) return undefined;
  core = core.replace(/^(?:(?:nohup|setsid)\s+)+/iu, "").trim();
  return core === "" ? undefined : core;
}

// F4 (keel14/keel59 trajectory review): ~100% of observed shell hard-resets were a heredoc fed to an
// interpreter (`python3 <<'EOF'`, `R --vanilla <<EOF`, `perl <<EOF`, even `cat > f <<EOF`) — the
// wedge is in stdin delivery, so the shell never even acknowledges the command and is hard-reset
// (cwd/env lost) almost INSTANTLY (~9 ms), NOT after a timeout. `python3 -c '…'` and the `write`
// tool never wedge. The reset is classified `resetCause: "wedge"` (the session saw zero output), so
// this one machine-readable line tells the TRUTH — a wedge, not a timeout — and steers the model to
// the paths that never wedge, instead of asserting a timeout that did not occur (the honesty bug).
const HEREDOC_WEDGE_MESSAGE =
  "bash: a heredoc-fed command wedged the shell (NOT a timeout — it never ran); the shell was reset " +
  "and lost its working directory/env. Prefer `python3 -c '…'`, a script file written with the " +
  "`write` tool, or `cmd < file` instead of `<<EOF` heredocs, then re-establish any directory you need.";

// The truthful one-liner when the shell wedges but the operator has disabled the steering guidance
// (`KEEL_NO_SHELL_RESET_HINT`): still never claims a timeout — it just omits the alternatives.
const WEDGE_RESET_BASE =
  "bash: the shell wedged (NOT a timeout) and was reset (cwd/env lost). Re-establish any directory or " +
  "environment you need, then try a smaller step.";

function maxTimeoutSeconds(maxTimeoutMs: number): number {
  return Math.floor(maxTimeoutMs / 1_000);
}

function specForMaxTimeout(maxTimeoutMs: number): CoreTool["spec"] {
  if (maxTimeoutMs === MAX_TIMEOUT_MS) return SPEC;
  return {
    ...SPEC,
    description: SPEC.description.replace(
      "max 600s",
      `max ${String(maxTimeoutSeconds(maxTimeoutMs))}s`,
    ),
    parameters: {
      ...SPEC.parameters,
      properties: {
        ...SPEC.parameters.properties,
        timeoutMs: {
          ...SPEC.parameters.properties.timeoutMs,
          maximum: maxTimeoutMs,
        },
      },
    },
  };
}

function normalizeBashArgs(raw: JsonObjectT): JsonObjectT {
  const normalized: JsonObjectT = { ...raw };
  // Some OpenAI-compatible models emit a tool-call `description` field copied from other harnesses.
  // It is metadata, never execution input. Drop only this known harmless key, then keep strict zod
  // validation so real typos still surface instead of silently changing behavior.
  delete normalized["description"];
  return normalized;
}

function foregroundSleepSeconds(command: string): number | undefined {
  const match = /(?:^|[;&|]\s*)sleep\s+(\d+)(?:\s|$)/.exec(command);
  if (match === null) return undefined;
  const fromSleep = command.slice(match.index);
  if (/sleep\s+\d+(?:\s|$)[^;&|]*&/.test(fromSleep)) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function looksLikeTinyProbe(command: string): boolean {
  const trimmed = command.trim();
  return /^(head\b|tail\b|wc\b|ls\b|pwd\b|true\b|false\b|test\b|\[\s|stat\b)/.test(trimmed);
}

function timeoutRecoveryHint(command: string, maxTimeoutMs: number): string | undefined {
  const sleepSeconds = foregroundSleepSeconds(command);
  if (sleepSeconds !== undefined && sleepSeconds >= DEFAULT_TIMEOUT_SECONDS) {
    return (
      `Hint: foreground sleep ${String(sleepSeconds)}s exceeds the default ` +
      `${String(DEFAULT_TIMEOUT_SECONDS)}s timeout; shorten it, background it, or pass ` +
      `{"timeoutMs": ${String(maxTimeoutMs)}}.`
    );
  }
  if (looksLikeTinyProbe(command)) {
    return (
      "Hint: this looks like a tiny probe; a timeout usually means an interactive hang or stuck " +
      "resource, not slow work."
    );
  }
  return undefined;
}

function render(
  result: RunResult,
  command: string,
  env: NodeJS.ProcessEnv,
  maxTimeoutMs: number,
): string {
  if (result.outcome === "timeout") {
    const timeoutLabel =
      result.timeoutKind === "absolute"
        ? "absolute timeout"
        : result.timeoutKind === "idle"
          ? "idle timeout (no command-owned progress)"
          : "timeout";
    if (result.shellReset === true) {
      // F4 honesty: a `wedge` reset happened with no timeout elapsed — say so, do not assert a timeout.
      if (result.resetCause === "wedge") {
        throw new ToolError(hintSuppressed(env) ? WEDGE_RESET_BASE : HEREDOC_WEDGE_MESSAGE);
      }
      // A genuine timeout reset: the command ran and stalled, then could not resync. Honest as-is.
      throw new ToolError(
        `bash: command timed out (${timeoutLabel}) and the shell was reset (cwd/env lost). Re-establish any directory or ` +
          "environment you need, then try a smaller step.",
      );
    }
    const hint =
      result.timeoutKind === "absolute" ? undefined : timeoutRecoveryHint(command, maxTimeoutMs);
    const recovery =
      result.timeoutKind === "absolute"
        ? "The configured absolute command ceiling already fired; split the step smaller, persist intermediate state, or use a structured `lease` for verifier-handoff service/job work "
        : `Retry the slow step with a literal tool arg such as {"timeoutMs": ${String(
            maxTimeoutMs,
          )}}, split it smaller, or use a structured \`lease\` for verifier-handoff service/job work `;
    throw new ToolError(
      `bash: command timed out (${timeoutLabel}) and was terminated — the shell and your cwd/env are intact. ` +
        recovery +
        '(`{"command":"<cmd>","lease":{"kind":"job","scope":"until-verifier-handoff","logPath":"/tmp/job.log","statusCommand":"<poll command>"}}`). ' +
        "Unmanaged `setsid`/`nohup` backgrounding is not cleanup-owned by keel." +
        (hint !== undefined ? ` ${hint}` : ""),
    );
  }
  if (result.outcome === "aborted") {
    throw new ToolError("bash: command was cancelled before it finished.");
  }
  if (result.outcome === "shell-died") {
    throw new ToolError(
      "bash: the shell exited during the command (e.g. `exit`/`exec`, or it crashed); it was reset.",
    );
  }
  const parts: string[] = [];
  // Observation normalization (Epic 1.12 slice 1): when the output is a recognized test run, prepend
  // a salient one-line pass/fail summary so the model sees the verdict up front. Strictly additive —
  // the raw output is preserved below; unrecognized output adds nothing (honest, no fabrication).
  const summary = summarizeTestOutput(result.output, result.exitCode);
  if (summary !== undefined) parts.push(summary);
  if (result.output.length > 0) parts.push(result.output);
  if (result.exitCode !== 0 && result.exitCode !== null) {
    parts.push(`[exit code: ${String(result.exitCode)}]`);
  }
  // F3: attach daemon-survival guidance to a SUCCESSFUL (outcome ok) backgrounded-server launch.
  // Strictly additive and default-on — the raw output above is untouched; the negative paths
  // (no backgrounding, no listener signal, or the flag set) leave the result unchanged.
  if (!daemonHintSuppressed(env) && startsBackgroundedServer(command)) {
    parts.push(DAEMON_SURVIVAL_HINT);
  }
  return parts.length > 0 ? parts.join("\n") : "(command produced no output; exit code 0)";
}

function renderLeaseStarted(lease: ProcessLeaseStartResult): string {
  const lines = [
    `lease registered: ${lease.id}`,
    `kind: ${lease.kind}`,
    `pid/process group: ${String(lease.pid)}/${String(lease.processGroupId)}`,
    `log: ${lease.logPath}`,
    `scope: ${lease.scope}`,
    "cleanup: preserved for verifier handoff; cleanup runs only when the post-handoff owner calls cleanupLeases or the disposable eval container exits",
  ];
  if (lease.healthCommand !== undefined) {
    lines.push(`health command recorded (not run): ${lease.healthCommand}`);
  }
  if (lease.statusCommand !== undefined) {
    lines.push(`status command recorded (not run): ${lease.statusCommand}`);
  }
  return lines.join("\n");
}

export interface BashToolDeps {
  /** Process environment — defaults to `process.env`. Inject in tests to control the hint opt-out
   *  flags (`KEEL_NO_SHELL_RESET_HINT`, `KEEL_NO_DAEMON_HINT`) hermetically. */
  readonly env?: NodeJS.ProcessEnv;
  /** The session's actual max timeout, for honest model-facing hints/spec text. Production default is
   *  600s; eval-only builds may pass a higher ack-gated ceiling. */
  readonly maxTimeoutMs?: number;
  /** EVAL-ONLY. When true, a SAFELY-rewritable backgrounded-server launch (`nohup server &`) is
   *  auto-promoted to the same setsid verifier-handoff lease the model could have requested, so the
   *  service survives into the separate verifier process instead of being reaped with the session
   *  group. Off by default and set ONLY by the build/run-time-gated eval-direct runtime (never a
   *  release binary); production keeps its no-orphans teardown and the advisory-only hint. The
   *  general product behavior (honoring explicit detach idioms) is a separate, ADR-gated change. */
  readonly autoLeaseBackgroundedServices?: boolean;
}

export function createBashTool(session: ShellSession, deps: BashToolDeps = {}): CoreTool {
  const env = deps.env ?? process.env;
  const maxTimeoutMs = deps.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const handler = async (
    raw: JsonObjectT,
    opts?: { signal?: AbortSignal; onOutput?: (chunk: string) => void; toolCallId?: string },
  ): Promise<string> => {
    const args = parseArgs("bash", BashArgs, normalizeBashArgs(raw));
    if (args.lease !== undefined) {
      if (opts?.toolCallId === undefined || opts.toolCallId.trim() === "") {
        throw new ToolError("bash: lease requested without an executor-provided tool call id.");
      }
      if (session.startLeased === undefined) {
        throw new ToolError("bash: this executor does not support service/job leases.");
      }
      const leaseOptions: LeaseStartOptions = {
        kind: args.lease.kind,
        scope: args.lease.scope,
        logPath: args.lease.logPath,
        ownerToolCallId: opts.toolCallId,
        ...(args.lease.healthCommand === undefined
          ? {}
          : { healthCommand: args.lease.healthCommand }),
        ...(args.lease.statusCommand === undefined
          ? {}
          : { statusCommand: args.lease.statusCommand }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      };
      return renderLeaseStarted(await session.startLeased(args.command, leaseOptions));
    }
    // Eval-direct auto-lease (see BashToolDeps.autoLeaseBackgroundedServices): structurally promote a
    // safely-rewritable backgrounded server to a verifier-handoff lease instead of relying on the
    // advisory the model may ignore (F3). Gated to eval mode; anything not safely rewritable — or a
    // non-server background job — falls through to the normal run + advisory below.
    if (
      deps.autoLeaseBackgroundedServices === true &&
      session.startLeased !== undefined &&
      opts?.toolCallId !== undefined &&
      opts.toolCallId.trim() !== "" &&
      startsBackgroundedServer(args.command)
    ) {
      const leasable = extractLeasableServiceCommand(args.command);
      if (leasable !== undefined) {
        const leaseOptions: LeaseStartOptions = {
          kind: "service",
          scope: "until-verifier-handoff",
          logPath: join(tmpdir(), `keel-auto-svc-${randomBytes(8).toString("hex")}.log`),
          ownerToolCallId: opts.toolCallId,
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        };
        return `${AUTO_LEASE_NOTE}\n${renderLeaseStarted(await session.startLeased(leasable, leaseOptions))}`;
      }
    }
    const runOpts = {
      ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      // Forward the live-output sink so a long command streams to the TUI (Epic 1.5c).
      ...(opts?.onOutput !== undefined ? { onOutput: opts.onOutput } : {}),
    };
    return render(await session.run(args.command, runOpts), args.command, env, maxTimeoutMs);
  };
  return {
    spec: specForMaxTimeout(maxTimeoutMs),
    handler,
    staticCapability: staticCapability(
      SPEC.name,
      ["fs_read", "fs_write", "network_read", "network_write", "process_exec"],
      true,
    ),
  };
}
