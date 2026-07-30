import { JsonObject, type JsonObjectT } from "@keel/shared";
import type { FinishReasonT, ModelStreamChunkT } from "@keel/shared";
import { PROVIDER_STRINGS } from "./strings.js";

/**
 * Map AI-SDK-v6 `fullStream` parts onto keel's frozen `ModelStreamChunk` vocabulary
 * (design §6). Two entry points:
 *
 * - `mapPart` — the PURE, stateless mapper for parts that need no cross-part context:
 *   `text-delta`, `finish`, `error`, `abort`, and the atomic `tool-call` (its id, name,
 *   and fully-parsed args are all present in the one part). Reasoning passthrough and the
 *   streaming tool-arg parts are ignored here.
 * - `createPartMapper` — a per-`stream()` STATEFUL wrapper that adds the streaming
 *   tool-call deltas. Native providers stream a tool call as `tool-input-start` →
 *   `tool-input-delta`* → `tool-input-end`; keel's frozen contract puts the tool `name`
 *   on the FIRST `tool-call-delta` only, so the wrapper holds a small `id → toolName`
 *   buffer (created fresh per `stream()` call) and delegates everything else to `mapPart`.
 *
 * The SDK reshapes and renames its stream parts across versions (this is exactly the
 * churn the `ModelPort` was frozen to absorb), so this is the ONE place that knows the
 * provider-native shape — the kernel only ever sees keel chunks. The tool-part field
 * names below were verified against the INSTALLED `ai@6.0.197` `TextStreamPart` union
 * (the design §6 table's `inputTextDelta` is stale — the real field is `delta`).
 */

/**
 * Structural view of the AI SDK v6 `fullStream` part union (the fields this slice reads).
 * Deliberately permissive: the SDK's typed union carries far more, but a structural
 * shape keeps the mapper decoupled from the SDK's exact generic types and lets the unit
 * tests construct parts directly. At pinned ai@6.0.197, `text-delta` carries `.text`
 * as a required field. We defend against a missing `.text` with `?? ""` — the branch
 * is unreachable from the SDK's type-checked path but is tested for resilience against a
 * future SDK shape change (a version bump that changes the field name would be caught
 * by the parse-conformance tests on the first affected run).
 */
export interface SdkStreamPart {
  readonly type: string;
  /** `text-delta` / `reasoning-delta` payload (v6 field name: `.text`). */
  readonly text?: string;
  /** `finish` part: provider-native finish reason. */
  readonly finishReason?: string;
  /** `finish` part: cumulative usage for the turn (verified against ai@6.0.197 `LanguageModelUsage`).
   *  In ai@6 the prompt-cache read/write subsets of `inputTokens` live under `inputTokenDetails`; the
   *  top-level `cachedInputTokens` is the DEPRECATED alias for the read subset (still populated at this
   *  pin, kept only as a fallback). */
  readonly totalUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /** Detailed input-token breakdown (ai@6). `cacheReadTokens`/`cacheWriteTokens` are the prompt-cache
     *  read/write subsets of `inputTokens` (Anthropic reports both; write is billed ~1.25×, ADR-0047). */
    readonly inputTokenDetails?: {
      readonly noCacheTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
    /** @deprecated ai@6 alias for `inputTokenDetails.cacheReadTokens`; read only as a fallback. */
    readonly cachedInputTokens?: number;
  };
  /** `error` part payload (unknown shape — never trusted). */
  readonly error?: unknown;
  /** `tool-input-start` / `tool-input-delta` / `tool-input-end`: the streamed call's id. */
  readonly id?: string;
  /** `tool-input-start`: the tool name (buffered to put `name` on the first delta only). */
  readonly toolName?: string;
  /** `tool-input-delta`: the next slice of the tool-args JSON text (v6 field name: `.delta`). */
  readonly delta?: string;
  /** Atomic `tool-call`: the call id (v6 field name: `.toolCallId`). */
  readonly toolCallId?: string;
  /**
   * Atomic `tool-call`: the args. The SDK pre-parses static-tool args to an object, but a
   * dynamic/invalid call can carry a string or other shape (`unknown`) — never trusted; it
   * is parsed/validated to a `JsonObject` (or rejected as an error chunk) in `mapPart`.
   */
  readonly input?: unknown;
}

type ToolNameMapper = (name: string) => string;

const identityToolName: ToolNameMapper = (name) => name;

/** Non-negative integer token count, defaulting missing/non-finite/negative/fractional to 0. */
function normalizeTokens(n: number | undefined): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 0;
}

/** Collapse the SDK's `finishReason` onto keel's `FinishReason`. Non-clean or unknown
 * provider reasons map to `error` so they cannot silently enter the clean completion path. */
export function mapFinishReason(reason: string): FinishReasonT {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool-calls":
      return "tool-calls";
    case "length":
      return "length";
    case "error":
      return "error";
    default:
      return "error";
  }
}

