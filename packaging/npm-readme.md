# keel

`keel-harness` is the pre-alpha npm carrier for keel, a local-first harness for governed coding
agents. It combines high autonomy with structurally enforced boundaries: the model requests actions,
while an out-of-process Warden decides what may execute and records the result.

## Status

This package is pre-alpha. Interfaces may change, performance targets remain unclaimed, and the
current threat model does not protect against same-user malware or a compromised host. Standalone
binaries are not part of this package.

Every release is built from the public [`keel-harness/keel`](https://github.com/keel-harness/keel)
repository. The npm carrier includes an exact shrinkwrap, Apache-2.0 license and notices, and the
bundled-component inventory used by the published SPDX and CycloneDX evidence.

- Project: <https://github.com/keel-harness/keel>
- Source and documentation: <https://github.com/keel-harness/keel>
- Security policy: <https://github.com/keel-harness/keel/blob/main/SECURITY.md>
- Issues: <https://github.com/keel-harness/keel/issues>
