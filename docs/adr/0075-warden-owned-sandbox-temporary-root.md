# ADR-0075 — Warden-owned sandbox temporary root

**Status:** Accepted by owner direction on 2026-07-19 for Epic 3.8e. The live Sonnet launch audit
proved that the vendored sandbox runtime points child `TMPDIR` at `/tmp/claude` while that path may
not exist. The owner explicitly approved remediation of the sandbox compatibility blocker, with no
warden weakening and production-grade downstream review.

**Date:** 2026-07-19

## Context

The production warden passes governed bash commands through the vendored Anthropic sandbox runtime.
When filesystem restrictions are active, that runtime replaces `TMPDIR` with `/tmp/claude` (seen as
`/private/tmp/claude` after macOS canonicalization) and includes that global path in its default
write allowances. It does not create the directory. A normal governed `pnpm test` therefore failed
before the package script started with `ENOENT lstat '/private/tmp/claude'`, while the underlying
`node --test` command passed. Keel correctly kept the goal incomplete, but the sandbox environment
made an advertised, ordinary test workflow unusable.

Creating the global directory is compatible but weak: it is predictable, shared across unrelated
processes/users, named for an upstream product rather than Keel, and grants more cross-process
interaction than the task requires. Inheriting the caller's `TMPDIR` is also wrong: it may be broad,
missing, symlinked, secret-bearing, or outside the sandbox profile. Putting temp files under the
workspace would pollute diffs and let project content influence a control-plane path. Putting them
under `KEEL_HOME` conflicts with the intentional deny-read/write protection of Keel-owned state.

The existing capability manifest already has the intended primitive: `declared_temp` is allowed for
read/write, but the production bash profile currently supplies no declared roots.

## Decision

Each production warden process owns one fresh sandbox temporary root for its lifetime:

1. The warden creates the root with `mkdtemp` below the host OS temporary directory, resolves its
   canonical path, verifies it is a directory rather than a symlink, and enforces owner-only mode.
   Project/model input and inherited `TMPDIR`/`TEMP`/`TMP`/upstream Claude temp variables never choose
   this path.
2. Before the vendored runtime wraps any command, the warden points the runtime's child `TMPDIR`
   override at that exact root. The provider/API credential environment remains scrubbed by the
   existing sandbox adapter.
3. The same exact canonical root is supplied as the `declared_temp` projection when building bash,
   lifecycle, MCP-discovery, and interactive-console profiles that share the production sandbox.
   No parent temp directory or sibling is added. Existing deny-read/write roots retain precedence.
4. The warden cleans the exact owned root only after its in-flight sandbox child/process group has
   settled. Cleanup is idempotent during orderly EOF, RPC shutdown, SIGTERM, SIGINT, startup
   failure, and one-shot discovery completion. If the bounded reap wait expires, the warden exits
   without removing the private root because a child may still be using it. Cleanup never follows a
   replacement symlink.
5. The warden snapshots and revalidates the root's device, inode, owner, group, type, and mode before
   each governed use. A replaced, permission-widened, ownership-changed, or missing root fails closed.
6. Creation, pre-execution validation, and post-execution validation failures are typed separately.
   Each carries the request identifier and an accurate `actionMayHaveExecuted` value so recovery
   cannot imply non-execution after an indeterminate postcheck. Cleanup reporting never masks the
   primary execution or validation result.
7. If creation, validation, or required profile projection fails, the production sandbox is
   unavailable/fails closed. Keel does not fall back to ambient `/tmp`, the workspace, or an
   unconfined child environment.

The root is runtime-local state, not durable evidence. This decision adds no RPC field, session or
audit record, grant, policy verdict, public CLI, credential store, or security claim. It instantiates
the already-designed `declared_temp` capability with least privilege.

## Consequences

- Package managers, compilers, and tests receive a real writable `TMPDIR` without ambient host-temp
  authority.
- Failures distinguish proven pre-execution denial from post-execution uncertainty, allowing callers
  and receipts to avoid unsafe retry or inaccurate “not executed” claims.
- Each warden process has a small lifecycle responsibility and may leave a private stale directory
  after uncatchable `SIGKILL`/host crash. A future bounded stale-root janitor would require its own
  ownership proof; it is not part of this slice.
- The warden startup/teardown, sandbox profile, MCP discovery, interactive console, package build,
  and real OS sandbox paths require regression coverage.
- Vendored runtime updates must retain an explicit temp-root injection seam or this compatibility
  bug can recur. Keel must not silently return to the global `/tmp/claude` default.

## Rejected alternatives

- **Create `/tmp/claude` globally.** Simple, but predictable/shared and broader than necessary.
- **Use inherited `TMPDIR`.** Caller-controlled, possibly missing/broad/symlinked, and not bound to
  the sandbox profile.
- **Use a workspace directory.** Pollutes project state and crosses control/data-plane ownership.
- **Use `KEEL_HOME`.** Conflicts with intentional protection of audit, policy, config, and secrets.
- **Disable filesystem restrictions for compatibility.** Directly weakens the warden and is
  prohibited.
