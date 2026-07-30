# TUI principles — "legible trust": calm, premium, honest by construction

**Status:** design (rationale + visual language). The *normative* requirements live in
`MASTER_SPEC.md` — **§8.6** (Kernel DX contract, gated), **§4.9** (autonomy/approval UX),
**§4.10** (mid-run steering), **§8.5** (UX gates), **Appendix G** (first-run / launch). This doc is
the *why* and the *what it feels like*; it must never restate a normative rule as if it owned it —
it points at the section that does. A change to an enforced behavior happens in the spec, not here.

**Date:** 2026-06-15. **Updated:** 2026-07-23 for ADR-0081 informed approval sources.
**Relates to:** ADR-0033 (modes as postures), ADR-0034 (steering),
ADR-0036 (TUI architecture — `UIPort` · reducer/dumb-renderer split · honest-posture HUD),
ADR-0037 (TUI deps), ADR-0055 (TUI brand identity + structured chrome), ADR-0080 (runtime truth
vocabulary + copy ownership), ADR-0081 (informed approval sources), and the public TUI tests.

## 0. Why this doc exists

keel's terminal UI is **part of the trust model, not decoration**. The whole product thesis —
autonomy at the reasoning layer, determinism at the control layer (§1.1) — only lands for a human
if they can *see* what is true at a glance: what mode they are in, what is enforced, what the agent
is doing, what file evidence exists, what was verified, and how to recover safely. A beautiful TUI that overstates
enforcement is worse than an ugly honest one; for a trust product, **the most premium thing the UI
can do is never lie.** So the bar here is not "flashy" — it is *calm, premium, inspectable, and
honest by construction*. ADR-0055 sharpens the visual rule: restrained brand and structure may
encode identity and hierarchy; state color still means state; neither may imply enforcement that is
not active.

Most of the behavior this doc describes is **already normative** in §4.9/§4.10/§8.6 and already
shipped in Epic 1.5 (the `UIPort` reducer, the honest-posture HUD, mid-run steering, the calm
failure line). This doc consolidates the scattered surfaces into one **design spine** a forker can
absorb in one sitting, and it specifies the three surfaces the spec did not yet cover: the
**visual language / themes**, the **launch / header sequence**, and **progress / waiting**.

## 1. The philosophy

> **Show intent, hide noise, reveal evidence.**

- **Show intent** — the main screen orients around what the agent is *trying to do* (task, plan,
  phase, current action), not the mechanism (every file read, every byte of tool output).
- **Hide noise** — raw logs are *artifacted, not erased* (§4.7.1-D). They are one command away
  (`/log`, `/tool`, `/artifact`, `/diff full`), never in your face.
- **Reveal evidence** — when a decision needs proof (a failure, a review, a verification claim), the
  evidence is surfaced *where the eye settles*, drawn from the ledger/audit chain, never narrated by
  the model (§4.9.4, §8.6).

> **Quiet confidence.** The UI is calm because the truth is visible, not because risk is hidden. On
> an explicitly unenforced route that truth is prominent; on the governed route restraint is a
> consequence of structural containment (§4.9), never a substitute for it.

These two lines are the tie-breakers. When a design choice is ambiguous, pick the one that shows
more intent, hides more noise, and reveals more evidence — quietly.

## 2. The design spine — two always-answered questions

The Epic 1.5 design fixed the aesthetic as **calm / minimal with first-class discoverability**
("legible trust"). The bottom zone, where attention lives during interaction, always answers two
questions:

- **"What's enforced?"** — the **trust HUD / status line** (§4.9.1). Compact, honest, glanceable.
- **"What can I do now?"** — the **contextual hint footer** (idle → `/ commands · ↑ history · ?
  help`; mid-run → `esc interrupt · /now urgent · type to queue`).

Everything below is in service of keeping those two answers true and calm.

## 3. The principles (each points at its normative anchor)

Each principle states the *feel*, names the *spec section that enforces it*, shows *what it looks
like*, and is honest about its *phase*. The spec is the law; this is the rationale.

### 3.1 Calm by default, detailed on demand · **§4.9.7 · §8.6 (gated)**

The default view prioritizes orientation: **task · plan/ledger · current phase · current action ·
mode/status · pending input/reviews · final receipt.** Raw tool output appears *by default* only
when (a) a command fails, (b) the output is required for a review decision, (c) the user asks,
(d) the output *is* the core artifact, or (e) it is short and useful. Otherwise it is artifacted
and reachable via `/log · /tool · /artifact · /diff full`. *(The default-view contract + the
artifacting commands are the §4.9.7 / §8.6 addition; command names are illustrative, not frozen.)*

