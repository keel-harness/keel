# R25 — structural continuation blocker after #143

Date: 2026-08-05
Anthropic spend during this analysis: USD 0.00
Candidate head: `38f21afb33423d63e2370e1ec73e0b99885f24b8`
Exact live failure: `BLOCKED_AFTER_SYNTHESIS`, clean Click workspace, zero actionable reviews

## Exact failure chain

The final #143 carrier stopped on:

```sh
find <workspace>/tests/typing -name "*.py" | xargs grep -l "edit" 2>/dev/null
```

Warden classified the `xargs` stage as an unknown shell shape and correctly returned terminal
POL-003 review with no live handle. The existing #139 lane then allowed exactly one unchanged,
model-authored correction:

```sh
grep -rn "edit" <workspace>/tests/typing/
```

That command was allowed and executed, but exited 1 because there were no matches. The kernel
correctly treated the nonzero bash result as an unsuccessful bounded correction, disabled tools,
and produced an honest blocked closeout. No requested edit or verification occurred.

## Contract trace

- `MASTER_SPEC.md` freezes POL-003 as review plus simpler-command guidance for unknown or obfuscated
  shell shapes. Changing unknown review to deny or allow would alter the public enforcement
  contract.
- The starter Rego pack implements that rule exactly.
- Warden RPC tests prove an unsupported POL-003 review is ungrantable, opens no review handle, does
  not execute, and is audited as terminal non-execution.
- `packages/kernel/src/strings.ts` owns one process-local, model-authored, Warden-gated correction.
  `packages/kernel/src/loop.ts` resumes ordinary work only after a sole authoritative success and
  finalizes every nonzero, signal, malformed, sibling, timeout, or second-review outcome.
- Keel's typed `search` tool already represents no matches as a successful observation
  (`search: no matches.`), which avoids interpreting command-specific shell exit codes in the
  controller.

## Options rejected

1. **Allow `xargs grep` in Warden.** Rejected as the default next slice. `xargs` executes data-derived
   argv; attacker-controlled filenames can become options or alter the invoked program's behavior.
   Safely modeling it is security-sensitive classifier work, not a narrow UX repair.
2. **Change POL-003 unknown review to deny.** Rejected. It changes frozen policy semantics and would
   turn an intentionally consequential review boundary into ordinary model churn.
3. **Treat bash `grep` exit 1 as recovery success.** Rejected. The kernel lacks authoritative
   read-only side-effect metadata in the frozen result contract, and command-specific exit parsing
   would duplicate Warden classification in the controller.
4. **Add a second recovery attempt.** Rejected. It is an explicit #143 non-goal, increases provider
   spend, and weakens the current one-shot control boundary.
5. **More global system-prompt wording.** Rejected as the sole remedy. The exact #143 live replay
   already demonstrated that the model can ignore that guidance.

## Recommended separately authorized slice

Add situational guidance to the existing controller-owned `terminalReviewRecovery` instruction:

- for read-only file discovery, use one typed `search` or `read` call instead of bash
  `find`/`grep`/`xargs`; a typed no-match is a valid observation;
- for a requested test or check, use one exact atomic bash call;
- retain one model-authored call, unchanged execution through Warden, and the current terminal
  finalization for every unsuccessful or ambiguous outcome.

This changes kernel recovery behavior, so it requires a separate approved public issue. It does not
change Warden, policy, RPC, audit, sandbox, egress, grants, tool contracts, or security claims; it
does not split, rewrite, retry, or auto-execute a command; and it adds no provider pass.

## Red-first proof plan

1. Assert the recovery instruction names typed `search`/`read` for file discovery, explains typed
   no-match semantics, and reserves bash for one atomic requested command.
2. Capture the exact controller-injected recovery message in the loop test.
3. Preserve existing adversarial cases: one call only; sibling skipped; no-call, truncation,
   nonzero, signal, malformed, timeout, denial, second review, and untrusted result all terminate.
4. Preserve the exact original reviewed command and model-authored correction bytes.
5. Run focused loop/string tests, full coverage, lint, typecheck, format, build, package,
   supply-chain, diff check, five-lens QC, and exact-head CI.
6. Build a fresh scripts-disabled exact carrier. Run one Click replay first; stop if it fails. Only
   after a pass, run the second required fresh-home replay. Cap incremental Anthropic spend at USD
   1.25 so the protected final USD 2 reserve remains intact.

## Decision required

Owner authorization is required before creating the public continuation issue or changing the
controller-owned recovery instruction. The recommended authorization is limited to the slice above;
any Warden/classifier change, second recovery, controller command transformation, frozen-contract
change, dependency, or security-claim change remains a stop-and-ask boundary.
