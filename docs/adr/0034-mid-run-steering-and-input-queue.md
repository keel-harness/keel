# ADR-0034 — Mid-run steering and the input queue

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** keel maintainers
- **Governs:** MASTER_SPEC §4.10 (normative), with cross-refs in §8.6 (steering/interruption + queue gate) and Epics 1.4 (session events), 1.5 (TUI input queue), 1.6 (task-state / compaction integration). Relates to ADR-0008 (session JSONL — the steering events ride this format), ADR-0025 (context lifecycle — queued input as recent-verbatim / constraint, preserved through compaction), ADR-0033 (autonomy modes — Autopilot honors steering before scope expansion / mutation), ADR-0017 (authority — authority-expanding steering still routes through the approval path), ADR-0027 (Phase 2A/2B split — the audit-chain-inclusion seam settles before the 2A freeze), ADR-0016 (single-agent loop — steering is the human's channel into that loop).

## Context

A coding agent that cannot take a mid-run note is exhausting to drive: the user either waits for the whole run to finish or hard-kills it to say one sentence ("keep the public API unchanged", "don't touch generated files"). Every credible coding harness lets the user type *while the agent works*. §8.6 already required that a mid-task interrupt + redirect be honored and resumable, but it did not specify the common, lighter case — a **non-interrupting** steering comment — nor how mid-run input is classified, when it is applied, how it persists, or how it interacts with compaction and Autopilot.

The risk is treating mid-run input as either (a) a hard interrupt every time (heavy, kills momentum) or (b) text blindly appended to the transcript (lost, applied too late, or applied after a mutating action it was meant to prevent). Both are real failure modes: a "don't edit auth.ts" that lands *after* the edit is worse than useless. The design must give mid-run input **explicit semantics** and **safe application points**, and must make a steering note durable and compaction-surviving like any other task constraint.

This also touches a freeze boundary: if interrupt/steering events are to live in the warden's tamper-evident chain, that is an Appendix-B `eventType` decision that must be settled before the Phase-2A audit-format freeze (ADR-0027). Deciding the v1 home now (the session ledger, not the frozen audit record) keeps that freeze clean.

## Decision

Adopt §4.10 as the normative design.

1. **Three input classes.** **Queued comment** (default; non-interrupting — applied at the next *safe injection boundary*), **immediate interrupt** (`Esc`/`/interrupt`/`Ctrl-C`; no new actions start, summarize, stay resumable), and **urgent override** (`/now`·`/before-next-edit`·`/stop-after-current`; applied before the next risky/mutating action). Mid-run input is a *steering channel with explicit semantics*, never noise blindly appended to context.

2. **Safe injection boundaries.** A queued comment is applied after the current tool call / model turn, or before the next edit, risky action, final answer, compaction, plan expansion, or scope/autonomy boundary (§4.9) — a sibling set to the §4.7.3 semantic triggers. The agent acknowledges receipt in one line without derailing the current run.

3. **Mid-run input is a session-ledger event — no frozen-schema change.** It rides the keel-internal session JSONL (ADR-0008), reserving `input_id` · `timestamp` · `class` · `inserted_at` · `changed_task_state` · `invalidated_plan`. It is **not** added to the frozen warden RPC (Appendix A) or the Appendix-B audit record. Whether interrupt/steering also enters the warden's tamper-evident chain (via the existing `warden.audit.append`) is a **reserved seam** to settle before the Phase-2A freeze, not a v1 schema change.

4. **Persistence, resume, and compaction.** Queued comments are persisted, **survive resume** (unresolved → rehydrate as pending, §4.7.10), and are **preserved through compaction** as recent-verbatim or, when they set a constraint, as a non-negotiable constraint in structured task state (§4.7.2/§4.7.7) — never summarized away while unresolved. The final answer notes when a queued/urgent instruction changed the plan (§8.6 honesty).

5. **Autonomy interaction (composes with ADR-0033).** Autopilot must honor queued comments **before** expanding scope or performing a risky/mutating action. **Authority-narrowing** input (constraints, "keep it small", "don't run integration tests") takes effect **eagerly** at the next boundary; **authority-expanding** input ("go ahead and push") does **not** silently grant authority — it routes through the §4.9.3 approval path (the model may not grant itself authority, ADR-0017). Input that invalidates the plan triggers a re-plan before continuing.

## Alternatives considered

1. **Every mid-run message is a hard interrupt.** Rejected — kills momentum for the common "just a note" case; the user shouldn't have to stop the agent to add a constraint. Interrupt remains available as an explicit class, not the default.
2. **Append mid-run text to the transcript and let the model notice it whenever.** Rejected — no guarantee a "don't edit X" lands before the edit; loses the note on compaction; provides no pending-state visibility. The whole point is *explicit application points* and *durability*.
3. **A new warden audit `eventType` for steering now.** Rejected for v1 — it is an Appendix-B change that freezes at 2A (ADR-0027); the session ledger is the correct v1 home, and the audit-chain question is a reserved, ADR-gated seam.
4. **A separate steering store outside the session ledger.** Rejected — the ledger is already the canonical, append-only, crash-safe, resumable record (ADR-0008/0025); a second store would duplicate its guarantees and risk divergence.
5. **Block all input while a tool runs (type only between turns).** Rejected — that *is* the make-the-user-wait problem; the queue exists precisely so input is accepted at any time and applied safely.

## Consequences

- **Positive:** table-stakes steering UX with correctness guarantees — a constraint reliably lands before the action it constrains; notes survive resume and compaction; Autopilot can't expand scope past an unheard "keep it small". The freeze stays clean (session ledger, not audit record).
- **Honesty constraint.** The agent must visibly acknowledge queued input (pending indicator + one-line ack) and must note in the final answer when steering changed the plan — no silent absorption, no silent drop.
- **Phasing.** Kernel-side queue + indicator + interrupt + session-ledger persistence are **Phase 1** (Epics 1.4/1.5/1.6). Stronger policy/autonomy interactions (urgent override forcing a warden re-evaluation; authority-expanding steering through the review path) mature with the warden in **Phase 2**. The audit-chain-inclusion decision lands **before the 2A freeze**.
- **Cost:** an input-queue + pending-state surface in the TUI, steering-event fields in the session ledger, and compaction/task-state handling for unresolved input — modest, and largely reusing the existing ledger, task-state, and loop-interrupt machinery.

## Non-goals

- **Not** a change to a frozen interface — steering rides the keel-internal session JSONL (ADR-0008); a warden audit `eventType` is a reserved Phase-2A-freeze decision, not part of this ADR.
- **Not** a new authority for the model — authority-expanding steering still routes through the human approval path (ADR-0017/§4.9.3); steering is the *human's* channel, applied by the kernel.
- **Not** multi-user / concurrent-steering semantics — single local user (consistent with §1.4); concurrent sessions in one workspace keep their existing isolation (Epic 1.4).
- **Not** a natural-language command interpreter — the classes are explicit (default queue, `/interrupt`, `/now` etc.); a queued comment is content for the model to honor, not a parsed command DSL.

## Implementation implications

- **Epic 1.4 (sessions):** add steering session-event records with the reserved fields; resume rehydrates unresolved queued input as pending; property test — a queued comment survives kill-9 + resume as still-pending.
- **Epic 1.5 (TUI):** the input queue accepts text while the agent works; pending-input indicator (`… · input:1`); one-line ack; `Esc`/`/interrupt`/`Ctrl-C` (graceful/hard) and `/now`·`/before-next-edit`·`/stop-after-current`. e2e — a queued comment during a long-running command is applied after it completes; an interrupt starts no new actions and is resumable.
- **Epic 1.6 (context):** a queued comment that sets a constraint updates structured task state *before* the next edit; unresolved queued input is preserved across compaction; a plan-changing instruction triggers a re-plan and is noted in the final answer (§8.6).
- **Phase 2 (warden):** urgent override forces re-evaluation before the next mutating action through the policy gate; authority-expanding steering routes through the §4.9.3 approval path; settle the audit-chain-inclusion seam before the 2A freeze (ADR-0027).
