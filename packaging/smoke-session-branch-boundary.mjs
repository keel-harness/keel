import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const keelArg = process.argv[2];
assert.ok(keelArg, "usage: node smoke-session-branch-boundary.mjs <absolute-keel-bin>");
const keelBin = resolve(keelArg);
assert.ok(isAbsolute(keelBin), "installed keel bin must resolve to an absolute path");
assert.ok(existsSync(keelBin), `installed keel bin is missing: ${keelBin}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-session-branch-boundary-")));
const workspace = join(root, "workspace");
const keelHome = join(root, "keel-home");
const sessions = join(keelHome, "sessions");
const sourceId = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const sourcePath = join(sessions, `${sourceId}.jsonl`);
const timestamp = "2026-07-29T00:00:00.000Z";

function fail(label, result) {
  throw new Error(
    [
      `${label} failed`,
      `status: ${String(result.status)}`,
      `signal: ${String(result.signal)}`,
      `error: ${String(result.error ?? "(none)")}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join("\n"),
  );
}

function runBranch(index) {
  return spawnSync(keelBin, ["sessions", "branch", sourceId, index], {
    cwd: workspace,
    env: { ...process.env, KEEL_HOME: keelHome, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });
}

function ledgerNames() {
  return readdirSync(sessions)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

function readLedger(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

try {
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  writeFileSync(
    sourcePath,
    [
      {
        type: "session_meta",
        v: 1,
        id: sourceId,
        createdAt: timestamp,
        cwd: workspace,
      },
      { type: "user", v: 1, ts: timestamp, content: "first" },
      { type: "user", v: 1, ts: timestamp, content: "second" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    { mode: 0o600 },
  );

  const valid = runBranch("2");
  if (valid.error !== undefined || valid.status !== 0) fail("exact-end branch", valid);
  assert.match(
    valid.stdout,
    new RegExp(`branched ${sourceId}@2 -> ses_`),
    "missing success receipt",
  );

  const afterValid = ledgerNames();
  assert.equal(afterValid.length, 2, "exact-end branch must create exactly one child");
  const childName = afterValid.find((name) => name !== `${sourceId}.jsonl`);
  assert.ok(childName, "exact-end branch did not create a distinct child ledger");
  const child = readLedger(join(sessions, childName));
  assert.deepEqual(child[0].parent, { id: sourceId, atIndex: 2 });
  assert.deepEqual(
    child.slice(1).map((event) => event.content),
    ["first", "second"],
    "exact-end child must copy the complete source prefix",
  );

  const invalid = runBranch("3");
  if (invalid.error !== undefined) fail("one-past branch", invalid);
  assert.equal(invalid.status, 1, "one-past branch must exit nonzero");
  assert.match(invalid.stdout, /out of range; expected 0\.\.2/u);
  assert.deepEqual(ledgerNames(), afterValid, "one-past branch must not create a child artifact");
  assert.deepEqual(
    readLedger(sourcePath)
      .slice(1)
      .map((event) => event.content),
    ["first", "second"],
    "branching must not mutate the source ledger",
  );

  process.stdout.write("installed session branch boundary smoke passed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
