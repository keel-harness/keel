import type { FileStateT, SessionEventT } from "@keel/shared";
import { governedProcessEnvelope, renderToolCommand } from "../tool-command.js";

/** The factual scaffold derived deterministically from the session ledger (§4.7.6). These facts are
 *  the un-inventable ground truth a compaction summary is validated against — they come from real
 *  tool events, never from the model. */
export interface DerivedFacts {
  readonly filesRead: FileStateT[];
  readonly filesModified: FileStateT[];
  /** Bash commands actually run (confirmed by a result), in order — the ground truth a claimed
   *  test status is checked against (a claimed test for a command never run is invented). */
  readonly commandsRun: string[];
  /** Per confirmed bash run (in order): the command + whether its result indicated success. `ok` is
   *  the ground truth a claimed `passed` is checked against — a model cannot launder a FAILED command
   *  into a "test passed" (§4.7.6 "no invented test success"). See `commandResultIndicatesFailure`. */
  readonly commandOutcomes: { command: string; ok: boolean }[];
}

function governedCommandEnvelope(
  output: string,
): { readonly exitCode?: unknown; readonly signal?: unknown } | undefined {
  const candidates = [output];
  for (
    let index = output.indexOf("\n\n");
    index !== -1;
    index = output.indexOf("\n\n", index + 1)
  ) {
    candidates.push(output.slice(index + 2));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && "exitCode" in parsed) {
        return parsed;
      }
    } catch {
      // Not this slice; keep scanning guidance-header boundaries.
    }
  }
  return undefined;
}

/**
 * Whether a bash tool result indicates the command FAILED. Three signals, all honest: `isError` (the
 * executor flagged a timeout / abort / shell-death), a governed-bash JSON result envelope whose child
 * exit code is not zero, OR a trailing non-zero `[exit code: N]` annotation from the local bash tool.
 *
 * LIMIT (honest): a command that exits 0 but reports failure only in prose (a test runner that prints
 * "FAILED" yet exits 0) is NOT detected — that needs structured test-result parsing (a deferred
 * technique). If `bash.ts`'s render format ever changes, this degrades to `isError`-only (safe: the
 * weaker pre-existing behavior), not to a crash.
 */
export function commandResultIndicatesFailure(output: string, isError: boolean): boolean {
  if (isError) return true;
  const processEnvelope = governedProcessEnvelope(output);
  if (processEnvelope !== undefined) {
    return processEnvelope.exitCode !== 0 || processEnvelope.signal !== null;
  }
  const envelope = governedCommandEnvelope(output);
  if (envelope !== undefined) {
    return envelope.exitCode !== 0 || (envelope.signal !== undefined && envelope.signal !== null);
  }
  return /\[exit code: [1-9]\d*\]\s*$/.test(output);
}

/** Tool name → how a completed result for it touches a file. read = read; write/edit = modified
 *  (created-vs-modified refinement — parsing the tool output — is deferred; "modified" is the honest
 *  conservative state: the file's content was changed). */
const FILE_TOOL_STATUS: Record<string, "read" | "modified"> = {
  read: "read",
  write: "modified",
  edit: "modified",
};

type ToolCallFact =
  | { readonly kind: "file"; readonly name: string; readonly path: string }
  | { readonly kind: "command"; readonly name: "bash" | "process.run"; readonly command: string }
  | { readonly kind: "other"; readonly name: string };

const firstLine = (s: string): string => {
  const nl = s.indexOf("\n");
  const line = nl === -1 ? s : s.slice(0, nl);
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
};

/**
 * Derive {filesRead, filesModified} from the ledger (Epic 1.6b slice 1). A file fact is recorded
 * only for a tool_result that (a) is for a file tool (read/write/edit) and (b) correlates by
 * `toolCallId` to an assistant tool-call carrying a `path` arg — so an orphan result, an
 * unconfirmed (result-less) call, or a path never touched produces nothing. Deduped by path within
 * each bucket (last result's summary wins); read and modified are tracked separately (a file may be
 * both). The single source of these facts is the ledger, never the model.
 */
export function deriveTaskFacts(events: readonly SessionEventT[]): DerivedFacts {
  const callsById = new Map<string, ToolCallFact[]>();
  const read = new Map<string, FileStateT>();
  const modified = new Map<string, FileStateT>();
  const commandsRun: string[] = [];
  const commandOutcomes: { command: string; ok: boolean }[] = [];
  for (const ev of events) {
    if (ev.type === "assistant" && ev.toolCalls !== undefined) {
      for (const call of ev.toolCalls) {
        const queue = callsById.get(call.id) ?? [];
        if (FILE_TOOL_STATUS[call.name] !== undefined) {
          const path = call.args["path"];
          queue.push(
            typeof path === "string" && path.length > 0
              ? { kind: "file", name: call.name, path }
              : { kind: "other", name: call.name },
          );
        } else if (call.name === "bash" || call.name === "process.run") {
          const command = renderToolCommand(call);
          queue.push(
            command !== undefined && command.length > 0
              ? { kind: "command", name: call.name, command }
              : { kind: "other", name: call.name },
          );
        } else {
          queue.push({ kind: "other", name: call.name });
        }
        callsById.set(call.id, queue);
      }
      continue;
    }
    if (ev.type !== "tool_result") continue;
    const call = callsById.get(ev.toolCallId)?.shift();
    if (call?.kind === "command" && ev.name === call.name) {
      commandsRun.push(call.command); // confirmed run (has a result); an unconfirmed call is not a fact
      commandOutcomes.push({
        command: call.command,
        ok: !commandResultIndicatesFailure(ev.output, ev.isError === true),
      });
      continue;
    }
    const status =
      call?.kind === "file" && call.name === ev.name ? FILE_TOOL_STATUS[ev.name] : undefined;
    const path = call?.kind === "file" ? call.path : undefined;
    if (status === undefined || path === undefined) continue; // orphan / non-file tool → not a fact
    const bucket = status === "read" ? read : modified;
    bucket.set(path, { path, status, summary: firstLine(ev.output), artifactRefs: [] });
  }

  return {
    filesRead: [...read.values()],
    filesModified: [...modified.values()],
    commandsRun,
    commandOutcomes,
  };
}
