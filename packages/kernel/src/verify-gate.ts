/**
 * Execution-grounding for the pre-completion verification gate (Epic 1.19 / Lever B).
 *
 * The Epic-1.16 gate fires on a clean model-stop and injects a STOP-biased "prove it" prompt. But the
 * post-fix benchmark analysis found the model often satisfies that prompt by *inspecting* its work
 * (grep/cat) rather than running it, or it never runs anything at all — a confident false "done". This
 * module classifies the completion from the conversation so the gate can (a) SKIP genuinely-verified
 * work (a real test PASS on record — less friction), (b) push a SHARPER, execution-grounded nudge when
 * the model declared done without ever executing its deliverable, or (c) fall back to the STANDARD
 * prompt. It reads only what the loop already has (`messages`): assistant tool calls (the verbatim bash
 * command) and tool outputs (which carry the harness-prepended `TEST SUMMARY (...): PASS|FAIL` banner).
 */
import { READ_ONLY_COMMAND_NAMES, type ModelMessageT } from "@keel/shared";
import {
  governedProcessEnvelope,
  processRunArgv,
  renderToolCommand,
  toolCommandIsReadOnly,
} from "./tool-command.js";

/** Commands that only observe state. Deliberately CONSERVATIVE: anything not on this list is treated as
 *  execution, so we only ever class a command read-only when we are confident — biasing toward NOT
 *  nagging a model that actually ran something. (Excludes e.g. `sed`, which can mutate with `-i`.)
 *
 *  Sourced from the shared `READ_ONLY_COMMAND_NAMES` (the single source of truth, F-3 RC1) so this
 *  nudge heuristic and the warden's authoritative classifier cannot silently drift apart. */
const READ_ONLY_COMMANDS = READ_ONLY_COMMAND_NAMES;

function shellWords(command: string): string[] {
  return command
    .trim()
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function stripSimpleQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function envWrappedTokens(tokens: readonly string[]): readonly string[] {
  if ((tokens[0] ?? "").toLowerCase() !== "env") return tokens;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (isAssignmentToken(token)) {
      i += 1;
      continue;
    }
    if (token === "-i" || token === "-" || token === "--ignore-environment") {
      i += 1;
      continue;
    }
    if (token === "-u" || token === "--unset") {
      i += 2;
      continue;
    }
    if (token.startsWith("-u") && token.length > 2) {
      i += 1;
      continue;
    }
    break;
  }
  return i >= tokens.length ? tokens.slice(0, 1) : tokens.slice(i);
}

function executableTokens(command: string): readonly string[] {
  const tokens = shellWords(command);
  let i = 0;
  while (i < tokens.length && isAssignmentToken(tokens[i]!)) i += 1;
  return envWrappedTokens(tokens.slice(i));
}

/** The effective executable token of a (sub)command, lowercased. */
function firstToken(command: string): string {
  return executableTokens(command)[0]?.toLowerCase() ?? "";
}

/**
 * True only if EVERY sub-command (split on `&&`, `||`, `;`, `|`) is a recognized read-only command.
 * An empty command, or any unrecognized/executing token, makes the whole command non-read-only.
 */
export function isReadOnlyCommand(command: string): boolean {
  const subs = command
    .split(/\|\||&&|;|\|/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (subs.length === 0) return false;
  return subs.every((s) => READ_ONLY_COMMANDS.has(firstToken(s)));
}

/** Matches the harness-generated test banner (`summarizeTestOutput`), anchored to a line start so a
 *  model's free-text "tests pass" does not count. The banner is content the model can *also* produce
 *  (e.g. `echo`-ing it), so a banner alone is NOT trusted for the skip decision — it must come from the
 *  output of a real (non-read-only) command (see `classifyCompletion`), which closes the echo/cat
 *  gaming vector. The residual: a model that runs a script which *prints* a pytest-style banner from
 *  fabricated output would still be trusted — but that requires actually executing something, not a
 *  one-line echo, and a wrong skip only leaves the (default-off) gate quiet. */
const TEST_SUMMARY_RE = /^TEST SUMMARY \([^)]+\): (PASS|FAIL)/m;

