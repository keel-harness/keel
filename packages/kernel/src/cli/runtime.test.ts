import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObjectT, SessionEventT, ToolInvocationT } from "@keel/shared";
import type { SkillRegistry } from "../context/skills.js";
import type { SecretStore } from "../secrets/secret-store.js";
import {
  createModelPort,
  createReplayModelPort,
  createToolRuntime,
  resolveApiKey,
  resolveModelConfig,
} from "./runtime.js";
import {
  EVAL_BASH_MAX_TIMEOUT_ENV,
  EVAL_BASH_TIMEOUT_ACK,
  EVAL_BASH_TIMEOUT_ACK_ENV,
  EVAL_DENIED_ROOTS_ENV,
  EVAL_EXTRA_ROOTS_BANNER_PREFIX,
  EVAL_EXTRA_ROOTS_ACK,
  EVAL_EXTRA_ROOTS_ACK_ENV,
  EVAL_EXTRA_ROOTS_ENV,
} from "./eval-executor-gate.js";

const BUILD_GLOBAL = "__KEEL_EVAL_DIRECT_EXEC_BUILD__";
const tmp = (): string => mkdtempSync(join(tmpdir(), "keel-rt-"));
const fakeStore = (seed: Record<string, string>): SecretStore => ({
  get: (a) => seed[a],
  set: () => undefined,
  remove: () => false,
});
const call = (name: string, args: JsonObjectT): ToolInvocationT => ({
  id: `c_${name}`,
  name,
  args,
});
const advertisedTimeoutMaximum = (tool: { readonly parameters?: unknown }): number => {
  const parameters = tool.parameters as {
    readonly properties: { readonly timeoutMs: { readonly maximum: number } };
  };
  return parameters.properties.timeoutMs.maximum;
};

