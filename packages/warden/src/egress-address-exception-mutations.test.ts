import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  addEgressAddressException,
  egressAddressExceptionFilePath,
  listEgressAddressExceptions,
  loadEgressAddressExceptionSnapshot,
  removeEgressAddressException,
} from "./egress-address-exceptions.js";

const cleanupRoots: string[] = [];

function fixture(options: { readonly createHome?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-egress-exception-mutation-")));
  cleanupRoots.push(root);
  const keelHome = join(root, "keel-home");
  const workspace = join(root, "workspace");
  const otherWorkspace = join(root, "other-workspace");
  if (options.createHome !== false) mkdirSync(keelHome, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(otherWorkspace, { mode: 0o700 });
  return {
    env: { KEEL_HOME: keelHome },
    keelHome,
    workspace: realpathSync(workspace),
    otherWorkspace: realpathSync(otherWorkspace),
    path: join(keelHome, "egress-address-exceptions.v1.json"),
  };
}

const ENTRY = {
  host: "registry.corp.example",
  cidr: "10.20.0.0/16",
  ports: [8443, 443],
} as const;

function writeStore(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("egress address exception mutations", () => {
  it("creates an owner-only home and durable strict store, then lists only the selected workspace", () => {
    const { env, keelHome, workspace, path } = fixture({ createHome: false });

    const result = addEgressAddressException(workspace, ENTRY, env);

    expect(result).toMatchObject({ status: "added", durability: "durable" });
    expect(lstatSync(keelHome).mode & 0o777).toBe(0o700);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(listEgressAddressExceptions(workspace, env)).toEqual([{ ...ENTRY, ports: [443, 8443] }]);
    expect(loadEgressAddressExceptionSnapshot(workspace, env).revision).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              realpath: workspace,
              exceptions: [{ ...ENTRY, ports: [443, 8443] }],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("treats exact duplicate adds and misses as no-ops, then removes the exact tuple", () => {
    const { env, workspace, path } = fixture();
    expect(addEgressAddressException(workspace, ENTRY, env).status).toBe("added");
    const installed = readFileSync(path, "utf8");

    expect(
      addEgressAddressException(workspace, { ...ENTRY, ports: [443, 8443] }, env),
    ).toMatchObject({ status: "already-present" });
    expect(readFileSync(path, "utf8")).toBe(installed);
    expect(removeEgressAddressException(workspace, { ...ENTRY, ports: [443] }, env)).toMatchObject({
      status: "not-found",
    });
    expect(readFileSync(path, "utf8")).toBe(installed);

    expect(removeEgressAddressException(workspace, ENTRY, env)).toMatchObject({
      status: "removed",
      durability: "durable",
    });
    expect(listEgressAddressExceptions(workspace, env)).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, workspaces: [] });
  });

  it("preserves unrelated workspace authority while sorting output deterministically", () => {
    const { env, workspace, otherWorkspace, path } = fixture();
    writeStore(path, {
      version: 1,
      workspaces: [
        {
          realpath: otherWorkspace,
          exceptions: [{ host: "z.example", cidr: "192.0.2.0/24", ports: [8443] }],
        },
      ],
    });

    addEgressAddressException(
      workspace,
      { host: "b.example", cidr: "10.30.0.0/16", ports: [9443] },
      env,
    );
    addEgressAddressException(
      workspace,
      { host: "a.example", cidr: "10.20.0.0/16", ports: [443] },
      env,
    );

    expect(listEgressAddressExceptions(workspace, env).map((entry) => entry.host)).toEqual([
      "a.example",
      "b.example",
    ]);
    expect(listEgressAddressExceptions(otherWorkspace, env)).toEqual([
      { host: "z.example", cidr: "192.0.2.0/24", ports: [8443] },
    ]);
  });

  it("fails closed on lock contention without changing authority", () => {
    const { env, workspace, path } = fixture();
    writeFileSync(`${path}.lock`, `${JSON.stringify({ pid: process.pid, path })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    expect(() => addEgressAddressException(workspace, ENTRY, env)).toThrow(/lock is held/u);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("never overwrites malformed, insecure, or symlinked existing authority", () => {
    const { env, workspace, path, keelHome } = fixture();
    writeFileSync(path, "{", { encoding: "utf8", mode: 0o600 });
    expect(() => addEgressAddressException(workspace, ENTRY, env)).toThrow(/JSON/u);
    expect(readFileSync(path, "utf8")).toBe("{");

    writeStore(path, { version: 1, workspaces: [] });
    chmodSync(path, 0o644);
    expect(() => addEgressAddressException(workspace, ENTRY, env)).toThrow(/0600/u);
    rmSync(path);

    const outside = join(dirname(keelHome), "outside.json");
    writeStore(outside, { version: 1, workspaces: [] });
    symlinkSync(outside, path);
    expect(() => addEgressAddressException(workspace, ENTRY, env)).toThrow(/no-follow/u);
    expect(readFileSync(outside, "utf8")).toContain('"workspaces": []');
  });

  it("rejects insecure or symlinked existing homes instead of silently repairing them", () => {
    const { env, workspace, keelHome } = fixture();
    chmodSync(keelHome, 0o755);
    expect(() => addEgressAddressException(workspace, ENTRY, env)).toThrow(/0700/u);
    expect(lstatSync(keelHome).mode & 0o777).toBe(0o755);

    chmodSync(keelHome, 0o700);
    const alias = `${keelHome}-alias`;
    symlinkSync(keelHome, alias);
    expect(() => addEgressAddressException(workspace, ENTRY, { KEEL_HOME: alias })).toThrow(
      /0700/u,
    );
  });

  it("revalidates the authoritative bytes after replacement", () => {
    const { env, workspace, path } = fixture();
    expect(() =>
      addEgressAddressException(workspace, ENTRY, env, {
        afterWriteBeforeValidation: () => chmodSync(path, 0o644),
      }),
    ).toThrow(/0600/u);
  });

  it("rejects invalid proposed entries and non-directory workspaces before writing", () => {
    const { env, workspace, keelHome } = fixture();
    expect(() =>
      addEgressAddressException(
        workspace,
        { host: "REGISTRY.CORP.EXAMPLE", cidr: ENTRY.cidr, ports: [443] },
        env,
      ),
    ).toThrow(/canonical exact ASCII DNS name/u);

    const fileWorkspace = join(keelHome, "not-a-workspace");
    writeFileSync(fileWorkspace, "x", { mode: 0o600 });
    expect(() => addEgressAddressException(fileWorkspace, ENTRY, env)).toThrow(/directory/u);
    expect(() => readFileSync(egressAddressExceptionFilePath(env), "utf8")).toThrow();
  });
});
