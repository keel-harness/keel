import { Buffer } from "node:buffer";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonRejectingDuplicateKeys } from "@keel/shared";
import { homeCredentialSecretRoots, resolveWardenKeelHome } from "./capability-manifest.js";
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

function remediation(error: unknown): Pick<GitCredentialDoctorResult, "detail" | "fix"> {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("environment_authority")) {
    return {
      detail: "operator HOME/XDG authority is unsafe",
      fix: 'chmod 700 -- "$HOME" && keel doctor',
    };
  }
  if (message.includes("configuration_origin") || message.includes("include_authority")) {
    return {
      detail: "credential helper config origin/include is unsafe",
      fix: 'chmod go-w -- "$HOME/.gitconfig" && keel doctor',
    };
  }
  if (message.includes("configuration_scope")) {
    return {
      detail: "credential helper is not system/global authority",
      fix: "git config --local --unset-all credential.helper && keel doctor",
    };
  }
  if (message.includes("helper_syntax") || message.includes("helper_count")) {
    return {
      detail: "credential helper command is not one eligible fixed helper",
      fix:
        "git config --global --unset-all credential.helper; " +
        "git config --global --add credential.helper ''; " +
        "git config --global --add credential.helper '!gh auth git-credential'; keel doctor",
    };
  }
  return {
    detail: "credential helper executable could not be identity-bound",
    fix: "gh auth login --git-protocol https && gh auth setup-git && keel doctor",
  };
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
