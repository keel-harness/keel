import { Buffer } from "node:buffer";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonRejectingDuplicateKeys } from "@keel/shared";
import { homeCredentialSecretRoots, resolveWardenKeelHome } from "./capability-manifest.js";
import { GitCredentialAuthorityError } from "./git-credential-authority.js";
import { createGitCredentialBroker } from "./git-credential-broker.js";
import { parseCanonicalGitHttpsUrl } from "./git-push.js";
import { resolveProductionGitExecutable } from "./git-push-product.js";

export const INTERNAL_GIT_CREDENTIAL_DOCTOR_ENV = "KEEL_INTERNAL_GIT_CREDENTIAL_DOCTOR_V1";
export const GIT_CREDENTIAL_DOCTOR_REQUEST_ENV = "KEEL_GIT_CREDENTIAL_DOCTOR_REQUEST_B64";

export interface GitCredentialDoctorResult {
  readonly status: "ok" | "error";
  readonly detail: string;
  readonly fix?: string;
}

function requestFromEnv(env: NodeJS.ProcessEnv): {
  readonly workspaceRoot: string;
  readonly remoteUrl: string;
} {
  const encoded = env[GIT_CREDENTIAL_DOCTOR_REQUEST_ENV];
  if (encoded === undefined || encoded === "" || encoded.length > 8 * 1024) {
    throw new Error("Git credential doctor request is unavailable");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const value = parseJsonRejectingDuplicateKeys(decoded);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\u0000") !== "remoteUrl\u0000workspaceRoot" ||
    typeof (value as Record<string, unknown>)["workspaceRoot"] !== "string" ||
    typeof (value as Record<string, unknown>)["remoteUrl"] !== "string"
  ) {
    throw new Error("Git credential doctor request is malformed");
  }
  return value as { readonly workspaceRoot: string; readonly remoteUrl: string };
}

function authorityFailure(error: unknown): GitCredentialAuthorityError | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof GitCredentialAuthorityError) return current;
    current = current.cause;
  }
  return undefined;
}

const MAX_DIAGNOSTIC_ENTRY_BYTES = 256;
const MAX_DOCTOR_RESPONSE_BYTES = 1_024;
const UNSAFE_DIAGNOSTIC_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const GENERIC_ENVIRONMENT_REMEDIATION = {
  detail: "operator HOME/XDG authority is unsafe",
  fix: "set HOME/XDG_CONFIG_HOME to an existing operator-owned directory, then run: keel doctor",
} as const;
const GENERIC_CONFIGURATION_REMEDIATION = {
  detail: "credential helper config origin/include is unsafe",
  fix: "repair the affected system/global Git config origin/include, then run: keel doctor",
} as const;
const GENERIC_EXECUTABLE_REMEDIATION = {
  detail: "credential helper executable could not be identity-bound",
  fix: "install or reconfigure one supported Git/helper executable, then run: keel doctor",
} as const;

