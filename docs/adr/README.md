# Architecture Decision Records

One ADR per significant decision. Each records the context, the options, the decision, and the
consequences, so the *why* survives a fork.

To add one, copy [`0000-template.md`](0000-template.md), take the next free number, and keep it
aligned with `MASTER_SPEC.md` §10.1. An ADR is the right home for a decision that must outlive its
implementation; a design exploration that *led* to a decision belongs in the
[design archive](../design/README.md).

**Status here is a summary — the ADR itself is authoritative.** *(amended)* marks an ADR whose own
decision was later revised; the ADR names what changed it. An ADR that amends a *different* one is
not marked, because its own decision still stands.

## Numbering gaps

Six numbers are unused, and this is deliberate rather than a mistake:\n| Number | Reserved for |
| --- | --- |
| 0010 | provenance design |
| 0011 | declassification scoping |
| 0014 | hybrid-retrieval scoring |
| 0015 | decay-rejected |
| 0057, 0068 | allocated during drafting, never used |

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-typescript-everywhere-v1.md) | TypeScript everywhere in v1 | accepted |
| [0002](0002-provider-abstraction-vercel-ai-sdk.md) | Provider abstraction via Vercel AI SDK behind ModelPort | accepted |
| [0003](0003-tui-ink-behind-uiport.md) | TUI via Ink behind UIPort | accepted *(amended)* |
| [0004](0004-policy-engine-regorus-vs-opa-wasm.md) | Policy engine: regorus-js vs opa-wasm | accepted |
| [0005](0005-vendoring-sandbox-runtime.md) | Vendoring the sandbox runtime | accepted |
| [0006](0006-crypto-noble-and-audit-format.md) | Crypto: audit hashing, Ed25519, and audit record canonicalization | accepted *(amended)* |
| [0007](0007-embedding-runtime.md) | Embedding runtime for memory index | proposed |
| [0008](0008-session-jsonl-format.md) | Session store: append-only JSONL with atomic rename snapshots | accepted |
| [0009](0009-binary-packaging-bun-compile.md) | Binary packaging via bun build --compile | accepted |
| [0012](0012-protocol-versioning.md) | Warden RPC Protocol Versioning Policy | accepted |
| [0013](0013-oap-conformance.md) | OAP conformance: stay an OAP-mappable superset, do not conform (OQ-8) | accepted |
| [0016](0016-single-agent-durable-loop.md) | Single-agent durable loop | accepted |
| [0017](0017-agent-authority-model.md) | Agent authority model | accepted |
| [0018](0018-pin-esbuild-security-override.md) | Pin esbuild via pnpm override for GHSA-gv7w-rqvm-qjhr | accepted |
| [0019](0019-modelport-prefreeze-refinements.md) | ModelPort pre-freeze refinements (tool-call linkage, abort, streaming/reasoning chunks) | accepted |
| [0020](0020-coverage-gate-design.md) | Coverage gate design (per-file floor, per-package floors, measured property harness, seeded fast-check) | accepted |
| [0021](0021-executor-port.md) | ExecutorPort: the kernel↔execution swap seam | accepted |
| [0022](0022-oq3-oq4-benchmark-pins.md) | OQ-3 / OQ-4: pinned reference model, cost caps, and reference harness | accepted |
| [0023](0023-epic-1.2-tool-dependencies.md) | Epic 1.2 tool dependencies and the bash process model | accepted |
| [0024](0024-tool-side-effect-taxonomy.md) | Tool side-effect taxonomy | accepted *(amended)* |
| [0025](0025-context-lifecycle-and-compaction.md) | Context lifecycle and compaction architecture | accepted |
| [0026](0026-declarative-only-extensibility.md) | Declarative-only extensibility in the alpha | accepted |
| [0027](0027-phase-2a-2b-split.md) | Phase 2A / 2B split and the audit-format freeze boundary | accepted |
| [0028](0028-retry-policy-refinement.md) | Retry-policy refinement: transport-vs-tool retries | accepted |
| [0029](0029-file-native-topic-document-memory-vault.md) | File-native topic-document memory vault | accepted |
| [0030](0030-provider-adapter-temperature-and-capability-table.md) | Provider-adapter capability table + temperature-under-reasoning correction | accepted |
| [0031](0031-full-fidelity-recording-format.md) | Full-fidelity recording format + replay (record mode) | accepted |
| [0032](0032-epic-1.3-provider-dependencies.md) | Epic 1.3 provider dependencies (Vercel AI SDK + provider packages) | accepted |
| [0033](0033-autonomy-modes-and-approval-ux.md) | Autonomy modes and approval UX | accepted |
| [0034](0034-mid-run-steering-and-input-queue.md) | Mid-run steering and the input queue | accepted |
| [0035](0035-session-ledger-event-model-and-crash-safety.md) | Session ledger event model & crash-safety | accepted |
| [0036](0036-tui-architecture.md) | TUI architecture (UIPort · reducer/dumb-renderer split · honest-posture HUD) | accepted *(amended)* |
| [0037](0037-tui-dependencies.md) | TUI dependencies (ink/react · ink-testing-library, not node-pty · no markdown dep) | accepted |
| [0038](0038-workspace-trust-gate.md) | Workspace trust gate (trust-before-parse) | accepted |
| [0039](0039-secrets-handling.md) | Secrets handling (redaction · 0600 secret store · config-dir guard) | accepted |
| [0040](0040-packaging-build.md) | Packaging build: bun-compile binaries + npx bundle | accepted |
| [0041](0041-harbor-dependency-license-gate.md) | Harbor dependency: license gate + the keel TB-2 adapter | accepted |
| [0042](0042-tb2.1-dataset-pin.md) | Switch the Terminal-Bench pin from 2.0 to 2.1 (the verified dataset) | accepted |
| [0043](0043-workspace-snapshot-input-safety.md) | Run-start workspace snapshot (structural input-safety net) | accepted |
| [0044](0044-cost-aware-budget-controller.md) | Cost-aware multi-budget controller (effective tokens, not gross) | accepted |
| [0045](0045-content-aware-compression.md) | Content-aware context compression + `ContextCompressionEvent` | accepted |
| [0046](0046-cache-aware-context-reduction.md) | Cache-aware context reduction (fold + deterministic compression) | accepted |
| [0047](0047-cache-write-accounting.md) | Cache-write (cache_creation) token accounting | accepted |
| [0048](0048-spend-guard-real-cost-recalibration.md) | Spend-guard recalibration onto real (cache-discounted) cost | accepted |
| [0049](0049-in-loop-compaction-production-wiring.md) | In-loop compaction production wiring (Epic 1.6c PR-d) | accepted |
| [0050](0050-bash-timeout-recovery-keep-shell.md) | Bash timeout recovery: terminate the command, keep the shell alive | accepted |
| [0051](0051-wall-clock-budget-deadline-stop.md) | Wall-clock run budget + a `"deadline"` stop reason | accepted *(amended)* |
| [0052](0052-rolling-cache-breakpoints.md) | Rolling Anthropic cache breakpoints (20-block-lookback-safe) | accepted |
| [0053](0053-cache-ttl-lever.md) | `KEEL_CACHE_TTL` lever (opt-in 1-hour Anthropic cache TTL) | accepted |
| [0054](0054-workspace-identity-cwdhash-for-continue.md) | Workspace identity via `cwdHash` for `keel --continue` | accepted |
| [0055](0055-tui-brand-and-structured-chrome.md) | TUI brand identity + structured chrome (evolving "color = state, not decoration") | accepted |
| [0056](0056-capability-manifest.md) | Capability manifest: one source of truth for policy ⇄ sandbox ⇄ egress ⇄ conformance | accepted |
| [0058](0058-lifecycle-manifest-and-validation-posture.md) | Lifecycle manifest and validation posture | accepted |
| [0059](0059-reviewed-self-improvement-and-honest-receipt.md) | Reviewed durable learning and evidence-derived receipts | accepted *(amended)* |
| [0060](0060-goal-and-loop-run-control-primitives.md) | `/goal` and `/loop`: audited run-control primitives | accepted |
| [0061](0061-audit-event-payload-json-safety.md) | Audit-event payloads use `JsonObject`, not `z.record(z.unknown())` | accepted |
| [0062](0062-bind-runs-and-scores-to-claimed-subset.md) | Bind eval runs and scoreboard entries to their claimed subset | accepted |
| [0063](0063-provenance-fence-untrusted-project-prose.md) | Provenance-fence untrusted project prose (AGENTS.md + workspace skills) | accepted |
| [0064](0064-surface-skill-source-in-stub.md) | Surface a skill's source in the discovery stub (shadow visibility) | accepted |
| [0065](0065-governed-model-routing.md) | Governed model routing | accepted |
| [0066](0066-secretless-egress-credential-proxy-walking-skeleton.md) | Secretless egress credential proxy | accepted |
| [0067](0067-governed-mcp-projection-seam.md) | Governed MCP projection seam | accepted |
| [0069](0069-interactive-terminal-console-warden-mediation.md) | Interactive terminal console warden mediation | accepted |
| [0070](0070-headless-reviewed-interactive-console-grants.md) | Headless-reviewed interactive console grants | accepted |
| [0071](0071-kernel-warden-contract-decoupling.md) | Decouple the kernel from the warden's TypeScript library surface | accepted |
| [0072](0072-durable-format-evolution.md) | Durable on-disk format evolution policy (tolerant readers + golden vectors) | accepted |
| [0073](0073-uiport-presentation-evolution.md) | UIPort presentation evolution and live approval scope | accepted |
| [0074](0074-detached-service-process-lifecycle.md) | Detached / long-lived service process lifecycle | proposed |
| [0075](0075-warden-owned-sandbox-temporary-root.md) | Warden-owned sandbox temporary root | accepted |
| [0076](0076-terminal-review-mode-for-automated-validators.md) | Terminal review mode for automated validators | accepted |
| [0077](0077-mcp-schema-projection-is-a-model-hint-not-a-control.md) | MCP tool-schema projection is a model hint, not a security control | accepted |
| [0078](0078-warden-observed-mutation-review.md) | Warden-observed mutation review without model or ledger carriage | accepted |
| [0079](0079-receipt-recovery-without-unsafe-undo.md) | Receipt recovery without unsafe automatic undo | accepted |
| [0080](0080-tui-runtime-truth-vocabulary-and-copy-ownership.md) | TUI runtime truth vocabulary and copy ownership | accepted |
| [0081](0081-informed-approval-presentation-sources.md) | Informed approval presentation sources | accepted |
| [0082](0082-process-specific-npx-entrypoints.md) | Process-specific npx entrypoints | accepted |
| [0083](0083-production-renderer-with-host-env-restoration.md) | Production-mode renderer via launcher `NODE_ENV`, with host-env restoration at the warden spawn boundary | accepted |
| [0084](0084-exact-once-local-mcp-invocation-review.md) | Exact once-only local MCP invocation review | accepted |
| [0085](0085-public-npm-release-authority-and-artifact-flow.md) | Public npm release authority and artifact flow | accepted *(amended)* |
| [0086](0086-warden-owned-egress-address-guard.md) | Warden-owned connect-time egress address guard | accepted |
| [0087](0087-controller-enforced-final-answer-contracts.md) | Controller-enforced final-answer contracts and inspectable settlement | accepted |
| [0088](0088-progress-earned-terminal-review-recovery.md) | Progress-earned terminal-review recovery | accepted |
| [0089](0089-governed-argv-only-process-execution.md) | Governed argv-only process execution | accepted |
