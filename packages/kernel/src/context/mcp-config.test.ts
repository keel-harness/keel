import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { type ProjectFs, ProjectReader } from "./project-reader.js";
import { MCP_PROJECT_CONFIG_PATH, loadMcpConfigFromProjectReader } from "./mcp-config.js";

function spyFs(files: Record<string, string>): ProjectFs & { calls: number } {
  const fs = {
    calls: 0,
    listDir(): string[] {
      fs.calls++;
      return [];
    },
    readFile(path: string): string | undefined {
      fs.calls++;
      return files[path];
    },
    probeVersion(): string | undefined {
      fs.calls++;
      return undefined;
    },
    realpath(path: string): string | undefined {
      fs.calls++;
      return path;
    },
  };
  return fs;
}

describe("MCP local-stdio config loading", () => {
  it("keeps project MCP config inert and performs zero real reads before workspace trust", () => {
    const workspace = "/workspace";
    const fs = spyFs({
      [join(workspace, MCP_PROJECT_CONFIG_PATH)]: JSON.stringify({
        version: 1,
        servers: {
          fixture: {
            transport: "stdio",
            command: "/bin/echo",
            args: ["MUST_NOT_RUN"],
          },
        },
      }),
    });
    const reader = new ProjectReader(fs, { trusted: false });

    const loaded = loadMcpConfigFromProjectReader(reader, workspace);

    expect(loaded).toEqual({ kind: "untrusted" });
    expect(fs.calls).toBe(0);
    expect(reader.accesses).toEqual([
      { op: "readFile", target: join(workspace, MCP_PROJECT_CONFIG_PATH), served: false },
    ]);
  });

  it("parses only local stdio servers after trust and rejects remote or unknown keys", () => {
    const workspace = "/workspace";
    const good = new ProjectReader(
      spyFs({
        [join(workspace, MCP_PROJECT_CONFIG_PATH)]: JSON.stringify({
          version: 1,
          servers: {
            fixture: {
              transport: "stdio",
              command: "/usr/bin/node",
              args: ["server.js"],
              envKeys: ["FIXTURE_MODE"],
            },
          },
        }),
      }),
      { trusted: true },
    );

    expect(loadMcpConfigFromProjectReader(good, workspace)).toMatchObject({
      kind: "loaded",
      config: {
        servers: {
          fixture: {
            transport: "stdio",
            command: "/usr/bin/node",
            args: ["server.js"],
            envKeys: ["FIXTURE_MODE"],
          },
        },
      },
    });

    const bad = new ProjectReader(
      spyFs({
        [join(workspace, MCP_PROJECT_CONFIG_PATH)]: JSON.stringify({
          version: 1,
          servers: {
            remote: {
              transport: "http",
              url: "https://mcp.example.com",
            },
          },
        }),
      }),
      { trusted: true },
    );

    const loaded = loadMcpConfigFromProjectReader(bad, workspace);
    expect(loaded.kind).toBe("invalid");
    expect(loaded.kind === "invalid" ? loaded.message : "").toContain("local stdio");

    const valueBearingEnv = new ProjectReader(
      spyFs({
        [join(workspace, MCP_PROJECT_CONFIG_PATH)]: JSON.stringify({
          version: 1,
          servers: {
            fixture: {
              transport: "stdio",
              command: "/usr/bin/node",
              args: ["server.js"],
              env: { FIXTURE_TOKEN: "project-value" },
            },
          },
        }),
      }),
      { trusted: true },
    );
    expect(loadMcpConfigFromProjectReader(valueBearingEnv, workspace)).toMatchObject({
      kind: "invalid",
    });
  });

  it("returns missing and invalid results without throwing", () => {
    const workspace = "/workspace";
    const missing = new ProjectReader(spyFs({}), { trusted: true });
    expect(loadMcpConfigFromProjectReader(missing, workspace)).toEqual({ kind: "missing" });

    const malformed = new ProjectReader(
      spyFs({ [join(workspace, MCP_PROJECT_CONFIG_PATH)]: "{not-json}" }),
      { trusted: true },
    );
    const malformedResult = loadMcpConfigFromProjectReader(malformed, workspace);
    expect(malformedResult.kind).toBe("invalid");
    expect(malformedResult.kind === "invalid" ? malformedResult.message : "").toContain(
      "not valid JSON",
    );
  });
});
