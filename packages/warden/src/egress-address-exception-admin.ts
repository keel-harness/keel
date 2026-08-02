import {
  EGRESS_EXCEPTION_ADMIN_REQUEST_B64_ENV,
  EgressAddressExceptionAdminRequest,
  EgressAddressExceptionAdminResponse,
  INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV,
  parseJsonRejectingDuplicateKeys,
  type EgressAddressExceptionAdminRequestT,
  type EgressAddressExceptionAdminResponseT,
} from "@keel/shared";

import {
  addEgressAddressException,
  loadEgressAddressExceptionSnapshot,
  removeEgressAddressException,
} from "./egress-address-exceptions.js";

const MAX_REQUEST_B64_BYTES = 32 * 1024;

function failure(error: unknown): EgressAddressExceptionAdminResponseT {
  const raw = error instanceof Error ? error.message : String(error);
  const bounded = raw.replace(/[\r\n\t\u2028\u2029]+/gu, " ").slice(0, 480);
  return { version: 1, ok: false, error: bounded };
}

export function runEgressAddressExceptionAdminRequest(
  request: EgressAddressExceptionAdminRequestT,
  env: NodeJS.ProcessEnv = process.env,
): EgressAddressExceptionAdminResponseT {
  const parsed = EgressAddressExceptionAdminRequest.safeParse(request);
  if (!parsed.success) return failure("invalid egress exception admin request");
  try {
    if (parsed.data.operation === "list") {
      const snapshot = loadEgressAddressExceptionSnapshot(parsed.data.workspace, env);
      return {
        version: 1,
        ok: true,
        result: {
          operation: "list",
          workspaceRealpath: snapshot.workspaceRealpath,
          revision: snapshot.revision,
          exceptions: snapshot.exceptions.map((entry) => ({
            host: entry.host,
            cidr: entry.cidr,
            ports: [...entry.ports],
          })),
        },
      };
    }
    if (parsed.data.operation === "add") {
      const result = addEgressAddressException(parsed.data.workspace, parsed.data.exception, env);
      if (result.status === "added") {
        return {
          version: 1,
          ok: true,
          result: {
            operation: "add",
            workspaceRealpath: result.workspaceRealpath,
            status: "added",
            revision: result.revision,
            durability: result.durability,
          },
        };
      }
      return {
        version: 1,
        ok: true,
        result: {
          operation: "add",
          workspaceRealpath: result.workspaceRealpath,
          status: "already-present",
          revision: result.revision,
        },
      };
    }
    const result = removeEgressAddressException(parsed.data.workspace, parsed.data.exception, env);
    if (result.status === "removed") {
      return {
        version: 1,
        ok: true,
        result: {
          operation: "remove",
          workspaceRealpath: result.workspaceRealpath,
          status: "removed",
          revision: result.revision,
          durability: result.durability,
        },
      };
    }
    return {
      version: 1,
      ok: true,
      result: {
        operation: "remove",
        workspaceRealpath: result.workspaceRealpath,
        status: "not-found",
        revision: result.revision,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

function decodeRequest(raw: string): unknown {
  if (
    raw.length === 0 ||
    raw.length > MAX_REQUEST_B64_BYTES ||
    raw.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw)
  ) {
    throw new Error("invalid egress exception admin request encoding");
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.toString("base64") !== raw) {
    throw new Error("invalid egress exception admin request encoding");
  }
  return parseJsonRejectingDuplicateKeys(bytes.toString("utf8"));
}

export async function runEgressAddressExceptionAdminFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  writeLine: (line: string) => void | Promise<void> = (line) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => {
        if (error !== undefined && error !== null) reject(error);
        else resolve();
      });
    }),
): Promise<void> {
  let response: EgressAddressExceptionAdminResponseT;
  try {
    if (env[INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV] !== "1") {
      throw new Error("egress exception admin mode is not enabled");
    }
    const raw = env[EGRESS_EXCEPTION_ADMIN_REQUEST_B64_ENV];
    if (raw === undefined) throw new Error("egress exception admin request is missing");
    const request = EgressAddressExceptionAdminRequest.parse(decodeRequest(raw));
    response = runEgressAddressExceptionAdminRequest(request, env);
  } catch (error) {
    response = failure(error);
  }
  await writeLine(`${JSON.stringify(EgressAddressExceptionAdminResponse.parse(response))}\n`);
}