### 3.2 Always-visible authority state · **§4.9.1 (gated, §2.1 100%)**

The status line always reveals the posture — autonomy mode · sandbox · network/egress · audit ·
memory-write · queued-input count · pending-review count — and **never renders a posture stronger
than what is enforced** (the honesty invariant). Mode is never hidden in settings.

```
protection: starting · input waits · no tool actions can run
protection: governed · sandbox on · egress:on · policy default · audit on
protection: UNENFORCED · deliberately direct · sandbox/egress/policy/audit off
protection: unavailable · tools halted                              # fail closed
protection: status not reported · do not infer enforcement
```

**Route binding (non-negotiable, ER-013; ADR-0080):** Guided/Autopilot are *postures over the
warden*. They appear only from controller-owned governed policy state. Starting, explicitly
unenforced, unavailable/fail-closed, and unreported routes never render a trust-mode word. Runtime
copy never infers a release phase from individual posture booleans (§4.9.1; golden-tested;
ADR-0036 §4).

### 3.3 Plan-level progress, not implementation noise · **§4.9.7 · §8.6 (shipped)**

A live task ledger shows what the agent is accomplishing, not every internal read. Survives
compaction verbatim — the most durable context item (§4.7.2). Shipped as the `plan` tool (Epic
1.6b slice 8a).

```
Plan
✓ reproduce failure
✓ inspect auth path
→ patch refresh-token expiry
□ run auth tests
□ summarize
```

### 3.4 Mid-run steering is first-class · **§4.10 (shipped)**

The input box stays usable while the agent works. Normal text becomes a **queued note** applied at
the next safe boundary; `Esc`/`Ctrl-C` is an **interrupt**; `/now`·`/before-next-edit`·
`/stop-after-current` is an **urgent override** applied before the next mutating action. keel
acknowledges in one calm line and shows `input:N` on the status line. Queued input persists,
survives resume, and is never summarized away while unresolved (§4.10.2, §4.7.2).

```
⏳ queued — will apply at the next safe point
⚡ urgent — will apply before the next change
```

### 3.5 Receipts beat transcripts · **§4.9.4 · §8.6 (gated, §2.1 100%)**

Every task-completing answer ends with a receipt: file evidence · why · verified · not-verified ·
auto-allowed actions · reviews · blocked/self-corrected · memory proposals · **recovery** · residual
risks. **Every line is drawn from controller-owned session/audit facts or ADR-0078's bounded
ephemeral presentation artifact, never model self-report** — the receipt cannot overstate what its
source proves.

```
File evidence:
- src/auth/session.ts — fixed refresh-token expiry comparison
- src/auth/session.test.ts — added regression coverage
Verified:
- pnpm test auth → passed
Autopilot:
- 12 reads auto-allowed · 2 workspace edits · 1 test command · 0 human prompts
- 1 denied .env read self-corrected
Recovery:
- automatic undo unavailable — review file evidence and recover deliberately from version control or a backup
Not verified:
- full test suite not run
```

**Phasing:** the session-event skeleton (allowed/verified) is Phase 1; allowed-vs-asked-vs-blocked
fidelity comes from the audit chain at Phase 2A, while ephemeral file evidence and recovery
presentation require the ADR-0078 producer/resolver path (§4.9.4).

### 3.6 Recovery is honest and obvious · **§4.9.4 · ADR-0079**

After file observations, keel separates bounded evidence from operation-effect claims and shows a
safe next step. The current producer retains no owned full preimage, proves no clean Git baseline,
and excludes no concurrent mutation, so v1 emits no `git restore`, removal, or automatic-undo
command. It states that automatic undo is unavailable and directs the human to review the evidence
and recover deliberately from version control or a backup. `keel undo <session>` and named
pre-change checkpoints require a separately ADR-gated owned-preimage/checkpoint design (§4.9.6).

### 3.7 Scoped approvals explain blast radius · **§4.9.3 · §8.5 · §8.6 (Phase 2A)**

Approval prompts are scoped and educational, never `Allow? y/n`:

```
Allow POST to api.github.com?
[a] once  [s] session  [d] deny  [?] why

Project scope is configured through Project Autopilot outside the live review.
Project grant means future writes to api.github.com from this repo will not ask again.
Untrusted-derived data still requires review.
```

