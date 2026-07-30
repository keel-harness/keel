// @keel/kernel providers — the Vercel-AI-SDK adapters behind the frozen `ModelPort`
// (Epic 1.3). The SDK's streaming churn is mapped onto keel's frozen chunk vocabulary in
// `chunks.ts`, consumed by `VercelModelPort`, and constructed by the per-provider factory.
// Native tool calling (`tools.ts` → SDK `tools`, no `execute`; the atomic + streaming
// tool-call chunk mappings) landed in slice 2. Per-turn reasoning params + the declarative
// per-provider capability table (`capabilities.ts`, ADR-0030) landed in slice 4. Cache-stable
// context assembly (`context.ts`, design §8) landed in slice 5. Bounded transport retry (SDK
// `maxRetries`, ADR-0028) landed in slice 6. Full-fidelity record/replay (`record.ts` —
// RecordingModelPort capture + RecordedModelPort replay, ADR-0031) landed in slice 7.
export { VercelModelPort, mergeProviderOptions, DEFAULT_MAX_RETRIES } from "./vercel-model-port.js";
export type {
  StreamTextFn,
  StreamTextOptions,
  StreamResultLike,
  VercelModelPortConfig,
  VercelModelPortDeps,
  SdkStreamPart,
} from "./vercel-model-port.js";
export { toSdkMessages } from "./messages.js";
export { assembleContext } from "./context.js";
export type { AssembleContextInput, AssembledContext, CacheTtl } from "./context.js";
export {
  createAnthropicModelPort,
  createOpenAIModelPort,
  createGoogleModelPort,
  createOpenAICompatibleModelPort,
} from "./factory.js";
export type {
  AnthropicModelPortOptions,
  OpenAIModelPortOptions,
  GoogleModelPortOptions,
  OpenAICompatibleModelPortOptions,
} from "./factory.js";
export { mapPart, mapFinishReason, isTerminal, createPartMapper } from "./chunks.js";
export { toSdkTools, EMPTY_OBJECT_SCHEMA } from "./tools.js";
export type { SdkToolSet } from "./tools.js";
export { CAPABILITIES, mapParams } from "./capabilities.js";
export type {
  ProviderCapability,
  ProviderId,
  ReasoningEffort,
  CacheStrategy,
  MappedParams,
} from "./capabilities.js";
export { PROVIDER_STRINGS } from "./strings.js";
export { RecordingModelPort, RecordedModelPort } from "./record.js";
export type { Clock, RecordingModelPortConfig } from "./record.js";
