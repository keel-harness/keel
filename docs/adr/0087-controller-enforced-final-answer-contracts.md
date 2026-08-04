# ADR-0087 — Controller-enforced final-answer contracts and inspectable settlement

- **Status:** **Proposed — explicit maintainer decision required before implementation.** This ADR
  changes public agent-output behavior, adds opt-in CLI/TUI controls, and adds optional,
  syntactically forward-compatible metadata to the non-frozen session ledger, including a fixed
  process-local closure for an exactly tagged interrupted rewrite prompt. The design and tests may
  be reviewed before acceptance; no behavior implementation is authorized by this proposed record.
- **Date:** 2026-08-04.
- **Decider:** keel maintainer.
- **Governs:** explicit operator-requested bounds on the terminal model answer. Relates to ADR-0002
  and ADR-0019 (frozen `ModelPort`), ADR-0008/0035/0072 (session ledger and compatible evolution),
  ADR-0031 (full-fidelity model-port recordings), ADR-0036/0073/0080 (presentation and runtime
  truth), ADR-0044 (cost/runway bounds), and `docs/design/tui-principles.md` §4.1.
- **Implementation plan and observed defect:**
  [issue #113](https://github.com/keel-harness/keel/issues/113), from R21 live dogfooding.

This is an output-integrity and usability decision, not a security authority. It changes no Warden
verdict, policy, sandbox, egress, grant, RPC method, audit format, frozen `ModelPort`, tool contract,
or provider adapter capability. It must not be described as making model prose trustworthy.

## Context

R21 ran three bounded live `anthropic/claude-sonnet-4-6` onboarding sessions against an unfamiliar
external repository through exact installed npm carriers. The baseline answer was 822 words and
contained a false runtime claim. Two red-first prompt-only candidates improved tool selection, but
the strongest still returned 568 words plus a table, ran no runtime probe, and violated an explicit
250-word request. Prompt text can ask for concision; it cannot enforce it.

The defect is narrower than general answer quality. An operator sometimes needs a hard, explicit
reading bound—for example, “give me the architecture and next plan in no more than 250 words.” Keel
must either satisfy that contract or say visibly that it could not. It must not silently cut text,
hide failed tests or Warden decisions, replay a tool, or make an unbounded second model attempt.

The current architecture creates four constraints:

1. `ModelPort.params.maxOutputTokens` is a per-request token ceiling, not a word or completeness
   contract. Anthropic documents `max_tokens` as a truncated response and tells clients to inspect
   the stop reason. AI SDK likewise reports the normalized terminal as `length`. A token cap can be
   a secondary spend rail, but not the user-visible success criterion.
2. `runAgentLoop` normally streams `text-delta` immediately. Once a long final answer reaches native
   terminal scrollback, a later compact rendering cannot remove the duplicate clutter honestly.
3. The session recorder persists the public event stream. A live-only replacement would lose the
   original on resume; persisting two ordinary assistant messages without presentation metadata
   would repaint both as primary answers.
4. Keel already carries controller-owned terminal-review synthesis, cumulative usage, cancellation,
   durable redaction, and additive presentation metadata patterns. The smallest safe design should
   reuse those seams rather than change `ModelPort`, Warden, or the audit chain.

There is also an existing durability boundary that this ADR must not overstate. The ordinary session
recorder accumulates an assistant turn in memory and appends it when the turn reaches a recordable
boundary. An abrupt process or host failure can therefore lose the still-pending tail exactly as it
can today. ADR-0031 separately defines full fidelity at the port boundary when that recording is
retained; it does not upgrade ordinary session-ledger crash durability. This ADR guarantees
inspectability for a **completed, recorded** candidate and never upgrades that into a claim that
every pre-crash delta is durable.

Primary references for the provider-cap option:

- [Anthropic stop reasons and fallback](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
  defines `max_tokens` as a truncated response and requires explicit handling.
- [AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) defines
  `maxOutputTokens` as the maximum generated tokens and exposes the normalized `length` finish
  reason separately from `stop`.

## Decision criteria

An acceptable design must satisfy all of these together:

- explicit typed opt-in; never infer authority from words such as “concise” in model-visible prose;
- one primary final-answer reading surface;
- a complete, redacted original answer remains inspectable;
- no repeated tool execution or new mutation authority;
- no more than one settlement-only provider request;
- honest provider `length`, error, cancellation, restart, resume, and insufficient-budget handling;
- controller-known failures, denials, partial outcomes, and attention state stay prominent;
- exact usage and incremental settlement cost remain attributable;
- no behavior change when the contract is absent; and
- deterministic component, resume, headless, real-Ink, and exact-package proof before one live replay.

## Options considered

### Option 1 — validate the terminal candidate; rewrite once with tools disabled

Buffer presentation of a no-tool terminal candidate, validate a typed size contract, and expose it
if compliant. If oversized, retain the original and make at most one tools-disabled rewrite request.

**Strengths**

- preserves the model's ability to prioritize and restate a useful unfamiliar-repository answer;
- isolates the additional request from tool side effects;
- gives the controller a real accept/reject decision rather than trusting a prompt; and
- naturally exposes a bounded incremental cost and cancellation point.

**Risks**

- adds latency and provider spend only on a violated opt-in contract;
- the rewrite can also violate the contract, stop on `length`, error, or omit an important caveat;
- raw plus rewritten answers need durable presentation identity to avoid duplicate resume clutter;
  and
- “tools absent” must be structurally proven at the actual adapter input and executor boundary.

Option 1 is selected as the normal settlement path, with Option 3's deterministic projection used
only as a failure fallback and Option 2's token cap used only as a secondary rewrite rail.

### Option 2 — provider output ceiling only

Set a smaller `maxOutputTokens` when an explicit answer contract exists.

**Rejected as the contract.** Tokens are not words or display bytes. A provider `length` terminal is
explicitly incomplete. The current loop also continues ordinary `length` stops, so a lower ceiling
does not bound the eventual visible answer. Applying it before the terminal turn is known can cut
tool-call arguments or progress turns and change task execution. This option remains useful only on
the already tool-disabled rewrite request, where `length` deterministically rejects the rewrite.

### Option 3 — deterministic controller-owned compact projection

Hide the full model answer from the primary surface and show a controller-generated projection while
retaining the full answer in history.

**Rejected as the normal answer.** The controller can summarize typed facts such as changed-file
counts, failed tools, Warden outcomes, and the terminal reason. It cannot deterministically preserve
the meaning of a repository architecture explanation or implementation recommendation without
becoming another semantic model. A head/tail excerpt would be visible truncation, not a useful answer.

This option is retained as the bounded failure mode after the single rewrite is unavailable or
rejected. The fallback makes no semantic claim about the hidden prose; it reports controller facts,
the settlement failure, and the exact local inspection command.

### Option 4 — improve the system prompt again

**Rejected.** R21 already tested two red-first prompt revisions. The strongest violated the explicit
word and table constraints. A third prompt paragraph has no additional authority and adds context
cost to every task.

## Proposed decision

Adopt an opt-in **final-answer settlement controller** with one typed word bound, one derived byte
rail, at most one tools-disabled rewrite, and a deterministic honest fallback.

### 1. The contract is typed and task-scoped

The v1 contract is intentionally small:

```ts
interface FinalAnswerContractV1 {
  readonly version: 1;
  readonly maxWords: number; // integer, 40..2_000
}
```

The controller derives `maxVisibleBytes = min(64_000, max(2_560, maxWords * 64))`. The byte rail
prevents one pathological no-whitespace run or hostile Markdown payload from satisfying the word
count while flooding the primary surface. It is a validation rail, not an advertised equivalence
between tokens, bytes, terminal cells, and words.

For deterministic cross-runtime behavior, a “word” is one non-whitespace run after Keel's existing
terminal-control stripping and newline normalization. Markdown punctuation remains data and does not
change the count. The v1 controller does not grade writing quality, ban tables, or infer a locale.

The public opt-in surfaces proposed for the complete issue are:

- one-shot: `keel run -p <prompt> --final-max-words <40..2000>`;
- interactive: `/answer <40..2000>` arms the next ordinary task only, `/answer clear` disarms it,
  and the composer visibly shows `final answer ≤N words · next task only`; and
- inspection after settlement: `/answer full` opens the retained redacted original in a read-only
  overlay, while `keel sessions answer <id> --original` provides the same local, sanitized surface
  for headless runs.

The next-task-only default prevents a forgotten compact setting from clipping a later code, diff, or
diagnostic task. A plain prompt, `/goal`, `/loop`, resume without a newly armed contract, and all
existing CLI invocations remain byte-behavior-identical.

The interactive arm is process-local before submission: exiting or crashing before the next
ordinary task discards it. Accepting that task consumes the arm immediately, before provider work,
so cancellation, error, or crash can never apply it to a later prompt. Resume does not silently
re-arm a consumed contract; only the tagged incomplete-settlement handling below remains.

The walking skeleton may land the internal typed contract before both public constructors, but the
issue is not complete—and no live score credit is allowed—until the one-shot and interactive
surfaces reach the exact installed carrier.

Both inspection commands are human-side controller surfaces. They preserve existing owner-only
session-store access and redaction; they do not grant governed tools access to `KEEL_HOME`, expose a
concrete store path to the model, or create a new Warden capability.

### 2. Settlement is a controller state machine

Only a model turn that finishes with `stop`, contains non-empty text, and has no tool calls is a
terminal answer candidate. Text before a tool call is ordinary working narration and is flushed to
the transcript unchanged.

The state machine is:

```text
contract absent
  -> existing stream and persistence path, unchanged

candidate within word+byte contract
  -> persist original -> render original once -> finish

candidate over contract
  -> persist original -> announce "rewriting once · tools off"
  -> if cancellation/budget/runway forbids rewrite: deterministic fallback
  -> otherwise one provider request with tools omitted and a secondary output-token rail
       -> compliant stop: persist rewrite -> render rewrite once -> finish
       -> length/error/abort/tool call/empty/oversized: persist honest terminal facts -> fallback

contract-active original ends on length
  -> persist the partial rejected attempt -> execute no partial tool call -> fallback-length
```

The rewrite instruction is controller-owned and typed by state, not activated by parsing a user's or
model's prose. It includes the exact word and byte limits, requests preservation of uncertainty and
failed/partial results, and says no tools are available. Prompt wording is defense in depth; the
controller still validates the result.

The rewrite turn:

- receives `tools: undefined` at the actual `ModelPort.stream` call;
- cannot dispatch a tool even if a provider emits an unadvertised call; each such call is settled as
  skipped and the rewrite is rejected;
- uses at most one provider request per settlement;
- uses `min(existingPerResponseCap, max(256, maxWords * 4))` output tokens as a secondary cost rail;
- participates in the existing abort signal, wall deadline, effective/gross/output budgets, and
  enforcement liveness checks;
- is skipped when a conservative preflight says the remaining configured runway cannot fit it; and
- adds its usage to the ordinary cumulative run usage and records its own request usage in settlement
  presentation metadata for exact cost attribution.

No rewrite is attempted after `length`, error, abort, or budget exhaustion on the rewrite itself.
There is no hidden retry and no fallback model route.

An original response that reaches provider `length` while a contract is active also does not use
Keel's ordinary automatic length-continuation path. Its partial text and any incomplete/unadvertised
call remain inspectable, no call executes, and settlement ends in `fallback-length`. This is an
intentional opt-in behavior change: combining independently generated partials cannot prove a
complete bounded answer, while continuing could consume more than the single allowed settlement
request. Contract-absent length handling remains unchanged and receives its own byte-equivalence
regression.

### 3. The fallback is bounded, visible, and evidence-derived

If no compliant model answer exists after the allowed path, Keel renders a deterministic answer that
fits the same contract. It states:

- that Keel could not obtain a complete answer within the requested bound;
- why settlement failed (`budget`, `cancelled`, `provider length`, `provider error`, `tool emitted`,
  or `still oversized`);
- controller-known attention counts and terminal status, reserving space before optional context;
- that no rewrite tool or side effect ran; and
- the exact local command that displays the redacted original.

The fallback does not summarize architecture, claim task success, or invent next steps. Existing
tool cards, failed-test summaries, Warden review/denial surfaces, goal audit, and run status remain
outside the compact answer and are never folded away. At narrow geometries they may be visually
collapsed under their existing typed affordances, but their attention state and recovery action stay
visible.

Fallback generation uses a fixed priority, proven against the 40-word minimum: settlement failure
and reason; `no rewrite tools ran`; the exact original-inspection command; then only the
controller-known attention facts that still fit. Facts that do not fit remain on their authoritative
cards outside the answer rather than being truncated or omitted from the overall completion surface.
Property tests cover every outcome, maximum-length session id, and attention combination at the
minimum word bound.

Contracts below 40 words are rejected because Keel cannot guarantee room for the failure reason,
attention state, and inspection path. Honesty has a minimum display budget.

### 4. Buffer presentation, not evidence

When a contract is active, the runner withholds only the current no-tool assistant text from the UI.
The session recorder still receives the original stream. If a tool call appears, the runner flushes
the held text before rendering the call, preserving event order and working narration. If the turn is
terminal, the settlement event selects the single primary answer.

The runner retains at most `maxVisibleBytes + 1` sanitized bytes only for delayed presentation, then
discards further UI-buffer bytes while the recorder continues its existing completed-turn
persistence. It does not recount words or settle the candidate. The one controller state machine
validates the complete candidate already held by the loop and emits the typed decision consumed by
the runner and recorder. `/answer full` reads the durable redacted assistant record; it is not served
from an unbounded second UI buffer. The ordinary configured per-response provider ceiling remains
the outer generation and recorder-memory rail. This design does not claim that the recorder's
pre-existing pending-turn buffer is newly bounded.

This introduces no generic delayed-stream mode. The activity/HUD continues to show that the model is
drafting; cancellation and steering stay live. Quantitative tests measure time-to-visible-activity
and prove the held text buffer is bounded independently of terminal width.

The loop, recorder, and runner coordinate through additive process-local `KernelEvent` variants,
not an ambient callback or parallel mutable flag. After a candidate terminal is known, one typed
attempt event carries the controller-minted settlement id, attempt, contract, decision, and that
request's usage. The recorder uses the event to flush its pending assistant bytes with the matching
optional presentation metadata; the runner uses the same event to accept, keep hidden, or fall back.
A typed rewrite-request event carries the exact controller prompt that both enters provider context
and is appended to the ledger. At `run-finished`, the recorder writes the final settlement outcome
beside the ordinary cumulative usage. Consumers that do not need presentation may ignore the new
kernel events. With no contract, none of these events is emitted and the existing event sequence is
unchanged.

The rewrite instruction is a **durable controller prompt**, unlike transient loop guidance that
`onFinalMessages` deliberately removes. It must remain between the original and rewrite assistant
messages in both the in-memory REPL carry and `rebuild()` output:

```text
user task -> assistant original -> user rewrite instruction -> assistant rewrite
```

Removing that middle prompt would leave consecutive assistant messages in the next interactive
turn, while retaining it only on disk would make same-process continuation diverge from fresh-process
resume. The implementation therefore needs a narrow durable-controller-prompt path rather than
placing the rewrite instruction in the existing filtered weak set. Red tests compare role ordering
and exact settlement membership across `onFinalMessages`, next-turn REPL input, and ledger rebuild.
The presentation layer hides the controller transaction by typed occurrence metadata; provider
history retains it unchanged.

The exact event names are implementation details, but parallel inference is forbidden: the recorder
must not recount words, the runner must not guess settlement from message text, and resume must not
infer controller ownership from a magic prompt string. One state machine produces one typed decision
that every downstream projection consumes.

#### Crash and torn-append semantics

ADR-0035 guarantees one durable JSONL record per append and permits at most a torn final line. It does
not make a multi-record original/prompt/rewrite/settlement transaction atomic. The final-answer
controller must therefore define every durable prefix rather than assuming `run_status` arrives:

| Last complete settlement record | Resume behavior |
| --- | --- |
| No tagged original attempt | Preserve the existing crash boundary: no final-answer transaction is reconstructed and no contract is retried. |
| Original attempt only | Show the raw original plus `settlement interrupted`; retain the original in provider history and consume the task-scoped contract. |
| Rewrite prompt, no rewrite assistant | Retain the exact prompt, insert one process-local synthetic assistant closure with the constant meaning `final-answer rewrite interrupted` before the next durable message or end of history, show the raw original plus an interruption fact, and consume the contract. |
| Rewrite assistant, no matching final settlement | Keep the complete raw transaction visible, report `settlement interrupted`, and consume the contract; do not guess whether the rewrite should have been accepted. |
| Matching final settlement | Apply the recorded one-primary-answer projection and ordinary terminal state. |

The synthetic closure is the text-only analogue of `INTERRUPTED_TOOL_RESULT`: it performs no model
request, carries no tool calls, is never recorded as provider output, and exists only in rebuilt
provider context so the stale rewrite instruction is structurally closed before the next human
message. Same-process graceful cancellation/error paths must write an explicit fallback settlement;
the synthetic path is only for an abruptly incomplete durable prefix. Rebuilding the same prefix is
idempotent and adds exactly one closure to the returned view each time, never to the append-only
ledger.

This is a narrow exception to presentation-only interpretation: well-formed settled transactions
rebuild the exact recorded message bytes and roles, while an exactly tagged orphan rewrite prompt
causes only the fixed synthetic closure above. Untagged, malformed, mismatched, or forged prose can
never activate it. New readers expose typed `settlement interrupted` occurrence state so the closure
cannot masquerade as the model's answer. Older tolerant readers can still parse and expose the raw
additive records, but the interrupted-transaction repair requires a reader implementing this ADR;
this is syntactic forward compatibility, not a promise of behavioral downgrade support after a
newer Keel writes an incomplete transaction.

### 5. Preserve raw content with additive compatible settlement metadata

The ordinary session conversation remains canonical model context. The original and any rewrite are
stored as redacted assistant messages; the controller rewrite instruction is stored as the user-role
message actually supplied to the provider. To prevent those three records from repainting as three
primary conversation turns on resume, add optional presentation metadata to the existing known
`user`, `assistant`, and `run_status` session variants:

```ts
type FinalAnswerOccurrence =
  | {
      readonly settlementId: string;
      readonly kind: "attempt";
      readonly attempt: "original" | "rewrite";
      readonly contract: FinalAnswerContractV1;
    }
  | {
      readonly settlementId: string;
      readonly kind: "rewrite-prompt";
      readonly contract: FinalAnswerContractV1;
    };

type FinalAnswerSettlement = {
  readonly settlementId: string;
  readonly outcome:
    | "accepted-original"
    | "accepted-rewrite"
    | "fallback-budget"
    | "fallback-cancelled"
    | "fallback-length"
    | "fallback-error"
    | "fallback-tool-call"
    | "fallback-oversized";
  readonly rewriteUsage?: ModelUsage;
};
```

Exact field names and nesting may be refined by the red schema tests, but these invariants may not:

- fields are additive and optional on known v1 events; no new event discriminant or version bump;
- older tolerant readers retain and ignore the fields rather than refusing resume;
- metadata is presentation only for every complete settled transaction and never enters a provider
  request; the sole provider-history effect is the fixed synthetic closure for an exactly tagged
  orphan rewrite prompt described above;
- new readers correlate by controller-minted settlement id plus durable message occurrence, never by
  parsing model/user text;
- the rewrite controller prompt remains in provider context and final-message carry even when its
  presentation row is hidden, preserving valid role alternation and same-process/resume parity;
- malformed or torn metadata cannot hide an ordinary assistant message; fail visibly to the raw
  transcript rather than guessing; and
- all strings still pass the existing single session-redaction chokepoint before disk.

The write schema validates this metadata strictly. The tolerant read path first validates the
load-bearing v1 message record, retains the optional metadata as JSON, then independently safe-parses
the presentation extension. Invalid extension data is treated as absent and exposes the raw message;
it must not convert otherwise valid assistant bytes into session corruption or activate hiding.
Invalid base message fields retain the existing `SessionCorruptError` behavior.

`ResumeState` may expose process-local occurrence metadata parallel to `messages`, following the
existing failed-tool-message-index pattern. `initialView` uses it to reconstruct one primary answer
and the read-only full-answer detail. No presentation tag is sent back to the provider.

The default session ledger preserves redacted reconstructed answer bytes and typed usage. Exact
chunk cadence and reasoning/tool-delta carriage remain available only when the already accepted
ADR-0031 full-fidelity recording mode is enabled; this ADR does not overstate the session ledger as a
byte-for-byte provider-native recording.

### 6. Completion truth remains outside model prose

Settlement answers only “did the visible terminal prose fit the explicit bound?” It does not answer
“did the task succeed?” Existing controller facts remain authoritative:

- `run_status` and goal completion audit own terminal/goal state;
- tool results own command/test outcomes;
- the Warden and its audit own allow/deny/review authority;
- mutation presentation owns observed workspace effects; and
- model prose, original or rewritten, owns none of those claims.

A compliant rewrite that says “all tests pass” cannot turn a failed tool card green. The compact
answer surface must never obscure a non-green controller status with a success color or glyph.
Fallback attention facts use only typed session events, the current reducer state, and verified
Warden/audit receipts already available to the controller. A fact absent from those sources renders
as unavailable; it is never reconstructed from model prose, a command string, or an assumed Warden
outcome.

## Red-first implementation plan

Every behavior slice begins with the stated failing tests. No production code is written before this
ADR is accepted explicitly.

### Slice 1 — typed contract and durable compatibility skeleton

1. Freeze a sanitized R21 568-word/table candidate fixture.
2. Add shared-schema reds for valid/min/max/invalid contracts; additive assistant/user/run-status
   metadata; tolerant old-field behavior; round trip; and redaction conflict handling.
3. Add session recorder/rebuild reds proving original bytes, rewrite bytes, controller prompt, usage,
   occurrence identity, valid provider-role ordering, same-process/resume parity,
   every crash-prefix row above, idempotent synthetic closure, malformed-metadata fail-visible
   behavior, and proof that presentation metadata itself never enters provider context.
4. Implement only the schema and process-local presentation projection required for those tests.

### Slice 2 — kernel settlement state machine

1. Add loop reds for absent contract byte-equivalence, compliant original, oversized original,
   exactly one rewrite, tools absent, unadvertised tool call, empty response, provider `length`,
   provider error, cancellation, deadline, enforcement loss, and insufficient token/gross/output
   runway.
2. Add properties over hostile Unicode/control/Markdown input for deterministic word/byte counting,
   at-most-one request, bounded visible bytes, and no executed rewrite tool.
3. Implement the smallest state machine and secondary per-response rail.

### Slice 3 — one primary surface and inspection

1. Add headless and reducer reds proving no raw+rewrite duplication, prominent attention facts,
   explicit fallback reason, exact inspection command, and unchanged output without a contract.
2. Add real-Ink reds for active drafting, cancellation while buffered, compliant settlement,
   fallback, `/answer full`, overlay dismissal, scroll/resize at 80x24 and 100x30, and
   `NO_COLOR`/basic-color parity.
3. Add resume/restart/property reds proving the same settlement projects once after a fresh process,
   forged prose cannot activate hiding or synthetic closure, every durable crash prefix remains
   provider-valid, and malformed metadata fails open to visible raw content.

### Slice 4 — public constructors and exact carrier

1. Add parser/help/docs reds for `--final-max-words`, `/answer N`, `/answer clear`, `/answer full`,
   next-task-only reset, invalid values, `/goal`/`/loop` non-interference, and headless inspection.
2. Build/package once from a clean exact commit. Install the npm carrier with scripts disabled.
3. Replay the R21 fixture at 80x24 and 100x30 through headless and real Ink; capture before/after
   screenshots and exact transcript/frame hashes.
4. Exercise error, cancel, resume, credential-absent, trust-decline, and Warden-denial controls.

### Slice 5 — bounded live validation and closeout

1. Only after deterministic, focused, coverage, lint, typecheck, format, package, and five-lens gates
   pass, run at most one live Anthropic onboarding replay with `--final-max-words 250` or its exact
   interactive equivalent.
2. Record provider usage for the original and rewrite separately, total cost, contract outcome,
   tools advertised/executed during rewrite, final word/byte count, and external-repo cleanliness.
3. Reject the candidate if the live primary answer exceeds the contract, duplicates raw output,
   hides attention state, repeats a tool, or cannot inspect the original.
4. Publish exact-head and exact post-main CI; remove every task-local branch, worktree, credential
   copy, recording, audit key, install root, and pack root after sanitized evidence merges.

## Five-lens acceptance review

Before merge, independent review passes must answer:

- **Spec compliance:** Is the contract explicit, opt-in, task-scoped, and behavior-neutral when
  absent? Are frozen ModelPort, Warden, RPC, audit, policy, grant, and side-effect contracts unchanged?
- **Security/adversarial:** Can forged prose or malformed metadata hide output? Can the rewrite call
  a tool, broaden egress, repeat a side effect, leak a secret, or make a Warden outcome disappear?
- **Reliability/edges:** Are `length`, empty, error, cancel, restart, resume, teardown, narrow width,
  hostile text, insufficient budget, and partial session append deterministic and honest?
- **DX/usability:** Is the delayed terminal stream visibly alive? Is there exactly one primary answer,
  one obvious full-detail action, and no unexplained extra cost or provider call?
- **Simplicity/maintainability:** Is settlement one state machine with one counter/validator and one
  projection path, rather than parallel loop/TUI/session heuristics?

Findings are classified must-fix-before-merge, should-fix-soon, acceptable-risk, follow-up, or
spec-issue. Every must-fix is resolved or explicitly escalated.

## Consequences

- An operator can request a hard final reading bound and gets either a compliant answer or an honest
  bounded failure surface. Natural-language concision remains advisory unless the typed control is
  present.
- A violated contract may add one small provider request, visible latency, and incremental cost. A
  compliant answer or absent contract adds no request.
- Terminal answer text is briefly buffered under the opt-in contract; activity and cancellation must
  remain responsive. Ordinary working narration flushes at the first tool boundary.
- The session ledger gains additive optional settlement metadata on existing events. This is a
  syntactically compatible non-frozen session evolution under ADR-0072, but still a public on-disk
  change and is included in this explicit owner decision. Complete settlements rebuild exact recorded
  provider messages; a typed orphan rewrite prompt receives the fixed process-local interrupted
  closure. Older readers remain parse-compatible but do not gain that interrupted-transaction
  repair.
- Full raw text stays local, redacted, and inspectable. It is not silently discarded and is not shown
  twice by default.
- The deterministic fallback is intentionally less useful than a valid rewrite. It is the honest
  terminal state, not a second summarizer or an excuse to claim the task completed.

## Explicit non-goals

- no implicit parsing of “concise,” “brief,” word counts, or format requests from prompt prose;
- no global answer cap or default behavior change;
- no general prose-quality scorer, model-as-judge, factuality claim, or runtime-probe enforcement;
- no table/code-block/style grammar in v1;
- no second rewrite, fallback model, automatic tool retry, or repeated mutation;
- no provider-native schema, structured-output, or dependency addition;
- no Warden/policy/sandbox/egress/grant/RPC/audit change; and
- no score increase from component tests or a docs-only accepted ADR.

## Owner decision requested

Accepting this ADR authorizes red-first implementation of the scoped controller, the public
`--final-max-words` and `/answer` surfaces, the local full-answer inspection surface, and the
additive optional session metadata above, including the exact orphan-prompt closure and documented
behavioral-downgrade boundary. It does **not** authorize a frozen contract, Warden/security authority,
audit-format, provider-routing, dependency, release, or claim-promotion change. Any such need
discovered during implementation is a new stop-and-ask.
