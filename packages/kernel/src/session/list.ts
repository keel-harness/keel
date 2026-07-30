import { readdirSync } from "node:fs";
import type { SessionEventT, StopReasonT } from "@keel/shared";
import { shouldPreserveStopDetailAfterLoopStopped, stopReasonForLoopStopped } from "../events.js";
import { sessionsDir } from "./paths.js";
import { readSession } from "./store.js";

export interface SessionUsageRun {
  readonly ts: string;
  readonly reason: StopReasonT;
  readonly code?: string;
  readonly message?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly tokens: number;
}

/** A one-line summary of a session, for `keel sessions list`. */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly cwd: string;
  /** One-way workspace identity (SHA-256 of the launch cwd, ADR-0054) — how `--continue` scopes to this
   *  directory. Absent on ledgers written before the field existed (those resume only via `--resume <id>`). */
  readonly cwdHash?: string;
  readonly events: number;
  /** Latest user prompt, if present. Presentation layers must still sanitize/control-strip it. */
  readonly summary?: string;
  /** Sum of recorded provider input+output tokens for all completed runs in this ledger. */
  readonly usageTokens?: number;
  /** Timestamped completed-run usage facts, used for opening-screen time windows. */
  readonly usageRuns?: readonly SessionUsageRun[];
  /** The most recent recorded stop reason, if any. Neutral display surfaces map this to an outcome. */
  readonly lastStop?: StopReasonT;
  /** Optional terminal detail from the latest run_status. Non-error codes may still need attention. */
  readonly lastStopCode?: string;
  readonly lastStopMessage?: string;
  /** Goal validation failed after the latest run status. This supersedes a successful model stop for
   * presentation without pretending `incomplete` or `unverified` are loop stop reasons. */
  readonly lastGoalFailure?: "incomplete" | "unverified" | "aborted" | "error";
  readonly lastRunAt?: string;
  readonly parent?: { readonly id: string; readonly atIndex: number };
}

function latestUserSummary(events: readonly SessionEventT[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "user") return ev.content;
  }
  return undefined;
}

function usageRuns(events: readonly SessionEventT[]): readonly SessionUsageRun[] {
  return events.flatMap((ev) => {
    if (ev.type !== "run_status") return [];
    const inputTokens = ev.usage.inputTokens;
    const outputTokens = ev.usage.outputTokens;
    return [
      {
        ts: ev.ts,
        reason: ev.reason,
        ...(ev.code !== undefined ? { code: ev.code } : {}),
        ...(ev.message !== undefined ? { message: ev.message } : {}),
        inputTokens,
        outputTokens,
        tokens: inputTokens + outputTokens,
      },
    ];
  });
}

interface TerminalStatus {
  readonly reason?: StopReasonT;
  readonly code?: string;
  readonly message?: string;
  readonly goalFailure?: "incomplete" | "unverified" | "aborted" | "error";
  readonly ts: string;
}

/** Fold terminal events in durable order. Goal validation is part of its turn, so any later goal
 * failure supersedes that turn's earlier model stop. A subsequent run_status starts a newer terminal
 * outcome and supersedes the old failure. Usage remains exclusively run_status-derived. */
function latestTerminalStatus(events: readonly SessionEventT[]): TerminalStatus | undefined {
  let terminal: TerminalStatus | undefined;
  for (const event of events) {
    if (event.type === "run_status") {
      terminal = {
        reason: event.reason,
        ...(event.code !== undefined ? { code: event.code } : {}),
        ...(event.message !== undefined ? { message: event.message } : {}),
        ts: event.ts,
      };
    } else if (event.type === "loop_stopped") {
      const loopStop = stopReasonForLoopStopped(event.reason);
      if (loopStop !== undefined) {
        const preserveDetail = shouldPreserveStopDetailAfterLoopStopped({
          loopStop,
          lastStop: terminal?.reason,
          lastStopCode: terminal?.code,
        });
        terminal = preserveDetail
          ? { ...terminal, ts: event.ts }
          : { reason: loopStop, ts: event.ts };
      }
    } else if (event.type === "goal_failed") {
      terminal = {
        ...(event.reason === "aborted" || event.reason === "error" ? { reason: event.reason } : {}),
        goalFailure: event.reason,
        ts: event.ts,
      };
    }
  }
  return terminal;
}

/**
 * Enumerate the sessions under the keel dir, newest-id last (ULIDs are time-sortable).
 * A session whose ledger is unreadable (corrupt header) is skipped, never fatal — one
 * bad file must not break `list`.
 */
export function listSessions(env: NodeJS.ProcessEnv = process.env): SessionSummary[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir(env));
  } catch {
    return []; // no sessions dir yet
  }

  const out: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const id = file.slice(0, -".jsonl".length);
    try {
      const { meta, events } = readSession(id, env);
      const summary = latestUserSummary(events);
      const runs = usageRuns(events);
      const usageTokens = runs.reduce((sum, r) => sum + r.tokens, 0);
      const terminal = latestTerminalStatus(events);
      out.push({
        id,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        ...(meta.cwdHash !== undefined ? { cwdHash: meta.cwdHash } : {}),
        events: events.length,
        ...(summary !== undefined ? { summary } : {}),
        ...(runs.length > 0
          ? {
              usageTokens,
              usageRuns: runs,
            }
          : {}),
        ...(terminal?.reason !== undefined ? { lastStop: terminal.reason } : {}),
        ...(terminal?.code !== undefined ? { lastStopCode: terminal.code } : {}),
        ...(terminal?.message !== undefined ? { lastStopMessage: terminal.message } : {}),
        ...(terminal?.goalFailure !== undefined ? { lastGoalFailure: terminal.goalFailure } : {}),
        ...(terminal !== undefined ? { lastRunAt: terminal.ts } : {}),
        ...(meta.parent !== undefined ? { parent: meta.parent } : {}),
      });
    } catch {
      // skip a corrupt / unreadable session file
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