/**
 * Turn an unknown thrown/streamed error into a stable `{ code, message }`. TOTAL — never throws,
 * for ANY input: the `Error`-instance field extraction is itself guarded (an `Error` whose
 * `message`/`name`/`status` getter throws — hostile or corrupted — falls back to a constant
 * code+message), and the non-`Error` `String()` branch is wrapped too. This totality is what makes
 * the `ModelPort` never-throw invariant hold all the way down (the kernel loop does not wrap
 * `stream()` in try/catch).
 *
 * HONESTY (redaction): a provider error message reaches two sinks with different posture. At the
 * LEDGER (at rest) it is redacted — it rides the `run_status` event's `message` field through
 * `redactJsonLine` at the single `SessionStore.append` chokepoint (SEC-014, shipped). At the live
 * UI/stdout it is NOT redacted — the model's in-context/display view is treated as exposed by design
 * (see `secrets/redact.ts`), so a hostile provider embedding a secret-shaped string would surface it
 * on screen, though not in the persisted record.
 */
function errorFields(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    // A hostile/corrupted Error can have throwing `message`/`name`/`status` getters, so the
    // whole extraction is guarded — falling back to a constant code+message keeps errorFields
    // (and thus stream()) total.
    try {
      const statusVal =
        (error as { statusCode?: unknown; status?: unknown }).statusCode ??
        (error as { status?: unknown }).status;
      const code =
        typeof statusVal === "number"
          ? String(statusVal)
          : error.name.length > 0
            ? error.name
            : PROVIDER_STRINGS.errorFieldsFallbackCode;
      return { code, message: error.message };
    } catch {
      return {
        code: PROVIDER_STRINGS.errorFieldsFallbackCode,
        message: PROVIDER_STRINGS.errorFieldsFallbackMessage,
      };
    }
  }
  // Wrap `String()` in a try/catch: a hostile object with a throwing `toString` /
  // `Symbol.toPrimitive` must not escape and break the never-throw invariant.
  try {
    return {
      code: PROVIDER_STRINGS.errorFieldsFallbackCode,
      message: typeof error === "string" ? error : String(error),
    };
  } catch {
    return {
      code: PROVIDER_STRINGS.errorFieldsFallbackCode,
      message: PROVIDER_STRINGS.unstringifiableError,
    };
  }
}

/**
 * Coerce a provider tool-call `input` to a keel `JsonObject`, or `null` if it cannot be
 * one. The SDK pre-parses static-tool args to an object, but a string (some providers
 * serialize args as a JSON string) is JSON-parsed here, and anything that is not a plain
 * JSON object — an array, null, a primitive, an unparseable string, or an object holding a
 * non-JSON-safe value (NaN/Infinity) — is rejected so the caller emits an honest `error`
 * chunk instead of a `tool-call` the frozen `ModelStreamChunk` schema would reject.
 */
function toJsonArgs(input: unknown): JsonObjectT | null {
  let candidate: unknown = input;
  if (typeof input === "string") {
    try {
      candidate = JSON.parse(input);
    } catch {
      return null;
    }
  }
  // `JsonObject` rejects arrays, null, primitives, and non-JSON-safe values (NaN/Infinity),
  // guaranteeing the resulting `tool-call` chunk passes the frozen union's `args: JsonObject`.
  const parsed = JsonObject.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Map one SDK part to a keel chunk, or `undefined` to ignore it. Terminal parts
 * (`finish`/`error`/`abort`) produce a terminal keel chunk; the adapter enforces the
 * terminal-chunk invariant (emit exactly one, last) around this mapper. Stateless: the
 * streaming tool-arg deltas (which need a per-stream id→name buffer) are added by
 * `createPartMapper`, not here.
 */
export function mapPart(
  part: SdkStreamPart,
  mapToolName: ToolNameMapper = identityToolName,
): ModelStreamChunkT | undefined {
  switch (part.type) {
    case "text-delta":
      return { type: "text-delta", text: part.text ?? "" };
    case "reasoning-delta":
      // Reasoning/thinking tokens (ADR-0019 / L; slice 4). The CONSUMED v6 `TextStreamPart`
      // union carries the text on `.text` (verified against ai@6.0.197) — the same field as
      // `text-delta`; the `.delta` fallback defends against the lower-level provider union's
      // field name leaking through a future SDK shape change. Non-terminal: consumers that do
      // not surface reasoning (the kernel loop) ignore it; it does not end the turn.
      return { type: "reasoning-delta", text: part.text ?? part.delta ?? "" };
    case "tool-call": {
      // Atomic form: id, name, and fully-formed args are all present (design §6). The
      // simulator emits this shape; some providers emit it for non-streamed calls. The SDK
      // types guarantee a non-empty `toolCallId`/`toolName`; we still guard against empty so
      // an unfaithful call becomes an honest `error` chunk, never a `tool-call` that fails the
      // frozen `min(1)` id/name constraint.
      const id = part.toolCallId ?? "";
      const rawName = part.toolName ?? "";
      const name = rawName.length === 0 ? "" : mapToolName(rawName);
      const args = toJsonArgs(part.input);
      if (args === null || id.length === 0 || name.length === 0) {
        return {
          type: "error",
          code: PROVIDER_STRINGS.toolCallArgsCode,
          message: PROVIDER_STRINGS.toolCallArgsMessage(name, id),
        };
      }
      return { type: "tool-call", id, name, args };
    }
    case "finish": {
      // Cache read/write subsets of inputTokens (bounded live Harbor validation / ADR-0047). Read from the ai@6 `inputTokenDetails`
      // (the real wire shape), falling back to the deprecated top-level `cachedInputTokens` for the read
      // subset. Recorded ONLY when the provider reports a number, so non-caching providers + older
      // records are unaffected. (PROV-1/2: the prior code read a top-level `cacheCreationInputTokens`
      // the SDK never emits, so the cache-WRITE subset was silently always dropped.)
      const cached =
        part.totalUsage?.inputTokenDetails?.cacheReadTokens ?? part.totalUsage?.cachedInputTokens;
      const cacheWrite = part.totalUsage?.inputTokenDetails?.cacheWriteTokens;
      const finishReason = part.finishReason ?? "unknown";
      const reason = mapFinishReason(finishReason);
      if (reason === "error" && finishReason !== "error") {
        return {
          type: "error",
          code: PROVIDER_STRINGS.providerTerminalFinishCode,
          message: PROVIDER_STRINGS.providerTerminalFinishMessage(finishReason),
        };
      }
      return {
        type: "finish",
        reason,
        usage: {
          inputTokens: normalizeTokens(part.totalUsage?.inputTokens),
          outputTokens: normalizeTokens(part.totalUsage?.outputTokens),
          ...(typeof cached === "number" ? { cachedInputTokens: normalizeTokens(cached) } : {}),
          // The cache-WRITE subset (ADR-0047) — recorded only when the provider reports it, so
          // non-caching providers + older records are unaffected (mirrors cachedInputTokens).
          ...(typeof cacheWrite === "number"
            ? { cacheCreationInputTokens: normalizeTokens(cacheWrite) }
            : {}),
        },
      };
    }
    case "error":
      return { type: "error", ...errorFields(part.error) };
    case "abort":
      return { type: "finish", reason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } };
    default:
      // Lifecycle parts (text-start/-end, reasoning-start/-end, start, start-step, finish-step,
      // source, file, raw) and tool-result carry nothing keel emits here. The STREAMING tool-arg
      // parts (tool-input-start/-delta/-end) are not handled by this pure mapper either — they
      // need the per-stream id→name buffer in `createPartMapper`, which delegates everything else
      // to this function. Ignoring an unhandled part must never crash.
      return undefined;
  }
}

