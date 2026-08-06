import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObjectT } from "@keel/shared";
import { Workspace } from "./workspace.js";
import { ToolError } from "./errors.js";
import {
  SEARCH_MAX_LINE_BYTES,
  SEARCH_MAX_OUTPUT_BYTES,
  SEARCH_MAX_RAW_STDOUT_LINE_BYTES,
  SEARCH_MAX_STDERR_BYTES,
  createSearchTool,
  parseRgMatch,
  resolveRgPath,
} from "./search.js";

let root: string;
let outside: string;
const search = (ws: Workspace, args: JsonObjectT): Promise<string> =>
  createSearchTool(ws).handler(args) as Promise<string>;
const file = (name: string, content: string): void => {
  const full = join(root, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-search-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "keel-out-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("search tool — content", () => {
  it("finds a content match as file:line:col:text", async () => {
    file("a.txt", "hello\nNEEDLE here\n");
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    expect(out).toMatch(/a\.txt:2:1:NEEDLE here/);
  });

  it("restricts content search by glob", async () => {
    file("a.txt", "NEEDLE");
    file("b.md", "NEEDLE");
    const out = await search(new Workspace(root), { pattern: "NEEDLE", glob: "*.md" });
    expect(out).toContain("b.md");
    expect(out).not.toContain("a.txt");
  });

  it("scopes concrete content globs at rg execution while still filtering returned paths", async () => {
    file("src/a.txt", "NEEDLE scoped");
    file("outside.txt", "NEEDLE broad");
    file(".env", "NEEDLE hidden");
    const calls: string[][] = [];
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: (_cmd, args) => {
        calls.push(args);
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          for (const [path, text] of [
            ["src/a.txt", "NEEDLE scoped"],
            ["outside.txt", "NEEDLE broad"],
            [".env", "NEEDLE hidden"],
          ] as const) {
            stdout.emit(
              "data",
              `${JSON.stringify({
                type: "match",
                data: {
                  path: { text: path },
                  line_number: 1,
                  lines: { text: `${text}\n` },
                  submatches: [{ start: 0 }],
                },
              })}\n`,
            );
          }
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    await expect(
      tool.handler({ pattern: "NEEDLE", glob: "src/**" }) as Promise<string>,
    ).resolves.toBe("src/a.txt:1:1:NEEDLE scoped");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--json");
    expect(calls[0]).not.toContain("--files");
    expect(calls[0]).toContain("src");
    expect(calls[0]).not.toContain("src/a.txt");
  });

  it("returns no scoped content matches without spawning rg when the scope is missing", async () => {
    const calls: string[][] = [];
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: (_cmd, args) => {
        calls.push(args);
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              type: "match",
              data: {
                path: { text: "README.md" },
                line_number: 1,
                lines: { text: "NEEDLE root\n" },
                submatches: [{ start: 0 }],
              },
            })}\n`,
          );
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    await expect(
      tool.handler({ pattern: "NEEDLE", glob: "src/**" }) as Promise<string>,
    ).resolves.toBe("search: no matches.");
    expect(calls).toHaveLength(0);
  });

  it("stops scoped content output after the result cap without chunking candidate paths", async () => {
    const candidates = ["src/a.txt", "src/b.txt", "src/c.txt"];
    for (const candidate of candidates) file(candidate, "NEEDLE");
    const calls: string[][] = [];
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: (_cmd, args) => {
        calls.push(args);
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          for (const candidate of candidates) {
            stdout.emit(
              "data",
              `${JSON.stringify({
                type: "match",
                data: {
                  path: { text: candidate },
                  line_number: 1,
                  lines: { text: "NEEDLE\n" },
                  submatches: [{ start: 0 }],
                },
              })}\n`,
            );
          }
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    await expect(
      tool.handler({ pattern: "NEEDLE", glob: "src/**", maxResults: 1 }) as Promise<string>,
    ).resolves.toBe(`${candidates[0]}:1:1:NEEDLE\n… 1+ more matches; refine the pattern or glob.`);
    const contentCalls = calls.filter((args) => args.includes("--json"));
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]).toContain("src");
    expect(contentCalls[0]).not.toContain(candidates[0]);
    expect(contentCalls[0]).not.toContain(candidates.at(-1)!);
  });

  it("scopes path aliases at rg execution without passing enumerated candidate files", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.txt"), "NEEDLE scoped");
    const calls: string[][] = [];
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: (_cmd, args) => {
        calls.push(args);
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              type: "match",
              data: {
                path: { text: "src/a.txt" },
                line_number: 1,
                lines: { text: "NEEDLE scoped\n" },
                submatches: [{ start: 0 }],
              },
            })}\n`,
          );
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    await expect(
      tool.handler({ pattern: "NEEDLE", path: "src", output_mode: "content" }) as Promise<string>,
    ).resolves.toBe("src/a.txt:1:1:NEEDLE scoped");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("src");
    expect(calls[0]).not.toContain("src/a.txt");
  });

  it("keeps broad globs at the visible workspace root instead of passing widening rg globs", async () => {
    const calls: string[][] = [];
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: (_cmd, args) => {
        calls.push(args);
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          child.emit("close", 1);
        });
        return child as unknown as ChildProcess;
      },
    });

    await expect(tool.handler({ pattern: "NEEDLE", glob: "**" }) as Promise<string>).resolves.toBe(
      "search: no matches.",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(".");
    expect(calls[0]).not.toContain("--glob");
    expect(calls[0]).not.toContain("**");
  });

  it("maps a common path arg to a workspace-contained content-search glob", async () => {
    file("src/a.txt", "NEEDLE");
    file("other/a.txt", "NEEDLE");
    const out = await search(new Workspace(root), {
      pattern: "NEEDLE",
      path: join(root, "src"),
      output_mode: "content",
    });
    expect(out).toContain("src/a.txt");
    expect(out).not.toContain("other/a.txt");
  });

  it("maps a file path arg to an exact file glob", async () => {
    file("src/a.txt", "NEEDLE");
    file("src/b.txt", "NEEDLE");
    const out = await search(new Workspace(root), { pattern: "NEEDLE", path: "src/a.txt" });
    expect(out).toContain("src/a.txt");
    expect(out).not.toContain("src/b.txt");
  });

  it("does not widen a slashless file path arg to nested basename matches", async () => {
    file("README.md", "NEEDLE root");
    file("docs/README.md", "NEEDLE nested");
    const out = await search(new Workspace(root), { pattern: "NEEDLE", path: "README.md" });
    expect(out).toContain("README.md:1:1:NEEDLE root");
    expect(out).not.toContain("docs/README.md");
  });

  it("does not widen extglob metacharacters in file path aliases", async () => {
    file("src/a+(b).txt", "NEEDLE literal");
    file("src/ab.txt", "NEEDLE widened");
    file("src/a@(b).txt", "NEEDLE at-literal");
    file("src/a(b|c).txt", "NEEDLE paren-literal");

    const plus = await search(new Workspace(root), { pattern: "NEEDLE", path: "src/a+(b).txt" });
    expect(plus).toContain("src/a+(b).txt");
    expect(plus).not.toContain("src/ab.txt");

    const at = await search(new Workspace(root), { pattern: "NEEDLE", path: "src/a@(b).txt" });
    expect(at).toContain("src/a@(b).txt");
    expect(at).not.toContain("src/ab.txt");

    const paren = await search(new Workspace(root), {
      pattern: "NEEDLE",
      path: "src/a(b|c).txt",
    });
    expect(paren).toContain("src/a(b|c).txt");
    expect(paren).not.toContain("src/ab.txt");
  });

  it("rejects conflicting or unsafe search compatibility args", async () => {
    file("src/a.txt", "NEEDLE");
    await expect(search(new Workspace(root), { pattern: "NEED\0LE" })).rejects.toThrow(/NUL byte/i);
    await expect(
      search(new Workspace(root), { pattern: "NEEDLE", glob: "*.txt", path: "src" }),
    ).rejects.toThrow(/conflicting/i);
    await expect(
      search(new Workspace(root), { pattern: "NEEDLE", glob: "src/**", path: "src" }),
    ).rejects.toThrow(/conflicting/i);
    await expect(
      search(new Workspace(root), {
        pattern: "NEEDLE",
        path: "src",
        output_mode: "content",
        kind: "filename",
      }),
    ).rejects.toThrow(/conflicting/i);
    await expect(
      search(new Workspace(root), { pattern: "NEEDLE", path: "src", kind: "filename" }),
    ).rejects.toThrow(/path is only supported/i);
    await expect(search(new Workspace(root), { pattern: "NEEDLE", path: "" })).rejects.toThrow(
      /path must be a non-empty string/i,
    );
    await expect(search(new Workspace(root), { pattern: "NEEDLE", path: 1 })).rejects.toThrow(
      /path must be a non-empty string/i,
    );
    await expect(
      search(new Workspace(root), { pattern: "NEEDLE", path: join(outside, "secret.txt") }),
    ).rejects.toThrow(/outside the workspace/i);
    await expect(
      search(new Workspace(root), { pattern: "NEEDLE", path: "src", output_mode: "json" }),
    ).rejects.toThrow(ToolError);
  });

  it("normalizes root, literal metacharacter, and missing path aliases without widening containment", async () => {
    file("root.txt", "NEEDLE root");
    file("src/a.txt", "NEEDLE source");
    file("src/deep/b.txt", "NEEDLE nested");
    file("src/c.md", "NEEDLE md");
    file("src/a*b.txt", "NEEDLE literal-star");
    file("src/ab.txt", "NEEDLE widened-if-star-glob");
    file("src/name[old].txt", "NEEDLE literal-brackets");
    file("src/nameo.txt", "NEEDLE widened-if-bracket-glob");
    file("src/brace{one}.txt", "NEEDLE literal-brace");
    file("src/braceone.txt", "NEEDLE widened-if-brace-glob");

    const rootScoped = await search(new Workspace(root), { pattern: "NEEDLE", path: "." });
    expect(rootScoped).toContain("root.txt");
    expect(rootScoped).toContain("src/a.txt");

    const literalStarScoped = await search(new Workspace(root), {
      pattern: "NEEDLE",
      path: "src/a*b.txt",
    });
    expect(literalStarScoped).toContain("src/a*b.txt");
    expect(literalStarScoped).not.toContain("src/ab.txt");
    expect(literalStarScoped).not.toContain("src/a.txt");

    const literalBracketScoped = await search(new Workspace(root), {
      pattern: "NEEDLE",
      path: "src/name[old].txt",
    });
    expect(literalBracketScoped).toContain("src/name[old].txt");
    expect(literalBracketScoped).not.toContain("src/nameo.txt");

    const literalBraceScoped = await search(new Workspace(root), {
      pattern: "NEEDLE",
      path: "src/brace{one}.txt",
    });
    expect(literalBraceScoped).toContain("src/brace{one}.txt");
    expect(literalBraceScoped).not.toContain("src/braceone.txt");

    await expect(
      search(new Workspace(root), { pattern: "NEEDLE", path: "missing.txt" }),
    ).resolves.toBe("search: no matches.");
  });

  it("reports no matches cleanly (rg exit 1 is not an error)", async () => {
    file("a.txt", "nothing");
    expect(await search(new Workspace(root), { pattern: "ZZZ" })).toMatch(/no matches/i);
  });

  it("parses a path/match containing a colon and unicode (the --json reason)", async () => {
    file("od:d.txt", "café NEEDLE");
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    expect(out).toContain("od:d.txt");
    expect(out).toContain("NEEDLE");
  });

  it("escapes control characters in content result paths before model-visible output", async () => {
    file("src/evil\nfake.txt", "NEEDLE");
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: () => {
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          stdout.emit(
            "data",
            `${JSON.stringify({
              type: "match",
              data: {
                path: { text: "src/evil\nfake.txt" },
                line_number: 1,
                lines: { text: "NEEDLE\n" },
                submatches: [{ start: 0 }],
              },
            })}\n`,
          );
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    const out = await (tool.handler({ pattern: "NEEDLE" }) as Promise<string>);
    expect(out).toBe('"src/evil\\nfake.txt":1:1:NEEDLE');
    expect(out).not.toContain("src/evil\nfake.txt");
  });

  it("treats a leading-dash pattern as a literal (no flag injection)", async () => {
    file("a.txt", "x -n y");
    // With `--`, rg searches for the literal "-n", not the -n flag; must not throw an arg error.
    const out = await search(new Workspace(root), { pattern: "-n" });
    expect(out).toMatch(/a\.txt/);
  });

  it("maps a ripgrep error (invalid regex) to a ToolError, exit-2", async () => {
    file("a.txt", "x");
    await expect(search(new Workspace(root), { pattern: "(" })).rejects.toThrow(ToolError);
  });

  it("caps results and shows an 'N+ more' notice", async () => {
    file("a.txt", Array.from({ length: 50 }, (_, i) => `NEEDLE ${String(i)}`).join("\n"));
    const out = await search(new Workspace(root), { pattern: "NEEDLE", maxResults: 5 });
    expect(out.split("\n").filter((l) => l.includes("NEEDLE")).length).toBe(5);
    expect(out).toMatch(/more/i);
  });

  it("excludes a denied root (the keel config dir) from content + filename results (HON-1)", async () => {
    mkdirSync(join(root, "keelcfg"));
    writeFileSync(join(root, "keelcfg", "credentials.json"), '{"anthropic":"sk-ant-SUPERSECRET"}');
    file("app.ts", "const k = 'sk-ant-SUPERSECRET';");
    const ws = new Workspace(root, { deniedRoots: [join(root, "keelcfg")] });
    const content = await search(ws, { pattern: "sk-ant-SUPERSECRET" });
    expect(content).toContain("app.ts"); // a real workspace match still shows
    expect(content).not.toContain("credentials.json"); // the protected config dir is excluded
    const names = await search(ws, { pattern: "*.json", kind: "filename" });
    expect(names).not.toContain("credentials.json");
  });

  it("does not traverse a symlink that escapes the workspace (rg no-follow default)", async () => {
    // Decoy inside the workspace: proves search still works (not a false-green from zero searches).
    file("visible.txt", "NEEDLE inside");
    // Secret outside the workspace, linked in via a directory symlink.
    writeFileSync(join(outside, "secret.txt"), "NEEDLE outside");
    symlinkSync(outside, join(root, "link"));
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    // The in-workspace file IS found.
    expect(out).toContain("visible.txt");
    // The outside file is NOT reachable via the symlink.
    expect(out).not.toMatch(/secret/);
  });

  it("returns no matches (not an error) when workspace contains only symlinks (exit-2 searches=0)", async () => {
    // rg exits 2 with searches=0 when the only entries are symlinks it won't follow.
    writeFileSync(join(outside, "secret.txt"), "NEEDLE outside");
    symlinkSync(outside, join(root, "link"));
    // No in-workspace files: rg searches nothing and exits 2 with a summary showing searches=0.
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    expect(out).toMatch(/no matches/i);
  });

  it("ignores an external RIPGREP_CONFIG_PATH (no config inheritance)", async () => {
    file("a.txt", "NEEDLE");
    // A REAL config that, if honored, would exclude *.txt and hide the match. Clearing the env var
    // means rg ignores it and still finds the match — so this FAILS if the env-clearing is removed
    // (the denied path actually denies, per the security bar).
    const cfg = join(outside, "ripgrep.config");
    writeFileSync(cfg, "--glob=!*.txt\n");
    const prev = process.env["RIPGREP_CONFIG_PATH"];
    process.env["RIPGREP_CONFIG_PATH"] = cfg;
    try {
      expect(await search(new Workspace(root), { pattern: "NEEDLE" })).toContain("a.txt");
    } finally {
      if (prev === undefined) delete process.env["RIPGREP_CONFIG_PATH"];
      else process.env["RIPGREP_CONFIG_PATH"] = prev;
    }
  });

  it("rejects bad args (missing pattern)", async () => {
    await expect(search(new Workspace(root), {})).rejects.toThrow(ToolError);
  });
});

