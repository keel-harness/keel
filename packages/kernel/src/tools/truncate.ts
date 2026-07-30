/** Decode a buffer to UTF-8 dropping any INCOMPLETE trailing multibyte sequence (no replacement char). */
function decodeDropTrailingPartial(buf: Buffer): string {
  // TextDecoder with stream:true holds an incomplete trailing sequence instead of emitting U+FFFD;
  // we never flush, so the partial tail is dropped cleanly.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf, { stream: true });
}

/** Keep the first `maxBytes` of `text`, cut on a UTF-8 codepoint boundary — the trailing partial
 *  multibyte sequence is dropped cleanly (never an emitted U+FFFD). Returns `text` unchanged when it
 *  is already within `maxBytes`. (Head-only sibling of `truncateHeadTail`, for a single over-long line.) */
export function truncateHeadUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return decodeDropTrailingPartial(buf.subarray(0, maxBytes));
}

/** Decode a buffer to UTF-8 dropping any leading continuation bytes (a cut mid-codepoint at the start). */
function decodeDropLeadingPartial(buf: Buffer): string {
  let start = 0;
  // `buf[start]` is guaranteed defined because we check `start < buf.length` first; the cast avoids
  // a coverage-invisible `?? 0` branch that `noUncheckedIndexedAccess` would otherwise require.
  while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start += 1; // 10xxxxxx = continuation
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf.subarray(start));
}

/**
 * Head+tail truncation (borrowed-technique #7): if `text` exceeds `maxBytes`, keep ~half the budget
 * from the head and ~half from the tail, with an elision notice between — cutting on UTF-8 codepoint
 * boundaries so no replacement char is introduced. Returns `truncated:false` and the original text
 * when within the cap.
 */
export function truncateHeadTail(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const head = decodeDropTrailingPartial(buf.subarray(0, half));
  const tail = decodeDropLeadingPartial(buf.subarray(buf.length - half));
  const elided = buf.length - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return { text: `${head}\n… [${String(elided)} bytes elided] …\n${tail}`, truncated: true };
}
