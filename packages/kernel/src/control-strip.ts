/**
 * Terminal control-byte sanitizers (ER-020 / §4.9.1). User-, model-, tool-, and
 * filesystem-derived text is data, never terminal control input.
 */
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex -- intentional control-byte filter (security)
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(BIDI_CONTROL, "");
}

export function stripControlLine(s: string): string {
  return stripControl(s).replace(/[\n\u2028\u2029]/g, " ");
}

function stripAnsiCsi(value: string): string {
  let output = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b && value[i + 1] === "[") {
      i += 2;
      while (i < value.length) {
        const finalCode = value.charCodeAt(i);
        if (finalCode >= 0x40 && finalCode <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    output += value.charAt(i);
  }
  return output;
}

export function oneLineText(value: string): string {
  return stripControlLine(stripAnsiCsi(value)).replace(/\s+/gu, " ").trim();
}
