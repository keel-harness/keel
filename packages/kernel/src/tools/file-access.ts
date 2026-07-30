import { createHash } from "node:crypto";

/** A stable content signature for staleness comparison — sha256 hex of the bytes (§4.7.10 "mtime/hash";
 *  hash is chosen over mtime: content-exact, monotonic, and unfoolable by a timestamp reset). */
export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface KnownRange {
  /** Inclusive UTF-8 byte offset. */
  readonly start: number;
  /** Exclusive UTF-8 byte offset. */
  readonly end: number;
}

interface KnownRangeObservation extends KnownRange {
  /** SHA-256 of the exact UTF-8 bytes in this observed range. */
  readonly hash: string;
}

interface KnownFile {
  /** Present only when a full-file observation still matches the newest full-file hash we have seen. */
  readonly fullHash?: string;
  /** Exact byte ranges observed after, or in addition to, any full-file observation. */
  readonly ranges: readonly KnownRangeObservation[];
}

function hashUtf8Range(content: string, range: KnownRange): string {
  const bytes = Buffer.from(content, "utf8");
  return contentHash(bytes.subarray(range.start, range.end));
}

function rangeHashMatches(content: string, range: KnownRangeObservation): boolean {
  return hashUtf8Range(content, range) === range.hash;
}

function rangeObservation(content: string, range: KnownRange): KnownRangeObservation | undefined {
  if (range.end <= range.start) return undefined;
  return { ...range, hash: hashUtf8Range(content, range) };
}

function mergeRanges(ranges: readonly KnownRange[]): readonly KnownRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start)
    .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
  const merged: KnownRange[] = [];
  for (const range of sorted) {
    const prev = merged.at(-1);
    if (prev !== undefined && range.start <= prev.end) {
      merged[merged.length - 1] = { start: prev.start, end: Math.max(prev.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * Per-session record of which files the model has authoritatively seen (read, or written/edited this
 * session) and the content signature at that moment — the substrate for the **read-before-edit
 * invariant** (§8.6) and **resume-staleness** (§4.7.10 / SEC-025).
 *
 * In-memory and per session/process by design: a resumed session starts EMPTY, so the first edit to
 * any file forces a re-read — fail-closed against stale prior-session knowledge (the model must not
 * edit a region it has not validated against current disk). Keyed by absolute (workspace-resolved)
 * path. A full read/write records whole-file coverage; a sliced read records only the returned
 * UTF-8 byte range and a hash of those exact bytes.
 */
export class FileAccessTracker {
  readonly #known = new Map<string, KnownFile>();

  /** Record that the model now authoritatively knows `absPath`.
   *  Omit `range` only when the model saw or authored the whole file and `hash` is the whole-file
   *  content hash. With `range`, `hash` is the hash of exactly that returned byte range.
   *  `currentFullHash` is supplied only by read paths that also verified the whole file in the same
   *  operation; it lets a later small-file slice preserve prior full-file coverage without trusting a
   *  stale full read after unrelated external mutation. */
  markKnown(absPath: string, hash: string, range?: KnownRange, currentFullHash?: string): void {
    if (range === undefined) {
      this.#known.set(absPath, { fullHash: hash, ranges: [] });
      return;
    }
    if (range.end <= range.start) return;
    const prev = this.#known.get(absPath);
    const fullHash =
      prev?.fullHash !== undefined && currentFullHash === prev.fullHash ? prev.fullHash : undefined;
    this.#known.set(absPath, {
      ...(fullHash !== undefined ? { fullHash } : {}),
      ranges: [...(prev?.ranges ?? []), { ...range, hash }],
    });
  }

  /** True when the model has any current-session observation for `absPath`. */
  hasKnownCoverage(absPath: string): boolean {
    const known = this.#known.get(absPath);
    return known !== undefined && (known.fullHash !== undefined || known.ranges.length > 0);
  }

  /** The recorded whole-file signature for `absPath`, if the model saw or authored the full file. */
  knownHash(absPath: string): string | undefined {
    return this.#known.get(absPath)?.fullHash;
  }

  /** Drop all current-session evidence for a path whose contents may have changed out of band. */
  forget(absPath: string): void {
    this.#known.delete(absPath);
  }

  /** True when the UTF-8 byte span has been seen by the model and still matches current content. */
  coversRange(
    absPath: string,
    currentHash: string,
    range: KnownRange,
    currentContent: string,
  ): boolean {
    const known = this.#known.get(absPath);
    if (known === undefined) return false;
    if (known.fullHash === currentHash) return true;
    let cursor = range.start;
    const sorted = known.ranges
      .filter((observed) => rangeHashMatches(currentContent, observed))
      .sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
    for (const observed of sorted) {
      if (observed.end <= cursor) continue;
      if (observed.start > cursor) return false;
      cursor = Math.max(cursor, observed.end);
      if (cursor >= range.end) return true;
    }
    return false;
  }

  /** True when the model has seen the whole file at the current hash. */
  coversFullFile(absPath: string, hash: string): boolean {
    return this.#known.get(absPath)?.fullHash === hash;
  }

  /** Update known ranges after a successful edit without upgrading unseen file regions to known. */
  markEdited(
    absPath: string,
    previousHash: string,
    nextHash: string,
    replaced: KnownRange,
    replacementLength: number,
    previousContent: string,
    updatedContent: string,
  ): void {
    const known = this.#known.get(absPath);
    if (known === undefined || (known.fullHash === undefined && known.ranges.length === 0)) {
      this.#known.delete(absPath);
      return;
    }
    if (known.fullHash === previousHash) {
      this.#known.set(absPath, { fullHash: nextHash, ranges: [] });
      return;
    }
    if (!this.coversRange(absPath, previousHash, replaced, previousContent)) {
      this.#known.delete(absPath);
      return;
    }

    const delta = replacementLength - (replaced.end - replaced.start);
    const transformed: KnownRange[] = [
      { start: replaced.start, end: replaced.start + replacementLength },
    ];
    for (const range of known.ranges) {
      if (!rangeHashMatches(previousContent, range)) continue;
      if (range.end <= replaced.start) {
        transformed.push(range);
      } else if (range.start >= replaced.end) {
        transformed.push({ start: range.start + delta, end: range.end + delta });
      } else {
        if (range.start < replaced.start) {
          transformed.push({ start: range.start, end: replaced.start });
        }
        if (range.end > replaced.end) {
          transformed.push({
            start: replaced.start + replacementLength,
            end: range.end + delta,
          });
        }
      }
    }
    const observations = mergeRanges(transformed)
      .map((range) => rangeObservation(updatedContent, range))
      .filter((range): range is KnownRangeObservation => range !== undefined);
    if (observations.length === 0) {
      this.#known.delete(absPath);
      return;
    }
    this.#known.set(absPath, { ranges: observations });
  }
}
