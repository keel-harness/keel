# Releasing the npm carrier

This is the operator runbook for the first public pre-alpha npm carrier. ADR-0085 is authoritative.
The release is a staged, human-approved publication from `keel-harness/keel`; a private engineering
archive is never a publication authority. Standalone binaries remain excluded by ADR-0040.

The implementation of this runbook does not authorize a tag, GitHub Release, npm trusted-publisher
change, stage, approval, or publication. Each external mutation requires separate maintainer approval
in the public release issue.

## 1. Preflight

Stop unless all of these are true:

- `keel-harness/keel` is public and its curated initial commit passed the extracted-tree gates.
- Public `main` is clean, protected, and green at the exact intended release commit.
- Protected tag rules cover `v*`; the `npm-production` environment requires maintainer approval.
- npm's only trusted publisher for `keel-harness` names GitHub owner/repository
  `keel-harness/keel`, workflow `release.yml`, environment `npm-production`, and allows
  `npm stage publish` but not `npm publish`.
- Package access requires 2FA and disallows traditional publishing tokens. There is no `NPM_TOKEN`
  or other npm credential in repository or environment secrets.
- The operator has rechecked npm trusted/staged publishing, GitHub attestation, Node/npm, Syft, and
  action contracts against current primary documentation.
- The intended version is absent from both live and staged versions. Any ambiguous registry result
  is a stop, not permission to rerun.
- P1-007 remains named in release notes; no packaged-performance claim is made.

Record the exact public-main SHA and the successful public-main CI URL. Creating the annotated,
protected `v0.1.0` tag is a separately approved operation. The tag's peeled commit must equal both
`origin/main` and the recorded green commit.

## 2. What the workflow does

The tag-only `.github/workflows/release.yml` fails closed outside `keel-harness/keel`. It runs the
full hermetic source/security/real-sandbox gates, builds only `build/npx`, creates one npm tarball,
generates and cross-checks SPDX and CycloneDX evidence, and exercises that exact tarball on the
pinned Node 20, 22, and 24 lines. It then attests the tarball and both SBOMs, creates a draft GitHub
Release, and runs `npm stage publish` once.

The workflow does not approve the stage, call direct `npm publish`, upload standalone binaries, or
hold a long-lived npm token. A failed or indeterminate staging step is never rerun automatically.

## 3. Inspect the staged bytes

Use npm CLI 11.16.0 or the currently revalidated compatible version. List and inspect the stage:

```sh
npm stage list keel-harness --json
npm stage view <stage-id> --json
npm stage download <stage-id>
```

Download the draft GitHub Release assets into a separate empty directory. Before approval:

1. Compare the staged tarball byte-for-byte with the GitHub Release tarball.
2. Recompute SHA-256 and require the exact value recorded in `SHA256SUMS` and candidate metadata.
3. Inspect every tar member. Permit only the three JavaScript entry files, public metadata,
   `npm-shrinkwrap.json`, Apache license/notice, and the graph-derived third-party evidence.
4. Confirm package name/version, public repository/homepage/issues, `keel` command map, public
   access, Node engine, source commit, and clean-source marker.
5. Require both SBOMs to contain the exact shrinkwrap closure and all eight bundled components, with
   the tarball digest bound to the root carrier and no private/builder path.
6. Verify the GitHub attestations against the exact public repository and signer workflow:

```sh
gh attestation verify <tarball> \
  --repo keel-harness/keel \
  --signer-workflow keel-harness/keel/.github/workflows/release.yml \
  --deny-self-hosted-runners
gh attestation verify <tarball> \
  --repo keel-harness/keel \
  --signer-workflow keel-harness/keel/.github/workflows/release.yml \
  --predicate-type https://spdx.dev/Document/v2.3 \
  --deny-self-hosted-runners
gh attestation verify <tarball> \
  --repo keel-harness/keel \
  --signer-workflow keel-harness/keel/.github/workflows/release.yml \
  --predicate-type https://cyclonedx.org/bom \
  --deny-self-hosted-runners
```

If any byte, identity, packlist, SBOM, license, provenance, or attestation check disagrees, do not
approve. Record the discrepancy and use `npm stage reject <stage-id>` only with explicit owner
direction and the required 2FA proof.

## 4. Human approval

Only after the checklist above is signed off does a maintainer run:

```sh
npm stage approve <stage-id>
```

Approval prompts for 2FA and makes the staged version public. CI has no authority to perform this
step. An interrupted or unclear response is indeterminate: query `npm stage view`, `npm stage list`,
and `npm view` before taking any other action. Never repeat approval speculatively.

## 5. Live-registry oracle

After npm reports the package public, set `PACKAGE_SPEC` to the exact approved package/version and
verify the registry, not the local workspace:

```sh
PACKAGE_SPEC=keel-harness@<approved-version>
npm view "$PACKAGE_SPEC" name version dist.tarball dist.integrity --json
npm pack "$PACKAGE_SPEC" --pack-destination <empty-download-directory>
pnpm dlx "$PACKAGE_SPEC" --version
```

Require the live tarball to equal the staged and draft-release tarballs byte-for-byte. Verify npm
provenance and registry signatures in a fresh lockfile-backed install with `npm audit signatures`.
Repeat the fresh global/dlx version, doctor, replay, Warden, sandbox, and pre-trust `.env` probes from
`packaging/smoke-release-carrier.sh`. Reverify GitHub attestations and every draft-release asset.

Only after those checks pass:

- publish the already-reviewed draft GitHub Release;
- replace README's source-only preparation text with the tested install command and npm badge;
- record exact npm, release, tag, public-main CI, provenance, attestation, and carrier evidence; and
- close the placeholder-era release gate without claiming P1-007, binaries, stable API, or public
  alpha.

## 6. Failure handling

- Before staging: fix through a new reviewed commit and new green public-main/tag decision.
- Draft created, no stage: leave it draft, reconcile why staging failed, and stop. Do not rerun.
- Stage exists but inspection fails: do not approve; preserve evidence and request an explicit reject
  decision.
- Approval/publication result unclear: inspect registry and stage state before any action.
- Live bytes differ: stop launch work, preserve all copies/digests, and treat it as a release
  integrity incident.
- Any token, direct-publish path, self-hosted runner, unpinned action, non-main tag, missing
  attestation, or binary asset is a hard release failure.
