import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { minimalChildEnv, restoreHostNodeEnv } from "./child-env.js";

describe("minimalChildEnv (EXEC-2 — least-privilege env for harness-internal children)", () => {
  it("returns ONLY PATH + locale — host secrets in the source env are not carried through", () => {
    const out = minimalChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      AWS_SECRET_ACCESS_KEY: "wJalr",
      HOME: "/home/me",
    });
    expect(Object.keys(out).sort()).toEqual(["LANG", "LC_ALL", "PATH"]);
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["LC_ALL"]).toBe("C");
    expect(out["LANG"]).toBe("C");
    // The planted secrets must be absent — the central guarantee of this helper.
    expect(JSON.stringify(out)).not.toContain("sk-ant-secret");
    expect(JSON.stringify(out)).not.toContain("wJalr");
  });

  it("tolerates a missing PATH (empty string, never undefined — children need the key present)", () => {
    const out = minimalChildEnv({});
    expect(out["PATH"]).toBe("");
  });
});

describe("restoreHostNodeEnv (ADR-0083 — release-renderer env restoration)", () => {
  it("is a strict no-op when the npx launcher did not manage NODE_ENV", () => {
    const source = {
      PATH: "/usr/bin",
      NODE_ENV: "development",
      KEEL_HOST_NODE_ENV: "host-value",
    };

    expect(restoreHostNodeEnv(source)).toBe(source);
  });

  it("restores an unset host NODE_ENV and strips both sentinels without mutating the source", () => {
    const source = {
      PATH: "/usr/bin",
      NODE_ENV: "production",
      KEEL_HOST_NODE_ENV_MANAGED: "1",
    };

    const restored = restoreHostNodeEnv(source);

    expect(restored).not.toBe(source);
    expect(restored).toEqual({ PATH: "/usr/bin" });
    expect(source).toEqual({
      PATH: "/usr/bin",
      NODE_ENV: "production",
      KEEL_HOST_NODE_ENV_MANAGED: "1",
    });
  });

  it.each(["development", "production"])(
    "restores the host NODE_ENV=%s and strips both sentinels",
    (hostNodeEnv) => {
      const restored = restoreHostNodeEnv({
        PATH: "/usr/bin",
        NODE_ENV: "production",
        KEEL_HOST_NODE_ENV: hostNodeEnv,
        KEEL_HOST_NODE_ENV_MANAGED: "1",
      });

      expect(restored).toEqual({ PATH: "/usr/bin", NODE_ENV: hostNodeEnv });
    },
  );

  it("uses the launcher-captured host value instead of a caller-supplied NODE_ENV", () => {
    expect(
      restoreHostNodeEnv({
        NODE_ENV: "caller-override",
        KEEL_HOST_NODE_ENV: "development",
        KEEL_HOST_NODE_ENV_MANAGED: "1",
      }),
    ).toEqual({ NODE_ENV: "development" });
  });

  it("preserves every ordinary own env key, including __proto__", () => {
    const source = Object.fromEntries([
      ["PATH", "/usr/bin"],
      ["__proto__", "kept"],
      ["NODE_ENV", "production"],
      ["KEEL_HOST_NODE_ENV_MANAGED", "1"],
    ]);

    const restored = restoreHostNodeEnv(source);

    expect(Object.keys(restored).sort()).toEqual(["PATH", "__proto__"].sort());
    expect(Object.getOwnPropertyDescriptor(restored, "__proto__")?.value).toBe("kept");
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  });

  it("preserves the restoration invariant across arbitrary child env maps", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 24 }), fc.string()),
        fc.option(fc.string(), { nil: undefined }),
        (env, hostNodeEnv) => {
          const managedEnv: NodeJS.ProcessEnv = {
            ...env,
            NODE_ENV: "production",
            KEEL_HOST_NODE_ENV_MANAGED: "1",
          };
          if (hostNodeEnv === undefined) delete managedEnv["KEEL_HOST_NODE_ENV"];
          else managedEnv["KEEL_HOST_NODE_ENV"] = hostNodeEnv;

          const restored = restoreHostNodeEnv(managedEnv);

          expect(restored).not.toBe(managedEnv);
          expect(restored).not.toHaveProperty("KEEL_HOST_NODE_ENV");
          expect(restored).not.toHaveProperty("KEEL_HOST_NODE_ENV_MANAGED");
          if (hostNodeEnv === undefined) expect(restored).not.toHaveProperty("NODE_ENV");
          else expect(restored["NODE_ENV"]).toBe(hostNodeEnv);
          for (const [key, value] of Object.entries(managedEnv)) {
            if (
              key === "NODE_ENV" ||
              key === "KEEL_HOST_NODE_ENV" ||
              key === "KEEL_HOST_NODE_ENV_MANAGED"
            ) {
              continue;
            }
            expect(Object.hasOwn(restored, key)).toBe(true);
            expect(restored[key]).toBe(value);
          }
        },
      ),
    );
  });
});
