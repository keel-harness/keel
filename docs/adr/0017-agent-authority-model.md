# 0017 — Agent authority model

**Status:** accepted
**Date:** 2026-06-11

## Context
In the kernel/warden split, the model (reasoning layer) and the warden (control layer) have a carefully bounded relationship. Without an explicit authority model, it is easy for capability creep to blur the boundary — for example, a model that "suggests" a policy change in natural language, or a tool that implicitly grants egress by its return value. Every "may not" that is not structurally enforced by the warden is a security claim the code does not actually provide, which violates ground rule 4 (honesty over impressiveness). The authority model is the per-action complement to ADR-0016's architectural commitment.

## Options
1. **No explicit model** — trust the prompt and the system design; document informally. Does not survive adversarial prompts or injection attacks.
2. **Explicit enumeration of may/may-not with warden enforcement** — each "may not" maps to a warden-enforced check; the enforcement is structural, not prompt-based.
3. **Capability tokens / capability-based security** — more expressive but much higher implementation complexity; out of scope for v1.

## Decision
Adopt an explicit enumerated authority model. The model (LLM reasoning layer) **MAY**:
- Request tool calls (expressed as structured tool-use blocks in the assistant turn)
- Suggest memory writes (expressed as a `memory.write` tool call subject to warden gating)
- Explain policy failures to the user in natural language
- Self-correct on warden guidance (structured machine-readable guidance returned on deny/review verdicts)
- Propose file edits and shell commands within the configured workspace and egress policy

The model **MAY NOT**:
- Approve its own review requests (only a human principal or an explicitly authorized automation can approve)
- Declassify or alter provenance metadata on memory entries or audit records
- Change, disable, or bypass policy (the policy engine is warden-controlled; the model has no write path to it)
- Grant egress permissions to domains or paths (egress policy is set by the human at session start or via a signed policy pack)
- Mark a workspace as trusted (workspace trust level is set by configuration, not by model output)
- Set or raise its own autonomy mode (mode/posture is human- or policy-selected and warden-evaluated)
- Write to the audit chain directly (the warden is the sole writer; the kernel is the sole reader of audit records)

## Consequences
Each "may not" item maps to a concrete warden-enforced check implemented in Phase 2. The warden's enforcement surface is exactly the "may not" list — any new capability added to the kernel loop must be evaluated against this list and either added to "may" (with a warden gate if needed) or explicitly added to "may not" with a new warden check. This ADR must be updated whenever the authority model changes; a change to the authority model that is not reflected here is a security finding. ADR-0016 governs the loop architecture; this ADR governs the per-action authority boundary.
