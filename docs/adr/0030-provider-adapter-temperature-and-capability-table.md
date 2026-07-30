# 0030 — Provider-adapter capability table + temperature-under-reasoning correction

**Status:** accepted
**Date:** 2026-06-14
**Amends:** ADR-0019 (the "force `temperature: 1` under `reasoningEffort`" adapter rule)

## Context

Epic 1.3 implements the frozen `ModelPort` with Vercel-AI-SDK adapters for Anthropic,
OpenAI, Google, and Ollama/OpenAI-compatible. Two design questions needed this durable
decision record; executable evidence lives in the nearby adapter tests.

**1. The `temperature`-under-reasoning rule is now wrong.** ADR-0019 (finding I5) and the
`ModelPort` doc-block instructed adapters to **auto-enforce `temperature: 1` when
`reasoningEffort` is set**, on the premise that "some providers reject extended-thinking
requests at other temperatures." Research against current provider docs (2026-06-14;
recorded in the Epic 1.3 design spec §2) shows that premise has hardened into a stricter
constraint: **current reasoning models reject *any* non-default `temperature` with a 400** —
Anthropic Opus 4.7/4.8 reject `temperature`/`top_p`/`top_k` outright; OpenAI o-series reject
`temperature` entirely; GPT-5-class accept only the default. Forcing `temperature: 1` would
therefore **400 on the very models the rule was meant to support** — a documented `MUST` that
ships a broken path.

**2. Per-provider divergence needs a structural home.** Reasoning enablement, prompt-caching
directives, and native-tool support differ per provider, but the adapter core (message/tool/
chunk mapping, abort, retry) is shared. Scattering provider conditionals through the adapter
would rot; the divergence needs one declarative place.

## Options

**Temperature:**
1. **Omit `temperature` entirely when `reasoningEffort` is set.** The provider default applies;
   it is the only accepted value on every current reasoning model (Anthropic's default is
   already `1`, satisfying the older thinking models the original rule targeted). One global
   rule, no per-model branching.
2. **Per-model capability gate** — omit for Anthropic-newest + OpenAI-reasoning, force `1` for
   older Anthropic thinking models, pass through for Gemini. More granular, more surface to
   maintain, no benefit over (1) since omission already yields the only accepted value.
3. **Keep the literal `force 1` rule** — matches ADR-0019 verbatim but ships a known-400 path;
   violates "honesty over impressiveness" (ground rule 4). Rejected.

**Provider divergence:**
A. **Declarative per-provider capability table** — one row per provider declaring
   `supportsNativeTools`, `reasoningOptions(effort) → providerOptions`, and `cacheStrategy`;
   the adapter core reads the table. B. Inline provider conditionals in the adapter. Rejected
   (rots; not forkable).

## Decision

- **Temperature: Option 1 — omit `temperature` entirely when `reasoningEffort` is set.** This
  corrects ADR-0019's adapter rule and the `ModelPort` doc-block prose (the doc-block is
  amended in the same change; the `ModelTurnInput.params` *types* are unchanged — `temperature`
  and `reasoningEffort` both remain optional fields). The owner approved this correction on
  2026-06-14 (a stop-and-ask, since it changes a documented `MUST` on a near-frozen interface).
  When `reasoningEffort` is unset, `params.temperature` passes through normally.

- **Provider divergence: Option A — a declarative capability table** (`capabilities.ts`), one
  row per provider: `{ supportsNativeTools, reasoningOptions(effort), cacheStrategy }`. Adding a
  fifth provider is a new row + a factory entry, no adapter-core change. `reasoningOptions` maps
  `low|medium|high` to provider-native options (Anthropic `thinking.budgetTokens`, OpenAI
  `reasoningEffort`, Google `thinkingConfig`; Ollama returns `undefined` — best-effort/ignored).
  Temperature handling is *not* a per-row field — it is the single global omit rule above.

## Consequences

- The `ModelPort` interface types are unchanged; only the doc-block prose and ADR-0019's rule
  are corrected (this ADR is the record; ADR-0019 gets a forward-pointer note). No semver break.
- Every current reasoning model is handled correctly with no per-model temperature branching;
  a contract test asserts that **no `temperature` is sent when `reasoningEffort` is set**, on
  each provider row, and that `temperature` passes through when reasoning is unset.
- The capability table is the single, forkable home for provider divergence; the native-tool
  invariant and caching strategy live there too (design spec §8).
- Anthropic thinking-budget values (low/medium/high token budgets) are first-guess defaults,
  tunable in the §2.3 iteration loop without touching the contract.
- If a *future* provider genuinely required a specific non-default temperature under reasoning,
  this global rule would need revisiting — recorded here so a fork inherits the reasoning. No
  such provider exists today.
