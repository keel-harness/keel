import { it } from "vitest";

// The pinned vendored suite uses Vitest's newer `it.if(...)` spelling, while Keel's reviewed
// Vitest 3 runtime exposes the equivalent `it.runIf(...)`. Adapt only this focused matrix process;
// do not rewrite imported vendor tests or widen the root test environment.
if (!("if" in it)) {
  Object.defineProperty(it, "if", {
    configurable: true,
    value: (condition: boolean) => it.runIf(condition),
  });
}
