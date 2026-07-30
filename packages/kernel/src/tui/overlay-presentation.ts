import type { Overlay } from "@keel/shared";

/** Ink-only focus metadata. A symbol keeps it out of JSON/session/audit/eval serialization. */
const OVERLAY_PRESENTATION: unique symbol = Symbol("keel.tui.overlay-presentation");

export interface OverlayPresentationState {
  readonly selected?: number;
  readonly offset?: number;
}

type PresentedOverlay = Overlay & {
  readonly [OVERLAY_PRESENTATION]?: OverlayPresentationState;
};

export function withOverlayPresentation(overlay: Overlay, next: OverlayPresentationState): Overlay {
  const previous = overlayPresentation(overlay);
  return {
    ...overlay,
    [OVERLAY_PRESENTATION]: { ...previous, ...next },
  } as PresentedOverlay;
}

export function overlayPresentation(overlay: Overlay): OverlayPresentationState {
  return (overlay as PresentedOverlay)[OVERLAY_PRESENTATION] ?? {};
}
