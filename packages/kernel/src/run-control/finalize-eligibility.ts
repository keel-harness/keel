import type { JsonObjectT } from "@keel/shared";
import { buildProgressLedgerEntry } from "./progress-ledger.js";

export interface FinalizeOnlyEvidence {
  readonly kind: "direct-check";
  readonly successSignal: "exit-zero";
  readonly actionSignature: string;
  readonly patternSignature: string;
}

interface ToolResultObservation {
  readonly ok: boolean;
  readonly output: string;
}

const WARDEN_WARNING_STEM = "warden warning:";
const WARDEN_WARNING_PREFIX = `${WARDEN_WARNING_STEM} `;
const WARDEN_MODIFIED_STEM = "warden modified tool args:";
const UNTRUSTED_RESULT_STEM = "[keel:untrusted-tool-result:";

function directNodeCheckPath(command: string): string | undefined {
  // Validate the raw command before any trim or normalization. Only printable ASCII is admitted;
  // this excludes tabs, all C0/C1/DEL controls, Unicode separators, and non-ASCII lookalikes.
  if (/[^\x20-\x7e]/u.test(command)) return undefined;
  const match = /^ *node +(?:(["'])([A-Za-z0-9._/-]+)\1|([A-Za-z0-9._/-]+)) *$/u.exec(command);
  if (match === null) return undefined;
  const path = (match[2] ?? match[3])!;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9._-]+-check\.[cm]?[jt]s$/u.test(basename) ? path : undefined;
}

function governedBashEnvelopeSucceeded(output: string): boolean | undefined {
  let candidate = output.trim();
  if (candidate.startsWith(WARDEN_MODIFIED_STEM) || candidate.startsWith(UNTRUSTED_RESULT_STEM)) {
    return false;
  }

  let warningDecorated = false;
  if (candidate.startsWith(WARDEN_WARNING_STEM)) {
    if (!candidate.startsWith(WARDEN_WARNING_PREFIX)) return false;
    warningDecorated = true;
    const separator = candidate.indexOf("\n\n");
    if (separator < 0) return false;
    const warning = candidate.slice(0, separator);
    if (
      warning.slice(WARDEN_WARNING_PREFIX.length).trim().length === 0 ||
      /[\r\n]/u.test(warning) ||
      !warning.startsWith(WARDEN_WARNING_PREFIX)
    ) {
      return false;
    }
    candidate = candidate.slice(separator + 2);
    if (
      candidate.startsWith(WARDEN_WARNING_STEM) ||
      candidate.startsWith(WARDEN_MODIFIED_STEM) ||
      candidate.startsWith(UNTRUSTED_RESULT_STEM)
    ) {
      return false;
    }
  }
  if (!candidate.startsWith("{")) return warningDecorated ? false : undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return false;
  }
  // Valid JSON beginning with `{` is necessarily a non-null object.
  const envelope = parsed as Record<string, unknown>;
  const hasEnvelopeField = ["exitCode", "signal", "stdout", "stderr"].some(
    (key) => key in envelope,
  );
  if (!hasEnvelopeField) return false;
  if (
    !Number.isSafeInteger(envelope["exitCode"]) ||
    typeof envelope["stdout"] !== "string" ||
    typeof envelope["stderr"] !== "string" ||
    !(envelope["signal"] === null || typeof envelope["signal"] === "string")
  ) {
    return false;
  }
  return envelope["exitCode"] === 0 && envelope["signal"] === null;
}

/**
 * Recognize one deliberately narrow completion-UX hint. This is not generic progress, acceptance,
 * policy authority, or proof that the script is read-only/correct; only the loop's bounded finalize
 * consumer imports it.
 */
export function finalizeOnlyEvidenceForToolResult(
  call: { readonly name: string; readonly args: JsonObjectT },
  result: ToolResultObservation,
): FinalizeOnlyEvidence | undefined {
  if (call.name !== "bash" || result.ok !== true) return undefined;
  const command = call.args["command"];
  if (typeof command !== "string" || directNodeCheckPath(command) === undefined) return undefined;

  const entry = buildProgressLedgerEntry(call, result.output, { ok: result.ok });
  if (entry.exitCode !== 0 || entry.errorFingerprint !== undefined) return undefined;
  if (governedBashEnvelopeSucceeded(result.output) === false) return undefined;

  return {
    kind: "direct-check",
    successSignal: "exit-zero",
    actionSignature: entry.actionSignature,
    patternSignature: `finalize-only:${entry.patternSignature}`,
  };
}