describe("search tool — filename", () => {
  it("lists files matching a glob", async () => {
    file("src/a.ts", "x");
    file("src/b.js", "x");
    const out = await search(new Workspace(root), { pattern: "*.ts", kind: "filename" });
    expect(out).toContain("a.ts");
    expect(out).not.toContain("b.js");
  });

  it("escapes control characters in filename result paths before model-visible output", async () => {
    file("src/\u001b[31mred.txt", "x");
    let seenArgs: string[] | undefined;
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: (_cmd, args) => {
        seenArgs = args;
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          stdout.emit("data", "src/\u001b[31mred.txt\0");
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    const out = await (tool.handler({
      pattern: "src/**",
      kind: "filename",
    }) as Promise<string>);
    expect(out).toBe('"src/\\u001b[31mred.txt"');
    expect(out).not.toContain("\u001b");
    expect(seenArgs).toContain("--null");
  });

  it("keeps newline and control-character filenames as single escaped filename results", async () => {
    const names = [
      "visible\nFAKE.txt",
      "tab\tname.txt",
      "carriage\rname.txt",
      "term\u001b[31mred.txt",
    ];
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "fake-rg",
      spawn: () => {
        const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          kill: () => true,
        });
        setImmediate(() => {
          stdout.emit("data", `${names.join("\0")}\0`);
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    });

    const out = await (tool.handler({ pattern: "**", kind: "filename" }) as Promise<string>);
    expect(out.split("\n")).toEqual([
      '"visible\\nFAKE.txt"',
      '"tab\\tname.txt"',
      '"carriage\\rname.txt"',
      '"term\\u001b[31mred.txt"',
    ]);
    expect(out).not.toContain("visible\nFAKE.txt");
    expect(out).not.toContain("\u001b");
  });

  it("rejects content-only glob scoping in filename mode instead of ignoring it", async () => {
    file("src/a.ts", "x");
    await expect(
      search(new Workspace(root), { pattern: "*.ts", kind: "filename", glob: "src/**" }),
    ).rejects.toThrow(/glob is only supported for content searches/i);
  });

  it("keeps filename inventories on ripgrep's visible file set before applying the requested glob", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    file(".gitignore", "packages/**/dist/\n.DS_Store\n.env\n");
    file("packages/.DS_Store", "NEEDLE hidden os file");
    file("packages/eval/dist/index.js", "NEEDLE ignored build output");
    file("packages/eval/src/index.ts", "NEEDLE source");
    file(".env", "NEEDLE secret");

    const names = await search(new Workspace(root), { pattern: "packages/**", kind: "filename" });
    expect(names).toContain("packages/eval/src/index.ts");
    expect(names).not.toContain(".DS_Store");
    expect(names).not.toContain("dist/index.js");

    const content = await search(new Workspace(root), { pattern: "NEEDLE", glob: "packages/**" });
    expect(content).toContain("packages/eval/src/index.ts");
    expect(content).not.toContain(".DS_Store");
    expect(content).not.toContain("dist/index.js");
    expect(content).not.toContain(".env");
  });
});

