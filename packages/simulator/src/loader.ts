import { SimulatorScript, type SimulatorScriptT } from "@keel/shared";
import { InvalidMatcherPatternError, errorMessage } from "./errors.js";

/**
 * Validate an already-parsed value as a `SimulatorScript` (parse, don't
 * validate-by-hope — §6.4). Throws `ZodError` on malformed input.
 *
 * After structural validation, walks every branch matcher whose kind is "regex"
 * and pre-compiles the pattern. An uncompilable pattern throws a typed
 * `InvalidMatcherPatternError` carrying the pattern and turn/branch provenance.
 *
 * WHY HERE AND NOT IN THE SCHEMA:
 *   `ResultMatcher` in @keel/shared intentionally has no `.superRefine` for regex
 *   compilation. The `simulator/script.test.ts` property test runs
 *   `assertRoundTrips(SimulatorScript)` with fast-check; adding a schema refine
 *   that rejects random strings would force zod-fast-check to filter, making that
 *   already-slow test slower and flakier. The loader is the right parse boundary
 *   for the file/JSON corpus. `matcher.ts` provides an in-memory backstop for
 *   `SimulatorScriptT` objects that bypass this loader entirely.
 */
export function loadScript(raw: unknown): SimulatorScriptT {
  const script = SimulatorScript.parse(raw);
  for (let i = 0; i < script.turns.length; i++) {
    const turn = script.turns[i]!;
    const branches = turn.branches ?? [];
    for (let j = 0; j < branches.length; j++) {
      const { match } = branches[j]!;
      if (match.kind === "regex") {
        try {
          new RegExp(match.pattern);
        } catch (e) {
          throw new InvalidMatcherPatternError(
            match.pattern,
            errorMessage(e),
            `turns[${String(i)}].branches[${String(j)}]`,
          );
        }
      }
    }
  }
  return script;
}

/**
 * Parse a JSON string into a validated `SimulatorScript`. YAML authoring is
 * deferred to the Phase 1/2 file-based corpus (keeps Phase 0 dependency-free);
 * in-memory objects and JSON cover every Phase 0 test. Throws `SyntaxError` on
 * bad JSON, `ZodError` on a structurally invalid script.
 */
export function parseScriptJson(text: string): SimulatorScriptT {
  return loadScript(JSON.parse(text) as unknown);
}
