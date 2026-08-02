import { spawnSync } from "node:child_process";
import {
  EGRESS_EXCEPTION_ADMIN_REQUEST_B64_ENV,
  EgressAddressExceptionAdminRequest,
  EgressAddressExceptionAdminResponse,
  INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV,
  parseJsonRejectingDuplicateKeys,
  type EgressAddressExceptionAdminRequestT,
  type EgressAddressExceptionAdminResponseT,
} from "@keel/shared";
import { oneLineText } from "../control-strip.js";
import { resolveProductionWardenStart } from "../warden/runtime.js";

export const EGRESS_EXCEPTIONS_USAGE =
  "usage: keel egress exception <add|list|remove>\n" +
  "usage: keel egress exception list --workspace <path>\n" +
  "usage: keel egress exception add --workspace <path> --host <host> --cidr <cidr> --port <port> [--port <port> ...]\n" +
  "usage: keel egress exception remove --workspace <path> --host <host> --cidr <cidr> --port <port> [--port <port> ...]";

export type EgressExceptionAdminRunner = (
  request: EgressAddressExceptionAdminRequestT,
  env: NodeJS.ProcessEnv,
) => EgressAddressExceptionAdminResponseT;

export interface EgressExceptionCommandInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly runAdmin?: EgressExceptionAdminRunner;
}

export interface EgressExceptionCommandResult {
  readonly output: string;
  readonly ok: boolean;
}

interface ParsedOptions {
  readonly workspace: string;
  readonly host?: string;
  readonly cidr?: string;
  readonly ports: readonly number[];
}

type SuccessfulAdminResult = Extract<EgressAddressExceptionAdminResponseT, { ok: true }>["result"];
type ListAdminResult = Extract<SuccessfulAdminResult, { operation: "list" }>;
type ChangedAdminResult = Extract<SuccessfulAdminResult, { status: "added" | "removed" }>;

const ADMIN_TIMEOUT_MS = 10_000;
const ADMIN_MAX_OUTPUT_BYTES = 64 * 1024;

function ok(output: string): EgressExceptionCommandResult {
  return { output, ok: true };
}

function fail(output: string): EgressExceptionCommandResult {
  return { output, ok: false };
}

function parsePort(value: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/u.test(value)) return undefined;
  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

function parseOptions(args: readonly string[], mutation: boolean): ParsedOptions | undefined {
  let workspace: string | undefined;
  let host: string | undefined;
  let cidr: string | undefined;
  const ports: number[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const equals = raw.indexOf("=");
    const flag = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
    if (!["--workspace", "--host", "--cidr", "--port"].includes(flag)) return undefined;
    const value = inline ?? args[++index];
    if (
      value === undefined ||
      value === "" ||
      value.length > 4_096 ||
      (inline === undefined && value.startsWith("--"))
    ) {
      return undefined;
    }
    if (flag === "--workspace") {
      if (workspace !== undefined) return undefined;
      workspace = value;
    } else if (flag === "--host") {
      if (host !== undefined) return undefined;
      host = value;
    } else if (flag === "--cidr") {
      if (cidr !== undefined) return undefined;
      cidr = value;
    } else {
      const port = parsePort(value);
      if (port === undefined || ports.includes(port)) return undefined;
      ports.push(port);
    }
  }

  if (workspace === undefined) return undefined;
  if (!mutation) {
    return host === undefined && cidr === undefined && ports.length === 0
      ? { workspace, ports }
      : undefined;
  }
  if (host === undefined || cidr === undefined || ports.length === 0) return undefined;
  return { workspace, host, cidr, ports: ports.sort((left, right) => left - right) };
}

function runAdminProcess(
  request: EgressAddressExceptionAdminRequestT,
  env: NodeJS.ProcessEnv,
): EgressAddressExceptionAdminResponseT {
  const validatedRequest = EgressAddressExceptionAdminRequest.parse(request);
  const start = resolveProductionWardenStart();
  const encoded = Buffer.from(JSON.stringify(validatedRequest), "utf8").toString("base64");
  const child = spawnSync(start.command, [...start.args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      ...start.env,
      [INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV]: "1",
      [EGRESS_EXCEPTION_ADMIN_REQUEST_B64_ENV]: encoded,
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: ADMIN_TIMEOUT_MS,
    maxBuffer: ADMIN_MAX_OUTPUT_BYTES,
  });
  if (child.error !== undefined) throw child.error;
  if (child.signal !== null) throw new Error(`warden admin terminated by ${child.signal}`);
  if (child.status !== 0) {
    throw new Error(oneLineText(child.stderr) || "warden admin process failed");
  }
  const lines = child.stdout.trimEnd().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === "") throw new Error("invalid warden admin response");
  const parsed = EgressAddressExceptionAdminResponse.safeParse(
    parseJsonRejectingDuplicateKeys(lines[0]!),
  );
  if (!parsed.success) throw new Error("invalid warden admin response");
  return parsed.data;
}

