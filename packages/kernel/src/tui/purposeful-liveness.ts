import type { UIPort } from "@keel/shared";

/**
 * Process-local opt-in for dynamic activity. Headless ports deliberately omit it so `run -p`,
 * goldens, and CI never acquire a wall-clock-driven render path. This is a renderer capability,
 * not a shared protocol or authority surface.
 */
export const PURPOSEFUL_LIVENESS = Symbol("keel.purposeful-liveness");

interface PurposefulLivenessPort {
  readonly [PURPOSEFUL_LIVENESS]?: true;
}

export function supportsPurposefulLiveness(ui: UIPort): boolean {
  return (ui as UIPort & PurposefulLivenessPort)[PURPOSEFUL_LIVENESS] === true;
}

export const LIVENESS_REVEAL_MS = 2_000;
export const LIVENESS_TICK_MS = 1_000;
export const MAX_LIVENESS_MS = 99 * 60 * 60 * 1_000;

/** Coarse buckets bound repaint cadence and make sub-two-second work visually timer-free. */
export function livenessDurationBucket(value: number): number {
  if (!Number.isFinite(value)) return value === Number.POSITIVE_INFINITY ? MAX_LIVENESS_MS : 0;
  const duration = Math.max(0, value);
  if (duration < LIVENESS_REVEAL_MS) return 0;
  if (duration >= MAX_LIVENESS_MS) return MAX_LIVENESS_MS;
  if (duration < 60_000) return Math.floor(duration / 1_000) * 1_000;
  if (duration < 60 * 60_000) return Math.floor(duration / 10_000) * 10_000;
  return Math.floor(duration / 60_000) * 60_000;
}
