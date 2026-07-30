# 0065 — Governed model routing

**Status:** accepted
**Date:** 2026-06-27

## Context

Keel already has a stable provider seam: `ModelPort` (ADR-0002/0019) is the contract the
kernel loop consumes, and the Vercel AI SDK adapter maps provider-native stream shapes into
Keel's frozen chunk vocabulary. Current runtime model selection is deliberately narrow:
`ModelTurnInput.params.model` is a per-turn model-id override resolved inside the already
configured provider adapter. It is useful for a reasoning-sandwich within one provider, but
it is not a governed cross-provider router, a policy decision, or an audit-backed data-boundary
decision.

Model calls are also not just "inference" from a security perspective. A request to an external
provider can send user text, workspace-derived context, tool observations, and retrieved memory
outside the local process. Phase 1 honestly documents provider API egress as ungoverned; Phase 2
builds the warden, egress, provenance, policy, and audit plane. If Keel later routes among models,
that routing must compose with those controls instead of becoming a parallel authority channel.

The market and research direction is clear: systems are adding automatic model selection, and
external gateways can route/fallback/load-balance across models. The Keel-specific design point is
different: route only among policy-approved models, explain the decision, preserve explicit human
or admin control, and leave an evidence trail. Routing must improve UX/DX without turning into
security theater or hidden autonomy.

References reviewed while drafting this ADR:

- GitHub Copilot automatic model selection and enterprise model availability controls:
  <https://docs.github.com/en/copilot/concepts/models/auto-model-selection> and
  <https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-availability-of-default-models>.
- GitHub Copilot model pricing/disclosure docs:
  <https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing>.
- LiteLLM routing/fallback docs:
  <https://docs.litellm.ai/docs/routing>.
- RouterBench and follow-on academic routing work:
  <https://arxiv.org/abs/2403.12031>, <https://arxiv.org/abs/2404.14618>, and
  <https://arxiv.org/abs/2606.22902>.
