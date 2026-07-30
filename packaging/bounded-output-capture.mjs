import { Buffer } from "node:buffer";

export const DEFAULT_OUTPUT_CAPTURE_BYTES = 2_097_152;

/**
 * Retains carrier output only while the complete UTF-8 chunk fits under the ceiling. Once crossed,
 * later chunks are still accepted by the stream listener but are not retained, so a noisy defective
 * launcher cannot turn the diagnostic oracle into an unbounded CI allocation.
 *
 * @param {string} label
 * @param {number} [maxBytes]
 */
export function createBoundedOutputCapture(label, maxBytes = DEFAULT_OUTPUT_CAPTURE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("output capture maxBytes must be a positive safe integer");
  }
  let text = "";
  let retainedBytes = 0;
  /** @type {Error | undefined} */
  let error;

  return {
    /** @param {unknown} chunk */
    append(chunk) {
      if (error !== undefined) return;
      const value = String(chunk);
      const chunkBytes = Buffer.byteLength(value, "utf8");
      if (retainedBytes + chunkBytes > maxBytes) {
        error = new Error(`installed carrier ${label} exceeded ${maxBytes} bytes`);
        return;
      }
      text += value;
      retainedBytes += chunkBytes;
    },
    get text() {
      return text;
    },
    get retainedBytes() {
      return retainedBytes;
    },
    get error() {
      return error;
    },
  };
}
