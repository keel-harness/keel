# R16 exact session-grant reuse evidence

## Scope and observed failure

R16 used the exact installed npm carrier from `main` commit `76a45c3` against the isolated
`pallets/click` workspace through a real 100x30 PTY, spawned production Warden, loopback model
fixture, and legitimate documentation egress. The human approved `domain example.com` for the
session. A second exact-domain request auto-resolved without another prompt. A later
`domain example.org` request opened a fresh review and was denied.

The controller state was correct: the session ledger contained exactly one
`warden_auto_resolved` event and the audit contained three requested/resolved pairs. The final
transcript omitted the automatic reuse receipt, so a developer could not tell why the second action
ran without interruption. The deliberate distinct-domain denial correctly ended with exit 1; that
attention state was not the defect.

The production review controller proved single-active topology: one actionable review is surfaced
at a time. Concurrent review requests do not create an executable queue. R16 therefore uses the
existing exact session-scope grant as the bounded equivalent-action mechanism and does not invent a
batch surface or equivalence rule.

## Red-first implementation

- A production-shaped headless runner test passed initially: Warden execution, exact-scope reuse,
  durable receipt collection, final reducer state, and headless rendering were already correct.
- The same sequence through the real Ink InputBar/REPL failed red because the automatic receipt was
  present in `turnSummary` but absent from the append-only transcript.
- A focused transcript-planner regression then failed red: the approval-settlement system message
  separated the latest user turn from later tools and caused Ink to commit the turn before
  `run-finished` attached its authoritative summary.
- A first broad fix held the latest turn live after any trailing system message. The full TUI
  property suite rejected it at **1,371 passed / 1 failed** with a random blank system-message
  counterexample. That run is not green and no property was weakened.
- The retained fix tags only controller-owned approval settlement messages with the existing
  `presentation: notice` type. The transcript planner holds only the latest incomplete user turn
  when such a tagged controller notice trails it. Earlier turns still commit when a later user turn
  proves the continuation boundary. Arbitrary system messages retain prior streaming parity.

This is a presentation-lifecycle repair. It changes no Warden verdict, policy, grant, reusable
scope, execution, sandbox, egress, audit, RPC, shared/session schema, dependency, or public CLI
contract.

## Verification

- Focused planner, reducer-tag, incremental Static, headless R16, real-Ink R16, and the retained
  streaming property all pass.
- Full affected conversation/Ink coverage passes **263/263**; the headless/real-REPL group passes
  **84/84**; selected approval/receipt/queue coverage passes **15/15**.
- Full TUI passes **1,372/1,372** across 48 files.
- The first managed-sandbox coverage run was not green because six loopback destination-guard
  tests received `listen EPERM 127.0.0.1`. The unrestricted rerun passes **6,561 tests / 20 existing
  opt-in skips** across 1,034 passing suites with zero failures. Coverage is **97.99%**
  statements/lines, **93.73%** branches, and **99.58%** functions; all enforced package/per-file
  thresholds pass.
- Full typecheck, lint, format, build, all four package carriers, supply-chain check, and
  `git diff --check` pass. The package gate produced macOS arm64/x64 and Linux arm64/x64 binaries
  plus the npm carrier.

## E3 installed-carrier matrix

The exact candidate npm carrier was packed as `keel-harness@0.1.1`, installed into an isolated
prefix with scripts disabled, and has tarball SHA-256
`8f40bfe461da20ad9c9c0ffbb374ff7e22c5e9600155900eb6a145468500e23d`.

| Scenario | Geometry | Exit | Fixture requests | Auto reuse | Requested/resolved reviews | Receipt visible | Transcript SHA-256 |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| equivalent only | 80x24 | 0 | 3 | 1 | 2/2 | yes | `4d462fa1f35a0d2a4fde3dd1a69f20f9b1eb6eb7e24300aa2eebe33e7a62b38e` |
| equivalent only | 100x30 | 0 | 3 | 1 | 2/2 | yes | `4f1b4597bd990e0a37f49475cf418f148686afbb3253e266a83cf24f6b270842` |
| distinct denied | 80x24 | 1 | 4 | 1 | 3/3 | yes | `d487c811b1dcbffea6c502df06eb00ec9d615590ac82351ae31bcef65542072f` |
| distinct denied | 100x30 | 1 | 4 | 1 | 3/3 | yes | `8ba61e281da4d64ed387648977227a846255c903c1c0bbf8e085fc98882576b1` |

Equivalent-only runs prove one human approval covers the later exact resource and finishes cleanly.
Distinct-domain runs prove a non-equivalent resource receives a fresh decision, denial remains
non-executing, and exit status remains attention-truthful. The optional pending-review field is
exactly `1` while each review is live and absent after settlement; the UI never claims a concurrent
two-item queue.

One initial 80x24 attempt is not accepted evidence: its oracle required the wide-screen
`a/s/d Enter` hint, which the compact panel intentionally omits. It timed out with the correct
approval panel visible and made no decision. Removing that geometry-invalid expectation produced
the four accepted runs above; no product byte changed for the retry.

## E4, cost, and safety

Screenshots `43-r16-session-grant-before.png` and `44-r16-session-grant-after.png` are sanitized,
visually inspected 1400x840 exact-text transcriptions of the baseline and candidate 100x30 PTY
scrollback. Their SHA-256 values are
`14e2f00210ca27d6e80cdf968165e8fd608a50dd9b9f57519ee6b21110a3c241` and
`08c44aa414a14e9c4b1f458d76ceb85c79c4d226401c7bc7a5c443102244e975`.
The candidate adds one green `automatic session grant (until session exit)` line with the exact
domain, review, and audit reference; the distinct denial and final answer remain visible.

The product harness's artifact-safety checks found no provider credential, credential-shaped token,
username, private home path, or private temporary path in retained frames or transcripts. E5 is
**NOT_RUN** because the defect is deterministic controller-to-Ink presentation and the exact
installed provider/Warden boundary is exercised by the loopback fixture. The four accepted runs
made fourteen loopback model requests and zero Anthropic calls. Cumulative Anthropic spend remains
USD 2.74434625; USD 17.25565375 remains and the final USD 2 reserve is intact.

## Five-lens QC

- **Spec/ADR:** the fix uses the existing notice presentation type and preserves the accepted
  single-active live-review and exact once/session scope model. No frozen carrier changes.
- **Security/adversarial:** only reducer-authored approval settlement messages receive the tag;
  arbitrary system messages, model prose, request arguments, tool output, and unlike domains cannot
  hold a turn open or create an allow receipt. Warden and durable evidence remain authoritative.
- **Reliability/edges:** late summary, incremental Static, exactly-once emission, earlier/later turn
  boundaries, random streaming parity, exact reuse, distinct denial, compact/wide layouts, and
  settled pending-count removal pass.
- **DX/usability:** one scoped approval now visibly explains the unprompted equivalent action;
  unlike risk still interrupts at the right moment; the UI does not claim unsupported batching.
- **Simplicity/maintainability:** two existing reducer message constructors add one existing tag and
  one planner condition consumes it. There is no new state machine, persistence, protocol,
  dependency, or UI surface.

No unresolved local must-fix remains. Candidate `6f4660c` passed exact reviewed-head CI
`30877328734`; PR #101 squash-merged as `be4fb5e`, and both trees are `0a916c1`. Exact post-main CI
`30877686690` passed, including `ci-required` job `91893411037`. Issue #100 closed, the remote
branch was absent, and the clean local feature branch/worktree were removed.
