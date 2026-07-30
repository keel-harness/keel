import { z } from "zod";

/**
 * Trivial wiring schema (Epic 0.1). Proves the test+coverage+CI loop.
 * Real schemas (RPC, audit, memory, policy, simulator-script) arrive in Epic 0.2.
 */
export const KeelMeta = z.object({
  name: z.literal("keel"),
  specVersion: z.string().min(1),
});
export type KeelMetaT = z.infer<typeof KeelMeta>;

export * from "./rpc/primitives.js";
export * from "./rpc/envelope.js";
export * from "./rpc/events.js";
export * from "./rpc/methods.js";
export * from "./rpc/mutation-presentation.js";
export * from "./common/formats.js";
export * from "./common/ulid.js";
export * from "./common/keel-home.js";
export * from "./common/search-path.js";
// Kernel↔warden data contracts (ADR-0071 P1-10): pure MCP wire/launch shapes + the
// cross-process wiring constants, so the kernel imports no warden enforcement library.
export * from "./common/subprocess-contracts.js";
export * from "./mcp/contracts.js";
export * from "./audit/record.js";
// Audit hash-chain primitives (Epic 2.6): RFC 8785 canonicalization, record hashing, chain
// verification. Pure + dependency-light so the (Phase-2B) standalone offline verifier can reuse them.
export * from "./audit/canonicalize.js";
export * from "./audit/hash.js";
export * from "./audit/verify.js";
export * from "./audit/checkpoint.js";
// Tolerant durable-read primitives (ADR-0072 P1-12): the shared strict-key scanner + spine-strict
// tolerant record parse, one source of truth for the warden/kernel readers and the vendored .mjs.
export * from "./audit/tolerant-read.js";
// Phase-2B evidence-bundle format + build/verify-shared audit helpers (ADR-0071 P1-10 slice 2):
// one schema + helper set for the warden writer and the kernel offline verifier.
export * from "./audit/evidence-bundle.js";
export * from "./memory/frontmatter.js";
export * from "./policy/input.js";
export * from "./policy/side-effect.js";
export * from "./policy/capability-manifest.js";
export * from "./policy/read-only-commands.js";
export * from "./lifecycle/index.js";
export * from "./run/index.js";
export * from "./model-routing/index.js";
export * from "./session/events.js";
export * from "./context/task-state.js";
export * from "./simulator/script.js";
export * from "./ports/model-port.js";
export * from "./cost/effective-tokens.js";
export * from "./ports/recording.js";
export * from "./ports/executor-port.js";
export * from "./ports/ui-port.js";
export * from "./common/json.js";
// SEC-014 (§3.2(6)) redaction filter — the single implementation shared by the kernel session-write
// chokepoint and the @keel/eval benchmark trajectory store (Epic 1.11 QR-4).
export * from "./secrets/redact.js";
