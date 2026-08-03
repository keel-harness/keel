# Warden interrupt audit

## Counting rule

Count each operator decision request once. Distinguish policy denial from human review,
and distinguish one-time, session, and project scopes. A repeated prompt is equivalent
only when capability, resource boundary, reversibility, and supply-chain risk match.

| ID | Workflow | Requested action | Decision | Scope offered | Necessary? | Burden | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W-001 | Feature | composite pytest version probe | review; not executed | none; no live approval | avoidable shape | high | audit seq 47 |
| W-002 | Feature | `git diff` | review; not executed | none; no live approval | yes; mutable Git execution metadata | high | audit seq 68 |
| W-003 | Feature | `uv run … pytest …` | review; not executed | none; no live approval | yes; unknown tool/supply-chain setup | high | audit seq 78 |
| W-004 | Interrupt | `uv --version` | review; not executed | none; no live approval | excessive for version probe | high | audit seq 79 |
| W-005 | Refactor | composite pytest with `cd`, two node IDs, `-v`, and redirection | review; not executed | none; no live approval | avoidable shape | high | session 2 audit seq 10 |
| W-006 | Refactor | quoted collect-only selector piped to `tail` | review; not executed | none; no live approval | excessive/avoidable diagnostic | high | session 2 audit seq 13 |

Totals: 6 review interrupts; 2 judged necessary; 4 judged excessive/avoidable; 0 offered an
actionable live decision. A separate `pip install --user -e …` action was allowed because the real
sandbox constrained writes to workspace/temp and denied all network; it failed under PEP 668.

## Automatic denials (not counted as human review interrupts)

| ID | Workflow | Action | Verdict | Precision | Presentation |
| --- | --- | --- | --- | --- | --- |
| D-001 | Debugging | edit `CHANGES.md` before a current-session read | denied, then recovered | justified and narrowly scoped | poor: audit guidance named the exact prerequisite, but TUI hid it and later omitted the successful retry |

## R1 validation outcome

The six historical interrupt counts above are unchanged: the R1 replay exercised the same terminal
review class but offered no operator decision, so it is validation evidence rather than a seventh
human interrupt.

Before R1, the terminal result was labeled `review needed` and its evidence claimed a human decision
was required despite `grantable:false`, `pending:false`. After R1, the same Warden verdict and exact
executor bytes render as `blocked`, explicitly state that no live decision exists, and provide the
supported atomic rerun path. The stale terminal-only `ask for approval` clause is suppressed.

This improves timing, explanation, cognitive load, and recovery honesty. It does **not** reduce
review frequency, change policy precision, add approval scope, or weaken enforcement. Those remain
separate security-sensitive follow-ups.
