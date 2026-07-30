import { redactText } from "@keel/shared";
import { redactThenTruncateHeadTail, truncateHeadTail } from "./typed-tools.js";

/**
 * Model-visible per-stream byte budget for a governed sandbox (bash/lifecycle) execute response. The
 * warden's srt sandbox caps each captured stream at 8 MiB to protect its own memory, but that raw
 * output is far larger than the kernel client's fatal RPC frame cap
 * (`DEFAULT_WARDEN_RESPONSE_MAX_LINE_BYTES` = 1 MiB). Without clamping, a mundane `cat big.log` (or an
 * injected `find /usr`) produces a response frame the kernel treats as a fatal protocol error and
 * kills the warden, bricking the session. This budget head+tail truncates each stream so the model
 * still sees the start and end with an honest marker.
 */
export const SANDBOX_RESPONSE_STREAM_MAX_BYTES = 256 * 1024;

/**
 * Per-stream byte budget for the DURABLE audit `tool.execute` payload. The audit is written to disk,
 * not sent over the 1 MiB RPC frame, so it keeps far more than the model-visible response — but it is
 * still bounded so a flood of giant-output commands cannot spike the warden's own audit disk/CPU (the
 * worst case is otherwise ~16 MiB per event: 8 MiB/stream from srt). Truncation is marked, so the
 * record stays honest about what was dropped.
 */
export const SANDBOX_AUDIT_STREAM_MAX_BYTES = 1024 * 1024;

/**
 * Total safe budget for the serialized execute-response frame, comfortably below the kernel's fatal
 * 1 MiB frame cap (leaving margin for the JSON-RPC wrapper `{jsonrpc,id,result}`). The response clamp
 * subtracts the rest of the envelope (verdict/guidance/modifiedArgs/auditSeq) from this so stdout+stderr
 * plus the envelope stay under the cap — the guarantee is structural, not an assumption about how large
 * the envelope fields can be. JSON escaping of control bytes (`cat` of a binary, where each 0x01 byte
 * becomes a 6-char JSON escape) is handled because the loop measures the *serialized* size.
 */
const SANDBOX_RESPONSE_FRAME_TOTAL_BYTES = 900 * 1024;

/** Floor for the stream portion of the frame, so a pathologically large envelope still leaves a small
 *  (marked-truncated) stream budget rather than a negative one. */
const SANDBOX_RESPONSE_MIN_STREAM_FRAME_BYTES = 4 * 1024;

export interface ClampedStreams {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ClampedResponseStreams extends ClampedStreams {
  readonly limited: boolean;
}

function serializedStreamBytes(stdout: string, stderr: string): number {
  return Buffer.byteLength(JSON.stringify({ stdout, stderr }), "utf8");
}

/**
 * Clamp a sandbox result's streams for the MODEL-VISIBLE execute response: head+tail truncate each to
 * the per-stream budget, then — because JSON escaping can still bloat the frame, and the rest of the
 * response envelope (guidance/modifiedArgs/…) also consumes the frame — shrink the budget until the
 * serialized pair fits under `frameTotal - reservedEnvelopeBytes`, so the WHOLE response stays under
 * the kernel's fatal frame cap and a large tool output truncates (with an honest marker) instead of
 * killing the warden. Pass `reservedEnvelopeBytes` = the serialized size of the response envelope with
 * empty streams (plus a small wrapper allowance); it defaults to 0 for callers that only frame streams.
 */
export function clampSandboxResponseStreams(
  stdout: string,
  stderr: string,
  reservedEnvelopeBytes = 0,
): ClampedResponseStreams {
  const streamCeiling = Math.max(
    SANDBOX_RESPONSE_MIN_STREAM_FRAME_BYTES,
    SANDBOX_RESPONSE_FRAME_TOTAL_BYTES - reservedEnvelopeBytes,
  );
  let budget = SANDBOX_RESPONSE_STREAM_MAX_BYTES;
  let clampedStdout = truncateHeadTail(stdout, budget);
  let clampedStderr = truncateHeadTail(stderr, budget);
  // Bounded loop (budget halves each pass to a 1 KiB floor). When the ceiling is generous the pair
  // fits after a few halvings; when a large envelope pins the ceiling to the 4 KiB minimum, the pair
  // may bottom out at the floor (~12 KiB serialized worst case for control bytes). That residual is
  // still safe because the total frame budget (900 KiB) leaves ~124 KiB of slack under the kernel's
  // 1 MiB fatal cap — enough to absorb it. (Only a policy pack authoring a ~1 MiB envelope could still
  // exceed the cap, which would break the frame with empty streams too — a pack bug, not this vector.)
  while (budget > 1024 && serializedStreamBytes(clampedStdout, clampedStderr) > streamCeiling) {
    budget = Math.floor(budget / 2);
    clampedStdout = truncateHeadTail(stdout, budget);
    clampedStderr = truncateHeadTail(stderr, budget);
  }
  return {
    stdout: clampedStdout,
    stderr: clampedStderr,
    limited: clampedStdout !== stdout || clampedStderr !== stderr,
  };
}

/**
 * Clamp a sandbox result's streams for the DURABLE audit payload: bounds the worst-case per-event
 * size so a giant-output command cannot spike the warden's audit disk/CPU, while preserving far more
 * than the model-visible response. No frame constraint applies (audit is disk-written, not framed).
 */
export function clampSandboxAuditStreams(stdout: string, stderr: string): ClampedStreams {
  // Redact BEFORE truncating (F5): head+tail truncation drops the middle, so a secret straddling a cut
  // is split into fragments that can fall below the entropy net's length floor and survive the writer's
  // later whole-record redaction. `redactThenTruncateHeadTail` redacts a bounded window spanning each
  // cut so a straddling secret is replaced by a marker while still whole — without ever feeding the
  // full (up to 8 MiB) stream to `redactText`, which would blow the stack. The writer's post-
  // serialization redaction stays as idempotent defense-in-depth.
  return {
    stdout: redactThenTruncateHeadTail(stdout, SANDBOX_AUDIT_STREAM_MAX_BYTES, redactText),
    stderr: redactThenTruncateHeadTail(stderr, SANDBOX_AUDIT_STREAM_MAX_BYTES, redactText),
  };
}
