/**
 * Sanitized deterministic carrier of the final external Click replay that motivated ADR-0089.
 * This fixture contains no provider transcript or private path. It preserves only the exact command
 * boundary, frozen public commit, and strict three-file oracle needed for controller regression tests.
 */
export const R26_PROCESS_RUN_ORACLE = {
  sourceArtifact:
    "artifacts/tui-dogfood/20260802T201841-0400/session-logs/39-r26-final-regression-no-go.md",
  externalRepository: "pallets/click",
  externalCommit: "00e592cea702e0b2caa0dee42489fdb1c22cd845",
  reviewedWrapper: "PYTHONPATH=src python3 -m pytest -q tests/test_termui.py",
  directArgv: [
    "python3",
    "-m",
    "pytest",
    "-o",
    "pythonpath=src",
    "-q",
    "tests/test_termui.py",
  ],
  alreadyChangedFiles: ["src/click/termui.py", "tests/test_termui.py"],
  requiredThirdFile: "CHANGES.md",
  expectedSummary: "223 passed, 23 skipped",
} as const;
