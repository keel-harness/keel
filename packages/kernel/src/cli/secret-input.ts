/**
 * Pure reducer for no-echo secret entry (Epic 1.9 QC — DX-1/DX-2). The bin reads the API key from a
 * raw-mode TTY one keystroke at a time; this turns a stream of decoded characters into submit / abort /
 * accumulate decisions WITHOUT echoing anything. Keeping it pure makes the tricky parts — backspace,
 * Ctrl-C/Ctrl-D, and swallowing terminal escape sequences (arrow keys, Home/End, bracketed-paste
 * markers) so they never corrupt the stored key — unit-testable; the bin keeps only the TTY plumbing.
 */

/** Control codes, by codepoint (kept numeric so no raw control bytes live in the source). */
const CTRL_C = 0x03;
const CTRL_D = 0x04; // EOF
const ESC = 0x1b;
const DEL = 0x7f;
const SPACE = 0x20;

export interface SecretInputState {
  /** The secret accumulated so far (never rendered to the terminal). */
  readonly buf: string;
  /** Escape-sequence parser state: `none` normally; `esc` just after ESC; `csi` inside a CSI/SS3 run. */
  readonly esc: "none" | "esc" | "csi";
}

export const initialSecretInput: SecretInputState = { buf: "", esc: "none" };

export type SecretInputResult =
  | { readonly kind: "continue"; readonly state: SecretInputState }
  | { readonly kind: "submit"; readonly value: string }
  | { readonly kind: "abort" };

const cont = (state: SecretInputState): SecretInputResult => ({ kind: "continue", state });

/**
 * Advance the reducer by one decoded character. Enter (`\n`/`\r`) submits; Ctrl-C and Ctrl-D (EOF)
 * abort; DEL/`\b` delete the last char; ESC begins a terminal escape sequence that is swallowed whole;
 * every other control char (< 0x20) is dropped; printable input appends.
 */
export function feedSecretChar(state: SecretInputState, ch: string): SecretInputResult {
  const code = ch.charCodeAt(0);

  // Mid escape sequence — swallow it so arrow keys / paste markers never land in the secret (DX-1).
  if (state.esc === "esc") {
    // ESC followed by '[' (CSI) or 'O' (SS3) opens a multi-byte sequence; anything else is a lone
    // alt-key chord — consume just that one trailing char.
    return cont({ buf: state.buf, esc: ch === "[" || ch === "O" ? "csi" : "none" });
  }
  if (state.esc === "csi") {
    const isFinal = code >= 0x40 && code <= 0x7e; // CSI/SS3 final byte (@..~) ends the sequence
    return cont({ buf: state.buf, esc: isFinal ? "none" : "csi" });
  }

  if (ch === "\n" || ch === "\r") return { kind: "submit", value: state.buf };
  if (code === CTRL_C || code === CTRL_D) return { kind: "abort" };
  if (code === DEL || ch === "\b") return cont({ ...state, buf: state.buf.slice(0, -1) });
  if (code === ESC) return cont({ ...state, esc: "esc" }); // start of an escape sequence
  if (code < SPACE) return cont(state); // drop other bare control chars
  return cont({ ...state, buf: state.buf + ch });
}
