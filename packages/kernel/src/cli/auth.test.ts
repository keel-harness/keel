import { describe, expect, it } from "vitest";
import type { SecretStore } from "../secrets/secret-store.js";
import { runAuthCli } from "./auth.js";
import { PROVIDERS } from "./runtime.js";

/** In-memory secret store for the auth CLI tests. */
function memStore(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (a) => map.get(a),
    set: (a, s) => void map.set(a, s),
    remove: (a) => map.delete(a),
  };
}

const SECRET = "sk-ant-api03-supersecretvalue1234567890ABCDEF";

describe("runAuthCli — keel auth set/list/remove (Epic 1.9)", () => {
  it("set: reads the secret and stores it for the provider, reporting the backend (never echoes it)", async () => {
    const store = memStore();
    const out = await runAuthCli(["set", "anthropic"], { store, readSecret: async () => SECRET });
    expect(store.get("anthropic")).toBe(SECRET);
    expect(out).toMatch(/anthropic/);
    expect(out).toMatch(/0600|file/); // honest about the actual backend (never "keychain" in v1)
    expect(out).not.toContain(SECRET); // the secret is NEVER printed back
  });

  it("set: distinguishes durable storage from process reload and gives one exact recovery command", async () => {
    const store = memStore();
    const out = await runAuthCli(["set", "anthropic"], {
      store,
      readSecret: async () => SECRET,
    });

    expect(out).toBe(
      "stored the anthropic key in the 0600 credentials file\n" +
        "running Keel sessions were not reloaded — restart from the session workspace with `keel --continue`",
    );
    expect(out).not.toContain(SECRET);
  });

  it("set: an empty secret is rejected (no blank key stored)", async () => {
    const store = memStore();
    const out = await runAuthCli(["set", "anthropic"], { store, readSecret: async () => "  " });
    expect(out).toMatch(/no key|empty/i);
    expect(store.get("anthropic")).toBeUndefined();
  });

  it("set: an unknown provider is rejected with the valid list", async () => {
    const store = memStore();
    const out = await runAuthCli(["set", "bogus"], { store, readSecret: async () => SECRET });
    expect(out).toMatch(/unknown provider|anthropic.*openai/i);
    expect(store.get("bogus")).toBeUndefined();
  });

  it("list: shows which providers have a key set — never the secret value", async () => {
    const store = memStore();
    store.set("anthropic", SECRET);
    const out = await runAuthCli(["list"], { store, readSecret: async () => "" });
    expect(out).toMatch(/anthropic/);
    expect(out).toMatch(/set|✓|yes/i);
    expect(out).toMatch(/openai/); // unset providers are listed too
    expect(out).not.toContain(SECRET);
  });

  it("remove: deletes a stored key (and reports when there was none)", async () => {
    const store = memStore();
    store.set("anthropic", SECRET);
    expect(
      await runAuthCli(["remove", "anthropic"], { store, readSecret: async () => "" }),
    ).toMatch(/removed/i);
    expect(store.get("anthropic")).toBeUndefined();
    expect(
      await runAuthCli(["remove", "anthropic"], { store, readSecret: async () => "" }),
    ).toMatch(/no .*key|not set/i);
  });

  it("remove: an unknown provider is rejected with the valid list", async () => {
    const store = memStore();
    expect(await runAuthCli(["remove", "bogus"], { store, readSecret: async () => "" })).toMatch(
      /unknown provider/i,
    );
  });

  it("set/remove with no provider arg → unknown-provider guidance (not a crash)", async () => {
    const store = memStore();
    expect(await runAuthCli(["set"], { store, readSecret: async () => SECRET })).toMatch(
      /unknown provider/i,
    );
    expect(await runAuthCli(["remove"], { store, readSecret: async () => "" })).toMatch(
      /unknown provider/i,
    );
  });

  it("bad usage → a usage string", async () => {
    const store = memStore();
    expect(await runAuthCli([], { store, readSecret: async () => "" })).toMatch(/usage/i);
    expect(await runAuthCli(["frobnicate"], { store, readSecret: async () => "" })).toMatch(
      /usage/i,
    );
  });

  it("set: a cancelled secret read (Ctrl-C) returns a clean message, never an uncaught throw (M5)", async () => {
    const store = memStore();
    const out = await runAuthCli(["set", "anthropic"], {
      store,
      readSecret: () => Promise.reject(new Error("aborted")),
    });
    expect(out).toMatch(/cancel|abort/i);
    expect(out).not.toMatch(/Error:/); // not a leaked stack/Error string
    expect(store.get("anthropic")).toBeUndefined(); // nothing stored
  });

  it("set: a failing store write returns a clean error message, never an uncaught throw (M5)", async () => {
    const store: SecretStore = {
      get: () => undefined,
      set: () => {
        throw new Error("EACCES: permission denied");
      },
      remove: () => false,
    };
    const out = await runAuthCli(["set", "anthropic"], { store, readSecret: async () => SECRET });
    expect(out).toMatch(/could not store|failed/i);
    expect(out).not.toContain(SECRET); // the secret is never echoed even in an error
  });

  it("list: distinguishes a key found in the environment from one in the file (DX-5)", async () => {
    const store = memStore();
    store.set("anthropic", SECRET);
    const out = await runAuthCli(["list"], {
      store,
      readSecret: async () => "",
      env: { OPENAI_API_KEY: "sk-openai-from-env" },
    });
    expect(out).toMatch(/anthropic.*file/i); // file-backed
    expect(out).toMatch(/openai.*env/i); // env-backed (not in the file, but keel WILL find it)
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("sk-openai-from-env");
  });

  it("list: keeps the source column aligned with the header", async () => {
    const store = memStore();
    store.set("anthropic", SECRET);
    const out = await runAuthCli(["list"], {
      store,
      readSecret: async () => "",
      env: { OPENAI_API_KEY: "sk-openai-from-env" },
    });
    const lines = out.split("\n");
    const header = lines[0] ?? "";
    const rows = lines.slice(1);
    const keyColumn = header.indexOf("key");

    expect(keyColumn).toBeGreaterThan(0);
    expect(rows).toHaveLength(PROVIDERS.length);
    for (const row of rows) {
      expect(PROVIDERS).toContain(row.slice(0, keyColumn).trim());
      expect(row[keyColumn]).not.toBe(" ");
    }
  });
});