/**
 * A generic "a real test runner just passed" recognizer (F6 — broaden skip-on-verified). The model
 * rarely emits keel's own `TEST SUMMARY` banner, so without this the gate re-nags work the model
 * already verified. We recognize pytest's own end-of-run summary line — pytest is the dominant runner
 * in the benchmark set and prints a stable, unambiguous line. This is treated EXACTLY like the harness
 * banner for trust purposes: it only counts when it came from a real (non-read-only) command, never an
 * echoed/cat'd line (see `classifyCompletion`), and any failure/error in the summary disqualifies it.
 *
 * Conservatism is the whole point: a wrong skip leaves the gate quiet on possibly-incomplete work, so
 * we recognize ONLY a summary that affirmatively reports ≥1 passed AND reports no `failed`/`error(s)`.
 * Anything ambiguous ("no tests ran", a bare "PASSED" the model printed, another runner's output) is
 * NOT a pass here and falls through to sharpen/standard. False negatives (gate still fires) are the
 * cheap failure mode; false skips are not.
 */
// pytest's summary line, e.g. `===== 12 passed in 3.41s =====` / `== 3 passed, 2 warnings in 1s ==`.
// Anchored to a line, requires the surrounding `=` rule pytest always prints, and a positive pass count.
const PYTEST_SUMMARY_RE = /^=+ .*?\b(\d+) passed\b.*? in [\d.]+s.*?=+$/m;
// Any failure/error token in a pytest summary disqualifies a pass (e.g. `1 failed`, `2 errors`).
const PYTEST_FAILURE_RE = /\b\d+ (failed|error|errors)\b/;
const PYTEST_FAILURE_SUMMARY_RE = /^=+ .*?\b\d+\s+(?:failed|error|errors)\b.*?=+$/m;

/** True only if `output` contains a pytest summary line reporting ≥1 passed and zero failed/errors,
 *  from a real run. Deliberately strict: ambiguous output is not a pass. */
function isGenericTestPass(output: string): boolean {
  const m = PYTEST_SUMMARY_RE.exec(output);
  if (m === null) return false;
  if (Number(m[1]) <= 0) return false; // "0 passed" is not a pass
  if (PYTEST_FAILURE_RE.test(m[0])) return false; // any failure/error on the summary line → not a pass
  return true;
}

interface CompletionCommandEvidence {
  readonly command: string;
  readonly process: boolean;
  readonly readOnly: boolean;
  readonly exactArgv?: readonly string[];
}

function completionCommandEvidence(call: {
  readonly name: string;
  readonly args: unknown;
}): CompletionCommandEvidence | undefined {
  const args =
    typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
      ? (call.args as Readonly<Record<string, unknown>>)
      : undefined;
  if (args === undefined) return undefined;
  const command = renderToolCommand({ name: call.name, args });
  if (command === undefined) return undefined;
  const exactArgv = processRunArgv({ name: call.name, args });
  return {
    command,
    process: exactArgv !== undefined,
    ...(exactArgv === undefined ? {} : { exactArgv }),
    readOnly:
      call.name === "bash"
        ? isReadOnlyCommand(command)
        : toolCommandIsReadOnly({ name: call.name, args }),
  };
}

function completionEvidenceOutput(
  output: string,
  evidence: CompletionCommandEvidence | undefined,
): { readonly output: string; readonly authoritative: boolean } {
  if (evidence?.process !== true) return { output, authoritative: true };
  const envelope = governedProcessEnvelope(output);
  if (
    envelope === undefined ||
    !envelope.cleanContained ||
    envelope.exitCode !== 0 ||
    envelope.signal !== null
  ) {
    return { output: "", authoritative: false };
  }
  return { output: `${envelope.stdout}\n${envelope.stderr}`, authoritative: true };
}

