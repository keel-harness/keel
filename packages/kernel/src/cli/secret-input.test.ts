import { describe, expect, it } from "vitest";
import { feedSecretChar, initialSecretInput, type SecretInputState } from "./secret-input.js";

const ESC = "";
const CTRL_C = "";
const CTRL_D = "";
const BS = ""; // DEL (the usual terminal backspace)

/** Feed a whole string through the reducer, returning the terminal result or the accumulated state. */
function feed(s: string): { kind: string; value?: string; state?: SecretInputState } {
  let state = initialSecretInput;
  for (const ch of s) {
    const r = feedSecretChar(state, ch);
    if (r.kind === "submit") return { kind: "submit", value: r.value };
    if (r.kind === "abort") return { kind: "abort" };
    state = r.state;
  }
  return { kind: "continue", state };
}

describe("feedSecretChar — the no-echo secret-entry reducer (Epic 1.9 QC, DX-1/DX-2)", () => {
  it("accumulates printable characters into the buffer", () => {
    const r = feed("sk-ant-abc123");
    expect(r.kind).toBe("continue");
    expect(r.state?.buf).toBe("sk-ant-abc123");
  });

  it("submits the buffer on Enter (\\n and \\r)", () => {
    expect(feed("hello\n")).toEqual({ kind: "submit", value: "hello" });
    expect(feed("world\r")).toEqual({ kind: "submit", value: "world" });
  });

  it("aborts on Ctrl-C and Ctrl-D (EOF)", () => {
    expect(feed(`partial${CTRL_C}rest`)).toEqual({ kind: "abort" });
    expect(feed(`partial${CTRL_D}rest`)).toEqual({ kind: "abort" });
  });

  it("backspace (DEL and ^H) removes the last buffered character", () => {
    expect(feed("abcd")?.state?.buf).toBe("abcd");
    expect(feed(`abcd${BS}`)?.state?.buf).toBe("abc");
    expect(feed("abcd\b")?.state?.buf).toBe("abc");
    expect(feed(BS)?.state?.buf).toBe(""); // backspace on empty is a no-op, not a crash
  });

  it("drops a CSI escape sequence (arrow keys) instead of corrupting the key — DX-1", () => {
    // ESC [ D is a left-arrow; the whole 3-byte sequence must vanish, not append "[D".
    expect(feed(`ab${ESC}[Dcd`)?.state?.buf).toBe("abcd");
    // Home/End with a parameter + final byte: ESC [ 1 ~
    expect(feed(`x${ESC}[1~y`)?.state?.buf).toBe("xy");
  });

  it("drops an SS3 sequence (function keys: ESC O P) and a lone alt-chord (ESC z)", () => {
    expect(feed(`a${ESC}OPb`)?.state?.buf).toBe("ab");
    expect(feed(`a${ESC}zb`)?.state?.buf).toBe("ab"); // ESC + 'z' (alt-z) consumes just the one char
  });

  it("drops bare control characters (e.g. a stray TAB) rather than buffering them", () => {
    expect(feed("a\tb")?.state?.buf).toBe("ab");
  });

  it("does not treat a bracketed-paste of a realistic key as control input", () => {
    // The paste payload itself is printable and is buffered; the bracket markers (ESC [ 200~ … 201~)
    // are CSI sequences and are dropped.
    const r = feed(`${ESC}[200~sk-proj-XYZ789${ESC}[201~`);
    expect(r.state?.buf).toBe("sk-proj-XYZ789");
  });
});
