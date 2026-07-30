import * as fc from "fast-check";
// Deterministic property-test seed so a CI failure is replayable locally. Override
// via FAST_CHECK_SEED to rotate (e.g. a scheduled fuzz job) or to reproduce a
// reported seed. numRuns mirrors the assertRoundTrips default. See ADR-0020.
const seed = process.env.FAST_CHECK_SEED ? Number(process.env.FAST_CHECK_SEED) : 424242;
fc.configureGlobal({ seed, numRuns: 200 });
