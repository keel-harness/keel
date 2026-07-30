# ADR-0071 — Decouple the kernel from the warden's TypeScript library surface

**Status:** Accepted (2026-07-14). The maintainer approved the recommended direction, and
after a three-lens adversarial review the same day approved the **re-scope** recorded here:
move only the genuinely-pure contracts + the offline evidence verifier, **defer** the
grant-store and credential-proxy coupling (do not duplicate their readers), and downgrade the
claim wording honestly. Implementation proceeds by slice (see the epic plan); the ADR-0001 /
`MASTER_SPEC.md:400` wording amendment (§4) lands in the wording slice.
**Date:** 2026-07-14

## Context

ADR-0001 (§Decision, line 15) and `MASTER_SPEC.md:400` claim that the frozen warden RPC
interface makes a Phase-4 Rust warden port a drop-in replacement — ADR-0001 goes further:
"**without touching the kernel or any other package**."

That promise is **structurally false today.** Eight non-test kernel source files statically
`import … from "@keel/warden"` — a TypeScript *library* dependency, not an RPC call:

| Kernel file | Symbols imported from `@keel/warden` | Kind |
|---|---|---|
| `mcp/local-stdio.ts` | `canonicalMcpToolPinForLaunch`, `MCP_TRUSTED_SERVERS_ENV`, `encodeTrustedMcpServersEnv` | pure fn + const |
| `cli/mcp.ts` | `McpDiscoveryResult`, `McpStdioLaunchConfig` (types) | type |
| `warden/runtime.ts` | 7 env/capability consts, `parseMcpDiscoveryResult`, 2 MCP types (+ a re-export of 2 consts) | const + pure fn + type |
| `cli/bin.ts` | `CREDENTIAL_PROXY_CONFIG_ENV`, `runWardenFromEnv` | const + **warden host entry** |
| `cli/doctor.ts` | `parseCredentialProxyConfig` | parser (runtime-entangled) |
| `cli/session-entry.ts` | `verifyEvidenceBundle` | **offline audit verifier (fs+crypto)** |
| `cli/autopilot-grants.ts` | `loadProjectCommandGrants`, `loadProjectEgressGrants`, `revokeProjectCommandGrant`, `revokeProjectEgressGrant` | **file-IO reader/mutator** |
| `cli/autopilot-mode.ts` | `loadProjectCommandGrants`, `loadProjectEgressGrants` | **file-IO reader** |

If `@keel/warden` became a Rust crate, those TS exports disappear and **the kernel no
longer compiles.** The RPC contract being frozen (`@keel/shared`: `rpc/*`, `WARDEN_METHODS`,
`PROTOCOL_VERSION`, versioned per ADR-0012) does not save the build — these are not RPC
calls.

**A three-lens adversarial review (2026-07-14) reshaped the fix.** It established that the
eight imports are **three different kinds** of thing, and the naïve "move it all to
`@keel/shared`" plan conflated them:

1. **Genuinely pure contracts** (consts, MCP types, three pure functions). These have no
   runtime dependency and belong in `@keel/shared`. Moving them is the real, safe win.
2. **The offline evidence verifier** (`verifyEvidenceBundle`). It is `node:fs`/`node:crypto`
   code that runs **in the kernel** (`keel audit verify`), and the warden never calls it.
   For a Rust warden, `keel audit verify` still needs a *TypeScript* offline verifier — so
   giving it a warden-language-independent home is genuinely load-bearing. But that means
   **relocating the verifier implementation into the kernel**, not "moving a schema."
3. **The grant stores and the credential-proxy parser.** These are the trap. The kernel
   imports the *readers/mutators themselves* — `node:fs` + `withFileLock` code. Crucially,
   the kernel and the warden **co-mutate one on-disk grant file**: the kernel `revoke`s it
   while the warden `save`s it over RPC (`rpc-server.ts:756-759, 3631, 4828, 4867`), and
   the shared `${file}.lock` is the P0-2 fail-open resurrection fix. "Move the schema, keep
   a reader in each process" would **fork that cross-process mutex into two hand-maintained
   copies** — and the lock primitive is *already* divergent between
   `kernel/src/tools/file-lock.ts` and `warden/src/file-lock.ts`. Duplicating the reader is a
   security/correctness regression, and it does not even help the drop-in claim: a Rust
   warden owning the file *while the TS kernel still reads and writes it directly* is exactly
   the fragile cross-language on-disk coupling we are trying to remove. `WARDEN_METHODS` has
   `warden.*.grant` (create) but **no** grant `list`/`revoke` method, so the drop-in-correct
   design (kernel stops touching the file, asks the warden over RPC) is a **frozen-protocol
   change** — its own ADR, out of scope here.

