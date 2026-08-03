# R11 bounded terminal-command recovery

Date: 2026-08-03. Public plan: issue #82. Branch:
`fix/kernel-bounded-command-recovery`. External workload: isolated `pallets/click`. Terminal sizes:
80x24 and 100x30.

## Same scenario

Prompt:

> Verify the installed pytest version for this Click checkout. If a composite command is blocked
> without a live decision, choose one smaller atomic check and report exactly what ran.

The non-secret fixture first asks for
`cd . && python3 -m pytest --version 2>&1`. The production Warden returns the real POL-003 terminal
no-handle result. Candidate recovery proposes `python3 -m pytest --version`; the final provider pass
is delayed so bounded waiting state can be captured.

## Before

- Provider phases: `original` only.
- Ledger tool results: `r11-composite-review` only.
- Original executed: no.
- Terminal: `error`, code `BLOCKED`.
- Public exit: 1.
- Visible outcome: blocked; no live decision; simplify and rerun.

## After

- Provider phases: `original`, `correction`, `final`.
- Ledger tool results: `r11-composite-review`, `r11-atomic-correction`.
- Original executed: no.
- Correction executed: exactly once through Warden.
- Observed correction result: `pytest 9.1.1`.
- Terminal: clean `model-stop`, no attention code.
- Public exit: 0.
- Visible outcome: done; one bounded recovery receipt; original reviewed action explicitly not
  executed.

The aggregate oracle passed with eight exact fixture requests, zero paid-provider requests, and an
unchanged external checkout. Its SHA-256 is
`97e78a47c85ac139dd831499e69c46bfe35e389964446b58348da3da10b4e738`.

Final adversarial review found that the first success check trusted transport `ok` over a real
Warden JSON command outcome. Three production-shaped cases for nonzero exit, signal, and
indeterminate exit failed red. Warning-decorated nonzero, untrusted apparent success, and malformed
JSON were added before the fail-closed correction; a complete exit-zero/no-signal envelope is the
positive control and the legacy textual nonzero fallback remains covered. The targeted matrix
passes 8/8, the eight-file focused matrix passes 825/825,
full tests and enforced coverage pass 6,528 with 20 existing opt-in skips, and all static gates
pass. The exact PTY oracle was repeated afterward and retained the same aggregate SHA-256 above.

## Visual evidence

- `33-r11-command-recovery-before.png` — baseline terminal block.
- `34-r11-command-recovery-active.png` — original non-execution retained while bounded recovery is
  active.
- `35-r11-command-recovery-after.png` — clean completion, observed pytest result, and recovery
  receipt.

All are sanitized exact-frame transcriptions at 1400x840. Source frames contain no credential,
user-home path, username, or private temporary path. The harness ran its secret/path safety checks
before writing each source frame. The PNGs were visually inspected after rasterization.

## Evidence boundaries

- The local fixture proves provider-turn shape and product integration, not live Anthropic quality.
- The ledger proves exact calls, tool results, and terminal state; transient compact frames are not
  substitutes for durable execution truth.
- No claim is made that Warden reviews less often, that commands are equivalent, or that Keel can
  rewrite shell syntax.
- No shared schema, audit format, Warden policy, sandbox rule, egress rule, or security claim changed.
