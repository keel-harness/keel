# ADR-0085 — Public npm release authority and artifact flow

**Status:** Accepted for Epic 3.21 by explicit owner authorization on 2026-07-30.

**Date:** 2026-07-30

**Amended:** 2026-08-02 for the owner-selected `0.1.1` release target. The authority model is
unchanged.

**Amends:** ADR-0040's deferred npm-publication decision. The standalone-binary licensing hold is
unchanged.

**Relates to:** ADR-0009, ADR-0040, ADR-0082, `MASTER_SPEC.md` §5.3 and §9, the public release tests,
and the curated one-commit public repository.

## Context

Keel has a mechanically proven npm carrier, but the registry currently contains only the
`keel-harness@0.0.1` name-reservation placeholder. The real package must bind one public source
commit to one inspected tarball, complete license and SBOM evidence, npm provenance, and a human
approval. Publishing from any repository other than the public source would prevent npm's automatic
public-repository provenance and would bind the package to the wrong source repository.

The release path is security-sensitive. A conventional long-lived npm token would outlive a run and
could publish directly. A conventional CI publish would also make a version public before a
maintainer inspected the exact staged bytes. npm now supports GitHub Actions OIDC trusted publishers
whose allowed commands can be limited to `npm stage publish`; staged packages remain unavailable
until a maintainer approves them with 2FA.

The carrier mixes two dependency shapes:

- exact external and optional npm dependencies installed by the package manager; and
- permissively licensed packages and vendored SRT bytes bundled into the generated JavaScript and
  already recorded by ADR-0040's Bun-metafile-derived component inventory.

An npm lockfile or ordinary filesystem scanner sees the first shape but cannot infer the second from
minified/bundled JavaScript. An SBOM that silently omitted those bundled components would be false.

`0.1.0` was staged but never approved or made public. The owner selected `0.1.1` for the current
release after Epic 3.22. The existing `0.1.0` stage remains a separate human-controlled object: it
must be inspected and
explicitly rejected with 2FA before a `0.1.1` release tag is created. Its draft release and protected
tag are retained until that decision; they are not publication evidence.

## Decision

### 1. Publish only from the curated public repository

The first intended public carrier is `keel-harness@0.1.1`. It may be staged only from the public
`keel-harness/keel` repository after a fresh one-commit public seed has passed the extracted-tree
gates and public-main CI is green. A separate development workspace may implement and test the
release mechanism, but it is not a publication authority.

The release ref is a protected annotated `v0.1.1` tag whose peeled commit is the exact green public
`main` commit. The runtime constant, source-workspace manifest versions, generated carrier version,
tag, tarball filename, and candidate metadata must all agree. An existing live registry version, a
lightweight tag, a dirty source tree, a non-main tag commit, or any mismatch fails before artifact
construction. Existing staged versions are a separate human preflight because the read-only
candidate job has no registry authority: the operator must prove none exists before creating the tag,
and an ambiguous result stops release work. For this release, that proof includes an explicit final
state for the prior `0.1.0` stage; merely observing that `0.1.0` is absent from the public registry is
not sufficient.

### 2. One stage-only OIDC authority

The package has exactly one npm trusted publisher:

- GitHub owner/repository: `keel-harness/keel`;
- workflow filename: `release.yml`;
- environment: `npm-production`;
- allowed action: `npm stage publish` only.

The workflow runs only on GitHub-hosted runners. Candidate construction has `contents: read` only.
One immutable GitHub workflow artifact carries the exact candidate into three downstream jobs:

- the attestation job has `contents: read`, `id-token: write`, `attestations: write`, and
  `artifact-metadata: write`, but cannot create a release or stage a package;
- the draft job has `contents: write`, but no OIDC or attestation authority; and
- the protected `npm-production` stage job has `contents: read` and `id-token: write`, but no
  repository-write or attestation authority.

Every upload/download/action is SHA-pinned. Each downstream job rechecks the candidate checksum
after download. The workflow contains no `NPM_TOKEN`, npm automation token, classic token, or publish
credential. Once the trusted publisher has been proven, package settings require 2FA and disallow
traditional publishing tokens.

CI never approves, rejects, unpublishes, changes a dist-tag, or runs `npm publish`. It stages the
already-built tarball and stops. A maintainer downloads and inspects the staged tarball, compares its
digest to the workflow artifact, and separately approves it with 2FA. No automatic publication retry
is permitted; an ambiguous or partial attempt stops for reconciliation.

### 3. Build and pack the npm carrier exactly once

The release job pins Node `24.18.1` (which ships npm `11.16.0`), pnpm, Bun, and every GitHub Action.
It builds only `build/npx`; `build/bin/keel-*` is neither constructed as a release input nor uploaded.
The generated package carries a complete public repository/homepage/issues identity, public access,
the supported Node engine, exact command map, Apache-2.0 license, source commit, and clean-source
marker.

The candidate builder resolves one npm shrinkwrap for the generated manifest, installs it with
scripts disabled for inspection/SBOM evidence, and invokes `npm pack` once. It rejects unexpected
packlist members, source-mode loaders, private paths, standalone binaries, version drift, or a second
tarball. The resulting tarball SHA-256 is the identity used by the checksum manifest, candidate
metadata, GitHub attestations, staged review, and live-registry verification.

