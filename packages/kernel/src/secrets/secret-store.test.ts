import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, credentialsFilePath, defaultSecretStore } from "./secret-store.js";

const home = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-ss-")) });

describe("FileSecretStore — the pure-TS 0600 secret store (Epic 1.9, ADR-0039)", () => {
  it("round-trips set/get/remove keyed by account, under keelHome", () => {
    const env = home();
    const s = new FileSecretStore(env);
    expect(s.get("anthropic")).toBeUndefined();
    s.set("anthropic", "sk-ant-secret");
    expect(s.get("anthropic")).toBe("sk-ant-secret");
    expect(s.get("openai")).toBeUndefined(); // independent accounts
    expect(s.remove("anthropic")).toBe(true);
    expect(s.get("anthropic")).toBeUndefined();
    expect(s.remove("anthropic")).toBe(false); // already gone
  });

  it("writes the credentials file 0600 under keelHome (never the workspace)", () => {
    const env = home();
    new FileSecretStore(env).set("anthropic", "x");
    const path = credentialsFilePath(env);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps the credentials file 0600 across a rewrite (set a second key)", () => {
    const env = home();
    const s = new FileSecretStore(env);
    s.set("anthropic", "a");
    s.set("openai", "b"); // rewrite
    expect(statSync(credentialsFilePath(env)).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing loose keelHome directory to 0700 before storing credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-ss-root-"));
    const keel = join(root, "keel-home");
    mkdirSync(keel, { mode: 0o755 });
    chmodSync(keel, 0o755); // deterministic across umasks
    const env: NodeJS.ProcessEnv = { KEEL_HOME: keel };

    new FileSecretStore(env).set("anthropic", "x");

    expect(statSync(keel).mode & 0o777).toBe(0o700);
    expect(statSync(credentialsFilePath(env)).mode & 0o777).toBe(0o600);
  });

  it("writes 0600 even when a loose-perm leftover temp exists in keelHome (SEC-1)", () => {
    const env = home();
    // A crashed write under a looser umask leaves a 0644 sibling temp. A fixed-name temp would be
    // written into (mode only applies on create) and inherit 0644 after rename — the durability bug.
    writeFileSync(`${credentialsFilePath(env)}.tmp`, "leftover", { mode: 0o644 });
    new FileSecretStore(env).set("anthropic", "sk-ant-secret");
    expect(statSync(credentialsFilePath(env)).mode & 0o777).toBe(0o600);
    expect(new FileSecretStore(env).get("anthropic")).toBe("sk-ant-secret");
  });

  it("does not write the secret through a symlink planted at the predictable temp path (SEC-2)", () => {
    const env = home();
    const victim = join(env["KEEL_HOME"] as string, "victim.txt");
    writeFileSync(victim, "UNTOUCHED");
    symlinkSync(victim, `${credentialsFilePath(env)}.tmp`); // legacy predictable temp name
    new FileSecretStore(env).set("anthropic", "sk-ant-leak");
    expect(readFileSync(victim, "utf8")).toBe("UNTOUCHED"); // secret never leaked through the symlink
    expect(lstatSync(credentialsFilePath(env)).isSymbolicLink()).toBe(false);
    expect(statSync(credentialsFilePath(env)).mode & 0o777).toBe(0o600);
  });

  it("fails soft on a malformed credentials file (no throw, treated as empty; a later write recovers)", () => {
    const env = home();
    writeFileSync(credentialsFilePath(env), "{ not json");
    const s = new FileSecretStore(env);
    expect(s.get("anthropic")).toBeUndefined();
    s.set("anthropic", "recovered");
    expect(s.get("anthropic")).toBe("recovered");
  });

  it("defaultSecretStore is the 0600 file store (no native dependency in the credential path)", () => {
    const env = home();
    const s = defaultSecretStore(env);
    s.set("openai", "k");
    expect(new FileSecretStore(env).get("openai")).toBe("k"); // same backing file
  });
});
