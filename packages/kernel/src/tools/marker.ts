import { randomBytes } from "node:crypto";

/**
 * A unique, unguessable completion marker for one bash command. CSPRNG, 128 bits — a command cannot
 * predict or construct a future marker to spoof early completion (the sentinel-collision defense,
 * design spec §7). Fresh per `run`.
 */
export function makeMarker(): string {
  return `__keel_done_${randomBytes(16).toString("hex")}__`;
}

/**
 * Parse a completed command's marker line `<marker>:<exitcode>`. Anchored: the line must be EXACTLY
 * the marker, a colon, then digits. Returns the exit code, or null if `line` is not the marker (so a
 * coincidental mid-stream line — or the marker as a non-terminal substring — does not complete early).
 */
export function parseMarkerLine(line: string, marker: string): number | null {
  const prefix = `${marker}:`;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number.parseInt(rest, 10);
}
