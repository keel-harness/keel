import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";

function assertCanonicalDirectory(stat: Stats, message: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
}

export interface WardenSandboxTempRoot {
  readonly path: string;
  readonly runtimeEnv: Readonly<{ CLAUDE_CODE_TMPDIR: string }>;
  readonly declaredTempRoots: readonly string[];
  assertOwned(): void;
  cleanup(): void;
}

export interface WardenSandboxTempRootOptions {
  readonly parentDir?: string;
  /** Accepted so callers/tests can make the trust boundary explicit. Inherited temp authority is
   * deliberately ignored; only `parentDir` supplied by trusted warden code can change placement. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Creates the sole general-purpose temporary write root delegated to a warden sandbox runtime. */
export function createWardenSandboxTempRoot(
  options: WardenSandboxTempRootOptions = {},
): WardenSandboxTempRoot {
  void options.env;
  // `/tmp` canonicalizes to `/private/tmp` on macOS and remains `/tmp` on Linux. Resolving it here
  // avoids inheriting caller-controlled temp variables while keeping one platform-neutral path.
  const parent = realpathSync(options.parentDir ?? "/tmp");
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("warden sandbox temporary parent must be a canonical directory");
  }

  const created = mkdtempSync(join(parent, "keel-sandbox-"));
  const path = realpathSync(created);
  chmodSync(path, 0o700);
  const identity = lstatSync(path);
  assertCanonicalDirectory(
    identity,
    "warden sandbox temporary root was not created as a directory",
  );
  const expectedOwner = { uid: identity.uid, gid: identity.gid, mode: identity.mode & 0o777 };

  const currentIdentity = () => {
    let current;
    try {
      current = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("warden sandbox temporary root is missing");
      }
      throw error;
    }
    assertCanonicalDirectory(current, "warden sandbox temporary root identity changed");
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("warden sandbox temporary root identity changed");
    }
    if (
      current.uid !== expectedOwner.uid ||
      current.gid !== expectedOwner.gid ||
      (current.mode & 0o777) !== 0o700 ||
      expectedOwner.mode !== 0o700
    ) {
      throw new Error("warden sandbox temporary root ownership or permissions changed");
    }
    return current;
  };

  const assertOwned = (): void => {
    currentIdentity();
  };

  const cleanup = (): void => {
    let current;
    try {
      current = lstatSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
    if (current.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
    currentIdentity();
    rmSync(path, { recursive: true, force: false });
  };

  return Object.freeze({
    path,
    runtimeEnv: Object.freeze({ CLAUDE_CODE_TMPDIR: path }),
    declaredTempRoots: Object.freeze([path]),
    assertOwned,
    cleanup,
  });
}
