/**
 * Sanitized shape fixture for the R21 live onboarding defect (ADR-0087 / issue #113).
 *
 * The live carrier emitted 568 non-whitespace runs plus a Markdown table while the operator had
 * explicitly requested no more than 250 words. Private checkout paths and provider/session
 * identifiers were not retained. This deterministic fixture freezes the acceptance-relevant shape
 * (word count, table syntax, headings, and repository-oriented prose) without reconstructing those
 * discarded values or pretending it is a verbatim provider transcript.
 */
const PREFIX = `# Repository onboarding

The repository separates command-line entry, domain behavior, compatibility helpers, documentation,
and focused tests. The requested change belongs near the existing filename normalization seam and
should preserve string behavior while accepting path-like values. Relevant validation includes the
focused edit tests, typing, formatting, and compatibility checks. No runtime probe was performed.

| Area | Finding |
| --- | --- |
| Architecture | command layer delegates to focused helpers |
| Tests | targeted behavior and compatibility coverage are required |
| Risk | iterable and scalar filename handling must remain distinct |

The implementation plan is to freeze the failure with focused tests, make the smallest normalization
change, document the compatibility behavior, and run the repository's existing checks.`;

const OBSERVED_WORDS = 568;
const prefixWords = PREFIX.trim().split(/\s+/u).length;
const padding = Array.from(
  { length: OBSERVED_WORDS - prefixWords },
  (_, index) => `sanitized-detail-${String(index + 1).padStart(3, "0")}`,
).join(" ");

export const R21_OVERSIZED_FINAL_ANSWER = `${PREFIX}\n\n${padding}`;
export const R21_OVERSIZED_FINAL_ANSWER_WORDS = OBSERVED_WORDS;