export type CompletionVerdict = "skip" | "sharpen" | "standard";

export interface KnownRedCompletionEvidence {
  readonly toolCallId: string;
  readonly command: string;
  readonly exactArgv?: readonly string[];
  readonly verdict: "FAIL";
  readonly source: "test-summary" | "pytest-summary";
  readonly detail: string;
  readonly relation?: PytestCommandRelation;
  readonly residualFailure?: PytestResidualFailure;
}

function normalizeVerificationCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

function sameVerificationCommand(a: string, b: string): boolean {
  return normalizeVerificationCommand(a) === normalizeVerificationCommand(b);
}

export function knownRedCompletionEvidenceKey(evidence: KnownRedCompletionEvidence): string {
  return `${evidence.source}:${
    evidence.exactArgv === undefined
      ? normalizeVerificationCommand(evidence.command)
      : JSON.stringify(evidence.exactArgv)
  }`;
}

interface PytestCommandRelation {
  readonly cwd?: string;
  readonly interpreter: string;
  readonly runnerSignature: string;
  readonly targets: readonly string[];
  readonly collectionAltering: boolean;
}

interface PytestResidualFailure {
  readonly items: readonly string[];
}

const COLLECTION_ALTERING_FLAGS = new Set([
  "-c",
  "-k",
  "-m",
  "-o",
  "--collect-only",
  "--confcutdir",
  "--continue-on-collection-errors",
  "--deselect",
  "--doctest-modules",
  "--failed-first",
  "--ignore",
  "--ignore-glob",
  "--import-mode",
  "--new-first",
  "--pyargs",
  "--rootdir",
]);
const COLLECTION_ALTERING_FLAGS_NO_VALUE = new Set([
  "--ff",
  "--last-failed",
  "--lf",
  "--nf",
  "--stepwise",
  "--stepwise-skip",
  "--sw",
]);
const OPTION_VALUE_FLAGS = new Set([
  "--capture",
  "--color",
  "--confcutdir",
  "--deselect",
  "--durations",
  "--durations-min",
  "--maxfail",
  "--rootdir",
  "--tb",
  "--verbosity",
]);
const BENIGN_PYTEST_FLAGS = new Set([
  "-q",
  "-qq",
  "-s",
  "-v",
  "-vv",
  "-x",
  "--disable-warnings",
  "--exitfirst",
  "--full-trace",
  "--no-header",
  "--quiet",
  "--showlocals",
  "--strict-config",
  "--strict-markers",
  "--trace-config",
  "--verbose",
  "--version",
]);

