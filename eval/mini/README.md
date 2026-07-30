# keel mini-eval

A small, **manual, live** quality probe for the keel harness — an internal signal + regression
baseline until the real Terminal-Bench harness lands (Epic 1.11). It is **not** CI (it needs a real
model + network) and **not** a leaderboard-comparable score.

## How it works

For each task under `tasks/<id>/`:

1. the starting `workspace/` is copied into a fresh temp dir;
2. `keel run -p "<prompt.txt>"` runs against the real model in that dir;
3. a **held-out** verifier (`verify/check.mjs`) — which the agent never sees — is copied in
   **afterward** and run. The task passes iff the verifier exits 0.

Because the verifier is held out and tests more than the visible tests, an agent that games the
visible tests (e.g. editing them to pass) still fails. Each task exercises several tools and
multi-step reasoning (run → read against a spec → edit → re-verify).

## Run it

```bash
corepack pnpm build
set -a && . ./.env && set +a          # provides ANTHROPIC_API_KEY (gitignored)
node eval/mini/run.mjs                 # all tasks; or: node eval/mini/run.mjs 01-csv-quoted-fields
```

Output is a per-task PASS/FAIL line (with duration + token estimate) and a final resolve rate.
Defaults to the pinned model (`KEEL_PROVIDER`/`KEEL_MODEL` override it; ADR-0022).

## Tasks

| id | skill exercised |
|---|---|
| `01-csv-quoted-fields` | debug a parser against a spec; held-out edge cases (quoted commas, escaped quotes) |
| `02-slugify-implement` | implement a function from a spec (stub → working); held-out edge cases |
| `03-reverse-flag` | add a feature wired across two files (CLI flag → formatter) |
| `04-rename-across-files` | search + rename across a definition and call sites without breaking behavior |
| `05-fix-build-script` | run a failing `bash` build, diagnose, fix without regressing intended behavior |

## Honesty

This measures *our* tasks, not a standard benchmark — it does not compare to other harnesses. The
comparable score (Terminal-Bench 2.1 vs the reference harness on the same model/infra) is Epic 1.11,
and is meaningful only after context discipline (Epic 1.6b) + the loop-safety/reasoning wiring land.
A score here also reflects the model, not just the harness.