function boundedEntry(entry: string): string | undefined {
  if (
    entry === "" ||
    Buffer.byteLength(entry, "utf8") > MAX_DIAGNOSTIC_ENTRY_BYTES ||
    UNSAFE_DIAGNOSTIC_TEXT.test(entry)
  ) {
    return undefined;
  }
  return entry;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

type DoctorRemediation = Pick<GitCredentialDoctorResult, "detail" | "fix">;
type Diagnostic = NonNullable<GitCredentialAuthorityError["diagnostic"]>;

const SUBJECT_LABELS: Readonly<
  Record<Diagnostic["subject"], Readonly<Record<Diagnostic["entryType"], string>>>
> = {
  environment: {
    directory: "operator HOME/XDG directory",
    file: "credential inspection file",
    helper: "credential inspection helper",
  },
  configuration: {
    directory: "credential helper config directory",
    file: "credential helper config file",
    helper: "credential helper config helper",
  },
  executable: {
    directory: "credential helper executable directory",
    file: "credential helper executable file",
    helper: "credential helper executable",
  },
};

const CONDITION_DETAILS: Readonly<Record<Diagnostic["condition"], string>> = {
  blocked: "is inside a refused authority root",
  changed: "changed during inspection",
  malformed: "path is malformed",
  ownership: "ownership rejected",
  permissions: "permissions rejected",
  size: "exceeds the identity size bound",
  type: "is not one ordinary entry of the required type",
  unavailable: "unavailable",
};

const MANUAL_FIXES: Readonly<
  Record<Diagnostic["subject"], Readonly<Record<Diagnostic["condition"], string>>>
> = {
  environment: {
    blocked:
      "set HOME/XDG_CONFIG_HOME outside the workspace and Keel secret roots, then run: keel doctor",
    changed: "wait for HOME/XDG_CONFIG_HOME to stop changing, then run: keel doctor",
    malformed: "set HOME/XDG_CONFIG_HOME to one absolute directory, then run: keel doctor",
    ownership: "set HOME/XDG_CONFIG_HOME to an operator-owned directory, then run: keel doctor",
    permissions:
      "use an operator-owned private HOME/XDG_CONFIG_HOME directory, then run: keel doctor",
    size: "use a bounded operator HOME/XDG_CONFIG_HOME directory, then run: keel doctor",
    type: "set HOME/XDG_CONFIG_HOME to one ordinary directory, then run: keel doctor",
    unavailable:
      "set HOME/XDG_CONFIG_HOME to an existing operator-owned directory, then run: keel doctor",
  },
  configuration: {
    blocked:
      "move or reconfigure the Git config/include outside the workspace and Keel secret roots, then run: keel doctor",
    changed: "wait for the Git config/include entry to stop changing, then run: keel doctor",
    malformed: "remove or replace the malformed Git config/include path, then run: keel doctor",
    ownership: "use an operator- or root-owned Git config/include entry, then run: keel doctor",
    permissions: "repair the privileged Git config/include permissions, then run: keel doctor",
    size: "replace the oversized Git config/include file, then run: keel doctor",
    type: "replace the Git config/include entry with one ordinary file, then run: keel doctor",
    unavailable:
      "restore or remove the unavailable Git config/include entry, then run: keel doctor",
  },
  executable: {
    blocked:
      "move or reconfigure the Git/helper executable outside the workspace and Keel secret roots, then run: keel doctor",
    changed: "wait for the Git/helper executable to stop changing, then run: keel doctor",
    malformed: "configure one absolute Git/helper executable path, then run: keel doctor",
    ownership: "use an operator- or root-owned Git/helper executable, then run: keel doctor",
    permissions: "repair the privileged Git/helper executable permissions, then run: keel doctor",
    size: "replace the oversized Git/helper executable, then run: keel doctor",
    type: "replace the Git/helper executable entry with one ordinary file, then run: keel doctor",
    unavailable:
      "install or reconfigure the unavailable Git/helper executable, then run: keel doctor",
  },
};

function genericRemediation(
  error: unknown,
  authority = authorityFailure(error),
): DoctorRemediation {
  const message = error instanceof Error ? error.message : "";
  if (authority?.code === "environment_authority" || message.includes("environment_authority")) {
    return GENERIC_ENVIRONMENT_REMEDIATION;
  }
  if (
    authority?.code === "configuration_origin" ||
    authority?.code === "configuration_framing" ||
    authority?.code === "include_authority" ||
    message.includes("configuration_origin") ||
    message.includes("configuration_framing") ||
    message.includes("include_authority")
  ) {
    return GENERIC_CONFIGURATION_REMEDIATION;
  }
  if (authority?.code === "configuration_scope" || message.includes("configuration_scope")) {
    return {
      detail: "credential helper is not system/global authority",
      fix: "git config --local --unset-all credential.helper && keel doctor",
    };
  }
  if (
    authority?.code === "helper_syntax" ||
    authority?.code === "helper_count" ||
    message.includes("helper_syntax") ||
    message.includes("helper_count")
  ) {
    return {
      detail: "credential helper command is not one eligible fixed helper",
      fix:
        "git config --global --unset-all credential.helper; " +
        "git config --global --add credential.helper ''; " +
        "git config --global --add credential.helper '!gh auth git-credential'; keel doctor",
    };
  }
  return GENERIC_EXECUTABLE_REMEDIATION;
}

function withinWireBound(
  candidate: DoctorRemediation,
  fallback: DoctorRemediation,
): DoctorRemediation {
  const line = `${JSON.stringify({ status: "error", ...candidate })}\n`;
  return UNSAFE_DIAGNOSTIC_TEXT.test(candidate.detail) ||
    candidate.fix === undefined ||
    UNSAFE_DIAGNOSTIC_TEXT.test(candidate.fix) ||
    Buffer.byteLength(line, "utf8") > MAX_DOCTOR_RESPONSE_BYTES
    ? fallback
    : candidate;
}

function structuredRemediation(diagnostic: Diagnostic, entry: string): DoctorRemediation {
  if (diagnostic.kind === "unresolved-helper") {
    return {
      detail: `credential helper executable unavailable: ${entry}`,
      fix:
        "gh auth login --git-protocol https && gh auth setup-git && " +
        "git config --global --get-all credential.helper && keel doctor",
    };
  }
  const label = SUBJECT_LABELS[diagnostic.subject][diagnostic.entryType];
  const detail = `${label} ${CONDITION_DETAILS[diagnostic.condition]}: ${entry}`;
  if (diagnostic.condition === "permissions" && diagnostic.operatorOwned === true) {
    const mode =
      diagnostic.subject === "environment"
        ? "700"
        : diagnostic.subject === "configuration" || diagnostic.entryType === "directory"
          ? "go-w"
          : "go-w,u+x";
    return { detail, fix: `chmod ${mode} ${shellQuote(entry)} && keel doctor` };
  }
  return { detail, fix: MANUAL_FIXES[diagnostic.subject][diagnostic.condition] };
}

function remediation(error: unknown): DoctorRemediation {
  const authority = authorityFailure(error);
  const fallback = genericRemediation(error, authority);
  const diagnostic = authority?.diagnostic;
  const entry = diagnostic === undefined ? undefined : boundedEntry(diagnostic.entry);
  if (diagnostic !== undefined && entry !== undefined) {
    return withinWireBound(structuredRemediation(diagnostic, entry), fallback);
  }
  return fallback;
}

/** Run the exact Warden authority inspection for `keel doctor`, without credential resolution. */
export async function inspectGitCredentialDoctorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitCredentialDoctorResult> {
  const request = requestFromEnv(env);
  const parsed = parseCanonicalGitHttpsUrl(request.remoteUrl);
  const resolvedGit = resolveProductionGitExecutable({
    workspaceRoot: request.workspaceRoot,
    env,
    platform: process.platform,
  });
  if (resolvedGit === undefined) {
    return {
      status: "error",
      detail: "supported Git executable authority is unavailable",
      fix: "install a supported Git 2.x release (2.39 or newer), then run: keel doctor",
    };
  }
  const home = env["HOME"];
  const temporaryRoot = mkdtempSync(join(tmpdir(), "keel-credential-doctor-"));
  chmodSync(temporaryRoot, 0o700);
  try {
    const broker = createGitCredentialBroker({
      gitExecutable: resolvedGit.path,
      tempRoot: temporaryRoot,
      workspaceRoot: request.workspaceRoot,
      denyRoots: [
        resolveWardenKeelHome(env),
        ...(home === undefined ? [] : homeCredentialSecretRoots(home)),
      ],
      env,
    });
    await broker.inspect({
      protocol: "https",
      host: parsed.host,
      path: parsed.path.slice(1),
    });
    return { status: "ok", detail: "operator helper authority eligible" };
  } catch (error) {
    return { status: "error", ...remediation(error) };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runGitCredentialDoctorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  process.stdout.write(`${JSON.stringify(await inspectGitCredentialDoctorFromEnv(env))}\n`);
}