The panel visually separates `Requested`, `Effective target`, `Why`, `Exact reusable scope`,
`Consequence`, and `Next`. Requested intent is only the bounded model tool name. The effective target
and reusable resource come from the live Warden request; missing facts say `unavailable` rather than
falling back to model or transcript prose. Submitted, confirmed, denied, failed, and indeterminate
states retain the selected choice and a state-specific safe next step (ADR-0081).

Non-urgent reviews **batch into a queue** rather than interrupting per action; keel stops
immediately only when the next action cannot safely proceed (§4.9.3).

### 3.8 Broad-rewrite guard · **§4.9.6 (kernel pieces shipped, slice 9)**

When work expands past the task — many files/lines, public-interface change, frozen schema/protocol,
dependency add, multi-package, generated-file edits — keel pauses *before* the surprise. This is an
**alignment** feature (is the work still what you wanted?), **separate from security policy** (what
is allowed); it is never described as a containment boundary.

```
This is becoming a broad rewrite:
- 9 files touched · 1,200 lines changed · public API touched
Continue?  [y] continue  [n] narrow scope  [p] show plan
```

### 3.9 Waiting should explain itself · **§8.6 (gated subset) — see §7 below**

No spinner purgatory. For long-running commands, show command · elapsed · last meaningful output ·
whether output is quiet · timeout if known. Progress bars only for *real, bounded* progress (§7).

```
Running: pnpm test auth
Elapsed: 0:42
Last output: 3 failed, 122 passed
```

### 3.10 Honest about uncertainty · **§8.6 · §4.7.9 · §4.7.10 (gated)**

The UI clearly shows: not verified · partially verified · skipped tests · truncated output · stale
file reads · blocked actions · reduced enforcement · queued-input-not-yet-applied. A final answer
**must not claim full verification from truncated output** (§4.7.9).

```
Output truncated. Relevant failure excerpt inspected; full log saved as artifact art_123.
Not verified:
- integration tests require TEST_DB_URL
```

### 3.11 Quiet mode and verbose mode · **§4.9.7 · §8.6 (gated default-view)**

**Quiet** (first-class): task ledger · current phase · review/blocking items · errors · final
receipt. **Verbose:** tool calls · policy decisions · fuller logs · artifact refs · debug. Toggled
via `/quiet` · `/verbose`; raw detail reachable via `/log` · `/status` regardless of mode.

### 3.12 Diff UX is a flagship surface · **§8.6 (rendering gated; modes = fast-follow) — see §8 below**

Diffs are beautiful and progressively disclosed: **compact** (one line per file/hunk) → **full**
(syntax-highlighted) → **explain** (why the change matters). Large diffs **paginate or summarize;
they must never silently truncate** (§8.6). Compact rendering ships in Epic 1.5; the three explicit
modes are the §8 spec.

### 3.13 Memory proposals feel respectful · **§4.9.8 (Phase 3)**

At session end, correction-derived memory is *staged, never silently written*:

```
Remember for this repo?
+ Use pnpm, not npm.
[a] accept  [e] edit  [d] decline
```

Proposals are reviewable and tied to evidence; **no hidden memory writes** (§4.9.8, Epic 3.4).

### 3.14 Low-confidence stop · **§4.9.6 (kernel pieces shipped)**

When thrashing or missing context, stopping should feel *competent*, not like failure:

```
I'm not confident enough to continue safely.
Why:
- two failed approaches
- test output is truncated
- relevant config file not found
Recommended next action:
- inspect jest.config.ts
```

Tied to loop detection + the per-file edit counter (Epic 1.1), truncated/stale context (§4.7.9/10),
and the verification pass (§4.9.6).

## 4. Visual language

Restrained and serious by default. **Structure and a restrained ocean-teal brand encode hierarchy
and identity; semantic color encodes state.** The TUI must degrade gracefully and **never rely on
color alone** — every colored signal also carries a text label or a glyph that reads in monochrome.

### 4.1 Semantic color (the target palette)

| Color | Meaning |
|---|---|
| **ocean teal** | brand identity · panel titles · primary product accents (never state) |
| **green** | success · verified · safe · added |
| **yellow** | warning · review · partial · pending |
| **red** | blocked · failed · danger · no enforcement · removed |
| **blue** | information · current phase |
| **muted/dim** | low-priority detail · artifact refs · timestamps · context lines |

Color is **adaptive** to light/dark terminals; truecolor → 256 → mono degrades cleanly; it requires
**no custom fonts**.

