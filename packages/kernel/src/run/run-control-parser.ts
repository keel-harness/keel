import {
  ENTROPY_NET_MIN_TOKEN_CHARS,
  Goal,
  LoopConfig,
  MAX_LOOP_ITERATIONS,
  RUN_CONTROL_SCHEMA_VERSION,
} from "@keel/shared";
import type { GoalT, LoopConfigT } from "@keel/shared";

export type GoalParseResult =
  | { readonly success: true; readonly goal: GoalT }
  | { readonly success: false; readonly error: string };

export type LoopParseResult =
  | { readonly success: true; readonly loop: LoopConfigT }
  | { readonly success: false; readonly error: string };

const FLAG_RE = /^--[a-z][a-z0-9-]*$/u;

export function shellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaped) current += "\\";
  if (quote !== undefined) throw new Error("unterminated quoted string");
  if (current.length > 0) words.push(current);
  return words;
}

export function shellJoin(argv: readonly string[]): string {
  return argv
    .map((part) => (isShellSafe(part) ? part : `'${part.replace(/'/gu, `'\\''`)}'`))
    .join(" ");
}

function isShellSafe(part: string): boolean {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/u.test(part);
}

// Ledger-safe id budget (SEC-014, see ENTROPY_NET_MIN_TOKEN_CHARS): a generated id — and every
// composite derived from it — is written to the session ledger as a string value, so id + longest
// composite must stay BELOW the entropy net's floor. Truncating the slug is the safe end to cut:
// the hash — of the FULL label — still disambiguates truncated slugs.
const FLOOR_IS_INCLUSIVE = 1; // a run of EXACTLY the floor length is already redacted
const LONGEST_COMPOSITE_SUFFIX_CHARS = `_exit_${String(MAX_LOOP_ITERATIONS)}`.length; // loop exit-check tool-call id
const ID_PREFIX_CHARS = Math.max("goal_".length, "loop_".length);
const HASH_SEPARATOR_CHARS = "_".length;
const MAX_HASH_CHARS = (2 ** 32 - 1).toString(36).length; // FNV-1a is folded through `>>> 0` below
const SLUG_MAX_CHARS =
  ENTROPY_NET_MIN_TOKEN_CHARS -
  FLOOR_IS_INCLUSIVE -
  LONGEST_COMPOSITE_SUFFIX_CHARS -
  ID_PREFIX_CHARS -
  HASH_SEPARATOR_CHARS -
  MAX_HASH_CHARS;

function stableId(prefix: "goal" | "loop", label: string): string {
  const slug =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, SLUG_MAX_CHARS)
      .replace(/-+$/gu, "") || "run";
  let hash = 2166136261;
  for (const ch of label) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${slug}_${(hash >>> 0).toString(36)}`;
}

function positiveInt(raw: string | undefined, name: string): number | string {
  if (raw === undefined || !/^[0-9]+$/u.test(raw)) return `${name} requires a positive integer`;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : `${name} requires a positive integer`;
}

function commandArgv(parts: readonly string[]): string[] {
  if (parts.length === 1) return shellWords(parts[0]!);
  return [...parts];
}

function collectUntilFlag(
  words: readonly string[],
  start: number,
): { parts: string[]; next: number } {
  const parts: string[] = [];
  let i = start;
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (FLAG_RE.test(word)) break;
    parts.push(word);
  }
  return { parts, next: i };
}

export function parseGoalArgs(input: string): GoalParseResult {
  let words: string[];
  try {
    words = shellWords(input);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "invalid goal syntax" };
  }

  const firstFlag = words.findIndex((word) => FLAG_RE.test(word));
  const objectiveWords = firstFlag === -1 ? words : words.slice(0, firstFlag);
  const objective = objectiveWords.join(" ").trim();
  if (objective.length === 0) return { success: false, error: "goal objective is required" };

  const checks: string[][] = [];
  let maxTurns: number | undefined;
  let maxWallMs: number | undefined;
  // Validation is OPT-IN (F-3 RC2a). A configured tier requires a trusted lifecycle manifest; a normal
  // workspace has none, so an implicit `standard` default reported `not_run` and forced the goal to
  // `incomplete` even when every check passed. Left undefined, a plain `/goal --check` reaches the
  // honest `unverified` terminal (ADR-0060) when its checks pass; `--validation <tier>` opts in.
  let validation: "minimal" | "standard" | "strict" | undefined;

  for (let i = firstFlag === -1 ? words.length : firstFlag; i < words.length; ) {
    const flag = words[i]!;
    if (flag === "--check") {
      const { parts, next } = collectUntilFlag(words, i + 1);
      if (parts.length === 0) return { success: false, error: "--check requires a command" };
      const argv = commandArgv(parts);
      if (argv.length === 0) return { success: false, error: "--check requires a command" };
      checks.push(argv);
      i = next;
      continue;
    }
    if (flag === "--max-turns") {
      const parsed = positiveInt(words[i + 1], "--max-turns");
      if (typeof parsed === "string") return { success: false, error: parsed };
      maxTurns = parsed;
      i += 2;
      continue;
    }
    if (flag === "--max-wall-ms") {
      const parsed = positiveInt(words[i + 1], "--max-wall-ms");
      if (typeof parsed === "string") return { success: false, error: parsed };
      maxWallMs = parsed;
      i += 2;
      continue;
    }
    if (flag === "--validation") {
      const tier = words[i + 1];
      if (tier !== "minimal" && tier !== "standard" && tier !== "strict") {
        return { success: false, error: "--validation must be minimal, standard, or strict" };
      }
      validation = tier;
      i += 2;
      continue;
    }
    return { success: false, error: `unknown goal option: ${flag}` };
  }

  if (checks.length === 0) {
    return { success: false, error: "goal requires at least one --check command" };
  }

  const bounds =
    maxTurns !== undefined || maxWallMs !== undefined
      ? {
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(maxWallMs !== undefined ? { maxWallMs } : {}),
        }
      : undefined;
  const parsed = Goal.safeParse({
    schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
    id: stableId("goal", objective),
    objective,
    doneWhen: checks.map((argv, index) => ({
      id: `check-${String(index + 1)}`,
      kind: "command",
      check: { argv },
    })),
    ...(validation !== undefined ? { validation: { tier: validation } } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    requiresCompletionAudit: true,
  });
  return parsed.success
    ? { success: true, goal: parsed.data }
    : { success: false, error: parsed.error.issues[0]?.message ?? "invalid goal" };
}

export function parseLoopArgs(input: string): LoopParseResult {
  let words: string[];
  try {
    words = shellWords(input);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "invalid loop syntax" };
  }
  if (words.includes("--schedule") || words.includes("--background")) {
    return { success: false, error: "loop does not support scheduler/background fields" };
  }

  const firstFlag = words.findIndex((word) => FLAG_RE.test(word));
  const promptWords = firstFlag === -1 ? words : words.slice(0, firstFlag);
  const prompt = promptWords.join(" ").trim();
  if (prompt.length === 0) return { success: false, error: "loop prompt is required" };

  let until: string[] | undefined;
  let maxIterations = 3;
  let maxWallMs: number | undefined;

  for (let i = firstFlag === -1 ? words.length : firstFlag; i < words.length; ) {
    const flag = words[i]!;
    if (flag === "--until") {
      const { parts, next } = collectUntilFlag(words, i + 1);
      if (parts.length === 0) return { success: false, error: "--until requires a command" };
      until = commandArgv(parts);
      i = next;
      continue;
    }
    if (flag === "--max-iterations") {
      const parsed = positiveInt(words[i + 1], "--max-iterations");
      if (typeof parsed === "string") return { success: false, error: parsed };
      maxIterations = parsed;
      i += 2;
      continue;
    }
    if (flag === "--max-wall-ms") {
      const parsed = positiveInt(words[i + 1], "--max-wall-ms");
      if (typeof parsed === "string") return { success: false, error: parsed };
      maxWallMs = parsed;
      i += 2;
      continue;
    }
    return { success: false, error: `unknown loop option: ${flag}` };
  }

  if (until === undefined || until.length === 0) {
    return { success: false, error: "loop requires --until command" };
  }

  const parsed = LoopConfig.safeParse({
    schemaVersion: RUN_CONTROL_SCHEMA_VERSION,
    id: stableId("loop", prompt),
    prompt,
    until: {
      kind: "command",
      check: { argv: until },
      satisfiedWhen: "exitZero",
    },
    bounds: {
      maxIterations,
      ...(maxWallMs !== undefined ? { maxWallMs } : {}),
    },
    requireProgressEachIteration: true,
  });
  return parsed.success
    ? { success: true, loop: parsed.data }
    : { success: false, error: parsed.error.issues[0]?.message ?? "invalid loop" };
}
