import type { ModelMessageT, ModelPort, ModelStreamChunkT } from "@keel/shared";

/** Collect every chunk of one `stream()` call into an array (test convenience). */
export async function drain(
  model: ModelPort,
  messages: readonly ModelMessageT[],
): Promise<ModelStreamChunkT[]> {
  const out: ModelStreamChunkT[] = [];
  for await (const chunk of model.stream({ messages })) out.push(chunk);
  return out;
}