function shellSegments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\|/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizePathToken(value: string): string {
  const withoutSelectors = stripSimpleQuotes(value).split("::", 1)[0] ?? "";
  return withoutSelectors.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function normalizeCwd(value: string): string {
  return stripSimpleQuotes(value).replace(/\/+$/u, "");
}

function parseCdSegment(segment: string): string | undefined {
  const tokens = executableTokens(segment);
  if ((tokens[0] ?? "").toLowerCase() !== "cd") return undefined;
  const target = tokens[1];
  if (target === undefined || target.startsWith("-")) return undefined;
  return normalizeCwd(target);
}

function normalizeRunnerToken(token: string): string {
  return stripSimpleQuotes(token).toLowerCase();
}

function findPytestInvocation(lower: readonly string[]):
  | {
      readonly commandStartIndex: number;
      readonly pytestIndex: number;
      readonly interpreter: string;
    }
  | undefined {
  for (let i = 2; i < lower.length; i++) {
    if (
      /^python(?:\d+(?:\.\d+)?)?$/u.test(lower[i - 2]!) &&
      lower[i - 1] === "-m" &&
      (lower[i] === "pytest" || lower[i] === "py.test")
    ) {
      return { commandStartIndex: i - 2, pytestIndex: i, interpreter: lower[i - 2]! };
    }
  }

  const pytestIndex = lower.findIndex((t) => t === "pytest" || t === "py.test");
  if (pytestIndex < 0) return undefined;
  return { commandStartIndex: pytestIndex, pytestIndex, interpreter: lower[pytestIndex]! };
}

function parsePytestRelation(command: string): PytestCommandRelation | undefined {
  let cwd: string | undefined;
  const preludeSegments: string[] = [];
  for (const segment of shellSegments(command)) {
    const segmentCwd = parseCdSegment(segment);
    if (segmentCwd !== undefined) {
      cwd = segmentCwd;
      continue;
    }
    const rawTokens = shellWords(segment);
    const tokens = executableTokens(segment);
    const lower = tokens.map((t) => t.toLowerCase());
    const invocation = findPytestInvocation(lower);
    if (invocation === undefined) {
      preludeSegments.push(normalizeVerificationCommand(segment));
      continue;
    }
    const rawPytestToken = tokens[invocation.commandStartIndex];
    const rawCommandStart = rawPytestToken === undefined ? -1 : rawTokens.indexOf(rawPytestToken);
    const runnerPrefix =
      rawCommandStart > 0 ? rawTokens.slice(0, rawCommandStart).map(normalizeRunnerToken) : [];
    const runnerSignature = [...preludeSegments, ...runnerPrefix].join(" && ");
    const targets: string[] = [];
    let collectionAltering = false;
    let skipNext = false;
    for (let i = invocation.pytestIndex + 1; i < tokens.length; i++) {
      const raw = tokens[i]!;
      const token = raw.toLowerCase();
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (token.includes(">") || token === "2>&1" || token === "1>&2") continue;
      if (COLLECTION_ALTERING_FLAGS_NO_VALUE.has(token)) {
        collectionAltering = true;
        continue;
      }
      const eqIndex = token.indexOf("=");
      const flagName = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
      if (COLLECTION_ALTERING_FLAGS.has(flagName)) collectionAltering = true;
      if (
        token.startsWith("-") &&
        !BENIGN_PYTEST_FLAGS.has(flagName) &&
        !OPTION_VALUE_FLAGS.has(flagName)
      ) {
        collectionAltering = true;
      }
      if (OPTION_VALUE_FLAGS.has(flagName)) {
        if (eqIndex < 0) skipNext = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      const target = normalizePathToken(raw);
      if (target.length > 0) targets.push(target);
    }
    return {
      ...(cwd !== undefined ? { cwd } : {}),
      interpreter: invocation.interpreter,
      runnerSignature,
      targets,
      collectionAltering,
    };
  }
  return undefined;
}

function parsePytestArgvRelation(argv: readonly string[]): PytestCommandRelation | undefined {
  const lower = argv.map((token) => token.toLowerCase());
  const invocation = findPytestInvocation(lower);
  if (invocation === undefined || invocation.commandStartIndex !== 0) return undefined;
  const targets: string[] = [];
  let collectionAltering = false;
  let skipNext = false;
  for (let index = invocation.pytestIndex + 1; index < argv.length; index += 1) {
    const raw = argv[index]!;
    const token = lower[index]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (COLLECTION_ALTERING_FLAGS_NO_VALUE.has(token)) {
      collectionAltering = true;
      continue;
    }
    const eqIndex = token.indexOf("=");
    const flagName = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    if (COLLECTION_ALTERING_FLAGS.has(flagName)) collectionAltering = true;
    if (
      token.startsWith("-") &&
      !BENIGN_PYTEST_FLAGS.has(flagName) &&
      !OPTION_VALUE_FLAGS.has(flagName)
    ) {
      collectionAltering = true;
    }
    if (OPTION_VALUE_FLAGS.has(flagName)) {
      if (eqIndex < 0) skipNext = true;
      continue;
    }
    if (token.startsWith("-")) continue;
    const target = normalizePathToken(raw);
    if (target.length > 0) targets.push(target);
  }
  return {
    interpreter: invocation.interpreter,
    runnerSignature: "",
    targets,
    collectionAltering,
  };
}

function isBroadPytestTarget(target: string): boolean {
  if (target.length === 0 || target === ".") return true;
  if (/\.(?:py|pyx|js|ts|tsx|jsx|rs|go|java|c|cc|cpp|h)$/iu.test(target)) return false;
  return true;
}

function isWithinTarget(parent: string, child: string): boolean {
  const p = normalizePathToken(parent);
  const c = normalizePathToken(child);
  return c === p || c.startsWith(`${p}/`);
}

function extractPytestResidualFailure(output: string): PytestResidualFailure | undefined {
  if (
    /^FAILED\s+/mu.test(output) ||
    /\b\d+\s+failed\b/u.test(output) ||
    /\bAssertionError\b/u.test(output)
  ) {
    return undefined;
  }
  const residualKeyword =
    /\b(?:ModuleNotFoundError|ImportError|OSError|Could not find|No module named|external|database|not found)\b/iu.test(
      output,
    );
  if (!residualKeyword) return undefined;
  const items = new Set<string>();
  for (const match of output.matchAll(/^ERROR\s+collecting\s+(\S+)/gmu)) {
    const item = normalizePathToken(match[1]!);
    if (item.length > 0) items.add(item);
  }
  for (const match of output.matchAll(/^ERROR\s+(\S+)/gmu)) {
    const item = normalizePathToken(match[1]!);
    if (item.length > 0 && item !== "collecting") items.add(item);
  }
  return items.size > 0 ? { items: [...items] } : undefined;
}

function samePytestScope(a: PytestCommandRelation, b: PytestCommandRelation): boolean {
  return (
    (a.cwd ?? "") === (b.cwd ?? "") &&
    a.interpreter === b.interpreter &&
    a.runnerSignature === b.runnerSignature
  );
}

function canClearResidualPytestRed(
  pass: PytestCommandRelation,
  red: KnownRedCompletionEvidence,
): boolean {
  const redRelation = red.relation;
  const residual = red.residualFailure;
  if (redRelation === undefined || residual === undefined) return false;
  if (!samePytestScope(pass, redRelation)) return false;
  if (pass.collectionAltering || redRelation.collectionAltering) return false;
  if (pass.targets.length === 0 || redRelation.targets.length === 0) return false;
  if (!redRelation.targets.some(isBroadPytestTarget)) return false;
  const greenTargets = pass.targets.filter((target) => !isBroadPytestTarget(target));
  if (greenTargets.length === 0) return false;
  if (
    !greenTargets.every((target) =>
      redRelation.targets.some((redTarget) => isWithinTarget(redTarget, target)),
    )
  ) {
    return false;
  }
  for (const item of residual.items) {
    if (
      greenTargets.some((target) => isWithinTarget(target, item) || isWithinTarget(item, target))
    ) {
      return false;
    }
  }
  return true;
}

/** Options for `classifyCompletion`. */
export interface ClassifyOptions {
  /**
   * Whether to recognize GENERIC test-pass signals (a pytest summary line) in addition to keel's own
   * `TEST SUMMARY` banner when deciding to skip (F6). **Default `false` (fail-safe).** The bounded fix-validation run
   * fix-validation run measured this broadening net-negative: it widened the skip so far that it
   * silenced the gate-fire `hf-model-inference`'s win depended on, with zero net benefit. So it defaults
   * OFF and is exposed as an opt-IN (`KEEL_GENERIC_SKIP`) purely so it can be re-ablated under a
   * multi-seed run. When opted in it only *reduces* nagging on already-verified work and never relaxes
   * the execution-grounding (the generic signal still goes through the same real-run provenance check as
   * the banner — an echoed/cat'd line never counts). keel's own `TEST SUMMARY` banner is recognized
   * regardless of this flag.
   */
  readonly genericSkip?: boolean;
}

/**
 * Decide how the gate should treat a clean completion:
 * - `skip`     — the most recent test run PASSED and nothing ran after it (verified; don't nag). The
 *                pass is recognized from keel's own `TEST SUMMARY` banner (always) OR — only when
 *                `genericSkip` is opted in (it defaults OFF) — a generic pytest summary line. In BOTH
 *                cases the pass counts only when it came from a real, non-read-only command (echoed/cat'd
 *                output never counts).
 * - `sharpen`  — the model declared done having run only read-only commands (or none) → push execution.
 * - `standard` — it ran real work but has no passing test on record → the existing STOP-biased prompt.
 */
export function classifyCompletion(
  messages: readonly ModelMessageT[],
  options: ClassifyOptions = {},
): CompletionVerdict {
  const genericSkip = options.genericSkip ?? false;
  // (1) skip-if-verified: track the latest test verdict, whether it came from a REAL run (not an
  //     echoed banner), and whether anything ran after it.
  let lastVerdict: "PASS" | "FAIL" | undefined;
  let lastVerdictFromRealRun = false;
  let activityAfterTest = false;
  // (2) execution-grounding: did the model run any non-read-only bash command this session?
  let ranExecution = false;
  // Map each bash tool-call id → its verbatim command, so a banner's provenance (the command that
  // produced it) can be checked. Assistant turns precede their tool results, so this is populated first.
  const commandById = new Map<string, CompletionCommandEvidence>();

  for (const m of messages) {
    if (m.role === "tool") {
      // Recognize a passing test from the harness banner OR a generic pytest summary; a FAIL banner
      // still records a (failing) verdict so a later pass cannot be skipped past it. The generic
      // recognizer only ADDS pass signals — it never overrides a recorded harness FAIL.
      const evidence = m.toolCallId !== undefined ? commandById.get(m.toolCallId) : undefined;
      const presented = completionEvidenceOutput(m.content, evidence);
      const banner = TEST_SUMMARY_RE.exec(presented.output);
      const genericPass = genericSkip && isGenericTestPass(presented.output);
      if (banner || genericPass) {
        // A harness FAIL banner takes precedence over a co-located generic pass line (don't skip past a
        // failure); otherwise the verdict is PASS (banner PASS, or a generic all-green summary).
        lastVerdict = banner ? (banner[1] as "PASS" | "FAIL") : "PASS";
        const cmd = evidence;
        // Trust the signal only if a real (non-read-only) command produced it — an echoed/cat'd banner
        // or pytest summary does not count as a verified run.
        lastVerdictFromRealRun = cmd !== undefined && presented.authoritative && !cmd.readOnly;
        activityAfterTest = false;
      } else if (lastVerdict !== undefined) {
        activityAfterTest = true;
      }
    } else if (m.role === "assistant" && "toolCalls" in m && m.toolCalls !== undefined) {
      if (lastVerdict !== undefined) activityAfterTest = true;
      for (const call of m.toolCalls) {
        const cmd = completionCommandEvidence(call);
        if (cmd === undefined) continue;
        commandById.set(call.id, cmd);
        if (cmd.command.length > 0 && !cmd.readOnly) ranExecution = true;
      }
    }
  }

  if (lastVerdict === "PASS" && lastVerdictFromRealRun && !activityAfterTest) return "skip";
  return ranExecution ? "standard" : "sharpen";
}

export function findKnownRedCompletionEvidence(
  messages: readonly ModelMessageT[],
): KnownRedCompletionEvidence | undefined {
  const commandById = new Map<string, CompletionCommandEvidence>();
  const openReds = new Map<
    string,
    { readonly evidence: KnownRedCompletionEvidence; readonly order: number }
  >();
  let order = 0;

  for (const m of messages) {
    if (m.role === "assistant" && "toolCalls" in m && m.toolCalls !== undefined) {
      for (const call of m.toolCalls) {
        const cmd = completionCommandEvidence(call);
        if (cmd !== undefined) commandById.set(call.id, cmd);
      }
      continue;
    }
    if (m.role !== "tool" || m.toolCallId === undefined) continue;
    const commandEvidence = commandById.get(m.toolCallId);
    if (commandEvidence === undefined || commandEvidence.readOnly) continue;
    const processEnvelope = commandEvidence.process
      ? governedProcessEnvelope(m.content)
      : undefined;
    if (
      commandEvidence.process &&
      (processEnvelope === undefined || !processEnvelope.cleanContained)
    ) {
      continue;
    }
    const output =
      processEnvelope === undefined
        ? m.content
        : `${processEnvelope.stdout}\n${processEnvelope.stderr}`;
    const pytestRelation =
      commandEvidence.exactArgv === undefined
        ? parsePytestRelation(commandEvidence.command)
        : parsePytestArgvRelation(commandEvidence.exactArgv);
    const banner = TEST_SUMMARY_RE.exec(output);
    const pytestPass =
      pytestRelation !== undefined &&
      isGenericTestPass(output) &&
      (processEnvelope === undefined ||
        (processEnvelope.exitCode === 0 && processEnvelope.signal === null));
    if ((banner !== null && banner[1] === "PASS") || pytestPass) {
      for (const [key, red] of openReds) {
        const sameExactCommand =
          commandEvidence.exactArgv !== undefined && red.evidence.exactArgv !== undefined
            ? JSON.stringify(commandEvidence.exactArgv) === JSON.stringify(red.evidence.exactArgv)
            : commandEvidence.exactArgv === undefined &&
              red.evidence.exactArgv === undefined &&
              sameVerificationCommand(commandEvidence.command, red.evidence.command);
        if (
          sameExactCommand ||
          (pytestRelation !== undefined && canClearResidualPytestRed(pytestRelation, red.evidence))
        ) {
          openReds.delete(key);
        }
      }
      continue;
    }
    if (banner !== null && banner[1] === "FAIL") {
      const residualFailure =
        pytestRelation !== undefined ? extractPytestResidualFailure(output) : undefined;
      const evidence: KnownRedCompletionEvidence = {
        toolCallId: m.toolCallId,
        command: commandEvidence.command,
        ...(commandEvidence.exactArgv === undefined
          ? {}
          : { exactArgv: commandEvidence.exactArgv }),
        verdict: "FAIL",
        source: "test-summary",
        detail: banner[0],
        ...(pytestRelation !== undefined ? { relation: pytestRelation } : {}),
        ...(residualFailure !== undefined ? { residualFailure } : {}),
      };
      openReds.set(knownRedCompletionEvidenceKey(evidence), { evidence, order: order++ });
      continue;
    }
    if (pytestRelation === undefined) continue;

    const pytestFailure = PYTEST_FAILURE_SUMMARY_RE.exec(output);
    if (pytestFailure !== null) {
      const residualFailure = extractPytestResidualFailure(output);
      const evidence: KnownRedCompletionEvidence = {
        toolCallId: m.toolCallId,
        command: commandEvidence.command,
        ...(commandEvidence.exactArgv === undefined
          ? {}
          : { exactArgv: commandEvidence.exactArgv }),
        verdict: "FAIL",
        source: "pytest-summary",
        detail: pytestFailure[0],
        relation: pytestRelation,
        ...(residualFailure !== undefined ? { residualFailure } : {}),
      };
      openReds.set(knownRedCompletionEvidenceKey(evidence), { evidence, order: order++ });
    }
  }

  let latest: { readonly evidence: KnownRedCompletionEvidence; readonly order: number } | undefined;
  for (const red of openReds.values()) {
    if (latest === undefined || red.order > latest.order) latest = red;
  }
  return latest?.evidence;
}