### 4. Generate complete SPDX and CycloneDX evidence through Syft

Syft `1.49.0` is the selected SBOM engine. It is Apache-2.0 licensed, predates the seven-day
minimum-release-age boundary at implementation time, emits SPDX and CycloneDX from one native
inventory, and is downloaded only as an immutable release asset whose published SHA-256 is verified
before execution.

The candidate builder asks Syft for its native JSON inventory over the generated carrier plus exact
npm shrinkwrap/install tree. Before standards serialization, a narrow deterministic bridge adds
exactly the components from `THIRD_PARTY_LICENSES/components.json` that are absent because their
bytes were bundled. The bridge adds package identity, version, SPDX license, package URL, evidence
location, and a root dependency relationship; it neither parses nor serializes SPDX or CycloneDX.
Syft then serializes the augmented native inventory independently to SPDX JSON and CycloneDX JSON.

Tests require the root carrier, every lock-resolved external/optional dependency, and every
Bun-metafile component in both outputs. Unexpected, duplicate, unsupported-license, dev-only,
builder-path, or missing components fail closed. Normalized document identifiers/timestamps are
derived from the source commit and tarball digest so repeated generation is stable. The original
Syft native inventory is retained as diagnostic evidence but is not a public release asset.

### 5. Attest, draft, then stage

After all required gates pass, four chained jobs:

1. construct, smoke, and upload one immutable release-candidate artifact under read-only authority;
2. generate GitHub build provenance plus separate SPDX and CycloneDX attestations for the exact
   tarball;
3. create a draft GitHub Release containing the tarball, checksum, candidate metadata, both SBOMs,
   license inventory, and pre-alpha notes; and
4. under the protected environment, run `npm stage publish` against that exact tarball.

Job permissions are least-privilege and job-local: `contents: read` for verification/candidate,
attestation authority only in the attest job, `contents: write` only in the draft job, and stage OIDC
only in the protected stage job. Pull requests, forks, branches, lightweight/non-exact tags, dirty
checkouts, non-main tag commits, and other repositories cannot reach the staging step. Tag-protection
and protected-environment rules are external operator evidence and must pass the preflight; the
workflow does not falsely infer those settings from its own file.

### 6. Treat post-publication checks as release gates, not implementation claims

The operator verifies the staged and live registry tarballs byte-for-byte, npm provenance and
registry signatures, GitHub attestations constrained to `keel-harness/keel` and `release.yml`, fresh
pnpm global and `pnpm dlx` installs, version, doctor, replay, Warden enforcement, and the release
asset/checksum/SBOM set. Public install commands and the npm badge land only after that live proof.

Epic 3.21 implementation proves the mechanism without requesting OIDC, creating a tag/release,
staging a package, or changing npm/GitHub settings. Those operations remain separately authorized.

## Consequences

- The first package has a human proof-of-presence boundary without retaining a publish token.
- npm's provenance and GitHub's attestations complement each other; neither substitutes for staged
  byte inspection or Keel's own checksum/component closure.
- The npm shrinkwrap becomes part of the published carrier and fixes its transitive install graph.
- Syft remains an external pinned release tool rather than a runtime or workspace dependency.
- The repository owns only the small bridge from its already-reviewed bundle graph to Syft's native
  inventory; Syft owns SPDX/CycloneDX serialization.
- Standalone Bun binaries remain non-release-eligible under ADR-0040. This ADR does not sign,
  publish, or imply license completeness for them.
- P1-007 remains a named failed strict RSS gate. The owner accepted it as a residual risk for the
  `0.1.0` pre-alpha candidate on 2026-07-30 and separately for the `0.1.1` pre-alpha candidate on
  2026-08-02. Each acceptance is version-scoped and does not transfer to another release. Release
  issue #49 records the current decision; the gate and threshold remain unchanged, and the release
  carries no packaged-performance claim.

## Rejected alternatives

1. **Publish directly with `npm publish`.** Rejected because CI would make the version public before
   human byte inspection and 2FA approval.
2. **Use a long-lived npm token.** Rejected because the credential outlives one workflow and can be
   stolen or reused.
3. **Publish from a different source repository.** Rejected because public-repository provenance
   would be absent and registry source identity would be wrong.
4. **Use `npm sbom` or unaugmented Syft output alone.** Rejected because package-manager evidence
   does not identify Keel's Bun-bundled dependency bytes.
5. **Hand-write SPDX and CycloneDX serializers.** Rejected because standards implementation is not
   Keel's product and partial output would create false assurance.
6. **Upload the standalone binaries beside the npm package.** Rejected by ADR-0040's licensing hold.
7. **Rebuild after review or before staging.** Rejected because reviewed and published bytes could
   diverge.

## Revisit triggers

Revisit before release if npm removes or materially changes trusted/staged publishing, GitHub OIDC
or attestations cannot bind the intended public workflow, Syft cannot preserve the complete merged
inventory in both formats, the public repository/workflow/environment identity changes, or the
standalone-binary licensing hold is reconsidered.
