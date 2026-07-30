# 0028 — Retry-policy refinement: transport-vs-tool retries

**Status:** accepted
**Date:** 2026-06-14
**Amends:** ADR-0016 (single-agent durable loop — "no automatic tool retries; recovery is
model-driven")

## Context

ADR-0016 and the charter establish a hard rule: **the harness performs no automatic tool-call
retries** — a failed/denied tool returns structured guidance and the *model* drives recovery,
so the audit narrative stays faithful and irreversible side effects are never blindly repeated.

`MASTER_SPEC.md` §4.3 already carves out a distinct, narrower case: **model/provider transport
calls** — the HTTP request to the provider — are *not* tool side effects, and a
classified-transient transport failure (5xx, connection reset, rate-limit) should be retried
with backoff. Epic 1.3 builds the provider adapter, the **first place transport retry exists**,
so the boundary must be settled and recorded here.

This ADR also records two related refinements §4.3 names but that **land in Phase 2** (no
warden/audit exists in Phase 1): the read-only-idempotent *tool* carve-out, and audit-visible
retry events.

## Decision

1. **Transport retry uses the Vercel AI SDK's built-in `maxRetries`** (bounded). Its default
   retries exactly the classified-transient set — HTTP **408, 409, 429, and all 5xx** (incl.
   Anthropic 529) — and **honors `Retry-After`**; it does **not** retry generic 4xx-client
   errors. This matches §4.3's classified-transient policy exactly, so the adapter configures a
   bounded `maxRetries` rather than hand-rolling a classifier. The bound is small and
   configurable (default 2).

2. **A transport retry is NOT a tool retry.** It re-issues the *provider HTTP request*; it never
   re-executes a tool or repeats a tool side effect. ADR-0016's no-tool-retry rule is untouched
   — the kernel loop still feeds tool failures back to the model for model-driven recovery.

3. **Mid-stream failures are not auto-retried.** Once streaming has begun (≥1 chunk emitted),
   an error is **surfaced as a keel `error` chunk** → the loop ends with `stop(error)` →
   model-driven recovery. Re-issuing a partially-streamed turn could duplicate output and any
   tool calls already dispatched, so mid-stream recovery is model-driven, consistent with
   ADR-0016. (`maxRetries` therefore effectively governs the *initial request*, before output.)

4. **Non-classified errors surface, not retry.** Generic 4xx-client errors are surfaced as
   `error` chunks (honest, recoverable) rather than retried. **Connection errors (as-built,
   verified against `@ai-sdk/provider-utils@4.0.27`):** the SDK's `handleFetchError` classifies a
   `fetch` `TypeError` *with a `cause`* (the common connection-reset/ECONNRESET shape) as a
   **retryable `APICallError`**, so the built-in `maxRetries` already retries it — and safely,
   because this is the same *pre-stream* `doStream` request (no output emitted yet, so no
   duplication is possible). A bare `TypeError` with no `cause` is not classified and surfaces as
   an `error` chunk. The built-in behavior therefore already covers the safe connection-reset
   cases; **no hand-rolled classifier is added** (YAGNI). (This corrects the earlier draft of
   this item, which assumed a raw `TypeError` was never retried.)

5. **Resolved read-only tool carve-out (§4.3) — Phase 2, default OFF.** §4.3 permits an *optional*
   bounded retry of a tool call that failed with a classified `InfraError`, **iff** the warden-resolved
   dynamic side effect is retry-eligible under the frozen multi-axis taxonomy (`@keel/shared`
   `isRetryEligible`): every effect kind is `fs_read`; every scope is `workspace` or `temp`; every segment
   is an affirmatively resolved filesystem read with at least one normalized `path` target; every target
   sensitivity is `public` or `internal`; there are no modifiers; classifier confidence is `exact` or
   `conservative`; and no partial side effect is possible. The static envelope is deliberately **not** a
   conjunct: a broad static tool such as `bash` can resolve dynamically to a safe read-only invocation.
   Unknown, secret, obfuscated, ambiguous, write, network, process, external, and modifier-bearing effects
   are non-retryable. This stays **off** and unimplemented in Phase 1; the dynamic classification is the
   **warden's** to resolve in Phase 2A.

6. **Audit-visible retry metadata — Phase 2.** When a retry fires it is recorded in the audit chain (so a
   retried turn is distinguishable) as payload metadata on the relevant provider/tool event, including
   `retry_of`, attempt number, failure reason, side-effect classification when applicable, and whether it
   was automatic or model-requested. There is no separate `tool.retry` Appendix-B event type. The audit
   chain does not exist in Phase 1; this is implemented when the warden lands (Phase 2A), with no contract
   change needed here.

## Consequences

- The Epic 1.3 adapter sets a bounded `maxRetries` on the provider call; a contract test asserts
  a **503 retries** (≤ bound), a **400 does not**, **exhaustion surfaces an `error` chunk**, and
  — the load-bearing check — **a transport retry never re-executes a tool** (the executor is not
  called by a retry; transport retry is wholly inside the adapter, below the loop's tool path).
- ADR-0016's no-tool-retry guarantee is preserved and now precisely bounded against the
  transport case; the two are orthogonal (transport retry is below `ModelPort`; tool dispatch is
  above it, in the loop).
- The read-only carve-out and audit-visible retry events are explicitly Phase-2, keeping Phase 1
  honest-no-enforcement (no audit) without losing the decision.
