import type {
  MutationPresentationV1T,
  ToolResultT,
  UiMutationPresentationUnavailableReason,
} from "@keel/shared";

export type MutationPresentationLocalUnavailableReasonV1 = UiMutationPresentationUnavailableReason;

export type MutationPresentationResolutionV1 =
  | { readonly status: "available"; readonly artifact: MutationPresentationV1T }
  | {
      readonly status: "unavailable";
      readonly reason: MutationPresentationLocalUnavailableReasonV1;
    };

export type MutationPresentationResolverV1 = (
  occurrenceSignal?: AbortSignal,
) => Promise<MutationPresentationResolutionV1>;

/**
 * Process-local association only. The resolver is deliberately not an own property of the public
 * ToolResult object, so JSON/zod/session/audit/eval consumers cannot enumerate or serialize it.
 */
const resolverByResult = new WeakMap<ToolResultT, MutationPresentationResolverV1>();
const resolverByEvent = new WeakMap<object, MutationPresentationResolverV1>();

/** Bind one memoized resolver to one exact result object without mutating its public shape. */
export function associateMutationPresentationResolver(
  result: ToolResultT,
  resolver: MutationPresentationResolverV1,
): void {
  if (resolverByResult.has(result)) {
    throw new Error("mutation presentation resolver already associated with this result");
  }
  let settled: Promise<MutationPresentationResolutionV1> | undefined;
  resolverByResult.set(result, (occurrenceSignal) => {
    settled ??= Promise.resolve().then(() => resolver(occurrenceSignal));
    return settled;
  });
}

/** Return the resolver associated with this exact object identity, if one exists. */
export function mutationPresentationResolverFor(
  result: ToolResultT,
): MutationPresentationResolverV1 | undefined {
  return resolverByResult.get(result);
}

/** Transfer an exact-result resolver to an exact public-shape event without adding an own field. */
export function transferMutationPresentationResolver(result: ToolResultT, event: object): boolean {
  const resolver = resolverByResult.get(result);
  if (resolver === undefined) return false;
  if (resolverByEvent.has(event)) {
    throw new Error("mutation presentation resolver already associated with this event");
  }
  resolverByEvent.set(event, resolver);
  return true;
}

/** Return the resolver privately associated with this exact event occurrence. */
export function mutationPresentationResolverForEvent(
  event: object,
): MutationPresentationResolverV1 | undefined {
  return resolverByEvent.get(event);
}
