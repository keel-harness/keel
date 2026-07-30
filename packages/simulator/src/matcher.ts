import type { ResultMatcherT } from "@keel/shared";
import { InvalidMatcherPatternError, UnsupportedMatcherError, errorMessage } from "./errors.js";

/**
 * Evaluate a script branch matcher against the latest tool-result text. Phase 0
 * implements `regex`; `jsonpath` throws `UnsupportedMatcherError` (deferred —
 * see errors.ts and the public roadmap). An `undefined` result (no prior tool call) never
 * matches. The switch is exhaustive over the schema's enum: adding a new kind to
 * `ResultMatcher` without handling it here is a compile error, not a silent gap.
 *
 * DEFERRED RISK — ReDoS exposure: the `regex` case compiles `matcher.pattern` into a RegExp and
 * runs it against `resultText` with NO timeout, NO input-length cap, and NO anchoring. In Phase 0
 * both the pattern and the tool-result text are author-supplied (the scripted test corpus),
 * so a pathological pattern is self-inflicted and the surface is not externally attackable.
 * BEFORE Phase 1 wires real (potentially untrusted) tool output through this matcher, at minimum:
 *   - cap `resultText.length` (e.g. 64 KiB) before matching;
 *   - run the match under a deadline (e.g. `vm.runInNewContext` with timeout, or a worker);
 *   - or replace `RegExp` with a non-backtracking engine (e.g. `re2` — Apache-2.0).
 * Leaving this unguarded in a path that touches untrusted input is a P0 security issue.
 */
export function matchResult(matcher: ResultMatcherT, resultText: string | undefined): boolean {
  if (resultText === undefined) return false;
  switch (matcher.kind) {
    case "regex": {
      // Backstop: in-memory SimulatorScriptT objects handed to ScriptedModel may
      // bypass loadScript (the primary load-time check). Wrap compilation here so
      // callers always receive a typed InvalidMatcherPatternError — never a raw
      // SyntaxError — regardless of how the script arrived.
      let re: RegExp;
      try {
        re = new RegExp(matcher.pattern);
      } catch (e) {
        throw new InvalidMatcherPatternError(matcher.pattern, errorMessage(e));
      }
      return re.test(resultText);
    }
    case "jsonpath":
      throw new UnsupportedMatcherError(matcher.kind);
  }
}
