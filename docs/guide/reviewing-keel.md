# Reviewing keel's trust plane

This is a two-hour entry path for reviewers who want to inspect the three load-bearing
questions: who decides whether a tool runs, what is durably recorded, and how policy becomes an
OS-sandbox profile. It names functions instead of line numbers so the map survives ordinary edits.

The first pass follows governed `bash` and typed file tools. MCP and interactive-console paths have
additional review machinery; inspect those after the core path unless your report targets them.

## Before reading code — 10 minutes

Read these claim boundaries first:

1. [`MASTER_SPEC.md` §3](../../MASTER_SPEC.md#3-threat-model) for the trusted v1 kernel,
   same-user exclusion, and claimed tool surfaces.
2. The [security model](security-model.md) for the plain-language limits.
3. The [claim ledger](../quality/claim-ledger.md) for the executable evidence attached to each
   claim.

Keep three distinctions in view:

- `deny`, `review`, `modify`, `warn`, and `allow` are policy verdicts; only an execution path can
  cause the side effect.
- governed `bash` runs through the physical OS sandbox. Typed file tools are warden-hosted with
  policy, profile, audit, and path-containment checks, but are not a separate physical-sandbox
  claim.
- a valid audit chain proves integrity of the recorded bytes. It does not prove every classifier
  field is semantically exact or that the same OS user could not steal the at-rest signing key.

## 1. Policy decision path — 35 minutes

Start at [`rpc-server.ts`](../../packages/warden/src/rpc-server.ts) and search for these functions
in order:

1. `methodResult`, specifically the `warden.execute` case. This is the RPC dispatch and the main
   allow/deny/review/modify control flow. Confirm that unavailable enforcement fails closed and that
   a policy denial never reaches an execution function.
2. `commandFromToolCall`, `policyInputForResolvedCommand`, and `policyInputForCommand`. These bind
   the requested tool and effective command to the policy input.
3. In [`policy.ts`](../../packages/warden/src/policy.ts), read `buildPolicyInputForToolCall`, then
   the relevant builder (`buildPolicyInputForBash`, `buildPolicyInputForRead`,
   `buildPolicyInputForSearch`, `buildPolicyInputForWrite`, or `buildPolicyInputForEdit`). For Bash,
   follow `classifyShellCommand` and `classifyShellPart`; unsupported or uncertain shapes must not
   silently become known-safe.
4. Read `OpaWasmPolicyPort.evaluate`, `parsePolicyDecisionResult`, and `chooseVerdict`. Verify the
   embedded pack hash check in `createDefaultPolicyPort`, the verdict priority, and malformed-result
   failure behavior.
5. Return to `methodResult`. Follow the deny/review branch, the modified-argument re-evaluation,
   `policySandboxFindings`, and finally the call to `executeWithProfile` or `executeTypedTool`.

Then sample the denied, review, modified-argument, sandbox-mismatch, and execution cases in
[`policy.test.ts`](../../packages/warden/src/policy.test.ts) and
[`rpc-server.test.ts`](../../packages/warden/src/rpc-server.test.ts). Do not treat the classifier's
name or confidence as enforcement; trace the verdict and the branch that follows it.

## 2. Audit write path — 30 minutes

In [`rpc-server.ts`](../../packages/warden/src/rpc-server.ts), follow this chain:

1. `appendAuditSeq` is the RPC layer's only adapter to the audit writer. Confirm that a writer
   failure becomes `AUDIT_WRITE_FAILED` rather than being swallowed.
2. `executeWithProfile` writes a durable `tool.execute` intent before governed Bash side effects and
   an outcome afterward. `executeTypedTool` applies the same intent-before-mutation rule to typed
   `write` and `edit`, with prepare/revalidation before commit.
3. [`SessionAuditLog.append`](../../packages/warden/src/audit/session-log.ts) selects the per-session
   writer and supports recovery by evicting a poisoned writer before reopening it.
4. [`AuditChainWriter.append`](../../packages/warden/src/audit/writer.ts) redacts, schema-normalizes,
   hashes, and seals the record. Continue through `AuditChainWriter.#appendLine`: it loops over short
   writes, fsyncs, rolls a failed append back to the last durable byte, and poisons the writer.
5. Continue through checkpoint creation and [`verifyChain`](../../packages/shared/src/audit/verify.ts)
   to check that write and verify semantics agree.

Use [`writer.test.ts`](../../packages/warden/src/audit/writer.test.ts),
[`session-log.test.ts`](../../packages/warden/src/audit/session-log.test.ts), and the audit cases in
[`rpc-server.test.ts`](../../packages/warden/src/rpc-server.test.ts) to probe disk-full, short-write,
redaction, pre-execution intent, post-execution failure, and recovery behavior. The flagship
end-to-end denial/export path is in
[`security-suite.test.ts`](../../packages/kernel/src/warden/security-suite.test.ts).

## 3. Sandbox-profile projection — 30 minutes

Follow the profile from declaration to process spawn:

1. In [`rpc-server.ts`](../../packages/warden/src/rpc-server.ts), read
   `buildSandboxProfileOrError` and `buildSandboxProfile`. They select the capability manifest,
   project tool identity, add reviewed egress, and add credential-source deny-read paths.
2. In [`sandbox-profile.ts`](../../packages/warden/src/sandbox-profile.ts),
   `buildDefaultSandboxProfile` is the default-manifest wrapper.
3. In [`capability-manifest.ts`](../../packages/warden/src/capability-manifest.ts), inspect
   `DEFAULT_CAPABILITY_MANIFEST` and `buildSandboxProfileFromCapabilityManifest`. Verify how symbolic
   tokens expand into normalized `allowRead`, `allowWrite`, `denyRead`, and `denyWrite` roots and the
   network profile. Pay particular attention to the actual audit directory, keel config, home
   secrets, workspace dotenv files, and executable metadata.
4. Back in `rpc-server.ts`, `policySandboxFindings` rejects a policy/profile mismatch before
   execution. This check is a key defense against a classifier claiming containment that the
   projected profile does not provide.
5. For governed Bash, `executeWithProfile` calls `SandboxPort.execute`. In
   [`srt-sandbox.ts`](../../packages/warden/src/srt-sandbox.ts), follow `createSrtSandboxPort`,
   `createSrtSandboxLaunchPreparer`, and `createNodeSandboxProcessRunner` through profile conversion,
   argv/env construction, spawn, bounded output, abort, and process-group cleanup.

Compare the projections with [`capability-manifest.test.ts`](../../packages/warden/src/capability-manifest.test.ts),
[`sandbox-profile.test.ts`](../../packages/warden/src/sandbox-profile.test.ts), and
[`srt-sandbox.real.test.ts`](../../packages/warden/src/srt-sandbox.real.test.ts). The real-backend
suite must fail rather than skip when `KEEL_REQUIRE_REAL_SANDBOX=1`.

## Close the loop — 15 minutes

Run the smallest relevant evidence first:

```bash
pnpm exec vitest run packages/warden/src/policy.test.ts packages/warden/src/rpc-server.test.ts
pnpm exec vitest run packages/warden/src/audit/writer.test.ts packages/warden/src/audit/session-log.test.ts
pnpm exec vitest run packages/warden/src/capability-manifest.test.ts packages/warden/src/sandbox-profile.test.ts
```

If the host has the real sandbox prerequisites, also run:

```bash
pnpm test:sandbox:real
```

For a claim-level pass, run `pnpm test:security`, then compare the result with the claim ledger. A
green suite does not close an untested semantic gap; report what you traced and what you actually
ran.

Suspected vulnerabilities belong in GitHub private vulnerability reporting, as described in
[`SECURITY.md`](../../SECURITY.md). Design questions and non-sensitive claim-honesty findings can
use a public issue.
