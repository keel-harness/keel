import { graphemeSpans } from "./display-cells.js";

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MARK = /\p{Mark}/u;

function scalarToken(codePoint: number): string {
  return `‹U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}›`;
}

function visibleGrapheme(value: string): string {
  if (value.length === 1) {
    const codeUnit = value.charCodeAt(0);
    if (codeUnit >= 0x20 && codeUnit <= 0x7e) return value;
  }
  const scalars = [...value];
  const pictographicIndexes = scalars
    .map((scalar, index) => (EXTENDED_PICTOGRAPHIC.test(scalar) ? index : -1))
    .filter((index) => index >= 0);
  const firstPictographic = pictographicIndexes.at(0);
  const lastPictographic = pictographicIndexes.at(-1);
  const orphanedMarks =
    scalars.length > 0 &&
    !scalars.some((scalar) => !MARK.test(scalar) && !DEFAULT_IGNORABLE.test(scalar));
  let output = "";
  for (const [index, scalar] of scalars.entries()) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint === 0x09) {
      output += scalar;
    } else if (codePoint <= 0x1f) {
      output += String.fromCodePoint(0x2400 + codePoint);
    } else if (codePoint === 0x7f) {
      output += "␡";
    } else if (codePoint >= 0x80 && codePoint <= 0x9f) {
      output += scalarToken(codePoint);
    } else if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      output += scalarToken(codePoint);
    } else if (
      (codePoint === 0x200d &&
        firstPictographic !== undefined &&
        lastPictographic !== undefined &&
        firstPictographic < index &&
        lastPictographic > index) ||
      (((codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
        (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) &&
        firstPictographic !== undefined &&
        firstPictographic < index)
    ) {
      // Preserve joiners/selectors only inside a real pictographic cluster so ordinary emoji keep
      // their intended grapheme. Standalone or injected instances become explicit inert tokens.
      output += scalar;
    } else if (
      (orphanedMarks && MARK.test(scalar)) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      DEFAULT_IGNORABLE.test(scalar)
    ) {
      output += scalarToken(codePoint);
    } else {
      output += scalar;
    }
  }
  return output;
}

/**
 * Display-only neutralization for untrusted terminal text. Invisible formatting scalars become
 * stable, copyable tokens while legitimate emoji and combining graphemes retain their meaning.
 * Callers that own multiline layout should apply this to each logical line separately.
 */
export function visibleTerminalText(value: string): string {
  return graphemeSpans(value)
    .map((span) => visibleGrapheme(span.text))
    .join("");
}