- Workweave Router — an open-source LLM router (Go) we reviewed for engine ideas, NOT posture:
  <https://github.com/workweave/router>. Worth borrowing: a fast **on-box embedding/cluster selector**
  (its "Avengers-Pro" scorer, <https://arxiv.org/abs/2508.12631>) instead of an LLM-as-router, and a
  **decision-only `/v1/route` endpoint** that returns the routing decision without an upstream call.
  Worth rejecting: it ships telemetry-on-by-default (OTLP), a hosted key-custody option, and has no
  policy/access-control/data-boundary plane — i.e. it is the cost-router engine without the governance
  that is Keel's whole point. We take its engine ideas and keep our governance.

Those references justify taking model routing seriously; they do not change Keel's authority model.
They also do not make model routing an exception to ADR-0016 or `MASTER_SPEC.md` §1.4. Keel rejects
workflow DAGs, separate intent classifiers, and tool routers because those surfaces decompose agency
into orchestration the model should internalize. Governed model routing is different: it is a
harness-owned infrastructure, cost, data-boundary, and evidence decision that the model structurally
cannot make for itself, like transport retry, policy gating, budget enforcement, and egress control.
That distinction is load-bearing; any routing design that becomes a model-selected orchestration layer
is out of scope.

## Options

1. **Keep only the configured `ModelPort` plus `params.model`.** This is simple and honest, but it
   leaves cross-provider selection, cost posture, model capability, data-boundary policy, and
   user-visible explanation outside a first-class governed seam.
2. **Let the model select or escalate its own model.** Rejected. The model may request or explain; it
   may not grant itself more authority, pick a less-restricted data boundary, bypass budget policy,
   or silently change the evidentiary record. This would violate ADR-0017 for the same reason a model
   may not grant egress or raise autonomy mode.
3. **Adopt a hosted/router service as the policy engine.** Rejected for v1. It adds a new remote
   decision point and likely a second data egress surface before Keel's local trust plane is complete.
4. **Introduce a governed local `ModelGateway` above `ModelPort`.** Chosen. The gateway owns model
   catalog lookup, routing policy filtering, deterministic router selection, budget checks, fallback
   constraints, and user/audit visibility while provider adapters stay below the existing transport
   seam.

## Decision

Keel adds model routing as a governed model-call gateway, not as a model-selected convenience
feature and not as a warden RPC shortcut.

The runtime shape is:

```text
kernel loop
  -> ModelGateway
  -> ModelPolicyFilter
  -> ModelRouter
  -> provider-specific ModelPort adapter
  -> provider/model
```

`ModelPort` remains the provider transport contract. `ModelGateway` sits above it and returns the same
streaming vocabulary to the loop. The Epic 2.13 product path wraps today's configured `ModelPort`; a
future implementation may wrap more than one `ModelPort`, but the kernel should not learn
provider-specific routing rules.

The first implemented router must be boring:

- **locked/default mode first**: one configured model, one provider, one decision object, no
  cross-provider fallback.
- **policy filter before preference**: allowed providers, allowed model refs, data-boundary rules,
  retention posture, capability requirements, budget posture, and org/user/project restrictions filter
  candidates before cost/quality preferences run.
- **deterministic static routing before learned routing**: phase/posture maps such as
  `auto-cost`, `auto-balanced`, and `auto-quality` can be deterministic policy data. A learned router,
  LLM-as-router, or benchmark-adaptive router is out of scope until eval-gated after the local
  governance seam exists. When a learned router is eventually eval-gated in, the preferred shape is a
  **small on-box classifier** (a local embedding + cluster scorer — e.g. the Avengers-Pro approach the
  Workweave router ships), **not** an LLM-as-router: it is fast (the kind of sub-50ms selection that
  protects the perceived-start budget), adds no extra model call or spend, and runs **fully on-box so no
  content egresses merely to choose a model**. It runs **after** the policy filter, choosing only among
  already-allowed candidates, so a misjudged or adversarially-shaped embedding can never widen a data
  boundary, add a provider, or exceed budget — it can only reorder safe options. Its decision is recorded
  for replay (below). This is the one disciplined way content-derived selection composes with the
  metadata-only boundary: the content never leaves the box and never expands authority.
- **fallback cannot cross policy**: fallback is for provider/runtime failure only. It cannot select a
  denied provider, widen a data boundary, exceed a budget ceiling, or silently bypass a locked model.
- **routing input is metadata, not raw prompt text**: a router receives structured routing context
  such as phase, posture, token estimate, required capabilities, data class, and budget envelope. It
  does not inspect raw user/workspace content unless a later ADR explicitly introduces a classifier and
  proves the trust/provenance boundary. Those structured fields are harness-derived from structural
  facts — validated policy/profile state, declared tool and model capabilities, measured token counts,
  explicit user/admin configuration, and provenance tags on the assembled context — never model
  assertions. The model may request or explain a preference, but it cannot inflate required
  capabilities, token estimates, or data class by proxy.

The request data class is computed per turn from the assembled context, not from a static workspace
label and never from the model. A turn can mix trusted system text, user input, workspace files, tool
outputs, retrieved memory, and future provenance-tagged artifacts; the route must fold those inputs to
the most restrictive applicable data class. Unknown, mixed, or untrusted provenance fails closed to the
most restrictive route class until an ADR-gated provenance/declassification mechanism proves otherwise.
This is a deterministic boundary, not a content-classifier claim.

The gateway should use model references rather than raw provider strings:

```text
<provider>/<model-id>@<catalog-version>
```

The catalog is local, versioned data. It may include provider id, provider-native model id, capability
flags, context limits, approximate price metadata, cache/read-write behavior, data-boundary class
(`local`, `vendor_api`, `private_cloud`, `public_proxy`), retention posture, and allowed data classes.
Unknown price or retention metadata fails conservative; it is never treated as free or safe.
The default routing posture is locked/current-provider only. When catalog data classes exist, local and
ordinary approved vendor API routes may be candidates under policy; `private_cloud`, `public_proxy`, or
any broader data-boundary class require explicit user/admin opt-in. A known public route is not
implicitly safe merely because it is known.

Model routing policy is human/admin controlled. The model may ask for "more quality" or explain that a
task likely needs a larger context window, but the gateway decides from policy. The model may not:

- select or raise its own routing mode;
- add a provider/model to the allowed set;
- widen the data class a provider may receive;
- override an org/user/project lock;
- turn a policy-denied fallback into an allowed call;
- mark a routing decision as audited or verified.

Model-routing visibility is a product surface. The TUI shows the selected model, the routing mode, and
whether the decision was locked or automatic; receipt polish remains future work. A `/model why` surface
explains the last decision from structured data: candidates considered, filters applied, selected model,
fallback reason if any, and the governing policy/profile identifiers.

Routing must be inspectable WITHOUT spending or egressing. The gateway exposes a **decision-only
preview**: given a request's routing input it returns the full `ModelRoutingDecision` (candidates
considered, filters applied, selected model, fallback chain, governing policy refs) **without making the
upstream model call** (cf. the Workweave router's `/v1/route`). One surface serves three jobs — a
dry-run for the user, the transparency artifact behind `/model`, and the substrate for denied-path tests
that assert a route or a denial at **zero spend and zero egress**. The preview is a pure function of
(routing input, catalog, policy) and must reach the same decision the live path would; it is the routing
analogue of the eval harness's existing dry-run discipline.

Audit integration must preserve the current freeze discipline. This ADR does not add a new Appendix B
event type, Appendix A RPC method, or Appendix D policy input field. Early implementation can record
model decisions in the internal session ledger and, where needed, open audit `payload` markers on
existing records. A claim-grade `model.route` / `model.call` audit event or a warden-owned model-call
policy input requires an ADR-gated schema-version bump and explicit stop-and-ask review.

Replay preserves the recorded route. A resumed or replayed session must use the recorded routing
decision/model-call transcript rather than re-running the router against changed catalog, price,
policy, or learned-router state. This invariant matters before learned or classifier-backed routing
exists because it is what keeps future evals and evidence replay faithful.

## Consequences

- The current provider layer remains valid. `params.model` is treated as a provider-local override
  below the gateway, not as the governance interface.
- The first vertical slice proved the seam without "smart" routing: shared schemas plus a locked
  `ModelGateway` wrapping today's configured `ModelPort`.
- Model calls become a planned data-boundary surface. Keel must not claim model-egress enforcement
  until the policy, provenance, egress, and audit path actually enforces it and denied-path tests prove
  it.
- Cost-aware routing composes with ADR-0044. Budget and spend guards remain conservative; routing
  preferences never weaken the money-safety floor. `auto-cost` decisions are estimates, not billing
  promises; actual usage and cost observations should feed catalog freshness/drift checks so stale model
  pricing is corrected or made conservative.
- The routing engine is OSS and fully functional locally: the gateway, policy filter, deterministic
  router, catalog mechanism, fallback discipline, decision-only preview, `/model why`, and local
  decision recording all run on the user's machine and fail closed.
- Multi-provider routing multiplies the credential and egress surface. Each provider entry needs
  explicit credential resolution through the existing `SecretStore`/environment seam or its successor,
  provider endpoint allowlist posture, redaction coverage, and failure behavior. Provider keys never
  live in the catalog, routing decision, session event, or user-visible explanation. Holding several
  provider keys also raises the value of **at-rest custody**: the secret-store seam should move toward
  OS-keychain / encrypted-at-rest storage (tracked with the existing secret-store hardening) rather than
  a plaintext owner-only file.
- **Observability stays zero-telemetry by default.** Routing decisions and selected models are visible
  **locally** through session metadata and `/model why`; claim-grade audit-chain integration remains an
  ADR-gated future schema change. No remote observability export is part of this decision.
- **No speculative/hedged dispatch by default.** Firing one request at multiple models to take the
  fastest (a tail-latency trick some routers ship) multiplies **both** spend and egress — the same
  context now lands at two providers — which is a cost and data-exposure anti-pattern for a governed
  harness. If ever offered it is opt-in and every hedged endpoint passes the same policy filter.
- No dependency is added by this ADR. External routers/gateways can inform tests and UX, but Keel's
  core routing policy must be local, readable, and forkable.

## Follow-ups

- Maintain the Epic 2.13 plan and claim ledger as the local product path broadens.
- Add provider metadata freshness and retention-posture tests before making any stronger catalog
  freshness claim.
- Decide in a future ADR whether model-call decisions deserve first-class Appendix B audit event types
  or remain linked through existing session/audit payload markers until a stricter claim requires them.
- Gate any learned or LLM-based router on an explicit latency/cost budget. A pre-turn classifier/model
  call can harm the sub-200ms perceived-start target and spend money before the real turn begins; it is
  never part of the default deterministic route.