describe("search tool — spawn-error branch (injection seam)", () => {
  it("maps a spawn ENOENT to a ToolError via the error event", async () => {
    // Build a minimal fake ChildProcess that emits 'error' asynchronously.
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const fakeChild = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: () => undefined,
    });

    const ws = new Workspace(root);
    const tool = createSearchTool(ws, {
      spawn: () => {
        setImmediate(() => fakeChild.emit("error", new Error("ENOENT: spawn failed")));
        return fakeChild as unknown as ChildProcess;
      },
    });
    await expect(tool.handler({ pattern: "x" }) as Promise<string>).rejects.toThrow(
      "search: cannot run ripgrep: ENOENT: spawn failed",
    );
  });

  it("fails before spawn with one recovery action when bundled ripgrep is unavailable", async () => {
    const spawn = vi.fn();
    const tool = createSearchTool(new Workspace(root), { rgPath: null, spawn });

    await expect(tool.handler({ pattern: "x" }) as Promise<string>).rejects.toThrow(
      "search: bundled ripgrep is unavailable — run `keel doctor` for one repair action",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("search tool — minimal child env (EXEC-2) + cancellation/timeout (EXEC-1)", () => {
  const fake = () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    let killed = 0;
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: () => {
        killed++;
        return true;
      },
    });
    return { child, stdout, stderr, killed: () => killed };
  };
  const run = (tool: ReturnType<typeof createSearchTool>, signal?: AbortSignal): Promise<string> =>
    (tool.handler as (r: JsonObjectT, o?: { signal?: AbortSignal }) => Promise<string>)(
      { pattern: "x" },
      signal !== undefined ? { signal } : undefined,
    );

  it.each([
    { code: null, signal: "SIGKILL" as NodeJS.Signals, message: /terminated by SIGKILL/i },
    { code: null, signal: null, message: /without an exit code/i },
    { code: 7, signal: null, message: /unexpected exit 7/i },
  ])("rejects abnormal ripgrep termination instead of reporting no matches: %o", async (event) => {
    const f = fake();
    const tool = createSearchTool(new Workspace(root), {
      spawn: () => {
        setImmediate(() => f.child.emit("close", event.code, event.signal));
        return f.child as unknown as ChildProcess;
      },
    });

    await expect(run(tool)).rejects.toThrow(event.message);
  });

  it("spawns ripgrep with a minimal env — host secrets in process.env are NOT inherited (EXEC-2)", async () => {
    const f = fake();
    let env: NodeJS.ProcessEnv | undefined;
    const tool = createSearchTool(new Workspace(root), {
      spawn: (_cmd, _args, opts) => {
        env = opts.env;
        setImmediate(() => f.child.emit("close", 1));
        return f.child as unknown as ChildProcess;
      },
    });
    await run(tool);
    // Only PATH + locale reach the child — no inherited API key or arbitrary host env (cf. the shell's
    // own minimal env). RIPGREP_CONFIG_PATH is excluded by omission.
    expect(Object.keys(env ?? {}).sort()).toEqual(["LANG", "LC_ALL", "PATH"]);
  });

  it("kills the rg child and rejects when the user abort signal fires mid-search (EXEC-1)", async () => {
    const f = fake();
    const ac = new AbortController();
    const tool = createSearchTool(new Workspace(root), {
      // Never emit 'close' — only the abort should settle the run.
      spawn: () => {
        setImmediate(() => ac.abort());
        return f.child as unknown as ChildProcess;
      },
    });
    await expect(run(tool, ac.signal)).rejects.toThrow(ToolError);
    expect(f.killed()).toBeGreaterThan(0);
  });

  it("kills the rg child and rejects when the user abort signal is already fired", async () => {
    const f = fake();
    const ac = new AbortController();
    ac.abort();
    const tool = createSearchTool(new Workspace(root), {
      spawn: () => f.child as unknown as ChildProcess,
    });

    await expect(run(tool, ac.signal)).rejects.toThrow(ToolError);
    expect(f.killed()).toBeGreaterThan(0);
  });

  it("kills the rg child and rejects when the wall-clock timeout elapses (EXEC-1)", async () => {
    const f = fake();
    const tool = createSearchTool(new Workspace(root), {
      timeoutMs: 5, // tiny cap; the fake child never closes, so the timeout must fire
      spawn: () => f.child as unknown as ChildProcess,
    });
    await expect(run(tool)).rejects.toThrow(/tim(e|ed) ?out/i);
    expect(f.killed()).toBeGreaterThan(0);
  });

  it("kills the rg child and rejects when one raw stdout line exceeds the control-plane cap", async () => {
    const f = fake();
    const tool = createSearchTool(new Workspace(root), {
      spawn: () => {
        setImmediate(() => f.stdout.emit("data", "x".repeat(SEARCH_MAX_RAW_STDOUT_LINE_BYTES + 1)));
        return f.child as unknown as ChildProcess;
      },
    });

    await expect(run(tool)).rejects.toThrow(/output line exceeded/i);
    expect(f.killed()).toBeGreaterThan(0);
  });

  it("kills the rg child and rejects when stderr exceeds the control-plane cap", async () => {
    const f = fake();
    const tool = createSearchTool(new Workspace(root), {
      spawn: () => {
        setImmediate(() => f.stderr.emit("data", "e".repeat(SEARCH_MAX_STDERR_BYTES + 1)));
        return f.child as unknown as ChildProcess;
      },
    });

    await expect(run(tool)).rejects.toThrow(/stderr exceeded/i);
    expect(f.killed()).toBeGreaterThan(0);
  });
});

