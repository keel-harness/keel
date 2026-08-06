import { spawn } from "node:child_process";
import type { UiGitStatus } from "@keel/shared";

/** Injectable git runner — returns a subcommand's stdout, or `undefined` on ANY failure (not a repo,
 *  git absent, timeout, non-zero exit). Tests inject a deterministic fake; production uses a bounded,
 *  fail-soft `git` spawn (so a slow/hostile repo can never hang or crash the cockpit). */
export type GitRunAsync = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<string | undefined>;

const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const GIT_TERMINATE_GRACE_MS = 100;

export interface GitRunnerOptions {
  readonly command?: string;
  readonly prefixArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The group may already be gone. This probe is cosmetic and always fails soft.
  }
}

export function createGitRunner(cwd: string, options: GitRunnerOptions = {}): GitRunAsync {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return (args, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(undefined);
        return;
      }
      let child;
      try {
        child = spawn(
          options.command ?? "git",
          [
            ...(options.prefixArgs ?? []),
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            ...args,
          ],
          {
            cwd,
            detached: process.platform !== "win32",
            env: { ...(options.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" },
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
      } catch {
        resolve(undefined);
        return;
      }
      let output = "";
      let outputBytes = 0;
      let settled = false;
      let terminating = false;
      let hardStopTimer: NodeJS.Timeout | undefined;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (hardStopTimer !== undefined) clearTimeout(hardStopTimer);
        signal?.removeEventListener("abort", terminate);
        child.stdout.destroy();
        resolve(value);
      };
      const terminate = (): void => {
        if (settled || terminating) return;
        terminating = true;
        signalProcessGroup(child.pid, "SIGTERM");
        // Keep this armed even when the leader closes after SIGTERM: resistant descendants can
        // retain the detached process group after the leader is gone.
        setTimeout(() => signalProcessGroup(child.pid, "SIGKILL"), GIT_TERMINATE_GRACE_MS);
        hardStopTimer = setTimeout(() => finish(undefined), GIT_TERMINATE_GRACE_MS * 3);
        hardStopTimer.unref();
      };
      const timeoutTimer = setTimeout(terminate, timeoutMs);
      timeoutTimer.unref();
      signal?.addEventListener("abort", terminate, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
          terminate();
          return;
        }
        output += chunk;
      });
      child.once("error", () => finish(undefined));
      child.once("close", (code) => finish(!terminating && code === 0 ? output : undefined));
    });
}

function gitStatusFromOutput(porcelain: string | undefined): UiGitStatus | undefined {
  if (porcelain === undefined) return undefined;
  const lines = porcelain.split("\n");
  const header = lines.shift();
  if (header?.startsWith("## ") !== true) return undefined;
  const branchSummary = header.slice(3).trim();
  if (branchSummary.length === 0) return undefined;
  const detached = branchSummary === "HEAD (no branch)";
  const branchCandidate = branchSummary.startsWith("No commits yet on ")
    ? branchSummary.slice("No commits yet on ".length)
    : (branchSummary.split("...", 1)[0] ?? "");
  // Only Git's explicit detached marker may omit the branch. An unknown `HEAD ...` header fails soft
  // instead of manufacturing detached state from malformed or future porcelain output (CLI-5).
  if (
    !detached &&
    (branchCandidate.length === 0 ||
      branchCandidate === "HEAD" ||
      branchCandidate.startsWith("HEAD "))
  ) {
    return undefined;
  }
  const branch = detached ? undefined : branchCandidate;
  let added = 0;
  let modified = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.length < 2) continue; // porcelain rows are `XY <path>`; blanks/short lines are noise
    const xy = line.slice(0, 2);
    if (xy === "??" || xy.includes("A")) added += 1;
    else if (xy.includes("D")) deleted += 1;
    else if (xy.trim().length > 0) modified += 1;
  }
  return {
    ...(branch !== undefined && branch.length > 0 ? { branch } : {}),
    added,
    modified,
    deleted,
  };
}

/**
 * Read the cockpit's git segment — current branch + porcelain change counts — for the status bar
 * (Epic 1.24 cockpit). **Fail-soft:** outside a repo, with git absent, or on any error it returns
 * `undefined` and the cockpit simply omits the git segment (never `n/a`-forever, never a crash/hang).
 *
 * **Trust-gated by the caller:** `session-entry` probes only a TRUSTED workspace — `git` can execute
 * repo-local config/hooks (e.g. `core.fsmonitor`), so it is not run in an untrusted/declined workspace
 * (consistent with project-context loading / the run-start backup; SEC-012 spirit).
 *
 * Counts are an approximate "you have changes" indicator (file-level, dominant status per line), not an
 * exact accounting: untracked + staged-add → `added`, deletions → `deleted`, the rest → `modified`.
 */
/** One bounded status process supplies both branch and change counts. Keeping this to one process
 * avoids duplicate startup work while the trusted-workspace cockpit probe overlaps Warden startup. */
export async function gitStatusAsync(
  cwd: string,
  run: GitRunAsync = createGitRunner(cwd),
  signal?: AbortSignal,
): Promise<UiGitStatus | undefined> {
  try {
    return gitStatusFromOutput(await run(["status", "--porcelain", "--branch"], signal));
  } catch {
    return undefined;
  }
}
