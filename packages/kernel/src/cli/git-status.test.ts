import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRunner, gitStatusAsync, type GitRunAsync } from "./git-status.js";

/** A fake git runner keyed by the joined args for deterministic parser and concurrency tests. */
const fakeRun =
  (map: Record<string, string | undefined>): GitRunAsync =>
  async (args) =>
    map[args.join(" ")];

describe("gitStatus — cockpit git segment (fail-soft, injectable runner)", () => {
  it("parses branch + porcelain change counts (added incl. untracked, modified, deleted)", async () => {
    const g = await gitStatusAsync(
      "/w",
      fakeRun({
        "rev-parse --abbrev-ref HEAD": "main\n",
        "status --porcelain": " M a.ts\nA  b.ts\n?? c.ts\n D d.ts\nR  e.ts -> f.ts\n",
      }),
    );
    // ` M`→modified · `A `→added · `??`→added(untracked) · ` D`→deleted · `R `→modified(rename)
    expect(g).toEqual({ branch: "main", added: 2, modified: 2, deleted: 1 });
  });

  it("a clean repo reports the branch with zero counts", async () => {
    const g = await gitStatusAsync(
      "/w",
      fakeRun({ "rev-parse --abbrev-ref HEAD": "main\n", "status --porcelain": "" }),
    );
    expect(g).toEqual({ branch: "main", added: 0, modified: 0, deleted: 0 });
  });

  it("fail-soft: not a repo / git absent (runner returns undefined for everything) → undefined, no throw", async () => {
    await expect(gitStatusAsync("/w", async () => undefined)).resolves.toBeUndefined();
  });

  it("a detached HEAD (rev-parse returns the literal 'HEAD', as real git does) reports counts and omits the branch (CLI-5)", async () => {
    const g = await gitStatusAsync(
      "/w",
      fakeRun({ "rev-parse --abbrev-ref HEAD": "HEAD\n", "status --porcelain": "A  x.ts\n" }),
    );
    expect(g).toEqual({ added: 1, modified: 0, deleted: 0 });
    expect(g?.branch).toBeUndefined(); // not the confusing literal "HEAD"
  });

  it("launches branch and porcelain probes concurrently", async () => {
    const calls: string[] = [];
    const releases = new Map<string, (value: string | undefined) => void>();
    const run: GitRunAsync = (args) => {
      const key = args.join(" ");
      calls.push(key);
      return new Promise((resolve) => releases.set(key, resolve));
    };

    const pending = gitStatusAsync("/w", run);

    expect(calls).toEqual(["rev-parse --abbrev-ref HEAD", "status --porcelain"]);
    releases.get("status --porcelain")?.(" M a.ts\n?? b.ts\n");
    releases.get("rev-parse --abbrev-ref HEAD")?.("feature/async-startup\n");

    await expect(pending).resolves.toEqual({
      branch: "feature/async-startup",
      added: 1,
      modified: 1,
      deleted: 0,
    });
  });

  it("fails soft when both asynchronous probes fail", async () => {
    await expect(gitStatusAsync("/w", async () => undefined)).resolves.toBeUndefined();
  });

  it("omits git status when the porcelain probe fails instead of implying a clean tree", async () => {
    await expect(
      gitStatusAsync(
        "/w",
        fakeRun({ "rev-parse --abbrev-ref HEAD": "main\n", "status --porcelain": undefined }),
      ),
    ).resolves.toBeUndefined();
  });

  it("fails soft when an asynchronous runner rejects", async () => {
    await expect(
      gitStatusAsync("/w", async () => {
        throw new Error("spawn failed");
      }),
    ).resolves.toBeUndefined();
  });

  it("uses the bounded production runner for a real repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-git-status-real-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "pipe" });
      writeFileSync(join(dir, "tracked.txt"), "fixture\n", "utf8");
      execFileSync("git", ["add", "tracked.txt"], { cwd: dir, stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Keel Test",
          "-c",
          "user.email=keel-test@example.invalid",
          "commit",
          "-qm",
          "fixture",
        ],
        { cwd: dir, stdio: "pipe" },
      );
      writeFileSync(join(dir, "untracked.txt"), "fixture\n", "utf8");

      const status = await gitStatusAsync(dir);

      expect(status).toBeDefined();
      expect(status?.added).toBe(1);
      expect(status?.modified).toBe(0);
      expect(status?.deleted).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails soft when the production runner cannot enter the workspace", async () => {
    await expect(
      gitStatusAsync("/this/path/does/not/exist/keel-git-status"),
    ).resolves.toBeUndefined();
  });

  it("disables optional locks and repo-local fsmonitor in the production subprocess", async () => {
    const run = createGitRunner(process.cwd(), {
      command: process.execPath,
      prefixArgs: [
        "-e",
        "process.stdout.write(JSON.stringify({argv:process.argv.slice(1), optional:process.env.GIT_OPTIONAL_LOCKS}))",
        "--",
      ],
    });

    const output = await run(["status", "--porcelain"]);
    expect(JSON.parse(output ?? "{}")).toEqual({
      argv: ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"],
      optional: "0",
    });
  });

  it("does not spawn a production probe when its signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const run = createGitRunner(process.cwd(), { command: "/keel/does-not-exist" });

    await expect(run(["status", "--porcelain"], abort.signal)).resolves.toBeUndefined();
  });

  it("fails soft when a production probe exceeds its bounded output budget", async () => {
    const run = createGitRunner(process.cwd(), {
      command: process.execPath,
      prefixArgs: ["-e", 'process.stdout.write("x".repeat(256 * 1024 + 1))', "--"],
      timeoutMs: 5_000,
    });

    await expect(run(["status", "--porcelain"])).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "aborts the complete detached probe group, including a TERM-resistant descendant",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-git-probe-group-"));
      const pidFile = join(dir, "descendant.pid");
      let descendantPid: number | undefined;
      try {
        const script = `
          const {spawn}=require("node:child_process");
          const {writeFileSync}=require("node:fs");
          const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
          writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
          process.on("SIGTERM",()=>{});
          setInterval(()=>{},1000);
        `;
        const run = createGitRunner(process.cwd(), {
          command: process.execPath,
          prefixArgs: ["-e", script, "--"],
          timeoutMs: 5_000,
        });
        const abort = new AbortController();
        const pending = run(["status", "--porcelain"], abort.signal);
        for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(pidFile)).toBe(true);
        descendantPid = Number(readFileSync(pidFile, "utf8"));

        abort.abort();
        await expect(pending).resolves.toBeUndefined();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(descendantPid, 0);
          } catch {
            descendantPid = undefined;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(descendantPid).toBeUndefined();
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Already reaped.
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps forced group cleanup armed when the probe leader exits before a TERM-resistant descendant",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-git-probe-leader-exit-"));
      const pidFile = join(dir, "descendant.pid");
      const readyFile = join(dir, "descendant.ready");
      let descendantPid: number | undefined;
      try {
        const childScript = `
          const {writeFileSync}=require("node:fs");
          process.on("SIGTERM",()=>{});
          writeFileSync(${JSON.stringify(readyFile)},"ready");
          setInterval(()=>{},1000);
        `;
        const script = `
          const {spawn}=require("node:child_process");
          const {writeFileSync}=require("node:fs");
          const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});
          writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
          setInterval(()=>{},1000);
        `;
        const run = createGitRunner(process.cwd(), {
          command: process.execPath,
          prefixArgs: ["-e", script, "--"],
          timeoutMs: 5_000,
        });
        const abort = new AbortController();
        const pending = run(["status", "--porcelain"], abort.signal);
        for (
          let attempt = 0;
          attempt < 100 && (!existsSync(pidFile) || !existsSync(readyFile));
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(existsSync(pidFile)).toBe(true);
        expect(existsSync(readyFile)).toBe(true);
        descendantPid = Number(readFileSync(pidFile, "utf8"));

        abort.abort();
        await expect(pending).resolves.toBeUndefined();
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            process.kill(descendantPid, 0);
          } catch {
            descendantPid = undefined;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(descendantPid).toBeUndefined();
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Already reaped.
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a short-lived parent alive until forced descendant cleanup fires",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-git-probe-parent-exit-"));
      const pidFile = join(dir, "descendant.pid");
      const readyFile = join(dir, "descendant.ready");
      const runnerFile = join(dir, "runner.mjs");
      let descendantPid: number | undefined;
      try {
        const childScript = `
          const {writeFileSync}=require("node:fs");
          process.on("SIGTERM",()=>{});
          writeFileSync(${JSON.stringify(readyFile)},"ready");
          setInterval(()=>{},1000);
        `;
        const probeScript = `
          const {spawn}=require("node:child_process");
          const {writeFileSync}=require("node:fs");
          const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});
          writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
          setInterval(()=>{},1000);
        `;
        writeFileSync(
          runnerFile,
          `
            import {existsSync} from "node:fs";
            import {createGitRunner} from ${JSON.stringify(new URL("./git-status.ts", import.meta.url).href)};
            const run=createGitRunner(process.cwd(),{
              command:process.execPath,
              prefixArgs:["-e",${JSON.stringify(probeScript)},"--"],
              timeoutMs:5000,
            });
            const abort=new AbortController();
            const pending=run(["status","--porcelain"],abort.signal);
            while(!existsSync(${JSON.stringify(readyFile)})) {
              await new Promise((resolve)=>setTimeout(resolve,10));
            }
            abort.abort();
            await pending;
          `,
        );

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const parent = spawn(process.execPath, ["--import", "tsx", runnerFile], {
            cwd: process.cwd(),
            stdio: "ignore",
          });
          parent.once("error", reject);
          parent.once("close", resolve);
        });
        expect(exitCode).toBe(0);
        descendantPid = Number(readFileSync(pidFile, "utf8"));
        try {
          process.kill(descendantPid, 0);
        } catch {
          descendantPid = undefined;
        }
        expect(descendantPid).toBeUndefined();
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // Already reaped.
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
