---
name: debug-failing-test
description: Use when a test is failing or flaky and you need a disciplined path from red to green without weakening the test.
---

# Debugging a failing test

1. **Reproduce** — run the single failing test in isolation; read the *full* output, not just the
   last line. Capture the exact assertion and values.
2. **Locate, do not guess** — read the code under test and the test itself before forming a theory.
   Do not infer behavior from names.
3. **Form one hypothesis** — state what you believe is wrong and what evidence would confirm or refute
   it. Add a minimal probe (a focused assertion/log) rather than scattering changes.
4. **Fix the root cause** — change the code or, if the test's premise is wrong, fix the test and say
   which. Never loosen, skip, or delete a test to get green.
5. **Re-verify against the spec** — run the test again; then run the surrounding suite to catch
   regressions. Compare results to the requirement, not to your own change.
6. **Flaky?** — a non-deterministic test is a real bug (ordering, timing, shared state); fix the cause,
   never quarantine.
