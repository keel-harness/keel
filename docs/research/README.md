# Research archive

**These are dated measurements and source records, not current documentation.**

Each item here backs a claim or a decision made elsewhere. They are reproducible on purpose: a
reader who doubts a number in `MASTER_SPEC.md` or an ADR should be able to re-run the spike rather
than take the number on trust.

| Item | What it is |
| --- | --- |
| [source-ledger.md](source-ledger.md) | Every external source that shaped the spec, with an access date, a confidence rating, and a revisit date. |
| [policy-engine-spike/](policy-engine-spike/) | The reproducible benchmark harness behind ADR-0004 (`opa-wasm` vs. regorus), including `results.json`. |
| [srt-vendoring-gate-2026-06-24.md](srt-vendoring-gate-2026-06-24.md) | The vendoring review that gated ADR-0005. |
| [iana-snapshots/](iana-snapshots/) | Pinned IANA special-purpose address registries used by the egress address classifier. |

The IANA snapshots are the exception to "archive": they are **live inputs**. The egress address
classifier is generated from these exact pinned CSVs by
[`tools/generate-egress-address-policy.mjs`](../../tools/generate-egress-address-policy.mjs), so
replacing them changes enforcement behavior. Runtime code never downloads or refreshes registry
data. Treat them as data under review, not as history; see
[iana-snapshots/README.md](iana-snapshots/README.md) for the refresh rules.