> **Code reconciliation (done — Epic 1.5b slice 3; evolved in Epic 1.24 slice 1).** Semantic color
> now lives in one token map ([packages/kernel/src/tui/theme.ts](../../packages/kernel/src/tui/theme.ts));
> the Ink layer maps a status/role to a token instead of a hardcoded color. The Epic-1.5 divergence
> is resolved — a running tool is now **info/blue** (in progress), not `yellow`. ADR-0055 adds the
> ocean-teal `brand` token and hierarchy roles; tests assert brand is not any state color and has AA
> contrast on black and white terminal backgrounds. This token map is the seam a future theme
> (`mono`/`high-contrast`/…) swaps — still not a theme *system*, just the gated palette it would map.

**Conversation focus rule (Epic 3.8 R17).** One completed turn gets one primary reading surface:

- the user request uses a thin brand rail and preserved line breaks, not a filled card;
- all visible Keel prose shares one blue information rail and a restrained charcoal response
  surface, capped to a comfortable reading measure rather than stretched across a wide terminal;
- assistant prose that precedes a typed tool boundary is labeled `keel · working`; the trailing
  reply uses the plain `keel` speaker label, while hidden reasoning remains unrendered;
- tools and consequential evidence remain on the base terminal background with explicit outcome and
  recovery labels, so they are inspectable without competing with the answer; and
- narrow, basic-color, and `NO_COLOR` terminals keep the same rails, labels, and source order even
  when the answer background is unavailable or collapses into the terminal palette.

The response surface is a speaker/focus affordance, not a success, completion, verification,
policy, or enforcement signal. It is stable while streaming because native scrollback is
append-only: a future tool boundary may refine the label, but cannot make an earlier generic `keel`
label dishonest. Typed transcript position chooses `progress` versus `answer`; model-authored
wording never does, and the warden and audit remain the only authorities for action status.

### 4.2 Glyph vocabulary (always paired with a label where it carries meaning)

| Glyph | Meaning | Where (shipped) |
|---|---|---|
| `✓` | passed / ok / done | tool ok · ledger done |
| `→` | running / current | ledger current step |
| `⋯` | in progress | tool running |
| `□` | pending / todo | ledger pending |
| `✗` / `×` | failed / blocked | tool error |
| `!` | review / attention | (review surfaces, Phase 2A) |
| `●` / `◐` / `○` | enforced / partial / absent | trust HUD posture (§4.9.1) |
| `⏳` / `⚡` | queued / urgent steering | input ack (§4.10) |

**Good:** `✓ passed`, `→ running`, `! review`, `× blocked`. **Bad:** a bare row of `✓ → ! ×` with no
labels. The HUD posture today is two-state (`●`/`○`); `◐` (partial) is reserved for partial
enforcement (e.g. an allowlist-narrowed egress) and should be adopted when such a state first
renders — do not paint `◐` for a state the warden did not actually compute (§4.9.1 honesty).

### 4.3 Accessibility, NO_COLOR, and headless — **§8.6 (gated)**

- Respect **`NO_COLOR`** and non-TTY: emit plain text, zero ANSI (already golden-tested via the
  headless renderer + `CI=true`).
- A **plain/headless mode** is the canonical CI output (`keel run -p`, non-TTY).
- Never rely on color alone — labels/glyphs carry the signal in mono.
- All model/tool-derived strings pass `stripControl()` before rendering (ER-020) — model output is
  data, never a format string. A theme can change colors; it can never re-enable raw escapes.

### 4.4 Themes (future-facing — not implemented; Epic 1.5 explicit non-goal)

Specify the *intent*, build later behind a theme token layer:

- **keel / default** — restrained dark/light adaptive (the current semantic palette).
- **mono** — no color; glyphs + text only (the headless aesthetic, interactive).
- **high-contrast** — accessibility-first.
- **minimal** — quiet, reduced ornamentation.
- *(optional)* a branded theme once the product name is final (OQ-1).

The TUI must not require fancy terminal capabilities; a theme is a palette + ornamentation level
over the same honest `ViewModel`, never a new render path that could diverge from the gated layer.

## 5. Launch & header sequence — **Appendix G (normative) · this doc (shapes)**

A header is fine if it is **fast, restrained, and honest** — premium, not cyberpunk.

Requirements (Appendix G): first paint stays under the **§8.3 cold-start budget (<200 ms)**; no slow
animation by default; no giant ASCII art that crowds small terminals; the header collapses/
disappears after the session starts; **`--no-banner` / CI mode** suppresses decoration; the header
**must never obscure or inflate enforcement status.**

