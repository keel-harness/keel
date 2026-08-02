import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { classifyEgressAddress } from "./egress-address-policy.js";
import {
  EGRESS_ADDRESS_EXCEPTION_LIMITS,
  EgressAddressExceptionStoreError,
  egressAddressExceptionFilePath,
  loadEgressAddressExceptionSnapshot,
} from "./egress-address-exceptions.js";

const cleanupRoots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-egress-exceptions-")));
  cleanupRoots.push(root);
  const keelHome = join(root, "keel-home");
  const workspace = join(root, "workspace");
  mkdirSync(keelHome, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  return {
    env: { KEEL_HOME: keelHome },
    keelHome,
    workspace: realpathSync(workspace),
    path: join(keelHome, "egress-address-exceptions.v1.json"),
  };
}

function validStore(workspace: string) {
  return {
    version: 1,
    workspaces: [
      {
        realpath: workspace,
        exceptions: [
          {
            host: "registry.corp.example",
            cidr: "10.20.0.0/16",
            ports: [443, 8443],
          },
          {
            host: "xn--bcher-kva.corp.example",
            cidr: "fd01:20::/32",
            ports: [443],
          },
        ],
      },
    ],
  };
}

function writeStore(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("egress address exception authority", () => {
  it("treats a missing file as an immutable deny-all snapshot", () => {
    const { env, workspace, path } = fixture();
    expect(egressAddressExceptionFilePath(env)).toBe(path);

    const snapshot = loadEgressAddressExceptionSnapshot(workspace, env);
    expect(snapshot).toMatchObject({
      revision: "none",
      workspaceRealpath: workspace,
      exceptions: [],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.exceptions)).toBe(true);
    expect(
      snapshot.allowsRestrictedAddress({
        hostname: "registry.corp.example",
        port: 443,
        address: "10.20.1.1",
        family: 4,
        classification: classifyEgressAddress("10.20.1.1"),
      }),
    ).toBe(false);
  });

  it("matches exact workspace, canonical host, port, family, and restricted CIDR", () => {
    const { env, workspace, path } = fixture();
    writeStore(path, validStore(workspace));

    const snapshot = loadEgressAddressExceptionSnapshot(workspace, env);
    expect(snapshot.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(snapshot.exceptions).toHaveLength(2);
    const allows = (hostname: string, port: number, address: string) =>
      snapshot.allowsRestrictedAddress({
        hostname,
        port,
        address,
        family: address.includes(":") ? 6 : 4,
        classification: classifyEgressAddress(address),
      });

    expect(allows("registry.corp.example", 443, "10.20.1.1")).toBe(true);
    expect(allows("registry.corp.example", 8443, "10.20.255.255")).toBe(true);
    expect(allows("registry.corp.example", 443, "10.21.0.1")).toBe(false);
    expect(allows("sub.registry.corp.example", 443, "10.20.1.1")).toBe(false);
    expect(allows("REGISTRY.CORP.EXAMPLE", 443, "10.20.1.1")).toBe(false);
    expect(allows("registry.corp.example", 80, "10.20.1.1")).toBe(false);
    expect(allows("registry.corp.example", 443, "8.8.8.8")).toBe(false);
    expect(allows("xn--bcher-kva.corp.example", 443, "fd01:20::1")).toBe(true);
  });

  it("keys authority to the trusted workspace realpath and ignores unrelated entries", () => {
    const { env, workspace, path, keelHome } = fixture();
    const other = join(keelHome, "other-workspace");
    mkdirSync(other, { mode: 0o700 });
    const otherRealpath = realpathSync(other);
    const store = validStore(workspace);
    store.workspaces.push({
      realpath: otherRealpath,
      exceptions: [{ host: "other.example", cidr: "192.0.2.0/24", ports: [443] }],
    });
    writeStore(path, store);

    const snapshot = loadEgressAddressExceptionSnapshot(workspace, env);
    expect(snapshot.exceptions.map((entry) => entry.host)).toEqual([
      "registry.corp.example",
      "xn--bcher-kva.corp.example",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("other.example");
  });

  it("retains one immutable process-lifetime snapshot after the file changes", () => {
    const { env, workspace, path } = fixture();
    writeStore(path, validStore(workspace));
    const snapshot = loadEgressAddressExceptionSnapshot(workspace, env);
    const before = snapshot.revision;

    writeStore(path, { version: 1, workspaces: [] });
    expect(snapshot.revision).toBe(before);
    expect(snapshot.exceptions).toHaveLength(2);
    expect(Object.isFrozen(snapshot.exceptions[0])).toBe(true);
    expect(Object.isFrozen(snapshot.exceptions[0]?.ports)).toBe(true);
    expect(loadEgressAddressExceptionSnapshot(workspace, env).exceptions).toEqual([]);
  });

  it.each([
    ["wrong version", { version: 2, workspaces: [] }],
    ["unknown top-level field", { version: 1, workspaces: [], extra: true }],
    [
      "unknown workspace field",
      { version: 1, workspaces: [{ realpath: "/tmp/work", exceptions: [], extra: true }] },
    ],
    [
      "unknown exception field",
      {
        version: 1,
        workspaces: [
          {
            realpath: "/tmp/work",
            exceptions: [
              { host: "private.example", cidr: "10.0.0.0/8", ports: [443], extra: true },
            ],
          },
        ],
      },
    ],
    [
      "duplicate workspace",
      {
        version: 1,
        workspaces: [
          { realpath: "/tmp/work", exceptions: [] },
          { realpath: "/tmp/work", exceptions: [] },
        ],
      },
    ],
  ])("rejects strict-schema violation: %s", (_name, value) => {
    const { env, workspace, path } = fixture();
    writeStore(path, value);
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(
      EgressAddressExceptionStoreError,
    );
  });

  it("rejects duplicate JSON keys before ordinary parsing can collapse them", () => {
    const { env, workspace, path } = fixture();
    writeFileSync(path, '{"version":1,"version":1,"workspaces":[]}\n', {
      encoding: "utf8",
      mode: 0o600,
    });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(
      /duplicate object key/u,
    );
  });

  it.each([
    ["uppercase host", "REGISTRY.CORP.EXAMPLE", "10.20.0.0/16", [443]],
    ["unicode host", "bücher.corp.example", "10.20.0.0/16", [443]],
    ["root-qualified host", "registry.corp.example.", "10.20.0.0/16", [443]],
    ["wildcard host", "*.corp.example", "10.20.0.0/16", [443]],
    ["IP-literal host", "10.20.1.1", "10.20.0.0/16", [443]],
    ["non-network CIDR", "registry.corp.example", "10.20.1.0/16", [443]],
    ["public CIDR", "registry.corp.example", "8.8.8.0/24", [443]],
    ["hard-deny CIDR", "registry.corp.example", "127.0.0.0/8", [443]],
    ["restricted CIDR containing metadata", "registry.corp.example", "100.64.0.0/10", [443]],
    ["empty ports", "registry.corp.example", "10.20.0.0/16", []],
    ["duplicate ports", "registry.corp.example", "10.20.0.0/16", [443, 443]],
    ["zero port", "registry.corp.example", "10.20.0.0/16", [0]],
    ["oversized port", "registry.corp.example", "10.20.0.0/16", [65_536]],
    ["fractional port", "registry.corp.example", "10.20.0.0/16", [443.5]],
  ])("rejects non-canonical or overbroad exception: %s", (_name, host, cidr, ports) => {
    const { env, workspace, path } = fixture();
    writeStore(path, {
      version: 1,
      workspaces: [{ realpath: workspace, exceptions: [{ host, cidr, ports }] }],
    });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(
      EgressAddressExceptionStoreError,
    );
  });

  it("rejects an exception file that is not a no-follow owner-only regular file", () => {
    const { env, workspace, path, keelHome } = fixture();
    const outside = join(dirnameOf(keelHome), "outside.json");
    writeStore(outside, validStore(workspace));
    symlinkSync(outside, path);
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(
      EgressAddressExceptionStoreError,
    );
    rmSync(path);

    writeStore(path, validStore(workspace));
    chmodSync(path, 0o644);
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(
      EgressAddressExceptionStoreError,
    );
    rmSync(path);

    mkdirSync(path, { mode: 0o700 });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(
      EgressAddressExceptionStoreError,
    );
  });

  it("rejects an insecure or symlink-aliased KEEL_HOME", () => {
    const { workspace, keelHome } = fixture();
    chmodSync(keelHome, 0o755);
    expect(() => loadEgressAddressExceptionSnapshot(workspace, { KEEL_HOME: keelHome })).toThrow(
      EgressAddressExceptionStoreError,
    );

    chmodSync(keelHome, 0o700);
    const alias = `${keelHome}-alias`;
    symlinkSync(keelHome, alias);
    expect(() => loadEgressAddressExceptionSnapshot(workspace, { KEEL_HOME: alias })).toThrow(
      EgressAddressExceptionStoreError,
    );
  });

  it("caps bytes, workspaces, exceptions, and ports before accepting authority", () => {
    const { env, workspace, path } = fixture();
    writeFileSync(path, " ".repeat(EGRESS_ADDRESS_EXCEPTION_LIMITS.maxFileBytes + 1), {
      encoding: "utf8",
      mode: 0o600,
    });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(/size limit/u);

    const tooManyWorkspaces = Array.from(
      { length: EGRESS_ADDRESS_EXCEPTION_LIMITS.maxWorkspaces + 1 },
      (_, index) => ({ realpath: `/tmp/work-${String(index)}`, exceptions: [] }),
    );
    writeStore(path, { version: 1, workspaces: tooManyWorkspaces });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(/workspace limit/u);

    const exception = {
      host: "private.example",
      cidr: "10.20.0.0/16",
      ports: [443],
    };
    writeStore(path, {
      version: 1,
      workspaces: [
        {
          realpath: workspace,
          exceptions: Array.from(
            { length: EGRESS_ADDRESS_EXCEPTION_LIMITS.maxExceptionsPerWorkspace + 1 },
            () => exception,
          ),
        },
      ],
    });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(/exception limit/u);

    writeStore(path, {
      version: 1,
      workspaces: [
        {
          realpath: workspace,
          exceptions: [
            {
              ...exception,
              ports: Array.from(
                { length: EGRESS_ADDRESS_EXCEPTION_LIMITS.maxPortsPerException + 1 },
                (_, index) => index + 1,
              ),
            },
          ],
        },
      ],
    });
    expect(() => loadEgressAddressExceptionSnapshot(workspace, env)).toThrow(/port limit/u);
  });

  it("rejects a file owned by a different effective user", () => {
    const { env, workspace, path } = fixture();
    writeStore(path, validStore(workspace));
    expect(() =>
      loadEgressAddressExceptionSnapshot(workspace, env, {
        effectiveUid: () => (process.geteuid?.() ?? 0) + 1,
      }),
    ).toThrow(/owner/u);
  });

  it("rejects path replacement between lstat and no-follow open", () => {
    const { env, workspace, path } = fixture();
    writeStore(path, validStore(workspace));
    expect(() =>
      loadEgressAddressExceptionSnapshot(workspace, env, {
        afterInitialLstat: () => {
          rmSync(path);
          writeStore(path, { version: 1, workspaces: [] });
        },
      }),
    ).toThrow(/identity changed/u);
  });

  it("never returns mutable file bytes or unrelated authority", () => {
    const { env, workspace, path } = fixture();
    writeStore(path, validStore(workspace));
    const snapshot = loadEgressAddressExceptionSnapshot(workspace, env);
    expect(JSON.stringify(snapshot)).not.toContain(readFileSync(path, "utf8"));
    expect(Object.keys(snapshot).sort()).toEqual([
      "allowsRestrictedAddress",
      "exceptions",
      "revision",
      "workspaceRealpath",
    ]);
  });
});

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
