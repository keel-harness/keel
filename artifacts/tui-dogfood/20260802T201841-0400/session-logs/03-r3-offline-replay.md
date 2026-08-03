# R3 offline product replay

Date: 2026-08-03

External workspace: disposable `pallets/click` worktree

Terminal: Kitty, 100 columns × 30 rows

Provider/network usage: none; deterministic recording, 175 synthetic replay tokens

## Scenario

1. Request an `edit` of `r3-recovery-fixture.txt` before a current-session read.
2. The real Warden blocks the mutation before execution under read-before-edit.
3. Read the exact fixture.
4. Retry the same `edit` operation/path successfully.
5. Run the harmless governed marker `echo keel-r3-replay-complete`.
6. Finish with an assistant answer.

The fixture began as `status=before` and ended as `status=after`. The independent external check
`python3 -m pytest -q -o pythonpath=src tests/test_termui.py` passed 227 tests with 23 existing
skips.

## Before R3

The final evidence retained the obsolete outcome:

```text
evidence
  what: file evidence: r3-recovery-fixture.txt · observed file before → verified installed after
  what: tool: read: r3-recovery-fixture.txt
  what: blocked: edit: r3-recovery-fixture.txt
  why: the warden denied the action before execution
  next: fix the request or command, then retry
```

See `../screenshots/18-r3-recovered-receipt-before.png`.

## After R3

The successful retry is dominant and the reconciliation remains explicit:

```text
tool  ✓ edit  done · +1 -1
  result: r3-recovery-fixture.txt
  evidence  observed before → verified installed after · 1 → 1 lines

evidence
  what: file evidence: r3-recovery-fixture.txt · observed file before → verified installed after
  what: recovered: edit r3-recovery-fixture.txt completed after earlier blocked attempt
  what: tool: read: r3-recovery-fixture.txt
```

The original blocked attempt remains available in verbose/debug history. See
`../screenshots/19-r3-recovered-receipt-after.png`.

No API key, username, user-home path, or provider credential is present in this artifact or either
capture.
