import type { UiMessage } from "@keel/shared";
import {
  assistantStreamingProjection,
  type AssistantStreamingProjection,
} from "./assistant-prose.js";

const STREAM_LINEAGE = Symbol("keel.assistant-stream-lineage");

type OwnedAssistantMessage = UiMessage & { readonly [STREAM_LINEAGE]?: object };

export interface AssistantStreamProjectionSnapshot {
  readonly projection: AssistantStreamingProjection;
  /** Internal reducer-owned identity. External object spreads deliberately lose this provenance. */
  readonly lineage?: object;
  readonly inputLength: number;
}

function withLineage(message: UiMessage, lineage: object): UiMessage {
  Object.defineProperty(message, STREAM_LINEAGE, {
    value: lineage,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return message;
}

export function beginAssistantStream(
  content: string,
  streamDeltas?: UiMessage["streamDeltas"],
): UiMessage {
  return withLineage(
    {
      kind: "message",
      role: "assistant",
      content,
      ...(streamDeltas === undefined ? {} : { streamDeltas }),
    },
    {},
  );
}

export function appendAssistantStream(
  message: UiMessage,
  text: string,
  streamDeltas?: UiMessage["streamDeltas"],
): UiMessage {
  const lineage = (message as OwnedAssistantMessage)[STREAM_LINEAGE] ?? {};
  return withLineage(
    {
      ...message,
      content: message.content + text,
      ...(streamDeltas === undefined ? {} : { streamDeltas }),
    },
    lineage,
  );
}

/** Incrementally project only reducer-owned append chains. Unknown/reconstructed messages take the
 * cold correctness path, so object copying or external rewrites cannot forge append provenance. */
export function projectAssistantStream(
  message: UiMessage,
  columns: number,
  previous?: AssistantStreamProjectionSnapshot,
  retainFromLine?: number,
): AssistantStreamProjectionSnapshot {
  const lineage = (message as OwnedAssistantMessage)[STREAM_LINEAGE];
  const reducerOwnedAppend =
    lineage !== undefined &&
    lineage === previous?.lineage &&
    previous.inputLength <= message.content.length;
  const projection = assistantStreamingProjection(
    message.content,
    columns,
    reducerOwnedAppend ? previous.projection : undefined,
    {
      ...(retainFromLine === undefined ? {} : { retainFromLine }),
      ...(reducerOwnedAppend ? { appended: message.content.slice(previous.inputLength) } : {}),
    },
  );
  return {
    projection,
    ...(lineage === undefined ? {} : { lineage }),
    inputLength: message.content.length,
  };
}
