import type { Overlay, UserInput } from "@keel/shared";
import { URGENT_VERBS, commandByName, paletteCommands } from "./commands.js";
import { nextGraphemeBoundary, previousGraphemeBoundary } from "./display-cells.js";
import { stripControl } from "./view-model.js";

/** A normalized keystroke (the Ink input widget maps raw key events to these). */
export type Key =
  | { kind: "char"; value: string }
  | { kind: "enter" }
  | { kind: "newline" } // Ctrl-J: insert a literal newline for multi-line input (never submits)
  | { kind: "backspace" } // delete one extended grapheme before the cursor
  | { kind: "deleteForward" } // delete one extended grapheme under the cursor
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "left" } // ← : move the cursor one extended grapheme left
  | { kind: "right" } // → : move the cursor one extended grapheme right
  | { kind: "home" } // Ctrl-A : cursor to line start
  | { kind: "end" } // Ctrl-E : cursor to line end
  | { kind: "wordLeft" } // Alt-B : cursor to the start of the previous word
  | { kind: "wordRight" } // Alt-F : cursor to the end of the next word
  | { kind: "killToStart" } // Ctrl-U : kill from line start to the cursor
  | { kind: "killToEnd" } // Ctrl-K : kill from the cursor to line end
  | { kind: "killWord" } // Ctrl-W : kill the word before the cursor
  | { kind: "yank" } // Ctrl-Y : insert the kill-ring at the cursor
  | { kind: "paste"; text: string } // bracketed paste — atomic, sanitized bulk insert (slice 4b)
  | { kind: "complete-command" } // Tab on the slash palette: complete the top match without running it
  | { kind: "complete-path"; path: string } // accept an @file completion (slice 5): replace the @token
  | { kind: "select-overlay"; delta: number; count: number } // bounded palette/@file selection
  | { kind: "set-buffer"; text: string } // replace the whole draft (used by the external editor hook)
  | { kind: "escape" }
  | { kind: "reverse-search" } // Ctrl-R: incremental reverse-search over history (Epic 1.23 slice 3b)
  | { kind: "interrupt" }; // Ctrl-C

/** Live `Ctrl-R` reverse-search state (Epic 1.23 slice 3b). `index` is the position in `history` of
 *  the current match (`null` = no current match — empty query or nothing found). Present only while
 *  searching; the buffer is left untouched until the match is accepted. */
export interface ReverseSearch {
  readonly query: string;
  readonly index: number | null;
}

export interface InputState {
  readonly buffer: string;
  /** UTF-16 insertion index in `[0, buffer.length]`; reducer-produced states keep it on an extended
   *  grapheme boundary shared with terminal display and wrapping. */
  readonly cursor: number;
  readonly history: readonly string[];
  /** Position in `history` during recall; `null` = editing the live buffer. */
  readonly histIndex: number | null;
  /** The unsent live draft captured when the user browses submitted history. */
  readonly draft?: string;
  /** Exact insertion cursor for `draft`, restored when history browsing returns to the live draft. */
  readonly draftCursor?: number;
  /** The kill-ring's single slot (Ctrl-K/U/W fill it; Ctrl-Y yanks it); `""` when empty (slice 4a). */
  readonly kill: string;
  readonly overlay?: Overlay;
  /** Zero-based local palette/@file selection. Omitted means the first item. */
  readonly selection?: number;
  /** Set only while a `Ctrl-R` reverse-search is active (Epic 1.23 slice 3b). */
  readonly search?: ReverseSearch;
}

export interface InputResult {
  readonly state: InputState;
  /** A resolved input to act on (submit a line, run a command, interrupt), if any. */
  readonly action?: UserInput;
}

export function emptyInput(history: readonly string[] = []): InputState {
  return { buffer: "", cursor: 0, history, histIndex: null, kill: "" };
}

