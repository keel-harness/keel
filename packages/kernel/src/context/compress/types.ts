import type { CompressorKindT } from "@keel/shared";

/**
 * The deterministic content-aware compression seam (Epic 1.6c / ADR-0045). Each compressor shrinks ONE
 * tool-result body by a content-type-specific rule, preserving the signal (errors, anchors). Pure,
 * deterministic, single-pass, bounded (hostile-input safe). The caller (`pass.ts`) appends the honest
 * ledger note and computes the before/after char deltas for the audit event — so a compressor returns
 * only the kept text + its kind. The net-gain guard (never enlarge) is applied by the caller, so a
 * compressor MAY return a body no smaller than its input; the pass then discards the swap.
 */
export interface CompressResult {
  readonly text: string;
  readonly kind: CompressorKindT;
}

/** Inputs a compressor may use. `taskTokens` is a deterministic keyword hint (latest user message +
 *  tool-call args) for relevance-lite keep decisions — never a model call; compressors MUST work with
 *  it absent. `maxBytes` bounds the generic head/tail budget. */
export interface CompressOpts {
  readonly taskTokens?: readonly string[];
  readonly maxBytes?: number;
}

export interface ContentCompressor {
  readonly kind: CompressorKindT;
  compress(content: string, opts: CompressOpts): CompressResult;
}