function renderList(result: ListAdminResult): EgressExceptionCommandResult {
  const workspace = oneLineText(result.workspaceRealpath);
  const lines = [`Egress address exceptions for ${workspace}`];
  if (result.exceptions.length === 0) lines.push("no exceptions");
  else {
    lines.push(
      ...result.exceptions.map(
        (entry) => `- ${entry.host} · ${entry.cidr} · ports ${entry.ports.join(", ")}`,
      ),
    );
  }
  return ok(lines.join("\n"));
}

function renderChanged(
  action: "added" | "removed",
  options: ParsedOptions & Required<Pick<ParsedOptions, "host" | "cidr">>,
  result: ChangedAdminResult,
): EgressExceptionCommandResult {
  const lines = [
    `${action} egress address exception`,
    `workspace: ${oneLineText(result.workspaceRealpath)}`,
    `host: ${options.host}`,
    `CIDR: ${options.cidr}`,
    `ports: ${options.ports.join(", ")}`,
    `revision: ${result.revision}`,
    "The running Warden still uses its prior immutable snapshot.",
    "Restart action: stop it, then run `keel --continue` from the workspace above.",
  ];
  if (result.durability === "replaced") {
    lines.splice(
      6,
      0,
      "warning: replacement was revalidated, but parent-directory fsync did not confirm crash durability",
    );
    return fail(lines.join("\n"));
  }
  return ok(lines.join("\n"));
}

function boundedError(error: unknown): string {
  const message = oneLineText(error instanceof Error ? error.message : String(error));
  return `keel egress exception: ${message}`.slice(0, 512);
}

function renderMutation(
  operation: "add" | "remove",
  options: ParsedOptions,
  runAdmin: EgressExceptionAdminRunner,
  env: NodeJS.ProcessEnv,
): EgressExceptionCommandResult {
  if (options.host === undefined || options.cidr === undefined) {
    return fail(EGRESS_EXCEPTIONS_USAGE);
  }
  const response = runAdmin(
    {
      version: 1,
      operation,
      workspace: options.workspace,
      exception: { host: options.host, cidr: options.cidr, ports: [...options.ports] },
    },
    env,
  );
  if (!response.ok) return fail(boundedError(response.error));
  const result = response.result;
  if (result.operation !== operation) return fail(boundedError("invalid warden admin response"));
  if (result.status === "already-present") {
    return ok("egress address exception already present; no file change");
  }
  if (result.status === "not-found") {
    return ok("no matching egress address exception; no file change");
  }
  return renderChanged(
    result.status,
    { ...options, host: options.host, cidr: options.cidr },
    result,
  );
}

export function runEgressExceptionCommandResult(
  input: EgressExceptionCommandInput,
): EgressExceptionCommandResult {
  const env = input.env ?? process.env;
  const [subcommand, ...rest] = input.args;
  if (subcommand !== "add" && subcommand !== "list" && subcommand !== "remove") {
    return fail(EGRESS_EXCEPTIONS_USAGE);
  }
  const options = parseOptions(rest, subcommand !== "list");
  if (options === undefined) return fail(EGRESS_EXCEPTIONS_USAGE);
  const runAdmin = input.runAdmin ?? runAdminProcess;
  try {
    if (subcommand === "list") {
      const response = runAdmin(
        { version: 1, operation: "list", workspace: options.workspace },
        env,
      );
      if (!response.ok) return fail(boundedError(response.error));
      return response.result.operation === "list"
        ? renderList(response.result)
        : fail(boundedError("invalid warden admin response"));
    }
    return renderMutation(subcommand, options, runAdmin, env);
  } catch (error) {
    return fail(boundedError(error));
  }
}

export function runEgressExceptionCommand(input: EgressExceptionCommandInput): string {
  return runEgressExceptionCommandResult(input).output;
}
