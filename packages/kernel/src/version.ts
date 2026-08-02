/**
 * The single source of truth for keel's version string.
 *
 * It lives in code (not read from `package.json` at runtime) so it survives `bun --compile`, where
 * the manifest is not on disk in the self-contained binary (Epic 1.10 / ADR-0009). The packaging
 * build stamps the publishable manifest from this constant, and `version.test.ts` is a drift guard
 * asserting it equals the kernel `package.json` version.
 */
export const KEEL_VERSION = "0.1.1";
