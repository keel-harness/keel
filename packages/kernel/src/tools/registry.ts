import type { EffectKindT, StaticCapabilityT, ToolSpecT } from "@keel/shared";
import type { LocalExecutor, ToolHandler } from "../local-executor.js";

/**
 * The arg key under which the typed path tools (read/write/edit) carry the file path. Pinned to the
 * shipped `LoopDetector`'s default `pathArg` ("path", loop-detection.ts) so its per-file doom-loop
 * signal fires on real edits. A drift-guard test (registry.test.ts) breaks if either side changes.
 */
export const PATH_ARG = "path";

/** Static side-effect capability — the per-tool worst-case effect envelope (MASTER_SPEC §4.8 axis-1
 * effect domains; ADR-0024). Declared on the kernel-local `CoreTool`, not on the frozen `ToolSpec`.
 * Slice 7 converges this metadata onto the shared `StaticCapability` schema so the kernel and warden
 * manifest speak the same vocabulary while the warden still computes the dynamic per-call effect. */
export type StaticCapability = StaticCapabilityT;

export function staticCapability(
  toolName: string,
  effectEnvelope: readonly EffectKindT[],
  broad = false,
): StaticCapability {
  return { toolName, effectEnvelope: [...effectEnvelope], broad };
}

export function isMutatingStaticCapability(capability: StaticCapability): boolean {
  return (
    capability.broad ||
    capability.effectEnvelope.includes("fs_write") ||
    capability.effectEnvelope.includes("network_write")
  );
}

/** A core tool: its model-facing spec, its handler, and its static side-effect capability (ADR-0024). */
export interface CoreTool {
  readonly spec: ToolSpecT;
  readonly handler: ToolHandler;
  readonly staticCapability: StaticCapability;
}

/** Register each core tool's handler on the executor, keyed by its spec name. */
export function registerCoreTools(executor: LocalExecutor, tools: readonly CoreTool[]): void {
  for (const tool of tools) executor.register(tool.spec.name, tool.handler);
}

/** The specs to advertise to the model (the agent loop's `tools` input). */
export function coreToolSpecs(tools: readonly CoreTool[]): readonly ToolSpecT[] {
  return tools.map((t) => t.spec);
}
