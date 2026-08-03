# R4 bounded mutation review replay

Date: 2026-08-03

External workspace: disposable `pallets/click` worktree

Terminal: Kitty, 100 columns × 30 rows

Provider/network usage: none; provider credentials explicitly unset; deterministic recording,
136 synthetic replay tokens

Keel before: `990f9904e791f74b80874100544930ace34c0e1a`

Keel after: `cd26923 fix(warden): preserve bounded mutation review evidence`

## Scenario

1. Read the first 4,096 bytes of Click's 68,669-byte, 1,634-line `CHANGES.md` through the real
   Warden path.
2. Replace the first heading with an R4 replay marker through governed typed `edit`.
3. Finish with a deterministic assistant answer.

The edit is intentionally small but the file dimensions match the directly observed DF-009 class.
Before R4, untrimmed 1,634 × 1,634 Hirschberg LCS required about 2.67 million scalar comparisons,
exceeding the existing 2,000,000-operation constructor ceiling despite both images being far below
the 2 MiB image limit.

## Before R4

The mutation completed, but no bounded live review survived:

```text
tool  ✓ edit  done
  result: CHANGES.md
  review  unavailable — observation exceeded presentation limits

evidence
  what: file evidence unavailable: edit observation unavailable · observation exceeded presentation limits
  what: tool: read: CHANGES.md
```

See `../screenshots/20-r4-mutation-review-before.png`.

## After R4

The same controller sequence remains inside the unchanged budgets and exposes bounded evidence:

```text
tool  ✓ edit  done · +1 -1
  result: CHANGES.md
  review  CHANGES.md
  evidence  observed before → verified installed after · 1634 → 1634 lines
  comparison  complete · 5 rows shown · 1630 unchanged rows omitted
  scope  transition not atomic · concurrent mutation not excluded

evidence
  what: file evidence: CHANGES.md · observed file before → verified installed after · comparison complete · transition not atomic · concurrent mutation not excluded
  what: tool: read: CHANGES.md
```

See `../screenshots/21-r4-mutation-review-after.png`.

The Warden decision, audit ordering, model-visible result, redaction, path identity, store/polling
bounds, 200 ms deadline, 2,000,000-operation cap, and no-resume-persistence contract are unchanged.
A divergent 1,415 × 1,415 middle still fails closed as `capture-budget` in the regression suite.

Neither capture contains an API key, credential, username, user-home path, or private repository
path. External Click verification passed 227 tests with 23 existing skips.
