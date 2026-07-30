// Single source of truth for the P1-10 kernel→warden import boundary (ADR-0071).
//
// The kernel process must not statically link the warden's TypeScript enforcement library:
// a Phase-4 Rust warden port (MASTER_SPEC.md §4.5) would replace `@keel/warden` with a native
// binary behind the frozen RPC seam, and any kernel `import … from "@keel/warden"` of an
// enforcement symbol would then fail to resolve. The pure kernel↔warden data contracts live
// in `@keel/shared`; the kernel imports them from there.
//
// Two tiers, so PRODUCTION kernel code stays strictly free of warden library imports while
// tests may still reach into the warden to build fixtures:
//   • PRODUCTION allowlist — only the couplings still pending their own decoupling slices. ADR-0082
//     moved the one-file Warden host dispatch into packaging, so the former host-entry exception is
//     now denied. Each future slice SHRINKS this list toward empty.
//   • TEST-ONLY additions — permanent-by-design fixture reaches (e.g. the warden evidence
//     WRITER the kernel round-trip test drives, or grant writers). These stay in the warden by
//     design and are allowed ONLY in *.test.ts, never in production kernel files.
// Consumed by both eslint.config.js (enforcement) and the kernel boundary test (behavioral
// proof), so the two never drift.

/** What PRODUCTION (non-test) kernel code may import from @keel/warden. */
export const WARDEN_PRODUCTION_ALLOWLIST = [
  "parseCredentialProxyConfig", // residual: credential-proxy parser — own follow-up
  "loadProjectCommandGrants", // residual: grant reader — RPC-mediation follow-up
  "loadProjectEgressGrants", // residual: grant reader — RPC-mediation follow-up
  "revokeProjectCommandGrant", // residual: grant mutator — RPC-mediation follow-up
  "revokeProjectEgressGrant", // residual: grant mutator — RPC-mediation follow-up
];

/** Permanent-by-design fixture reaches allowed ONLY in kernel *.test.ts files. */
export const WARDEN_TEST_ONLY_ALLOWLIST = [
  "buildEvidenceBundle", // warden evidence WRITER — kernel round-trip test builds real bundles
  "EvidenceBundleError", // warden writer's refusal error — asserted by the round-trip test
  "AuditChainWriter", // warden audit write-side — round-trip test harness
  "saveProjectCommandGrant", // grant writer — grant-CLI tests
  "saveProjectEgressGrant", // grant writer — grant-CLI tests
];

export const WARDEN_TEST_ALLOWLIST = [
  ...WARDEN_PRODUCTION_ALLOWLIST,
  ...WARDEN_TEST_ONLY_ALLOWLIST,
];

// `@typescript-eslint/no-restricted-imports` options. `allowTypeImports` is omitted (false)
// so `import type { … } from "@keel/warden"` reaches are denied too.
function restrictedImportsFor(allowImportNames) {
  return [
    "error",
    {
      paths: [
        {
          name: "@keel/warden",
          allowImportNames,
          message:
            "Import kernel↔warden data contracts from @keel/shared, not @keel/warden (ADR-0071 P1-10). " +
            "Only documented residuals are allowed in production kernel code; a new warden-library " +
            "import must be decoupled (moved to @keel/shared) first.",
        },
      ],
    },
  ];
}

/** Strict rule for production (non-test) kernel files. */
export const kernelWardenRestrictedImports = restrictedImportsFor(WARDEN_PRODUCTION_ALLOWLIST);

/** Looser rule for kernel *.test.ts files (adds the permanent fixture reaches). */
export const kernelWardenTestRestrictedImports = restrictedImportsFor(WARDEN_TEST_ALLOWLIST);