// Build a state, including `overlay` only when defined (exactOptionalPropertyTypes).
function make(
  buffer: string,
  cursor: number,
  history: readonly string[],
  histIndex: number | null,
  kill: string,
  overlay?: Overlay,
  draft?: string,
  draftCursor?: number,
  selection?: number,
): InputState {
  const base = { buffer, cursor, history, histIndex, kill };
  return {
    ...base,
    ...(overlay !== undefined ? { overlay } : {}),
    ...(draft !== undefined ? { draft } : {}),
    ...(draftCursor !== undefined ? { draftCursor } : {}),
    ...(selection !== undefined ? { selection } : {}),
  };
}

function boundedSelection(current: number | undefined, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, (current ?? 0) + delta));
}

/** A leading "/" opens the command palette (its query is the buffer). `?` help is handled
 *  separately as a key on an empty buffer. */
function overlayForBuffer(buffer: string): Overlay | undefined {
  return buffer.startsWith("/") ? { kind: "palette", query: buffer } : undefined;
}

/** The `@file` token the cursor sits in, if any (Epic 1.23 slice 5): the WHOLE whitespace-delimited run
 *  containing the cursor, but only when it STARTS with `@`. Returns the token's `start`/`end` indices +
 *  the `query` (the full token text after the `@`). Spanning the whole token (not just up to the cursor)
 *  means editing mid-token completes/filters the real token, never a truncated prefix. `email@host` is
 *  NOT a token (the `@` is mid-word). */
