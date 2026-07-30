import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyFromSecretKey } from "@keel/shared";
import { loadOrCreateAuditCheckpointKey } from "./checkpoint-key.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-checkpoint-key-"));
});

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

function storedKeyPayload(secretKey: Uint8Array): string {
  return `${JSON.stringify(
    {
      version: "keel-audit-checkpoint-key/v1",
      secretKey: Buffer.from(secretKey).toString("base64"),
      publicKey: Buffer.from(publicKeyFromSecretKey(secretKey)).toString("base64"),
    },
    null,
    2,
  )}\n`;
}

describe("audit checkpoint key store", () => {
  it("creates a 0600 file-backed key and reloads the same key", () => {
    const first = loadOrCreateAuditCheckpointKey(dir);
    const second = loadOrCreateAuditCheckpointKey(dir);

    expect(Buffer.from(second.secretKey).equals(Buffer.from(first.secretKey))).toBe(true);
    expect(Buffer.from(second.publicKey).equals(Buffer.from(first.publicKey))).toBe(true);
    expect(
      Buffer.from(publicKeyFromSecretKey(first.secretKey)).equals(Buffer.from(first.publicKey)),
    ).toBe(true);
    expect(first.mode & 0o077).toBe(0);
  });

  it("fails closed when the stored public key no longer matches the secret key", () => {
    const created = loadOrCreateAuditCheckpointKey(dir);
    const raw = JSON.parse(readFileSync(created.path, "utf8")) as { publicKey: string };
    raw.publicKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    writeFileSync(created.path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    chmodSync(created.path, 0o600);

    expect(() => loadOrCreateAuditCheckpointKey(dir)).toThrow(/public key mismatch/i);
  });

  it("fails closed when the key file mode is group/world accessible", () => {
    const created = loadOrCreateAuditCheckpointKey(dir);
    chmodSync(created.path, 0o644);

    expect(() => loadOrCreateAuditCheckpointKey(dir)).toThrow(/too permissive/i);
  });

  it("fails closed when stored key material is not 32 bytes", () => {
    const keyPath = join(dir, "checkpoint-key.json");
    writeFileSync(
      keyPath,
      `${JSON.stringify(
        {
          version: "keel-audit-checkpoint-key/v1",
          secretKey: Buffer.from(new Uint8Array(31)).toString("base64"),
          publicKey: Buffer.from(new Uint8Array(32)).toString("base64"),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    expect(() => loadOrCreateAuditCheckpointKey(dir)).toThrow(/secretKey must decode to 32 bytes/);
  });

  it("loads a concurrently-created key if exclusive create loses the race", async () => {
    const secretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const payload = storedKeyPayload(secretKey);

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const mockedOpenSync = ((
        pathLike: Parameters<typeof actual.openSync>[0],
        flags: Parameters<typeof actual.openSync>[1],
        mode?: Parameters<typeof actual.openSync>[2],
      ): number => {
        if (String(pathLike).endsWith("checkpoint-key.json") && flags === "wx") {
          actual.writeFileSync(pathLike, payload, { mode: 0o600 });
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
        return actual.openSync(pathLike, flags, mode);
      }) as typeof actual.openSync;
      return {
        ...actual,
        existsSync: (pathLike: Parameters<typeof actual.existsSync>[0]) =>
          String(pathLike).endsWith("checkpoint-key.json") ? false : actual.existsSync(pathLike),
        openSync: mockedOpenSync,
      };
    });

    const { loadOrCreateAuditCheckpointKey: loadWithRace } = await import("./checkpoint-key.js");
    const loaded = loadWithRace(dir);

    expect(Buffer.from(loaded.secretKey).equals(Buffer.from(secretKey))).toBe(true);
    expect(loaded.mode & 0o077).toBe(0);
  });

  it("surfaces non-race exclusive-create errors", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      const mockedOpenSync = ((
        pathLike: Parameters<typeof actual.openSync>[0],
        flags: Parameters<typeof actual.openSync>[1],
        mode?: Parameters<typeof actual.openSync>[2],
      ): number => {
        if (String(pathLike).endsWith("checkpoint-key.json") && flags === "wx") {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return actual.openSync(pathLike, flags, mode);
      }) as typeof actual.openSync;
      return {
        ...actual,
        existsSync: (pathLike: Parameters<typeof actual.existsSync>[0]) =>
          String(pathLike).endsWith("checkpoint-key.json") ? false : actual.existsSync(pathLike),
        openSync: mockedOpenSync,
      };
    });

    const { loadOrCreateAuditCheckpointKey: loadWithOpenFailure } =
      await import("./checkpoint-key.js");

    expect(() => loadWithOpenFailure(dir)).toThrow(/denied/);
  });
});
