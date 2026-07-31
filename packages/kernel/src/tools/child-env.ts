/**
 * The minimal environment handed to a harness-INTERNAL child process — the ripgrep `search` invocation
 * and the python syntax check. It carries only what such a child needs to run (`PATH` to exec, a stable
 * `C` locale for deterministic output) and NONE of the host secrets the harness holds in `process.env`
 * (e.g. the resolved provider API key). These helpers run fixed argv the model did not ask to run with
 * secrets, so least privilege says don't export the keychain into them (EXEC-2). `PATH` is always
 * present (empty string, never `undefined`) so the child can still resolve binaries.
 *
 * This is NOT used for the `bash` tool's shell, which builds its own minimal env at the session level.
 */
export function minimalChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: env["PATH"] ?? "", LC_ALL: "C", LANG: "C" };
}

/** Restore the host's original NODE_ENV for a process spawned by the release npx Kernel.
 *
 * The npx launcher keeps NODE_ENV=production for the Kernel lifetime so React and its reconciler
 * stay on their production paths. User-affecting children must instead receive the host value and
 * none of the launcher-only sentinels. Unmanaged source/dev and standalone-binary processes are a
 * strict no-op. See ADR-0083. */
export function restoreHostNodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env["KEEL_HOST_NODE_ENV_MANAGED"] !== "1") return env;

  // Object.fromEntries uses CreateDataProperty, so even the valid environment key "__proto__"
  // remains an own data property. Assignment into {} would invoke Object.prototype.__proto__'s
  // setter and silently drop that key, violating this helper's exact-key contract.
  const restored: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        key !== "NODE_ENV" && key !== "KEEL_HOST_NODE_ENV" && key !== "KEEL_HOST_NODE_ENV_MANAGED",
    ),
  );
  const hostNodeEnv = env["KEEL_HOST_NODE_ENV"];
  if (hostNodeEnv !== undefined) restored["NODE_ENV"] = hostNodeEnv;
  return restored;
}

/** Merge a child-specific environment without letting that later layer rewrite the launcher's
 * captured NODE_ENV state. The sentinel keys are internal ownership metadata, not caller
 * configuration: when the base environment is launcher-managed, its captured state is restored
 * after the ordinary override merge and before the sentinels are stripped. */
export function mergeAndRestoreHostNodeEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrideEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged = { ...baseEnv, ...overrideEnv };
  if (baseEnv["KEEL_HOST_NODE_ENV_MANAGED"] === "1") {
    merged["KEEL_HOST_NODE_ENV_MANAGED"] = "1";
    const hostNodeEnv = baseEnv["KEEL_HOST_NODE_ENV"];
    if (hostNodeEnv === undefined) delete merged["KEEL_HOST_NODE_ENV"];
    else merged["KEEL_HOST_NODE_ENV"] = hostNodeEnv;
  }
  return restoreHostNodeEnv(merged);
}