describe("resolveRgPath — bundled (npx/dev) vs system rg (standalone binary)", () => {
  it("honors an explicit KEEL_RG_PATH override", () => {
    const loadBundled = (): string => {
      throw new Error("must not resolve a bundled package for an explicit override");
    };
    expect(resolveRgPath({ KEEL_RG_PATH: "/opt/rg" }, () => true, loadBundled)).toBe("/opt/rg");
    // An empty override is ignored (falls through to detection).
    expect(
      resolveRgPath(
        { KEEL_RG_PATH: "" },
        () => true,
        () => "/bundled/rg",
      ),
    ).toBe("/bundled/rg");
  });

  it("uses the bundled @vscode/ripgrep when it exists on disk (npx/dev)", () => {
    expect(
      resolveRgPath(
        {},
        () => true,
        () => "/bundled/rg",
      ),
    ).toBe("/bundled/rg");
  });

  it.each([
    {
      label: "the platform package is not installed",
      exists: () => true,
      loadBundled: () => {
        throw Object.assign(new Error("missing optional package"), { code: "MODULE_NOT_FOUND" });
      },
    },
    {
      label: "the resolved bundled binary is absent",
      exists: () => false,
      loadBundled: () => "/missing/bundled/rg",
    },
  ])("fails closed instead of consulting PATH when $label", ({ exists, loadBundled }) => {
    expect(resolveRgPath({}, exists, loadBundled)).toBeUndefined();
  });

  it("uses system rg only for the explicit standalone-binary carrier", () => {
    expect(
      resolveRgPath(
        {},
        () => {
          throw new Error("must not probe a bundled path for the standalone carrier");
        },
        () => {
          throw new Error("must not load a bundled package for the standalone carrier");
        },
        true,
      ),
    ).toBe("rg");
  });
});

