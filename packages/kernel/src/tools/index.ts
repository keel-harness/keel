// @keel/kernel tools — the five core tools (read · write · edit · bash · search) and the shared
// infrastructure they plug into (Epic 1.2). The four typed tools share a `Workspace` (path
// containment); `bash` runs over a `ShellSession`. Phase 1 is honest-no-enforcement — see the design
// spec §5 (containment is a kernel-level precursor, not a sandbox; `bash` is unsandboxed).
import type { CoreTool } from "./registry.js";
import type { ShellSession } from "./shell-session.js";
import { Workspace } from "./workspace.js";
import { FileAccessTracker } from "./file-access.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool } from "./bash.js";
import { createSearchTool } from "./search.js";

export { Workspace } from "./workspace.js";
export type { ContainedPath, ContainmentDenial, ResolveResult } from "./workspace.js";
export { FileAccessTracker, contentHash } from "./file-access.js";
export { ToolError } from "./errors.js";
export {
  type CoreTool,
  type StaticCapability,
  isMutatingStaticCapability,
  registerCoreTools,
  coreToolSpecs,
  PATH_ARG,
  staticCapability,
} from "./registry.js";
export { createReadTool } from "./read.js";
export { createWriteTool } from "./write.js";
export { createEditTool } from "./edit.js";
export { createBashTool } from "./bash.js";
export { createSearchTool, resolveRgPath } from "./search.js";
export { createPlanTool, renderLedger, PLAN_TOOL_NAME } from "./plan.js";
export type { PlanItemT } from "./plan.js";
export { createSkillTool, SKILL_TOOL_NAME } from "./skill.js";
export { PipeShellSession } from "./shell-session.js";
export type {
  LeaseStartOptions,
  ProcessLeaseStartResult,
  ShellSession,
  RunResult,
  RunOptions,
  RunOutcome,
} from "./shell-session.js";

/**
 * Assemble the five core tools for a workspace + shell session, in their canonical order. The result
 * is registered on a `LocalExecutor` (via `registerCoreTools`) and advertised to the model (via
 * `coreToolSpecs`). The workspace-aware wiring of loop-detection and `ShellSession.dispose()` ownership
 * belongs to the kernel entrypoint (Epic 1.5/1.6), not here.
 *
 * The read/write/edit trio share ONE per-session `FileAccessTracker` so the **read-before-edit
 * invariant** (§8.6) + **resume-staleness** (§4.7.10 / SEC-025) hold across them: an `edit` to a file
 * not read this session (or changed on disk since) is refused with guidance until it is (re-)read.
 */
export function createCoreTools(
  workspace: Workspace,
  session: ShellSession,
  opts: {
    readonly bashMaxTimeoutMs?: number;
    /** EVAL-ONLY. Forwarded to the bash tool so a backgrounded server is auto-promoted to a
     *  verifier-handoff lease. Set only by the build/run-time-gated eval-direct runtime. */
    readonly autoLeaseBackgroundedServices?: boolean;
  } = {},
): CoreTool[] {
  const tracker = new FileAccessTracker();
  return [
    createReadTool(workspace, { tracker }),
    createWriteTool(workspace, { tracker }),
    createEditTool(workspace, { tracker }),
    createBashTool(session, {
      ...(opts.bashMaxTimeoutMs !== undefined ? { maxTimeoutMs: opts.bashMaxTimeoutMs } : {}),
      ...(opts.autoLeaseBackgroundedServices === true
        ? { autoLeaseBackgroundedServices: true }
        : {}),
    }),
    createSearchTool(workspace),
  ];
}
