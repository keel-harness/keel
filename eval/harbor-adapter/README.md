# keel Harbor agent (Terminal-Bench 2 adapter)

Runs the **keel** coding agent as a [Harbor](https://github.com/laude-institute/harbor) *installed
agent* so it can be scored on **Terminal-Bench 2** for the Epic 1.11 parity gate (§2.2 kill criterion).

- **License gate:** Harbor and Terminal-Bench are **Apache-2.0**; this adapter is Apache-2.0. See
  [ADR-0041](../../docs/adr/0041-harbor-dependency-license-gate.md).
- **Pins (ADR-0022, ADR-0042):** Harbor `v0.13.2`, model `anthropic/claude-sonnet-4-6`, dataset
  `terminal-bench/terminal-bench-2-1` (**TB-2.1** — the verified set; ADR-0042).

## Layout

```
eval/harbor-adapter/
  pyproject.toml                  # package + the exact-pinned harbor==0.13.2 dep
  keel_harbor_agent/
    commands.py                   # pure, Harbor-free shell-command builders (hermetically tested)
    agent.py                      # KeelAgent(BaseInstalledAgent) — composes the builders
  tests/test_commands.py          # stdlib unittest over commands.py (no Harbor needed)
```

`commands.py` has **no Harbor import** on purpose: the exact shell keel runs inside a benchmark
container is the security-sensitive surface, so it is built in small pure functions that are
unit-tested in isolation (`python3 -m unittest`), with **zero spend**. `agent.py` only wires those
commands into Harbor's `install`/`run` lifecycle.

## How it works

1. **install** — installs keel's runtime and fetch dependencies, downloads an owner-built glibc-linux
   evaluation binary from `KEEL_BINARY_URL`, verifies its required `KEEL_BINARY_SHA256`, preflights the
   authenticated temporary file, and only then atomically replaces the binary on `PATH`. The binary is
   glibc-linked, so the task base image must be **glibc/Debian-family**, not musl/Alpine (QR-3).
2. **run** — sets `KEEL_PROVIDER`/`KEEL_MODEL` from Harbor's `-m provider/model`, forwards the matching
   provider API key, and runs `keel run -p "<task>" --trust` headless, teeing the transcript to
   `/logs/agent/keel.txt`. The TB-2 task's own verifier decides resolved/unresolved — **keel's exit
   code is liveness-only and never scores the task** (QR-7).

## Trajectory egress + secret redaction (QR-4)

The §2.3 iteration loop needs the **raw** trajectory of each run on the host, but the TB-2 container is
ephemeral and has `ANTHROPIC_API_KEY` in its env. Two coupled concerns:

- **Egress (container → host):** keel's transcript is tee'd to `/logs/agent/keel.txt` and its session
  ledger is written under the container's keel home; Harbor syncs the container's `/logs` (and agent
  artifacts) back to the host after each trial. The host-side runner reads that synced output and calls
  `@keel/eval`'s **`ingestTrajectory(baseDir, rawJson)`** — a validating ingest that parses + schema-checks
  the (untrusted) container bytes before storing. (The exact transport — Harbor log sync vs. a volume
  mount vs. artifact copy-out — is finalized in slice 8 / Phase B; `ingestTrajectory` is the stable host
  boundary it feeds.)
- **Redaction (SEC-014):** `@keel/eval`'s trajectory store redacts at its **single write chokepoint**
  (`writeTrajectory` → the shared `redactText` filter, the same one the kernel applies to the session
  ledger). A planted key in any trajectory field never reaches the host store at rest (`store.test.ts`
  proves it). Failure-mode reports and the scoreboard route through the same filter; the scoreboard
  carries **aggregate metrics only** (no raw trajectory content). Redaction is best-effort
  defense-in-depth (documented blind spots in `@keel/shared/secrets/redact.ts`); CI also masks the key.

## Running the hermetic tests (no spend, no Harbor)

```bash
cd eval/harbor-adapter
python3 -m unittest discover -s tests -v
```

The keel-side result pipeline (replay `ModelPort` → trajectory → store → results parser) is validated
**offline** by `@keel/eval`'s `offline-skeleton.test.ts` (driven by a committed `Recording`, zero model
cost) — the two together are the Phase-A walking skeleton.

## Phase B (live, owner-gated — do NOT run without go-ahead)

```bash
pip install -e eval/harbor-adapter            # or: uv pip install -e eval/harbor-adapter
pnpm package                                  # from the clean, intended source commit
test "$(git status --short)" = ""              # provenance gate: do not benchmark dirty source
cat build/bin/build-manifest.json             # record and review source/target metadata
export KEEL_BINARY_URL=http://host.docker.internal:8077/keel-linux-x64
export KEEL_BINARY_SHA256="$(shasum -a 256 build/bin/keel-linux-x64 | awk '{print $1}')"
export ANTHROPIC_API_KEY=<key>
keel_http_pid=
keel_stop_http_server() {
  if test -n "$keel_http_pid"; then
    kill "$keel_http_pid" 2>/dev/null || true
    wait "$keel_http_pid" 2>/dev/null || true
  fi
}
trap keel_stop_http_server EXIT INT TERM
(cd build/bin && exec python3 -m http.server 8077 --bind 0.0.0.0) &
keel_http_pid=$!
harbor run --dataset terminal-bench/terminal-bench-2-1 \
  --agent-import-path keel_harbor_agent.agent:KeelAgent \
  -m anthropic/claude-sonnet-4-6 \
  --ae KEEL_BINARY_URL="$KEEL_BINARY_URL" \
  --ae KEEL_BINARY_SHA256="$KEEL_BINARY_SHA256"
```

Container-prep specifics — the **glibc base floor** (the adapter's `glibc_preflight_command` fails closed
on musl/Alpine), `ripgrep`+`bash` install, authenticated owner-built evaluation binary, and
**Anthropic-API egress** under the pinned `networkPolicy` — are specified in
[CONTAINER.md](CONTAINER.md). The first live binary run in a clean glibc container is the **B1 hard
gate**; all live runs are gated on the **slice-9 owner spend decision**.