describe("search tool — uses the resolved rg path", () => {
  it("spawns the rg binary from deps.rgPath", async () => {
    const calls: string[] = [];
    const stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
    const fakeChild = Object.assign(new EventEmitter(), { stdout, stderr, kill: () => undefined });
    const tool = createSearchTool(new Workspace(root), {
      rgPath: "/custom/path/rg",
      spawn: (cmd) => {
        calls.push(cmd);
        setImmediate(() => fakeChild.emit("close", 1)); // exit 1 = no matches
        return fakeChild as unknown as ChildProcess;
      },
    });
    await tool.handler({ pattern: "x" });
    expect(calls).toEqual(["/custom/path/rg"]);
  });
});

describe("parseRgMatch (unit — branch coverage)", () => {
  it("returns null for a non-match line, blank line, and malformed JSON", () => {
    expect(parseRgMatch("")).toBeNull();
    expect(parseRgMatch('{"type":"begin","data":{}}')).toBeNull();
    expect(parseRgMatch("not json")).toBeNull();
  });

  it("formats a match line as path:line:col:text", () => {
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "f.txt" },
        line_number: 7,
        lines: { text: "the MATCH\n" },
        submatches: [{ start: 4 }],
      },
    });
    expect(parseRgMatch(line)).toBe("f.txt:7:5:the MATCH");
  });

  it("byte-caps a single very wide matched line, with a marker (F1 per-line bound)", () => {
    const wide = "x".repeat(SEARCH_MAX_LINE_BYTES * 4); // a 4×-over-cap matched line
    const line = JSON.stringify({
      type: "match",
      data: {
        path: { text: "wide.csv" },
        line_number: 1,
        lines: { text: `NEEDLE,${wide}\n` },
        submatches: [{ start: 0 }],
      },
    });
    const out = parseRgMatch(line);
    expect(out).not.toBeNull();
    // The full match string stays within the per-line cap (+ a small allowance for the prefix/marker).
    expect(Buffer.byteLength(out as string, "utf8")).toBeLessThanOrEqual(
      SEARCH_MAX_LINE_BYTES + 64,
    );
    expect(out).toContain("wide.csv:1:1:");
    expect(out).toMatch(/line truncated/i);
  });
});

