/**
 * Canonical set of shell command NAMES that only OBSERVE state in their base form (no write/exec in
 * the bare invocation). This is the single source of truth shared by the two subsystems that reason
 * about read-only-ness, so they cannot silently drift apart (they previously did — F-3 RC1):
 *
 *  - the kernel's completion-verification gate (`verify-gate.ts`) uses it to decide whether the model
 *    merely *inspected* its work vs actually ran it — a conservative "did nothing execute?" heuristic;
 *  - the warden's side-effect classifier (`@keel/warden` `policy.ts`) is the AUTHORITATIVE security
 *    boundary and additionally reasons about ARGUMENTS: a name here is eligible for allow-without-review
 *    only in a form the classifier proves has no write/exec (e.g. `sort` allows, but `sort -o FILE`
 *    reviews). A drift-guard test (`policy.test.ts`) asserts the warden allows every name's safe form
 *    except a small documented exclusion set (`env`/`printenv` are secret-read surfaces → POL-001;
 *    `ll` is a shell alias, not a real binary).
 *
 * Membership means "read-only in the base form" — it is NOT itself an allow decision. The warden always
 * applies its own argument-level modeling; this set never widens enforcement on its own.
 */
export const READ_ONLY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "cat",
  "cd",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ls",
  "ll",
  "echo",
  "printf",
  "pwd",
  "head",
  "tail",
  "wc",
  "find",
  "which",
  "type",
  "file",
  "stat",
  "env",
  "printenv",
  "tree",
  "dirname",
  "basename",
  "realpath",
  "readlink",
  "cut",
  "sort",
  "uniq",
  "diff",
  "cmp",
  "true",
  "false",
  "test",
  "date",
]);
