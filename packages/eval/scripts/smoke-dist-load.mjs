const { stdout } = await import("node:process");
const { assertSubsetIntegrity } = await import("../dist/index.js");

const { catalog, tuned, smoke, heldout } = assertSubsetIntegrity();

const checks = [
  ["catalog.taskCount", catalog.taskCount, 89],
  ["tuned.taskCount", tuned.taskCount, 25],
  ["smoke.taskCount", smoke.taskCount, 5],
  ["heldout.taskCount", heldout.taskCount, 10],
];

for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    throw new Error(`${name} ${String(actual)} != ${String(expected)}`);
  }
}

stdout.write(
  `eval dist smoke ok: catalog=${String(catalog.taskCount)} tuned=${String(
    tuned.taskCount,
  )} smoke=${String(smoke.taskCount)} heldout=${String(heldout.taskCount)}\n`,
);