describe("search tool — output byte bounds (F1: wide-row budget-bomb regression)", () => {
  it("byte-caps a single very wide matched line so one match can't blow the input budget", async () => {
    // The sanitize-git-repo pathology: a wide single-line CSV — one match returned 284 KB uncapped.
    const wide = "NEEDLE," + "x".repeat(300_000);
    file("wide.csv", wide + "\n");
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    expect(out).toContain("wide.csv");
    expect(out).toMatch(/line truncated/i);
    // The whole tool result must be bounded — NOT the raw ~300 KB.
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SEARCH_MAX_LINE_BYTES + 256);
  });

  it("byte-caps total output across many wide matches (total-output backstop)", async () => {
    // 200 matches each ~2 KB → ~400 KB pre-cap; the total backstop must bound the tool result.
    const lines = Array.from(
      { length: 200 },
      (_, i) => `NEEDLE ${String(i)} ` + "y".repeat(2_000),
    ).join("\n");
    file("many.txt", lines);
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SEARCH_MAX_OUTPUT_BYTES + 1_024);
  });

  it("leaves normal (within-cap) results untouched", async () => {
    file("a.txt", "hello\nNEEDLE here\n");
    const out = await search(new Workspace(root), { pattern: "NEEDLE" });
    expect(out).toBe("a.txt:2:1:NEEDLE here");
  });
});