Governed header shape:

```
keel
coding agent for governed work
protection: governed · sandbox on · policy default · audit on
```

Explicitly unenforced route — **honest reduced enforcement**, never a phase label:

```
keel
protection: UNENFORCED · deliberately direct · all controls off
```

Launch shows *meaningful readiness checks*, not fake drama:

```
✓ workspace trusted
✓ warden online
✓ policy default@sha256:abcd
✓ sandbox: seatbelt
✓ audit chain ready
```

## 6. Failure & error messaging — **§8.6 · §8.5 · §4.9.3 (gated)**

Tool errors and policy denials render as **one calm, actionable line — what · why · how to
proceed** — placed where the eye settles, **never a raw stack trace** (§8.6). A denial teaches the
*model first* (machine-readable guidance → silent self-correction, §3.4/§4.9.3); the human sees it
only when it needs a decision, or on `/why-blocked`. The line names the exact command or grant that
unblocks it (§8.5). Errors are evidence, not noise — calm, specific, and never blaming the user.

```
✗ write blocked — path outside workspace (src/ allowed). Move the file or grant once: [a] allow
```

## 7. Progress & waiting — **§8.6 (honesty gated)**

> **Progress bars are only for real, bounded progress.**

**Use a progress bar for:** benchmark tasks N/M · evidence-bundle export stages · memory-index
rebuild · downloads with a known total · test-suite progress *only if* structured progress is known.

**Never use a progress bar for:** model thinking · unknown-duration shell commands · "agent
working" · unbounded search · vague analysis. For unknown-duration work show **current phase ·
elapsed time · last event · a restrained spinner if needed — and no fake percentage.**

This is gated as an honesty rule: the headless frame must contain **no percentage for unbounded
work** (cheap, deterministic, ties to the §8.6 honest-output discipline). The aesthetic of the bar
itself (style, width) is design polish, not a gate.

## 8. Diff UX — **§8.6 (rendering gated; compact/full + cap = Epic 1.5b · explain/highlight = fast-follow)**

Progressive disclosure, three concepts:

- **full** (the default) — the per-line diff with `+/-` framing. The edit diff *is the core artifact*
  of an edit (§3.1), so it is shown, not hidden. A diff past the per-line cap shows its head + an
  honest `… N more lines — /diff for compact` footer (a hidden-line **count** — not a `+A -D`
  magnitude, which would mix a whole-diff total with this remainder) — calm on a huge edit, and
  **never a silent truncation** (§8.6).
- **compact** — a calm one-line magnitude (`name path · +A -D`, ASCII minus so it copy/pastes and
  greps, and matches the per-line sign) for noise reduction across many edits; toggled with `/diff`
  (which emits a one-line ack — never a silent state change). A zero-change edit omits the `+0 -0`.
- **explain** — *why* the change matters (rationale, blast radius), drawn from the plan/receipt.

`full`/`compact` + the gated `planDiffRender` decision + the large-diff cap ship in **Epic 1.5b**
([tui/diff.ts](../../packages/kernel/src/tui/diff.ts)); syntax-highlight and `explain` remain
fast-follow. A markdown/syntax-highlight dependency, if added, is an ADR-0037 amendment behind the
same license + supply-chain gate.

> **As-built note (Epic 1.5b):** the slice spec first said *compact by default*; implementation
> reconsidered — for a coding agent the edit diff is signal, not noise, so **full is the default**
> and compact is the on-demand calm view. The §8.6 "never silently truncate" line is met by the
> large-diff cap, not by hiding diffs.

## 9. The joy acceptance checklist

A consolidated, testable bar (the gated subset is enforced in §8.6; the rest is the build target as
each surface lands — see §10).

**A user can always tell:**
- [ ] current autonomy mode — *§4.9.1 (gated)*
- [ ] whether sandbox is active — *§4.9.1 (gated)*
- [ ] whether audit is active — *§4.9.1 (gated)*
- [ ] current network/egress posture — *§4.9.1 (Phase 2A)*
- [ ] memory write posture — *§4.9.1 (Phase 2A/3)*
- [ ] current task/phase — *§4.9.7 (shipped)*
- [ ] current plan/task ledger — *§4.9.7 (shipped)*
- [ ] whether input is queued — *§4.10 (shipped)*
- [ ] whether review is pending — *§4.9.3 (Phase 2A)*
- [ ] what bounded file evidence exists — *§4.9.4 / §8.6 / ADR-0078 (gated)*
- [ ] what was verified — *§8.6 (gated)*
- [ ] what was not verified — *§8.6 (gated)*
- [ ] how to recover safely — *§4.9.4 · ADR-0079 (gated)*

