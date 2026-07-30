import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { publicKeyFromSecretKey } from "@keel/shared";

const KEY_FILE_VERSION = "keel-audit-checkpoint-key/v1";
const KEY_FILE_NAME = "checkpoint-key.json";

const StoredCheckpointKey = z
  .object({
    version: z.literal(KEY_FILE_VERSION),
    secretKey: z.string().min(1),
    publicKey: z.string().min(1),
  })
  .strict();

export interface AuditCheckpointKey {
  path: string;
  mode: number;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

function keyPathFor(auditDir: string): string {
  return join(auditDir, KEY_FILE_NAME);
}

function decodeBase64Bytes(value: string, field: string): Uint8Array {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) {
    throw new Error(`audit checkpoint ${field} must decode to 32 bytes`);
  }
  return new Uint8Array(bytes);
}

function loadKey(path: string): AuditCheckpointKey {
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`audit checkpoint key at ${path} is too permissive; expected 0600`);
  }

  const stored = StoredCheckpointKey.parse(JSON.parse(readFileSync(path, "utf8")));
  const secretKey = decodeBase64Bytes(stored.secretKey, "secretKey");
  const publicKey = decodeBase64Bytes(stored.publicKey, "publicKey");
  const derivedPublicKey = publicKeyFromSecretKey(secretKey);
  if (!Buffer.from(derivedPublicKey).equals(Buffer.from(publicKey))) {
    throw new Error(`audit checkpoint key public key mismatch at ${path}`);
  }

  return { path, mode, secretKey, publicKey };
}

function writeNewKey(path: string): AuditCheckpointKey {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const secretKey = new Uint8Array(randomBytes(32));
  const publicKey = publicKeyFromSecretKey(secretKey);
  const payload = `${JSON.stringify(
    {
      version: KEY_FILE_VERSION,
      secretKey: Buffer.from(secretKey).toString("base64"),
      publicKey: Buffer.from(publicKey).toString("base64"),
    },
    null,
    2,
  )}\n`;

  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return loadKey(path);
    }
    throw error;
  }

  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  return loadKey(path);
}

/**
 * Load the local Phase-2B checkpoint signing key, creating it on first use. The
 * file is intentionally local and `0600`: this is a same-user protection boundary,
 * not an EDR or defense against at-rest key theft by a compromised account.
 */
export function loadOrCreateAuditCheckpointKey(auditDir: string): AuditCheckpointKey {
  const path = keyPathFor(auditDir);
  if (existsSync(path)) return loadKey(path);
  return writeNewKey(path);
}