The single genuine warden entry the kernel legitimately reaches for is `runWardenFromEnv`
(`bin.ts`). `resolveProductionWardenStart` (`warden/runtime.ts`) spawns a separate warden
bin-entry when one exists (the normal packaged path) but **falls back to re-exec'ing the
kernel's own executable** with `KEEL_INTERNAL_WARDEN_STDIO=1` — the single-static-binary
(`bun --compile`, ADR-0009) path where the kernel binary *becomes* the warden and the whole
enforcement engine is linked into it. A Rust warden works for the separate-binary path but
breaks this self-exec fallback. The "drop-in" wording hides that.

There is also **no automated guard** against the coupling: `eslint.config.js` has no
`no-restricted-imports` rule. The line is held by hand — the 2026-07-13 warden-death plan
explicitly avoided a shared lock helper "to avoid worsening finding P1-10."

## Decision

**Re-scope to move only what is genuinely pure or genuinely a drop-in win; defer the
coupling that would regress; and make the claim honest.**

### 1. Relocate the pure contracts to `@keel/shared`

The env-var-name / capability-id **const strings**
(`MCP_TRUSTED_SERVERS_ENV`, `INTERNAL_MCP_DISCOVERY_ENV`, `MCP_DISCOVERY_REQUEST_ENV`,
`CREDENTIAL_PROXY_CONFIG_ENV`, `CREDENTIAL_PROXY_PROJECT_CONFIG_PATH`,
`LIFECYCLE_MANIFEST_CONFIG_ENV`, `INTERACTIVE_CONSOLE_CAPABILITY`,
`INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX`); the MCP **types** `McpDiscoveryResult`,
`McpStdioLaunchConfig` **and their transitive helper types**
(`McpToolDefinitionForPin`, `McpPinLaunchInput`, `TrustedMcpServerConfig`,
`TrustedMcpServers`); and the **pure functions** `parseMcpDiscoveryResult`,
`canonicalMcpToolPinForLaunch`, `encodeTrustedMcpServersEnv`. `canonicalMcpToolPinForLaunch`
carries its **local `sha256` helper** (a `node:crypto.createHash` wrapper — note:
`@keel/shared` today exports `canonicalize` but **not** a general `sha256(string)`; the
helper moves with it, adding no dependency since `node:crypto` is already used in shared).
The warden re-imports and re-exports these from `@keel/shared` so its public surface is
unchanged and there is a single source of truth.

### 2. Relocate the offline evidence verifier into the kernel

Move `verifyEvidenceBundle` (and only the verify-side helpers it needs) out of
`packages/warden/src/audit/bundle.ts` into a kernel-owned module
(`packages/kernel/src/audit/verify-bundle.ts`), reusing the shared audit primitives
(`verifyChain`, `verifySignedCheckpoint`, `canonicalize`) it already depends on. The
**write-side** (`buildEvidenceBundle`, `AuditChainWriter`) stays in the warden. The evidence
**bundle schema** (a frozen on-disk format) moves to `@keel/shared` byte-identically so the
warden writer and the kernel verifier reference one schema. This is the one relocation that
genuinely advances the drop-in claim: a Rust warden leaves `keel audit verify` intact.

### 3. Defer the grant stores and the credential-proxy parser — do not duplicate

- **Grant stores:** left importing from `@keel/warden` for now, recorded as a **documented
  residual**. The correct fix is RPC-mediation (new frozen `warden.grants.list` /
  `warden.grants.revoke` methods so the kernel stops touching the file), which is a
  frozen-protocol change requiring its own ADR and stop-and-ask. Tracked as a follow-up.
  **Duplicating the reader/lock is explicitly rejected** (forks the P0-2 mutex).
- **Credential-proxy:** `parseCredentialProxyConfig` is a hand-rolled parser welded to
  secret-injection runtime (`spawnSync`/`randomBytes`/`readFileSync`) returning the warden
  domain type `CredentialProxyRule[]`. Left as a documented residual; if later moved, it
  takes a versioned warden surface, not a forced relocation.

### 4. Amend the claim wording to the honest scope

Replace ADR-0001's "without touching the kernel or any other package" and
`MASTER_SPEC.md:400` with wording that is true by construction:

> The RPC contract and audit format are frozen and versioned (the Phase-4 gate,
> `MASTER_SPEC.md:1519`: byte-identical RPC contract suite + audit-format compatibility +
> performance ≥ TS warden). A Phase-4 Rust warden is a drop-in for the **enforcement
> process behind that seam**. The kernel makes no in-process warden-library enforcement
> **call** except the sanctioned warden-host launch entry (`runWardenFromEnv`); documented
> residuals (the grant-store readers pending RPC mediation, the credential-proxy parser) are
> tracked follow-ups. In the **single-binary build** (`bun --compile`), the warden
> enforcement engine is still linked into the kernel executable and self-dispatched — a
> packaging residual a Rust port supersedes by shipping/spawning the native binary; tracked
> as a Phase-4 spec-issue.

The absolute phrasing "links no enforcement code" is **not** used — it would be false for
the single-binary build, reintroducing the very overclaim this ADR removes.

### 5. Lint-enforce the property (honestly labelled)

Add `@typescript-eslint/no-restricted-imports` (the typescript-eslint variant, so
`import type` reaches are also caught) forbidding `@keel/warden` imports in
`packages/kernel`, with `allowImportNames` limited to `runWardenFromEnv` plus a small,
**named, documented residual allowlist** for the deferred grant/proxy files. Each future
decoupling shrinks the allowlist. This is **lint/CI-enforced** (ESLint is bypassable with an
inline disable) — not `tsc`-compiler-enforced; the wording says so. A denied-path test
asserts a non-`runWardenFromEnv` warden import fails `pnpm lint`.

### 6. The general rule this establishes

- **RPC-contract data** (consts, wire types, pure encoders/parsers/pins, on-disk *schemas*):
  home is `@keel/shared`; each process owns its reader against the shared schema.
- **A shared on-disk store mutated by more than one process** (grants): a **single owning
  reader** or **RPC mediation** — **never duplicated readers**. Duplication forks the lock
  protocol and relocates the coupling instead of removing it.

## Consequences

- **The claim becomes true and honest.** After slices 1–2, the kernel's `@keel/warden`
  product imports are: the warden-host entry (`runWardenFromEnv`) and the two documented
  residuals (grants, credential-proxy). The reworded claim matches that exactly; the lint
  guard prevents new creep.
- **`@keel/shared` grows a contract surface** (consts, MCP types, three pure functions, the
  evidence-bundle schema) with **no new dependency** (stays `@noble/hashes` + `zod`). These
  become **public, frozen** contracts forks may depend on: they are declared **stable / v1**
  and change only under the frozen-format rules (versioning + migration analysis + ADR).
- **The evidence verifier relocation is real code with its own tests** — not an import
  re-point. Its behavior is proven by moving the existing verify tests with it plus a golden
  pre-move bundle that verifies identically.
- **`packages/kernel` keeps its `@keel/warden` dependency** (`package.json:28`), because
  `runWardenFromEnv` + the deferred residuals still import it. The strongest structural proof
  (removing the dep) is unavailable until the single-binary self-dispatch residual and the
  grant RPC-mediation land; the lint guard is the honest second-best, and the ADR says so.
- **No enforcement path changes.** The warden still decides over RPC; no verdict, redaction,
  audit-write, or grant-enforcement path is altered. Security claims are *clarified*, not
  weakened. Because the claim wording is in scope, this ADR needs maintainer sign-off before
  code.

## Related

- Amends **ADR-0001** (the drop-in sentence) and `MASTER_SPEC.md:400`.
- Builds on **ADR-0012** (protocol versioning) — the RPC frame stays the frozen seam; the
  deferred grant RPC-mediation will extend it under a new ADR.
- Interacts with **ADR-0009** (single-binary packaging) — the self-dispatch residual.
- Governs the kernel/warden package-boundary implementation and tests.
- **Follow-ups it creates:** (a) grant list/revoke RPC-mediation (frozen-protocol ADR);
  (b) credential-proxy parser home; (c) Phase-4 single-binary packaging decision;
  (d) file-lock primitive consolidation.

## 2026-07-24 ADR-0082 amendment

ADR-0082 removes `runWardenFromEnv` from the Kernel entry and from the production import allowlist.
The release npx Kernel now launches a private exact-sibling Warden bundle; the non-release
`bun --compile` entry retains the one-file dispatch in packaging code rather than Kernel code. The
tables and quoted wording above remain the historical state and rationale accepted on 2026-07-14;
they are superseded on this one host-entry point.

The remaining production Kernel imports from `@keel/warden` are only the documented grant-store and
credential-proxy residuals. `packages/kernel` therefore still retains the dependency, and the
grant-RPC, credential-parser, and Phase-4 carrier follow-ups remain open. No enforcement decision,
RPC/audit format, or security claim changes.
