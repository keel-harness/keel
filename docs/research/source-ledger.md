# Research source ledger

Audit trail for research and benchmark claims that shaped MASTER_SPEC v1.1–v1.3.
Sophisticated OSS readers will challenge these — keep them honest and
give stale ones a revisit date instead of letting them rot in the spec.

| Source | Claim (as used in spec) | Date accessed | Confidence | Affects architecture? | Revisit |
|---|---|---|---|---|---|
| LangChain harness-engineering blog | +13.7 pts on TB-2 from harness hygiene (model fixed) | 2026-06 | medium | yes (§2.3, Epic 1.x) | 2026-09 |
| KRAFTON Terminus-KIRA | 74.7% TB-2 (Opus 4.6); native tool calling among 4 changes | 2026-06 | medium | yes (Epic 0.5, 1.3) | 2026-09 |
| Stanford Meta-Harness | 76.4% TB-2; raw traces > summaries for improvement | 2026-06 | medium | yes (Epic 0.4, 1.11) | 2026-09 |
| Anthropic sandbox-runtime | 84% fewer permission prompts via OS sandbox | 2026-05 | high | yes (Phase 2) | 2026-12 |
| Open Agent Passport (OAP) | pre-action auth + signed audit; ~53ms median | 2026-03 | medium | maybe (ADR-0013/OQ-8) | 2026-09 |
| MemoryAgentBench | 4 capabilities; current systems fall short on all | 2026 | medium | yes (§8.2, OQ-9) | 2026-12 |
| EU AI Act / Digital Omnibus | high-risk Annex III obligations from 2027-12-02 | 2026-05 | medium | claims framing (§1.2) | 2027-06 |

| npm: zod-fast-check@0.10.1 | Derive fast-check arbitraries from zod schemas for round-trip property tests | 2026-06-12 | high (MIT; spike-verified vs zod 3.25.76 + fast-check 3.23.2) | yes (test harness, Epic 0.2) | 2026-12 (stale since 2023-09; re-verify on zod upgrades, replace if it breaks) |
| npm: @noble/hashes@1.8.0 | SHA-256 for the audit hash chain (Appendix B); pre-cleared by ADR-0006 | 2026-06-26 | high (MIT; pure-JS, zero-dep, security-audited noble-cryptography; pinned exact, published 2025-04-21 ≫ 7-day age gate; `ignore-scripts` honored) | yes (Epic 2.6 audit chain, `@keel/shared`) | 2026-12 |

Add a row whenever a new external claim enters the spec. The repo now pins `pnpm@10.16.0` with
`minimumReleaseAge: 10080`; supply-chain drift is checked by `pnpm run supply-chain:check`.
