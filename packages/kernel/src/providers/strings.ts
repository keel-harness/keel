import { redactText } from "../secrets/redact.js";

/** Provider-layer microcopy — errors surfaced to the model/log (charter §6.4: microcopy
 *  is a product surface). Kept separate from `KERNEL_STRINGS` so the provider seam owns
 *  its own copy. */
function safeProviderReason(reason: string): string {
  const oneLine = redactText(reason).replace(/\s+/gu, " ").trim();
  return oneLine.length <= 96 ? oneLine : `${oneLine.slice(0, 95).trimEnd()}...`;
}

export const PROVIDER_STRINGS = {
  /** Code for the defensive `error` chunk emitted when a stream ends without a terminal chunk.
   *  Centralized here (with its message below) so every provider-layer error code is discoverable
   *  in one place — shared by `VercelModelPort` and the `RecordedModelPort` replay guard. */
  noTerminalCode: "no-terminal",
  /** Defensive `error` chunk message when a provider stream ends without a terminal chunk. */
  noTerminal: "provider stream ended without a terminal chunk",
  /** Fallback message when errorFields cannot stringify the thrown value (hostile toString). */
  unstringifiableError: "stream-error (unstringifiable value)",
  /** Fallback `code` when an `Error`'s own `name`/`status` field accessors throw (hostile Error). */
  errorFieldsFallbackCode: "stream-error",
  /** Fallback `message` when an `Error`'s `message`/`name` getter throws (hostile Error). */
  errorFieldsFallbackMessage: "stream-error (unreadable Error)",
  /** Code for the `error` chunk emitted when a provider tool-call's args aren't a JSON object. */
  toolCallArgsCode: "tool-call-args",
  /** Message for an unparseable / non-object provider tool-call input (name, id interpolated). */
  toolCallArgsMessage: (name: string, id: string): string =>
    `provider tool call '${name}' (id ${id}) had args that are not a JSON object`,
  /** Code for non-clean or unknown provider finish reasons that must not become a model stop. */
  providerTerminalFinishCode: "provider-terminal-finish",
  /** Message for a non-clean or unknown provider finish reason. */
  providerTerminalFinishMessage: (reason: string): string =>
    `provider finish reason '${safeProviderReason(reason)}' is not a clean completion reason`,
  /**
   * Code for the fail-closed `error` chunk emitted when a non-native-tool provider receives
   * a turn with `input.tools` non-empty (design §8: fails closed, never text-parses).
   */
  toolsUnsupportedCode: "tools-unsupported",
  /**
   * Message for the fail-closed `error` chunk when `supportsNativeTools === false`. This chunk
   * reaches the model (→ loop stop), but the cause is an operator/configuration concern, not
   * something the model can act on — so the copy is honest log/operator-facing diagnosis (the
   * configured provider lacks native tool calling and keel builds no text-parse fallback), not a
   * model instruction. The fix is to configure tools only on a native-tool-capable provider.
   */
  toolsUnsupportedMessage:
    "configuration error: tools were advertised to a provider that lacks native tool calling, and keel has no text-parse fallback — configure tools only on a native-tool-capable provider",
} as const;
