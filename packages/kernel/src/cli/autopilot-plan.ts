import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { oneLineText } from "../control-strip.js";
import {
  previewPlanApprovalEnvelope,
  type PlanApprovalEnvelope,
  type PlanApprovalPreview,
  type PlanApprovalResource,
} from "../warden/approval.js";
import { loadTrustDecision } from "../trust/trust-store.js";

export const AUTOPILOT_PLAN_USAGE =
  "usage: keel autopilot plan <preview>\n" +
  "usage: keel autopilot plan preview [--plan-id <id>] [--step <text> ...] " +
  "(--domain <domain> | --command-key <sha256:key>) ...";

export interface AutopilotPlanCommandInput {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly args: readonly string[];
}

export interface AutopilotPlanCommandResult {
  readonly output: string;
  readonly ok: boolean;
}

export interface ParsedPlanPreview {
  readonly planId: string;
  readonly steps: readonly string[];
  readonly resources: readonly PlanApprovalResource[];
}

export interface RunPlanApprovalConfirmation {
  readonly workspace: string;
  readonly planId: string;
  readonly prompt: string;
  readonly resources: readonly PlanApprovalResource[];
}

function ok(output: string): AutopilotPlanCommandResult {
  return { output, ok: true };
}

function fail(output: string): AutopilotPlanCommandResult {
  return { output, ok: false };
}

function workspaceDisplayPath(cwd: string): string {
  const abs = resolve(cwd);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function oneLine(value: string): string {
  return oneLineText(value);
}

function parseValue(
  args: readonly string[],
  index: number,
  flag: string,
): { readonly value: string; readonly consumed: 1 | 2 } | undefined {
  const arg = args[index];
  if (arg === undefined) return undefined;
  const equalsPrefix = `${flag}=`;
  if (arg.startsWith(equalsPrefix)) {
    const value = arg.slice(equalsPrefix.length);
    return value === "" ? undefined : { value, consumed: 1 };
  }
  if (arg !== flag) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return { value, consumed: 2 };
}

export function parsePreviewArgs(args: readonly string[]): ParsedPlanPreview | undefined {
  const resources: PlanApprovalResource[] = [];
  const steps: string[] = [];
  let planId = "plan";
  for (let i = 0; i < args.length; ) {
    const plan = parseValue(args, i, "--plan-id");
    if (plan !== undefined) {
      planId = plan.value;
      i += plan.consumed;
      continue;
    }
    const step = parseValue(args, i, "--step");
    if (step !== undefined) {
      steps.push(step.value);
      i += step.consumed;
      continue;
    }
    const domain = parseValue(args, i, "--domain");
    if (domain !== undefined) {
      resources.push({ kind: "domain", value: domain.value });
      i += domain.consumed;
      continue;
    }
    const commandKey = parseValue(args, i, "--command-key");
    if (commandKey !== undefined) {
      resources.push({ kind: "command-key", value: commandKey.value });
      i += commandKey.consumed;
      continue;
    }
    return undefined;
  }
  return resources.length === 0 ? undefined : { planId, steps, resources };
}

function renderResourceList(
  title: string,
  resources: readonly PlanApprovalResource[],
  kind: PlanApprovalResource["kind"],
): readonly string[] {
  const matching = resources.filter((resource) => resource.kind === kind);
  if (matching.length === 0) return [title, "  (none)"];
  return [title, ...matching.map((resource) => `  - ${resource.value}`)];
}

export function renderPreview(
  workspace: string,
  preview: PlanApprovalPreview,
  steps: readonly string[],
): string {
  const lines = [
    `Plan Autopilot preview for ${oneLine(workspace)}`,
    `plan: ${oneLine(preview.planId)}`,
    `workspace trust: ${preview.trustedWorkspace ? "trusted" : "untrusted"}`,
    "status: preview only; grants nothing until a live run resolves reviews",
    "source: plan preview; no session ledger or project grant was written",
  ];

  lines.push("plan steps:");
  if (steps.length === 0) lines.push("  (none provided)");
  else lines.push(...steps.map((step, index) => `  ${index + 1}. ${oneLine(step)}`));

  lines.push(`accepted exact resources: ${preview.acceptedResources.length}`);
  lines.push(...renderResourceList("egress domains:", preview.acceptedResources, "domain"));
  lines.push(...renderResourceList("command envelopes:", preview.acceptedResources, "command-key"));
  lines.push(`rejected resources: ${preview.rejectedResources.length}`);
  if (preview.rejectedResources.length === 0) lines.push("  (none)");
  else {
    lines.push(
      ...preview.rejectedResources.map(
        (resource) => `  - ${resource.kind} ${resource.value} (${resource.reason})`,
      ),
    );
  }
  lines.push(
    "This preview grants nothing. A live Plan Autopilot run still resolves every matching review through the warden and stops when the boundary expands.",
  );
  return lines.join("\n");
}

export function renderRunPlanApprovalConfirmation(input: RunPlanApprovalConfirmation): string {
  const lines = [
    `Plan Autopilot approval for ${oneLine(input.workspace)}`,
    `plan: ${oneLine(input.planId)}`,
    `task: ${oneLine(input.prompt)}`,
    "status: waiting for explicit human approval before execution",
    "exact resources requested for this run:",
    ...renderResourceList("egress domains:", input.resources, "domain"),
    ...renderResourceList("command envelopes:", input.resources, "command-key"),
    "Typing approve submits only the exact resources above to the Plan Autopilot runtime for this run. Workspace trust, policy, sandbox, egress, and audit gates still decide whether they become active; the warden stops on deny, egress outside this envelope, generic reviews, or sandbox failure.",
    'Type "approve" to continue.',
  ];
  return lines.join("\n");
}

export function renderInteractivePlanApproval(
  input: Omit<RunPlanApprovalConfirmation, "prompt">,
): string {
  const lines = [
    `Plan Autopilot approved for ${oneLine(input.workspace)}`,
    `plan: ${oneLine(input.planId)}`,
    "status: approved for the next plain task line only",
    "exact resources approved for the next plain task line:",
    ...renderResourceList("egress domains:", input.resources, "domain"),
    ...renderResourceList("command envelopes:", input.resources, "command-key"),
    "The warden still resolves every matching review and stops on deny, egress outside this envelope, generic reviews, sandbox failure, or audit failure. This writes no project grant.",
  ];
  return lines.join("\n");
}

export function interpretPlanApprovalConfirmationAnswer(answer: string): boolean {
  return answer.trim() === "approve";
}

function renderPreviewCommand(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): AutopilotPlanCommandResult {
  const parsed = parsePreviewArgs(args);
  if (parsed === undefined) return fail(AUTOPILOT_PLAN_USAGE);
  const workspace = workspaceDisplayPath(cwd);
  const trustedWorkspace = loadTrustDecision(workspace, env) === "trusted";
  const envelope: PlanApprovalEnvelope = {
    planId: parsed.planId,
    trustedWorkspace,
    resources: parsed.resources,
  };
  const preview = previewPlanApprovalEnvelope(envelope);
  return ok(renderPreview(workspace, preview, parsed.steps));
}

export function runAutopilotPlanCommandResult(
  input: AutopilotPlanCommandInput,
): AutopilotPlanCommandResult {
  const env = input.env ?? process.env;
  const [subcommand, ...rest] = input.args;
  if (subcommand === "preview") return renderPreviewCommand(input.cwd, env, rest);
  return fail(AUTOPILOT_PLAN_USAGE);
}

export function runAutopilotPlanCommand(input: AutopilotPlanCommandInput): string {
  return runAutopilotPlanCommandResult(input).output;
}
