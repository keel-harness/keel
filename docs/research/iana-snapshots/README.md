# Reviewed IANA address-policy snapshots

Keel's egress classifier is generated from the dated, repository-pinned CSV files in
this directory. Runtime code never downloads or refreshes registry data.

The `2026-08-01` snapshot contains the IANA IPv4 and IPv6 special-purpose registries,
the IPv4 address-space registry, and the IPv6 global-unicast assignment registry. The
generator pins each source URL and SHA-256 digest in both its source and generated
artifact.

To verify deterministic regeneration:

```sh
node tools/generate-egress-address-policy.mjs --check
```

Refreshing a snapshot is a security-policy change. It requires a new dated directory,
review of the upstream registry diff and every resulting classification change, updated
digests, boundary/adversarial tests, and normal human review. Do not automate registry
refreshes and do not fetch registry data during installation, startup, or request
handling.