/** True iff the mapped chunk is a terminal (`finish`|`error`) — the loop ends the turn on it. */
export function isTerminal(chunk: ModelStreamChunkT): boolean {
  return chunk.type === "finish" || chunk.type === "error";
}

/**
 * A stateful part mapper for ONE `stream()` call. It adds the streaming tool-arg parts to
 * the pure `mapPart`: it holds a small `id → toolName` buffer so the tool `name` rides only
 * on the FIRST `tool-call-delta` for each id (the frozen contract — providers send the name
 * once). Create one per `stream()` so the buffer never leaks across turns. Returns the keel
 * chunk to emit, or `undefined` to ignore the part. Never throws.
 *
 * - `tool-input-start {id, toolName}` → buffer the name; emit nothing.
 * - `tool-input-delta {id, delta}` → `{ type:"tool-call-delta", id, name?(first only),
 *   argsTextDelta: delta }`; the name is consumed (deleted) on its first use so later deltas
 *   omit it. A delta for an id we never saw started (shape drift) still emits a valid
 *   name-less delta.
 * - `tool-input-end {id}` → clear that id; emit nothing.
 * - everything else → delegated to the pure `mapPart` (text/finish/error/abort/atomic
 *   tool-call).
 */
export function createPartMapper(
  mapToolName: ToolNameMapper = identityToolName,
): (part: SdkStreamPart) => ModelStreamChunkT | undefined {
  // id → buffered tool name, awaiting its first delta. A name is deleted once emitted, so a
  // present key means "name not yet sent on a delta for this id".
  const pendingNames = new Map<string, string>();
  return (part: SdkStreamPart): ModelStreamChunkT | undefined => {
    switch (part.type) {
      case "tool-input-start":
        if (part.id !== undefined && part.toolName !== undefined) {
          pendingNames.set(part.id, mapToolName(part.toolName));
        }
        return undefined;
      case "tool-input-delta": {
        // A delta with no id can't be represented as a `tool-call-delta` (frozen `id` is
        // min(1)); ignore it rather than emit an invalid chunk. Unreachable from the typed SDK
        // path (id is required) but defended so a future shape change can't break the contract.
        const id = part.id;
        if (id === undefined || id.length === 0) return undefined;
        const name = pendingNames.get(id);
        // Consume the name so only the FIRST delta for this id carries it.
        if (name !== undefined) pendingNames.delete(id);
        return {
          type: "tool-call-delta",
          id,
          ...(name !== undefined ? { name } : {}),
          argsTextDelta: part.delta ?? "",
        };
      }
      case "tool-input-end":
        if (part.id !== undefined) pendingNames.delete(part.id);
        return undefined;
      default:
        return mapPart(part, mapToolName);
    }
  };
}