**The main view avoids:**
- [ ] raw log soup — *§4.9.7 calm-by-default (gated)*
- [ ] spinner purgatory — *§7 (gated: no fake %)*
- [ ] ambiguous mode state — *§4.9.1 (gated)*
- [ ] approval spam — *§4.9.3 review-queue batching (Phase 2A)*
- [ ] fake progress bars — *§7 (gated)*
- [ ] hidden skipped tests — *§8.6 (gated)*
- [ ] hidden queued input — *§4.10 (gated)*
- [ ] hidden reduced enforcement — *§4.9.1 (gated, §2.1 100%)*

## 10. Phase & epic mapping (cross-reference, not new epic scope)

Most mappings already exist in §4.9/§4.10 phasing and the epic plans; this is the index.

- **Phase 1 · Epic 1.5 (TUI) — shipped:** status line (honest no-enforcement) · honest header /
  first-run · task-ledger rendering · queued-input indicator + ack · calm failure line · receipt
  skeleton (from ledger) · plain/headless mode · first-paint budget. **Epic 1.5b (shipped):** real
  model/cwd in the HUD + honesty guards (slice 1) · diff compact/full modes + large-diff cap (slice
  2) · semantic-color token map + the §4.1 reconciliation (slice 3). **Remaining fast-follow:**
  `explain` diff mode + syntax highlight (§8) · waiting "last meaningful output" (§7). ADR-0080
  replaces the old package-wide string-consolidation idea with a focused TUI truth catalog.
- **Phase 1 · Epic 1.6 (Context discipline) — shipped/this branch:** queued input → task-state
  constraint · queued input survives compaction · ledger preserved verbatim · receipt must not claim
  verification from truncated output (§4.7.9). New cross-ref: the *calm-by-default default-view
  contract* + artifacting commands (§4.9.7 / §3.1).
- **Phase 1 · Epic 1.4 (Sessions) — shipped:** mid-run input events persist in the ledger;
  interrupt/queued/urgent survive resume (§4.10.2, ADR-0034/0035).
- **Phase 2A · approval/policy UX:** scoped approval prompts · review queue · blast-radius
  explanation · status line driven from warden state (§4.9.3, §4.9.1) · **Intent Preview /
  plan-before-act surface** — the loved "intention before execution" pattern as a *warden-enforced*
  boundary, not a prompt convention (MASTER_SPEC §4.9.5).
- **Phase 3 · memory:** correction-derived memory proposal UX · staged review · no hidden writes
  (§4.9.8, Epic 3.4).
- **Epic 1.10 (packaging + doctor):** the full launch/readiness sequence + `--no-banner` polish
  (Appendix G).

## 11. What this doc is NOT

- **Not a new security claim.** The TUI *reveals* the controller-owned route and individual posture
  facts (§4.9.1); it adds no enforcement and must never display a guarantee that is not structurally true
  (ADR-0036; claim-ledger honesty note). The status line, the receipt, and the undo line are drawn
  from the ledger/audit chain, never model self-report.
- **Not a UI framework.** Calm/minimal, content-first, almost no boxes. Craft shows in the diff, the
  receipt, and the status line — not chrome. The reducer stays the single source of "what to show"
  (ADR-0036); a theme is a palette over it, never a second render path.
- **Not a place that overrides the spec.** If this doc and §4.9/§4.10/§8.6 ever disagree, the spec
  wins and this doc is wrong — fix it here.

## 12. Open questions

- **OQ-1 (product name):** the header/banner name is dynamic until REL-001 lands.
- **Glyph three-state:** adopt `◐` (partial enforcement) only when a partial state actually renders
  (e.g. allowlist-narrowed egress) — reserved, not painted speculatively (§4.2, §4.9.1).
- **Command surface firmness:** `/log /tool /artifact /diff full /quiet /verbose /status` are
  illustrative; §4.9.7 deliberately under-specifies command names until the command surface firms up.
- **Theme tokenization timing:** when the Epic 1.5 theme fast-follow lands, reconcile the §4.1 code
  divergences and decide whether `mono`/`high-contrast` ship in the alpha or post-alpha.
