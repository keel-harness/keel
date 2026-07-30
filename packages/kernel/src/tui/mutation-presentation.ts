import type {
  DiffLine,
  MutationPresentationSegmentV1T,
  MutationPresentationV1T,
  UiToolActivity,
} from "@keel/shared";
import type { MutationPresentationResolutionV1 } from "../warden/mutation-presentation-resolver.js";
import { stripControlLine } from "./strip.js";

const activityByEvent = new WeakMap<object, UiToolActivity>();

export function associateMutationPresentationActivity(
  event: object,
  activity: UiToolActivity,
): void {
  if (activityByEvent.has(event)) {
    throw new Error("mutation presentation activity already associated with this event");
  }
  activityByEvent.set(event, activity);
}

export function mutationPresentationActivityForEvent(event: object): UiToolActivity | undefined {
  return activityByEvent.get(event);
}

function displayText(segments: readonly MutationPresentationSegmentV1T[]): string {
  return stripControlLine(
    segments.map((segment) => (segment.kind === "literal" ? segment.text : "[redacted]")).join(""),
  );
}

function artifactDiff(artifact: MutationPresentationV1T): readonly DiffLine[] {
  return artifact.comparison.hunks.flatMap((hunk) =>
    hunk.lines.map((line, lineIndex): DiffLine => {
      const text = displayText(line.segments);
      const hunkStart = lineIndex === 0 ? { hunkStart: true as const } : {};
      switch (line.kind) {
        case "context":
          return {
            kind: "context",
            text,
            observedBeforeLine: line.observedBeforeLine,
            installedAfterLine: line.installedAfterLine,
            ...hunkStart,
          };
        case "observed-before":
          return {
            kind: "del",
            text,
            observedBeforeLine: line.observedBeforeLine,
            ...hunkStart,
          };
        case "installed-after":
          return {
            kind: "add",
            text,
            installedAfterLine: line.installedAfterLine,
            ...hunkStart,
          };
      }
    }),
  );
}

function observedImageMetadata(
  image: MutationPresentationV1T["observedBefore"],
): Extract<UiToolActivity["mutationPresentation"], { status: "available" }>["observedBefore"] {
  if (image.status !== "file-observed") return { status: image.status };
  return {
    status: image.status,
    bytes: image.bytes,
    mode: image.mode,
    contentClass: image.contentClass,
    finalNewline: image.finalNewline,
  };
}

function installedImageMetadata(
  image: MutationPresentationV1T["verifiedInstalledAfter"],
): Extract<
  UiToolActivity["mutationPresentation"],
  { status: "available" }
>["verifiedInstalledAfter"] {
  return {
    status: image.status,
    bytes: image.bytes,
    mode: image.mode,
    contentClass: image.contentClass,
    finalNewline: image.finalNewline,
  };
}

export function resolveMutationPresentationActivity(
  activity: UiToolActivity,
  resolution: MutationPresentationResolutionV1,
): UiToolActivity {
  if (resolution.status === "unavailable") {
    return {
      ...activity,
      mutationPresentation: { status: "unavailable", reason: resolution.reason },
    };
  }
  const artifact = resolution.artifact;
  if (artifact.operation !== activity.name) {
    return {
      ...activity,
      mutationPresentation: { status: "unavailable", reason: "invalid-response" },
    };
  }
  return {
    ...activity,
    summary: displayText(artifact.displayPath.segments),
    diff: artifactDiff(artifact),
    mutationPresentation: {
      status: "available",
      operation: artifact.operation,
      displayPath: displayText(artifact.displayPath.segments),
      observedBefore: observedImageMetadata(artifact.observedBefore),
      verifiedInstalledAfter: installedImageMetadata(artifact.verifiedInstalledAfter),
      coverage: artifact.comparison.coverage,
      observedBeforeLines: artifact.comparison.totals.observedBeforeLines,
      installedAfterLines: artifact.comparison.totals.installedAfterLines,
      shownLines: artifact.comparison.totals.shownLines,
      hiddenLines: artifact.comparison.totals.hiddenLines,
      transitionBinding: artifact.transitionBinding,
      concurrentMutation: artifact.concurrentMutation,
    },
  };
}
