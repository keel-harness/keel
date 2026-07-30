import { readSession } from "../session/store.js";
import { listSessions, type SessionSummary } from "../session/list.js";
import { rebuild } from "../session/resume.js";
import { branch } from "../session/branch.js";
import { stopCodeNeedsAttention } from "../events.js";
import { oneLineText } from "../control-strip.js";

const USAGE = "usage: keel sessions <list | resume <id> | branch <id> <n>>";

/** Longest rendered stop code / detail. Bounds an unbounded ledger string so one field cannot
 *  dominate (or scroll away) the report around it. */
const MAX_STOP_CODE = 60;
const MAX_STOP_DETAIL = 200;
const MAX_CWD = 512;

/**
 * Render a ledger-derived string as REPORT DATA, never as terminal control input.
 *
 * `run_status.code`/`message` are unbounded strings that carry model- and provider-influenced text
 * (e.g. a failing bash command echoed into a completion-evidence prompt). Rendered raw, that text
 * could inject ANSI/CR to overwrite keel's own output, or add newlines that mimic a report field —
 * letting the agent forge keel's status report. `oneLineText` strips ANSI CSI + control bytes and
 * folds to a single line; the bound keeps one field from crowding out the rest. This mirrors the
 * sanitizing the TUI already applies to the same values (AGENTS.md: status truth is control-plane
 * state, never model self-report; ER-020: model/tool text is data, not terminal control input).
 */
function reportText(value: string, max: number): string {
  const clean = oneLineText(value);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * The headless `keel` CLI logic (pure: returns the output string; the `bin` wrapper does
 * the I/O). Phase 1 ships only the `sessions` command. `resume` REPORTS the resumable
 * state — live continuation of the loop needs a wired provider + keys (Epic 1.5/1.9).
 */
export interface KeelCliResult {
  readonly ok: boolean;
  readonly output: string;
}

function stopDetail(reason: string | undefined, code: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  return `${reason}${code !== undefined ? `:${reportText(code, MAX_STOP_CODE)}` : ""}`;
}

function terminalStatusText(input: {
  readonly finished?: boolean;
  readonly lastStop?: SessionSummary["lastStop"];
  readonly lastStopCode?: string | undefined;
  readonly lastGoalFailure?: SessionSummary["lastGoalFailure"] | undefined;
}): string {
  const detail = stopDetail(input.lastStop, input.lastStopCode);
  if (input.lastGoalFailure !== undefined) {
    return `goal failed (${input.lastGoalFailure})`;
  }
  if (input.lastStop === undefined) return "in progress";
  const terminalStatus =
    input.finished === true && !stopCodeNeedsAttention(input.lastStopCode)
      ? "finished"
      : input.lastStop === "aborted"
        ? "stopped"
        : "needs attention";
  return `${terminalStatus}${detail !== undefined ? ` (${detail})` : ""}`;
}

export function runKeelCliResult(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): KeelCliResult {
  if (args[0] !== "sessions") return { ok: false, output: USAGE };
  const [, sub, ...rest] = args;

  switch (sub) {
    case "list": {
      const sessions = listSessions(env);
      if (sessions.length === 0) return { ok: true, output: "no sessions" };
      return {
        ok: true,
        output: sessions
          .map((s) => {
            const lineage = s.parent ? `  (from ${s.parent.id}@${s.parent.atIndex})` : "";
            // `cwd` is the ledger-recorded launch directory: control-strip + bound it like the other
            // ledger-derived fields (LB-1) so a directory name carrying ANSI/CR cannot overwrite output
            // and an embedded newline cannot forge a second session row.
            return `${s.id}  ${reportText(s.cwd, MAX_CWD)}  ${s.events} event(s)  ${terminalStatusText(
              {
                lastStop: s.lastStop,
                lastStopCode: s.lastStopCode,
                lastGoalFailure: s.lastGoalFailure,
                finished:
                  s.lastStop === "model-stop" &&
                  s.lastGoalFailure === undefined &&
                  !stopCodeNeedsAttention(s.lastStopCode),
              },
            )}  ${s.createdAt}${lineage}`;
          })
          .join("\n"),
      };
    }
    case "resume": {
      const id = rest[0];
      if (id === undefined) return { ok: false, output: USAGE };
      try {
        const r = rebuild(readSession(id, env));
        const status = terminalStatusText({
          finished: r.finished,
          lastStop: r.lastStop,
          lastStopCode: r.lastStopCode,
          lastGoalFailure: r.lastGoalFailure,
        });
        const usage =
          r.usage !== undefined ? `${r.usage.inputTokens} in / ${r.usage.outputTokens} out` : "n/a";
        const detail =
          r.lastStopMessage !== undefined
            ? [`  detail: ${reportText(r.lastStopMessage, MAX_STOP_DETAIL)}`]
            : [];
        return {
          ok: true,
          output: [
            id,
            `  status: ${status}`,
            ...detail,
            `  messages: ${r.messages.length}`,
            `  pending steering: ${r.pendingSteering.length}`,
            `  usage: ${usage}`,
            `  (inspection only — use keel --resume ${id} to continue)`,
          ].join("\n"),
        };
      } catch (e) {
        return { ok: false, output: `error: ${(e as Error).message}` };
      }
    }
    case "branch": {
      const id = rest[0];
      const n = Number(rest[1]);
      if (id === undefined || rest[1] === undefined || !Number.isSafeInteger(n) || n < 0) {
        return { ok: false, output: USAGE };
      }
      try {
        return { ok: true, output: `branched ${id}@${n} -> ${branch(id, n, env)}` };
      } catch (e) {
        return { ok: false, output: `error: ${(e as Error).message}` };
      }
    }
    default:
      return { ok: false, output: USAGE };
  }
}

export function runKeelCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  return runKeelCliResult(args, env).output;
}
