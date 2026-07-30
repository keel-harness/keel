# 0043 — Run-start workspace snapshot (structural input-safety net)

**Status:** accepted; 2026-07-27 privacy/recovery remediation passes local exact-lock gates, fresh carrier/host verification pending
**Date:** 2026-06-17
**Relates to:** Phase-2 sandbox/provenance (the eventual structural successor) and §4.8 side-effect
taxonomy (the destructive-action class this nets). NOT a §4.9 autonomy-mode guarantee — the snapshot
is a pre-warden *safety net*, deliberately outside the enforced-boundary surface (see "Not a security
claim" below), so it must not be read as part of the autonomy-mode contract. Surfaced by the Epic 1.11
TB-2.1 quality probe.

## Context

The live TB-2.1 probe gave keel a concrete, reproducible failure that is worse than a benchmark miss:
on `db-wal-recovery`, keel opened a WAL-mode SQLite DB (`sqlite3.connect`) as its *second action* — which
checkpointed and **deleted the corrupted WAL file holding the very data it was asked to recover** — then
spent ~38 tool calls hunting for what it had destroyed. The same shape recurred even after we strengthened
the system-prompt guidance ("back up irreplaceable inputs first"): the model read the guidance and **still**
destroyed the input. In the real world this is a user-data-loss bug (run keel on "recover my corrupted X"
and it can delete X), not just a lost point.

keel's ethos is **structural, not behavioral**: never rely on the model behaving. Prompt guidance is a
behavioral lever — necessary but not sufficient. The structural fix is to make the originals recoverable
no matter what the agent does.

## Decision

**keel takes a byte-faithful, owner-private recovery snapshot of the (trusted) workspace at run
start, before the agent's first action, ON by default.** The originals survive any in-run mutation.
Recovery is a human-only host operation; the model and governed tools do not receive access to the
retained bytes.

- **Where:** `$KEEL_HOME/snapshots/<runId>/`. `runId` = the session id, so a human can correlate the
  backup with the ledger. Keel must establish the state root as an owner-only mode-`0700` directory
  before retaining bytes there; inability to establish that private boundary skips the snapshot
  fail-open with an honest reason.
- **When:** post-trust only (keel must not read/copy an untrusted workspace — SEC-012). Gated on the
  `trusted` flag now surfaced from `gatherProjectContext`. The snapshot copies trusted bytes to a backup;
  it does not parse untrusted content into the model context.
- **Fidelity:** the snapshot is a faithful local safety copy. It can therefore contain `.env`,
  secret-shaped bytes, and symlink objects. Symlinks are copied as links and never dereferenced while
  measuring or copying, including links whose targets are outside the workspace. These retained bytes
  are the narrow ADR-0043 exception to the general redact-before-snapshot rule: the exception applies
  only inside the private snapshot store and never to a model message, tool result, session ledger,
  audit record, evidence bundle, capture, scan output, or exported artifact.
- **No governed access:** the existing Warden denial of the whole `KEEL_HOME` root remains unchanged
  for governed bash and typed read/search/write/edit. No snapshot subtree allow-list, temporary grant,
  or recovery exception is introduced.
- **No model disclosure:** neither the concrete snapshot path nor snapshot contents are added to model
  context. A bounded message may state only that a private human recovery snapshot exists (or was
  skipped) and that the model cannot access it. It must not include an absolute path, a `cp` command,
  or instructions to use a governed tool for recovery.
- **Human-only recovery:** recovery happens outside Keel using the user's host shell. Public guidance
  may document the stable `$KEEL_HOME/snapshots/<session-id>/` convention, but must tell the human to
  inspect and copy a named regular file deliberately, never bulk-copy or follow a retained symlink.
  Automatic restore and `keel undo` remain out of scope.
- **Default ON, opt-out** via `KEEL_NO_SNAPSHOT=1` (safety-by-default).
- **Bounded + fail-open:** skip (with a reason, run proceeds) when the workspace exceeds **64 MiB or 2000
  files**, or if the copy errors. A big repo has git as its real backup; the case this protects is the
  small, un-versioned, irreplaceable input. A backup that blocked the task would be worse than none.
- **Excludes `keelHome`** from both the size walk and the copy, so a workspace that *contains* keelHome
  never recurses into keel's own state.

### 2026-07-27 implementation checkpoint

The final public-launch audit found the pre-amendment runtime still sends the concrete backup path and
`cp` guidance to the model, while the current Warden correctly denies governed bash access to the whole
Keel state root. That is the F-009 contradiction. It also confirmed a faithful `.env` copy inside the
private audit-scoped mode-`0700` state root (F-001), with no model/export disclosure of the secret bytes.

The amendment above resolves the contract. Its source remediation and registered regressions are now
written. The authorized closeout restored the checkout's exact locked dependencies with
`corepack pnpm install --frozen-lockfile --ignore-scripts`, changing no manifest or lockfile, and the
actual remediation branch passes all 22
snapshot regressions, including symlink-aliased ancestor containment, an in-workspace `KEEL_HOME`
exclusion, simultaneous byte/file cap reporting, and privacy-root failure. The complete registered
coverage gate passes with this module at 92.23% branches, and the security suite passes 925/925. A
separate exact-source probe also passes its bounded synthetic contract oracles. Fresh
installed-carrier/real-host recovery proof remains NOT_RUN in this closeout. Before the launch gate
can mark this verified, evidence must prove all of the following together:

1. `.env`, secret-shaped bytes, ordinary files, and symlink objects are retained faithfully without
   dereferencing a symlink or reading its outside target; a relative symlink's stored target text must
   remain relative and byte-identical rather than being rewritten to a host-specific absolute path;
2. the Keel state root is owner-only mode `0700`, does not equal or contain the workspace, and a
   privacy-establishment failure leaves no partial snapshot and proceeds with an honest skipped result;
3. model messages, session/audit records, headless output, and governed tool results contain neither
   the concrete snapshot path nor a synthetic secret sentinel;
4. typed tools and governed bash continue to deny the entire Keel state root; and
5. a host-side human can recover a named benign regular file while `.env`, secret-shaped files, and
   outside symlink targets are never read by the product or the recovery probe.

## Alternatives considered

- **Prompt guidance only** — kept (it's honest and helps clearer cases) but **rejected as the fix**: the
  validation re-run proved it does not reliably stop the destruction. "Downgrade the claim, not the
  honesty."
- **Git-based snapshot** — rejected: only works in a git repo and only for tracked files; the
  data-loss case (db-wal) is un-versioned.
- **Copy-on-write / hard links** — rejected: OS-specific (reflink) or unsafe (a hard link shares the
  inode, so mutating through it corrupts the "backup").
- **Block/deny the destructive op** — that is the Phase-2 sandbox's job (structural enforcement); in
  Phase-1 honest-no-enforcement, a recoverable snapshot is the available structural net.

## Consequences

- **Tradeoff (retention):** the snapshot is **kept** (not auto-deleted) so a user can recover *after* a
  bad run — at the cost of disk under `$KEEL_HOME/snapshots/`. A `keep-last-N` cleanup is a tracked
  follow-up; in the ephemeral benchmark container it is free.
- **Cost:** a bounded `cp` at run start (sub-second for normal small workspaces; skipped for big ones).
- **Not a security *claim*:** this is a safety net, not an enforcement control — it reduces the blast
  radius of an agent mistake; it does not *prevent* the mistake (Phase 2 does). No SEC-catalog claim is
  added.
- **Phase-2 successor:** a sandboxed/provenance-tracked workspace (copy-on-write overlay) makes this
  structural-by-construction; the snapshot is the Phase-1 approximation, and the `KEEL_NO_SNAPSHOT` knob +
  the caps are the seams that let it evolve.