function atTokenAt(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | undefined {
  let start = cursor;
  while (start > 0 && !/\s/.test(buffer[start - 1]!)) start--;
  if (buffer[start] !== "@") return undefined;
  let end = cursor;
  while (end < buffer.length && !/\s/.test(buffer[end]!)) end++;
  return { start, end, query: buffer.slice(start + 1, end) };
}

/** The discoverability overlay for a buffer+cursor: the `@file` completion overlay when the cursor is
 *  in an `@token` (slice 5), else the `/` command palette (when the whole buffer is a slash command). */
function overlayFor(buffer: string, cursor: number): Overlay | undefined {
  const at = atTokenAt(buffer, cursor);
  if (at !== undefined) return { kind: "at-complete", query: at.query };
  return overlayForBuffer(buffer);
}

/** If the buffer is an exact urgent verb (optionally followed by an instruction), resolve it to a
 *  command action carrying that instruction in `args`. Returns undefined otherwise (so the normal
 *  fuzzy palette handles it) — a mere prefix like "/no" is NOT the verb "/now". */
function urgentAction(buffer: string): UserInput | undefined {
  const space = buffer.indexOf(" ");
  const verb = space === -1 ? buffer : buffer.slice(0, space);
  if (!URGENT_VERBS.has(verb)) return undefined;
  const args = space === -1 ? "" : buffer.slice(space + 1).trim();
  return args.length > 0 ? { kind: "command", name: verb, args } : { kind: "command", name: verb };
}

function isUrgentPrefix(buffer: string): boolean {
  const space = buffer.indexOf(" ");
  const token = space === -1 ? buffer : buffer.slice(0, space);
  if (token.length <= 1 || URGENT_VERBS.has(token)) return false;
  return [...URGENT_VERBS].some((verb) => verb.startsWith(token));
}

function exactCommandAction(buffer: string): UserInput | undefined {
  const space = buffer.search(/\s/u);
  const name = space === -1 ? buffer : buffer.slice(0, space);
  const command = commandByName(name);
  if (command === undefined) return undefined;
  return slashCommandAction(buffer);
}

function slashCommandAction(buffer: string): UserInput {
  const space = buffer.search(/\s/u);
  const name = space === -1 ? buffer : buffer.slice(0, space);
  if (space === -1) return { kind: "command", name };
  const args = buffer.slice(space + 1).trim();
  return args.length > 0 ? { kind: "command", name, args } : { kind: "command", name };
}

/** Apply an edit (buffer + cursor change): recompute the overlay, drop history-recall, keep the
 *  kill-ring. The single chokepoint for character/newline insert + backspace (Epic 1.23 slice 4a). */
function editTo(s: InputState, buffer: string, cursor: number): InputState {
  return make(buffer, cursor, s.history, null, s.kill, overlayFor(buffer, cursor));
}

/** Pure cursor motion (no buffer change): keep the buffer, history-recall, and kill-ring, but RECOMPUTE
 *  the overlay — the `@file` overlay is cursor-position-dependent, so moving into/out of an `@token`
 *  opens/closes it (slice 5). The `/` palette is buffer-only, so it is unaffected by motion. */
function moveTo(s: InputState, cursor: number): InputState {
  return make(
    s.buffer,
    cursor,
    s.history,
    s.histIndex,
    s.kill,
    overlayFor(s.buffer, cursor),
    s.draft,
    s.draftCursor,
  );
}

/** The cursor index one extended grapheme LEFT of `cur`, using the shared Slice-3B0 boundary policy. */
function stepLeft(buffer: string, cur: number): number {
  return previousGraphemeBoundary(buffer, cur);
}

/** The cursor index one extended grapheme RIGHT of `cur`. Exported so Ink highlights one whole
 *  grapheme under the block cursor rather than a partial combining/emoji/Indic cluster. */
export function stepRight(buffer: string, cur: number): number {
  return nextGraphemeBoundary(buffer, cur);
}

function boundedCursor(buffer: string, cursor: number): number {
  return Math.min(buffer.length, Math.max(0, cursor));
}

/** Logical-line start for an insertion cursor. A cursor on `\n` belongs to the line before it; a
 *  cursor immediately after `\n` belongs to the following line. */
function logicalLineStart(buffer: string, cursor: number): number {
  const bounded = boundedCursor(buffer, cursor);
  return buffer.lastIndexOf("\n", bounded - 1) + 1;
}

/** Logical-line end excluding the line break, or the payload end for the final logical line. */
function logicalLineEnd(buffer: string, cursor: number): number {
  const bounded = boundedCursor(buffer, cursor);
  const newline = buffer.indexOf("\n", bounded);
  return newline === -1 ? buffer.length : newline;
}

/** Apply a kill — an edit that removed `killed` from the buffer, capturing it in the kill-ring. An
 *  EMPTY kill (Ctrl-K at line end, Ctrl-W at line start) leaves the ring UNTOUCHED, so a stray kill at
 *  a boundary never clobbers a real yank target. */
function withKill(s: InputState, buffer: string, cursor: number, killed: string): InputState {
  const kill = killed === "" ? s.kill : killed;
  return make(buffer, cursor, s.history, null, kill, overlayFor(buffer, cursor));
}

const isSpace = (c: string): boolean => /\s/.test(c);

/** Index where the whitespace-delimited word before `cur` starts (skip trailing whitespace, then the
 *  word) — the target of Alt-B and the extent of Ctrl-W. */
function prevWordStart(buffer: string, cur: number): number {
  let i = cur;
  while (i > 0 && isSpace(buffer[i - 1]!)) i--;
  while (i > 0 && !isSpace(buffer[i - 1]!)) i--;
  return i;
}

/** Index just after the whitespace-delimited word following `cur` (skip leading whitespace, then the
 *  word) — the target of Alt-F. */
function nextWordEnd(buffer: string, cur: number): number {
  let i = cur;
  while (i < buffer.length && isSpace(buffer[i]!)) i++;
  while (i < buffer.length && !isSpace(buffer[i]!)) i++;
  return i;
}

/** Most-recent history index ≤ `from` whose entry contains `query` as a substring, else null. Callers
 *  only pass a non-empty `query`; an empty history (`from === -1`) yields null without iterating. */
function searchBackward(history: readonly string[], query: string, from: number): number | null {
  for (let i = from; i >= 0; i--) if (history[i]!.includes(query)) return i;
  return null;
}

/** The rendered reverse-search overlay — `match` is included only when a history entry was found
 *  (omitted, not `undefined`, for exactOptionalPropertyTypes). */
function reverseSearchOverlay(
  history: readonly string[],
  query: string,
  index: number | null,
): Overlay {
  return index !== null
    ? { kind: "reverse-search", query, match: history[index]! }
    : { kind: "reverse-search", query };
}

/** A live reverse-search state: the buffer + cursor are left UNTOUCHED (restored on cancel, replaced on
 *  accept); the query + current match index live in `search`, mirrored into the overlay for renderers. */
function searchState(s: InputState, query: string, index: number | null): InputState {
  return {
    buffer: s.buffer,
    cursor: s.cursor,
    history: s.history,
    histIndex: s.histIndex,
    kill: s.kill,
    ...(s.draft !== undefined ? { draft: s.draft } : {}),
    ...(s.draftCursor !== undefined ? { draftCursor: s.draftCursor } : {}),
    search: { query, index },
    overlay: reverseSearchOverlay(s.history, query, index),
  };
}

/** Accept the current match into the buffer (or keep the pre-search buffer when nothing matched) and
 *  leave search mode — deliberately WITHOUT submitting: a recalled prompt is a re-runnable task, so the
 *  user reviews it and presses Enter again to send (the fish/Claude-Code idiom, the safe one). The
 *  cursor lands at the end of the accepted line. */
function acceptSearch(s: InputState): InputState {
  const idx = s.search!.index;
  if (idx !== null) {
    const buffer = s.history[idx]!;
    return make(buffer, buffer.length, s.history, null, s.kill, overlayFor(buffer, buffer.length));
  }
  return make(
    s.buffer,
    s.cursor,
    s.history,
    s.histIndex,
    s.kill,
    overlayFor(s.buffer, s.cursor),
    s.draft,
    s.draftCursor,
  );
}

/** Cancel search: restore the full untouched pre-search editing/history state and recompute its
 *  overlay; leave search mode without losing a live draft held behind history browsing. */
function cancelSearch(s: InputState): InputState {
  return make(
    s.buffer,
    s.cursor,
    s.history,
    s.histIndex,
    s.kill,
    overlayFor(s.buffer, s.cursor),
    s.draft,
    s.draftCursor,
  );
}

/**
 * Fold one keystroke while a `Ctrl-R` reverse-search is active (Epic 1.23 slice 3b). Chars/backspace
 * refine the query (re-matching from the newest entry); `Ctrl-R` steps to the next-older match;
 * Escape/Ctrl-C back out of the sub-mode WITHOUT interrupting the agent; ANY other key (Enter, cursor
 * motion, an edit) commits the current match and leaves search.
 */
function reduceSearch(s: InputState, key: Key): InputResult {
  const search = s.search!;
  switch (key.kind) {
    case "char": {
      // Refining the query re-scans from the NEWEST entry — the match is always "the most recent
      // history line containing what I've typed". Simpler + more predictable than readline anchoring
      // the re-scan at the current match index; the deliberate trade-off is that adding a char after
      // stepping older (Ctrl-R) can jump forward to a newer match that also contains the longer query.
      const query = search.query + key.value;
      return {
        state: searchState(s, query, searchBackward(s.history, query, s.history.length - 1)),
      };
    }
    case "backspace": {
      const query = search.query.slice(
        0,
        previousGraphemeBoundary(search.query, search.query.length),
      );
      const index = query === "" ? null : searchBackward(s.history, query, s.history.length - 1);
      return { state: searchState(s, query, index) };
    }
    case "reverse-search": {
      if (search.index === null) return { state: s }; // nothing matched yet → nothing older to step to
      const older = searchBackward(s.history, search.query, search.index - 1);
      return older === null ? { state: s } : { state: searchState(s, search.query, older) };
    }
    case "escape":
    case "interrupt":
      return { state: cancelSearch(s) };
    case "paste":
      // Commit the current match, THEN apply the paste to the committed buffer — pasted text is bulk
      // content and must never be silently dropped (unlike a motion key, which the match-commit consumes).
      return inputReduce(acceptSearch(s), key);
    default:
      return { state: acceptSearch(s) };
  }
}

/**
 * Pure input state machine: fold one keystroke into the input state, optionally emitting a
 * resolved `UserInput`. Gated + exhaustively tested; the Ink input widget is a thin driver that
 * maps raw key events to `Key`s and forwards the emitted actions.
 */
export function inputReduce(s: InputState, key: Key): InputResult {
  // A live Ctrl-R reverse-search owns every keystroke until it is accepted or cancelled (slice 3b).
  if (s.search !== undefined) return reduceSearch(s, key);
  switch (key.kind) {
    case "char":
      if (key.value === "?" && s.buffer === "" && s.overlay === undefined) {
        return { state: make("", 0, s.history, null, s.kill, { kind: "help" }) };
      }
      // Insert AT the cursor (not the end), and advance past the inserted text.
      return {
        state: editTo(
          s,
          s.buffer.slice(0, s.cursor) + key.value + s.buffer.slice(s.cursor),
          s.cursor + key.value.length,
        ),
      };
    case "backspace": {
      // Delete the whole extended grapheme BEFORE the cursor; at buffer start it is a no-op.
      if (s.cursor === 0) return { state: s };
      const from = stepLeft(s.buffer, s.cursor);
      return { state: editTo(s, s.buffer.slice(0, from) + s.buffer.slice(s.cursor), from) };
    }
    case "deleteForward": {
      // Forward Delete is distinct from Backspace: remove the whole grapheme under the cursor.
      if (s.cursor >= s.buffer.length) return { state: s };
      const to = stepRight(s.buffer, s.cursor);
      return {
        state: editTo(s, s.buffer.slice(0, s.cursor) + s.buffer.slice(to), s.cursor),
      };
    }
    case "newline":
      // Ctrl-J: insert a literal newline AT the cursor for multi-line input — never submits or runs a
      // command. Ignored while the command palette is open: a slash-command query is single-line, so a
      // newline there has no meaning (and would make `filterCommands` see a multi-line query).
      return s.overlay?.kind === "palette"
        ? { state: s }
        : {
            state: editTo(
              s,
              s.buffer.slice(0, s.cursor) + "\n" + s.buffer.slice(s.cursor),
              s.cursor + 1,
            ),
          };
    case "complete-command": {
      if (s.overlay?.kind !== "palette") return { state: s };
      const selected = paletteCommands(s.overlay.query)[s.selection ?? 0];
      return selected !== undefined
        ? { state: editTo(s, selected.name, selected.name.length) }
        : { state: s };
    }
    case "select-overlay": {
      if (s.overlay?.kind !== "palette" && s.overlay?.kind !== "at-complete") {
        return { state: s };
      }
      const selection = boundedSelection(s.selection, key.delta, key.count);
      return selection === s.selection ? { state: s } : { state: { ...s, selection } };
    }
    case "enter": {
      if (s.overlay?.kind === "palette") {
        const urgent = urgentAction(s.buffer);
        if (urgent !== undefined) return { state: emptyInput(s.history), action: urgent };
        const exact = exactCommandAction(s.buffer);
        if (exact !== undefined) return { state: emptyInput(s.history), action: exact };
        if (isUrgentPrefix(s.buffer)) return { state: emptyInput(s.history) };
        const selected = paletteCommands(s.overlay.query)[s.selection ?? 0];
        return selected !== undefined
          ? { state: emptyInput(s.history), action: { kind: "command", name: selected.name } }
          : { state: emptyInput(s.history), action: slashCommandAction(s.buffer) };
      }
      // Multi-line continuation (shell-style, ODD/EVEN): a line ending in an ODD number of backslashes
      // continues — the last one escapes the newline, so drop just that one, insert a newline, and don't
      // submit (the earlier backslashes stay literal). An EVEN trailing run is all-literal, so the line
      // SUBMITS with the backslashes intact — the escape hatch for a prompt that must end in a backslash
      // (a Windows path, a regex), which the old "any trailing backslash continues" rule silently ate.
      const trailingBackslashes = s.buffer.match(/\\*$/)?.[0].length ?? 0;
      if (trailingBackslashes % 2 === 1) {
        const continued = s.buffer.slice(0, -1) + "\n";
        return { state: editTo(s, continued, continued.length) };
      }
      // A blank or whitespace-only buffer (including a multi-line one of just newlines) is a no-op — it
      // must not submit an empty turn to the model (the single-line path was `=== ""`; multi-line needs trim).
      if (s.buffer.trim() === "") return { state: emptyInput(s.history) };
      const exact = exactCommandAction(s.buffer);
      if (exact !== undefined) return { state: emptyInput(s.history), action: exact };
      return {
        state: {
          buffer: "",
          cursor: 0,
          history: [...s.history, s.buffer],
          histIndex: null,
          kill: "",
        },
        action: { kind: "line", text: s.buffer },
      };
    }
    case "up": {
      if (s.history.length === 0) return { state: s };
      const idx = s.histIndex === null ? s.history.length - 1 : Math.max(0, s.histIndex - 1);
      const entry = s.history[idx]!;
      const draft = s.histIndex === null ? s.buffer : s.draft;
      const draftCursor = s.histIndex === null ? s.cursor : s.draftCursor;
      return {
        state: make(entry, entry.length, s.history, idx, s.kill, undefined, draft, draftCursor),
      };
    }
    case "down": {
      if (s.histIndex === null) return { state: s };
      const next = s.histIndex + 1;
      if (next >= s.history.length) {
        const draft = s.draft ?? "";
        const cursor = Math.min(draft.length, s.draftCursor ?? draft.length);
        return { state: make(draft, cursor, s.history, null, s.kill) };
      }
      const entry = s.history[next]!;
      return {
        state: make(
          entry,
          entry.length,
          s.history,
          next,
          s.kill,
          undefined,
          s.draft,
          s.draftCursor,
        ),
      };
    }
    // Cursor motion shares the Slice-3B0 extended-grapheme policy with display and wrapping.
    case "left":
      return { state: moveTo(s, stepLeft(s.buffer, s.cursor)) };
    case "right":
      return { state: moveTo(s, stepRight(s.buffer, s.cursor)) };
    case "home":
      return { state: moveTo(s, logicalLineStart(s.buffer, s.cursor)) };
    case "end":
      return { state: moveTo(s, logicalLineEnd(s.buffer, s.cursor)) };
    case "wordLeft":
      return { state: moveTo(s, prevWordStart(s.buffer, s.cursor)) };
    case "wordRight":
      return { state: moveTo(s, nextWordEnd(s.buffer, s.cursor)) };
    case "killToStart": {
      // Ctrl-U: kill only from the current logical-line start to the cursor.
      const start = logicalLineStart(s.buffer, s.cursor);
      return {
        state: withKill(
          s,
          s.buffer.slice(0, start) + s.buffer.slice(s.cursor),
          start,
          s.buffer.slice(start, s.cursor),
        ),
      };
    }
    case "killToEnd": {
      // Ctrl-K: kill only from the cursor to the current logical-line end; preserve its newline.
      const end = logicalLineEnd(s.buffer, s.cursor);
      return {
        state: withKill(
          s,
          s.buffer.slice(0, s.cursor) + s.buffer.slice(end),
          s.cursor,
          s.buffer.slice(s.cursor, end),
        ),
      };
    }
    case "killWord": {
      // Ctrl-W: kill the whitespace-delimited word before the cursor.
      const start = prevWordStart(s.buffer, s.cursor);
      return {
        state: withKill(
          s,
          s.buffer.slice(0, start) + s.buffer.slice(s.cursor),
          start,
          s.buffer.slice(start, s.cursor),
        ),
      };
    }
    case "yank": {
      // Ctrl-Y: insert the kill-ring at the cursor (the ring persists for re-yank); empty ring = no-op.
      if (s.kill === "") return { state: s };
      const buffer = s.buffer.slice(0, s.cursor) + s.kill + s.buffer.slice(s.cursor);
      return {
        state: make(
          buffer,
          s.cursor + s.kill.length,
          s.history,
          null,
          s.kill,
          overlayFor(buffer, s.cursor + s.kill.length),
        ),
      };
    }
    case "escape":
      // Closing the command palette / `?` help clears the buffer (the buffer IS the command). But the
      // `@file` overlay sits inside a real prompt — escaping it dismisses only the transient dropdown
      // while preserving the exact prompt/cursor/history state. The next edit may recompute it.
      if (s.overlay?.kind === "palette" || s.overlay?.kind === "help") {
        return { state: make("", 0, s.history, null, s.kill) };
      }
      if (s.overlay?.kind === "at-complete") {
        const { overlay: _overlay, selection: _selection, ...dismissed } = s;
        void _overlay;
        void _selection;
        return { state: dismissed };
      }
      return { state: s, action: { kind: "interrupt" } };
    case "complete-path": {
      // Accept an @file completion (slice 5): replace the `@token` at the cursor with `@<path>`, keeping
      // the `@`. The trust-gated completer (which produced `path`) lives in the driver; this is a pure
      // text replacement. A no-op when there is no @token at the cursor (defensive — the driver only
      // sends this while an at-complete overlay is active).
      const at = atTokenAt(s.buffer, s.cursor);
      if (at === undefined) return { state: s };
      // Replace the WHOLE `@token` (start..end), not just up to the cursor — otherwise a mid-token
      // completion would leave the token's tail dangling after the inserted path (slice-5 QC M1).
      const replacement = `@${key.path}`;
      const buffer = s.buffer.slice(0, at.start) + replacement + s.buffer.slice(at.end);
      return { state: editTo(s, buffer, at.start + replacement.length) };
    }
    case "set-buffer": {
      const buffer = stripControl(key.text);
      return {
        state: make(
          buffer,
          buffer.length,
          s.history,
          null,
          s.kill,
          overlayFor(buffer, buffer.length),
        ),
      };
    }
    case "reverse-search":
      // Open reverse-search with an empty query (no match yet); the buffer is preserved for cancel.
      return { state: searchState(s, "", null) };
    case "paste": {
      // Bulk paste (slice 4b): sanitize control bytes (ER-020 — a pasted blob is the raw-escape-byte
      // vector that typed input is not; `stripControl` keeps \n/\t and DROPS ESC/C0/C1 and \r), then
      // insert atomically at the cursor. Never opens the palette (no flicker, no `/`-blob treated as a
      // command) and never submits, so a multi-line paste lands as ONE unit.
      //
      // A bracketed paste delivers its line breaks as CR (0x0d), not LF — proven byte-for-byte: a
      // terminal/tmux hands `alpha\nbravo` to the app as `alpha\x0dbravo`. Normalize paste newlines
      // (CRLF and lone CR → LF) FIRST so the line boundaries survive; `stripControl` then keeps the
      // LFs. Without this, every CR falls in the C0 range and is dropped, silently joining all lines.
      const clean = stripControl(key.text.replace(/\r\n?/g, "\n"));
      const buffer = s.buffer.slice(0, s.cursor) + clean + s.buffer.slice(s.cursor);
      return {
        state: {
          buffer,
          cursor: s.cursor + clean.length,
          history: s.history,
          histIndex: null,
          kill: s.kill,
        },
      };
    }
    case "interrupt":
      return { state: s, action: { kind: "interrupt" } };
  }
}
