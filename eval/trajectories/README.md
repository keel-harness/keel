# eval/trajectories

Full raw benchmark-run trajectories (§2.3 iteration-loop substrate), one JSON file per task:

    eval/trajectories/<suite>/<runId>/<task>.json   # schema: @keel/eval `Trajectory`

Bulk run data is **gitignored** (see root `.gitignore`); this layout marker + the committed
`Trajectory` schema are the contract. Raw trajectories are written by `@keel/eval`'s trajectory
store and consumed by the failure-mode analysis loop (Epic 1.11). Never commit raw run data.
