/**
 * A tool's INTENDED, model-facing guidance failure (bad args, a domain refusal) — distinct from an
 * unexpected internal crash. The tools package throws this so its own tests can tell the two apart.
 *
 * Honesty note (design spec §4): through the Phase-1 `LocalExecutor` this tag is NOT observable on the
 * wire — the executor renders any thrown error as `{ ok:false, output: err.message }`. Surfacing the
 * intended-vs-crash distinction to the warden/audit is a Phase-2 `WardenExecutor` concern (it can
 * inspect `instanceof ToolError`), not claimed for Phase 1.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