describe("createToolRuntime (real Workspace + shell + five tools + plan + executor)", () => {
  it("advertises the five core tools + the plan task-ledger tool to the model", async () => {
    const rt = createToolRuntime({ cwd: tmp() });
    expect(rt.tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "edit",
      "plan",
      "read",
      "search",
      "write",
    ]);
    await rt.dispose();
  });

  it("threads the eval-only bash timeout ceiling into the runtime tool schema when structurally gated", async () => {
    const g = globalThis as Record<string, unknown>;
    const had = BUILD_GLOBAL in g;
    const prev = g[BUILD_GLOBAL];
    g[BUILD_GLOBAL] = true;
    const rt = createToolRuntime({
      cwd: tmp(),
      env: {
        [EVAL_BASH_TIMEOUT_ACK_ENV]: EVAL_BASH_TIMEOUT_ACK,
        [EVAL_BASH_MAX_TIMEOUT_ENV]: "10800000",
      },
    });
    try {
      const bash = rt.tools.find((tool) => tool.name === "bash");
      expect(bash).toBeDefined();
      expect(advertisedTimeoutMaximum(bash!)).toBe(10_800_000);
    } finally {
      await rt.dispose();
      if (had) g[BUILD_GLOBAL] = prev;
      else delete g[BUILD_GLOBAL];
    }
  });

  it("wires eval-only extra roots into typed tools only when structurally gated", async () => {
    const cwd = tmp();
    const extra = tmp();
    writeFileSync(join(extra, "artifact.txt"), "outside but declared");
    const g = globalThis as Record<string, unknown>;
    const had = BUILD_GLOBAL in g;
    const prev = g[BUILD_GLOBAL];
    g[BUILD_GLOBAL] = true;
    const emitted: string[] = [];
    const rt = createToolRuntime({
      cwd,
      env: {
        [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
        [EVAL_EXTRA_ROOTS_ENV]: extra,
      },
      emit: (line) => emitted.push(line),
    });
    try {
      expect(emitted.join("")).toContain(EVAL_EXTRA_ROOTS_BANNER_PREFIX);
      expect(emitted.join("")).toContain(extra);
      expect(emitted.join("")).toContain("[eval-extra-root; read+write]");
      const res = await rt.executor.execute(call("read", { path: join(extra, "artifact.txt") }));
      expect(res).toEqual({ ok: true, output: "outside but declared" });
    } finally {
      await rt.dispose();
      if (had) g[BUILD_GLOBAL] = prev;
      else delete g[BUILD_GLOBAL];
    }

    const productionRt = createToolRuntime({
      cwd,
      env: {
        [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
        [EVAL_EXTRA_ROOTS_ENV]: extra,
      },
    });
    try {
      const denied = await productionRt.executor.execute(
        call("read", { path: join(extra, "artifact.txt") }),
      );
      expect(denied.ok).toBe(false);
    } finally {
      await productionRt.dispose();
    }
  });

  it("threads eval denied roots into primary-workspace followSymlink reads", async () => {
    const cwd = tmp();
    const denied = tmp();
    writeFileSync(join(denied, "secret.txt"), "secret");
    symlinkSync(join(denied, "secret.txt"), join(cwd, "link.txt"));
    const g = globalThis as Record<string, unknown>;
    const had = BUILD_GLOBAL in g;
    const prev = g[BUILD_GLOBAL];
    g[BUILD_GLOBAL] = true;
    const rt = createToolRuntime({
      cwd,
      env: {
        [EVAL_EXTRA_ROOTS_ACK_ENV]: EVAL_EXTRA_ROOTS_ACK,
        [EVAL_DENIED_ROOTS_ENV]: denied,
      },
    });
    try {
      const deniedRead = await rt.executor.execute(
        call("read", { path: "link.txt", followSymlink: true }),
      );
      expect(deniedRead.ok).toBe(false);
      expect(deniedRead.output).toMatch(/protected directory/i);
    } finally {
      await rt.dispose();
      if (had) g[BUILD_GLOBAL] = prev;
      else delete g[BUILD_GLOBAL];
    }
  });

  it("derives isMutating from each tool's staticCapability (CAP-1, not a hardcoded name set)", async () => {
    const rt = createToolRuntime({ cwd: tmp() });
    // fs_write/network_write + broad static envelopes are mutating.
    expect(rt.isMutating("edit")).toBe(true);
    expect(rt.isMutating("write")).toBe(true);
    expect(rt.isMutating("bash")).toBe(true);
    // Pure read envelopes are not mutating.
    expect(rt.isMutating("read")).toBe(false);
    expect(rt.isMutating("search")).toBe(false);
    expect(rt.isMutating("plan")).toBe(false);
    await rt.dispose();
  });

  it("runs the real write tool — a file actually lands on disk in the workspace", async () => {
    const cwd = tmp();
    const rt = createToolRuntime({ cwd });
    const res = await rt.executor.execute(
      call("write", { path: "note.txt", content: "hello keel" }),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("hello keel");
    await rt.dispose();
  });

  it("contains tool paths to the workspace root (a traversal write is refused, not executed)", async () => {
    const rt = createToolRuntime({ cwd: tmp() });
    const res = await rt.executor.execute(call("write", { path: "../escape.txt", content: "x" }));
    expect(res.ok).toBe(false); // structured refusal, never a write outside the root
    await rt.dispose();
  });

  it("advertises and executes the local skill tool only when a post-trust registry has stubs", async () => {
    const registry: SkillRegistry = {
      stubs: [
        {
          name: "demo-skill",
          description: "demo",
          source: "builtin",
          dir: tmp(),
        },
      ],
      stubText: "# Skills\n- demo-skill",
      loadBody: (name) => (name === "demo-skill" ? "demo skill body" : undefined),
    };
    const rt = createToolRuntime({ cwd: tmp(), skillRegistry: registry });
    try {
      expect(rt.tools.map((t) => t.name)).toContain("skill");
      expect(rt.isMutating("skill")).toBe(false);
      const res = await rt.executor.execute(call("skill", { name: "demo-skill" }));
      expect(res.ok).toBe(true);
      expect(res.output).toContain("demo skill body");
    } finally {
      await rt.dispose();
    }
  });

  it("advertises and executes the local retrieve tool only when a session ledger reader is supplied", async () => {
    const events: SessionEventT[] = [
      {
        type: "tool_result",
        v: 1,
        ts: "2026-06-27T00:00:00.000Z",
        toolCallId: "read-a",
        name: "read",
        output: "full compressed output",
      },
    ];
    const rt = createToolRuntime({ cwd: tmp(), readEvents: () => events });
    try {
      expect(rt.tools.map((t) => t.name)).toContain("retrieve");
      expect(rt.isMutating("retrieve")).toBe(false);
      const res = await rt.executor.execute(call("retrieve", { ref: "read-a" }));
      expect(res.ok).toBe(true);
      expect(res.output).toContain("full compressed output");
    } finally {
      await rt.dispose();
    }
  });

  it("dispose() releases the shell session and resolves", async () => {
    const rt = createToolRuntime({ cwd: tmp() });
    await expect(rt.dispose()).resolves.toBeUndefined();
  });
});

describe("resolveModelConfig (env → provider/model)", () => {
  it("defaults to the pinned Anthropic Sonnet (OQ-3/ADR-0022) with no env set", () => {
    expect(resolveModelConfig({})).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("honors KEEL_PROVIDER + KEEL_MODEL overrides", () => {
    expect(resolveModelConfig({ KEEL_PROVIDER: "openai", KEEL_MODEL: "gpt-x" })).toEqual({
      provider: "openai",
      model: "gpt-x",
    });
  });

  it("rejects a non-anthropic provider with no KEEL_MODEL (no pinned default for it)", () => {
    expect(() => resolveModelConfig({ KEEL_PROVIDER: "openai" })).toThrow(/KEEL_MODEL/);
  });

  it("rejects an unknown provider", () => {
    expect(() => resolveModelConfig({ KEEL_PROVIDER: "bogus" })).toThrow(/provider/i);
  });

  it("requires KEEL_BASE_URL for openai-compatible; passes it through when set", () => {
    expect(() =>
      resolveModelConfig({ KEEL_PROVIDER: "openai-compatible", KEEL_MODEL: "m" }),
    ).toThrow(/KEEL_BASE_URL/);
    expect(
      resolveModelConfig({
        KEEL_PROVIDER: "openai-compatible",
        KEEL_MODEL: "m",
        KEEL_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toEqual({ provider: "openai-compatible", model: "m", baseURL: "http://localhost:11434/v1" });
  });

  it("omits cacheTtl by default (KEEL_CACHE_TTL unset → no key, 5m behavior unchanged)", () => {
    const cfg = resolveModelConfig({});
    expect(cfg).not.toHaveProperty("cacheTtl");
  });

  it("threads KEEL_CACHE_TTL=1h into config.cacheTtl (the long-TTL cache lever)", () => {
    expect(resolveModelConfig({ KEEL_CACHE_TTL: "1h" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      cacheTtl: "1h",
    });
  });

  it("accepts KEEL_CACHE_TTL=5m (explicit default)", () => {
    expect(resolveModelConfig({ KEEL_CACHE_TTL: "5m" }).cacheTtl).toBe("5m");
  });

  it("rejects an invalid KEEL_CACHE_TTL (only 5m | 1h)", () => {
    expect(() => resolveModelConfig({ KEEL_CACHE_TTL: "2h" })).toThrow(/KEEL_CACHE_TTL/);
  });
});

describe("resolveApiKey (secret store → provider env var)", () => {
  it("returns the stored key, which takes precedence over the env var", () => {
    const key = resolveApiKey(
      "anthropic",
      { ANTHROPIC_API_KEY: "from-env" },
      fakeStore({ anthropic: "from-store" }),
    );
    expect(key).toBe("from-store");
  });

  it("falls back to the provider env var when the store has no key", () => {
    expect(resolveApiKey("anthropic", { ANTHROPIC_API_KEY: "from-env" }, fakeStore({}))).toBe(
      "from-env",
    );
    expect(resolveApiKey("google", { GOOGLE_GENERATIVE_AI_API_KEY: "g" }, fakeStore({}))).toBe("g");
  });

  it("is undefined when neither the store nor the env has a key", () => {
    expect(resolveApiKey("openai", {}, fakeStore({}))).toBeUndefined();
  });

  it("treats an empty/whitespace stored key as absent — a blank key never masks a valid env var", () => {
    expect(
      resolveApiKey(
        "anthropic",
        { ANTHROPIC_API_KEY: "valid-env" },
        fakeStore({ anthropic: "  " }),
      ),
    ).toBe("valid-env");
    expect(
      resolveApiKey("openai", { OPENAI_API_KEY: "" }, fakeStore({ openai: "" })),
    ).toBeUndefined();
  });

  it("trims surrounding whitespace from the resolved key (a trailing newline breaks auth headers) — REL-6", () => {
    expect(resolveApiKey("anthropic", {}, fakeStore({ anthropic: "  sk-ant-x\n" }))).toBe(
      "sk-ant-x",
    );
    expect(resolveApiKey("openai", { OPENAI_API_KEY: " env-key \n" }, fakeStore({}))).toBe(
      "env-key",
    );
  });
});

describe("createModelPort (config → ModelPort, no network at construction)", () => {
  it("builds an Anthropic ModelPort without touching the network", () => {
    const port = createModelPort({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(typeof port.stream).toBe("function"); // constructed; the network is only hit on stream()
  });

  it("builds each supported provider", () => {
    expect(typeof createModelPort({ provider: "anthropic", model: "m" }).stream).toBe("function");
    expect(typeof createModelPort({ provider: "openai", model: "m" }).stream).toBe("function");
    expect(typeof createModelPort({ provider: "google", model: "m" }).stream).toBe("function");
    expect(
      typeof createModelPort({
        provider: "openai-compatible",
        model: "m",
        baseURL: "http://localhost:11434/v1",
      }).stream,
    ).toBe("function");
  });
});

describe("createReplayModelPort (offline replay from a Recording file — no key, no network)", () => {
  const writeRec = (content: string): string => {
    const p = join(tmp(), "rec.json");
    writeFileSync(p, content);
    return p;
  };
  const validRec = JSON.stringify({
    version: 1,
    provider: "anthropic",
    model: "replay",
    turns: [
      {
        chunks: [
          { type: "text-delta", text: "hello from replay" },
          { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 2 } },
        ],
      },
    ],
  });

  it("builds a ModelPort that replays the recorded chunks (no API key needed)", async () => {
    const port = createReplayModelPort(writeRec(validRec));
    const text: string[] = [];
    for await (const c of port.stream({ messages: [] })) {
      if (c.type === "text-delta") text.push(c.text);
    }
    expect(text).toEqual(["hello from replay"]);
  });

  it("throws a typed one-line error when the file does not exist", () => {
    expect(() => createReplayModelPort(join(tmp(), "nope.json"))).toThrow(/replay/i);
  });

  it("throws a typed error on invalid JSON", () => {
    expect(() => createReplayModelPort(writeRec("{ not json"))).toThrow(/replay/i);
  });

  it("throws a typed error on a recording schema mismatch", () => {
    expect(() => createReplayModelPort(writeRec(JSON.stringify({ version: 2 })))).toThrow(
      /replay/i,
    );
  });

  it("loads the committed CI-smoke recording (fixture stays valid)", async () => {
    // The packaging CI smoke depends on this file; assert it parses here so a broken edit fails in
    // `pnpm test`, not only in the (Bun-only) `package` job.
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = join(here, "..", "..", "..", "..", "packaging", "smoke.recording.json");
    const port = createReplayModelPort(fixture);
    const types: string[] = [];
    for await (const c of port.stream({ messages: [] })) types.push(c.type);
    expect(types).toContain("tool-call"); // turn 1 runs the bash tool
    expect(types).toContain("finish");
  });
});
