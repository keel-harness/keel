/**
 * Typed errors thrown by the scripted model. They are typed (not bare `Error`)
 * so the future kernel loop can branch on them instead of string-matching, and
 * so the message stays co-located with the failure. (No `strings.ts` yet — that
 * convention arrives with the Phase 1 TUI's real user-facing microcopy.)
 */

/**
 * Normalise a caught `unknown` into a human-readable string. `catch` binds
 * `unknown`, but a thrown value is almost always an `Error` (whose `.message` is
 * the useful part); anything else is stringified. DRY-extracted so the defensive
 * `: String(e)` branch is covered once here rather than re-tested at every
 * try/catch (loader.ts, matcher.ts). See ADR-0020.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A matcher kind the Phase 0 engine does not implement yet. */
export class UnsupportedMatcherError extends Error {
  constructor(public readonly kind: string) {
    super(
      `simulator: matcher kind "${kind}" is not implemented in Phase 0 (regex only). ` +
        `jsonpath lands with the Phase 1/2 adversarial corpus and gets its own ADR for the ` +
        `JSONPath library choice.`,
    );
    this.name = "UnsupportedMatcherError";
  }
}

/** A script's branch gotos cycled without ever reaching a content turn. */
export class ControlFlowError extends Error {
  constructor(message: string) {
    super(`simulator: ${message}`);
    this.name = "ControlFlowError";
  }
}

/**
 * A regex-kind branch matcher carries a pattern that cannot be compiled by the
 * JS `RegExp` engine. Thrown at load time (by `loadScript`/`parseScriptJson`) with
 * turn/branch provenance, or at match time (by `matchResult`) as a backstop for
 * in-memory `SimulatorScriptT` objects that bypass the loader.
 */
export class InvalidMatcherPatternError extends Error {
  /** The offending regex source string. */
  public readonly pattern: string;
  /** Human-readable reason from the underlying `SyntaxError`. */
  public readonly causeMessage: string;
  /** Turn/branch provenance (e.g. `"turns[2].branches[0]"`), absent on the in-memory path. */
  public readonly location: string | undefined;

  constructor(pattern: string, cause: string, location?: string) {
    const where = location !== undefined ? ` at ${location}` : "";
    super(`simulator: invalid regex pattern "${pattern}"${where} — ${cause}`);
    this.name = "InvalidMatcherPatternError";
    this.pattern = pattern;
    this.causeMessage = cause;
    this.location = location;
  }
}
