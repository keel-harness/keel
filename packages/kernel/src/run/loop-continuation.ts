import type { ModelMessageT } from "@keel/shared";

const controllerMessages = new WeakSet<object>();

export function loopContinuationContent(iteration: number): string {
  return `Keel loop controller · exit check failed · continue bounded iteration ${String(iteration)} toward the original loop objective.`;
}

/**
 * Provider roles are transport roles, not authorship. A bounded-loop continuation must be a `user`
 * message because that is the provider-valid adapter shape after a settled assistant turn; a tail
 * `system` message violates Anthropic's ordering contract. Object identity carries the process-local
 * presentation provenance: the TUI renders this as Keel-owned notice chrome, never as text the human
 * typed. Durable rebuild recreates the marked object from structured `loop_iteration` events rather
 * than trusting content. The exact content is replay-compatibility-sensitive: changing it requires a
 * migration analysis because rebuild intentionally regenerates the controller turn from events.
 */
export function loopContinuationMessage(iteration: number): ModelMessageT {
  const message: ModelMessageT = {
    role: "user",
    content: loopContinuationContent(iteration),
  };
  controllerMessages.add(message);
  return message;
}

export function isLoopContinuationMessage(message: ModelMessageT): boolean {
  return controllerMessages.has(message);
}
