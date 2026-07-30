import { describe, expect, it, vi } from "vitest";
import {
  acceptanceContractFromRequiredArtifacts,
  acceptanceContractFromProcessLeases,
  artifactReaderForRoot,
  evaluateAcceptanceContract,
  renderAcceptanceFailurePrompt,
  requiredArtifactsFromEnv,
  type AcceptanceContract,
  type ArtifactReadResult,
} from "./acceptance-contract.js";
import type { PreStopCheck, PreStopCheckResult } from "../prestop-check.js";

const virtualReader =
  (files: Readonly<Record<string, string>>): ((path: string) => Promise<ArtifactReadResult>) =>
  async (path) =>
    Object.hasOwn(files, path) ? { exists: true, content: files[path] ?? "" } : { exists: false };

describe("AcceptanceContract", () => {
  it("blocks only high-confidence missing, empty, whitespace, and placeholder artifacts", async () => {
    const contract: AcceptanceContract = {
      source: "prompt-explicit-path",
      confidence: "high",
      provenance: "explicit visible task path",
      requiredArtifacts: [
        { path: "missing.txt", source: "prompt-explicit-path", confidence: "high" },
        { path: "zero.txt", source: "prompt-explicit-path", confidence: "high" },
        { path: "blank.txt", source: "prompt-explicit-path", confidence: "high" },
        { path: "todo.txt", source: "prompt-explicit-path", confidence: "high" },
        { path: "stub.txt", source: "prompt-explicit-path", confidence: "high" },
        { path: "answer.txt", source: "prompt-explicit-path", confidence: "high" },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      readArtifact: virtualReader({
        "zero.txt": "",
        "blank.txt": " \n\t",
        "todo.txt": "TODO: implement\n",
        "stub.txt": "stub result pending\n",
        "answer.txt": "42\n",
      }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking.map((issue) => issue.kind)).toEqual([
      "required-artifact-missing",
      "required-artifact-empty",
      "required-artifact-empty",
      "required-artifact-placeholder",
      "required-artifact-placeholder",
    ]);
    expect(evaluation.blocking.map((issue) => issue.path)).not.toContain("answer.txt");
  });

  it("warns, but does not block, on advisory artifact evidence", async () => {
    const contract: AcceptanceContract = {
      source: "task-metadata",
      confidence: "advisory",
      provenance: "low-confidence metadata hint",
      requiredArtifacts: [{ path: "report.html", source: "task-metadata", confidence: "advisory" }],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      readArtifact: virtualReader({}),
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.blocking).toEqual([]);
    expect(evaluation.warnings).toMatchObject([
      { kind: "advisory-artifact-not-checked", path: "report.html" },
    ]);
  });

  it("denies model/project/hidden-grader-looking evidence sources as hard-stop evidence", async () => {
    const contract: AcceptanceContract = {
      source: "prompt-explicit-path",
      confidence: "high",
      provenance: "adversarial source-policy fixture",
      requiredArtifacts: [
        {
          path: "answer.txt",
          source: "model-authored-path",
          confidence: "high",
          provenance: "model claimed this path proves completion",
        },
        {
          path: "scripts/pass.sh",
          source: "project-authored-script",
          confidence: "explicit",
          provenance: "project script can fake PASS",
        },
        {
          path: "package.json",
          source: "package-script",
          confidence: "explicit",
          provenance: "project package script can fake PASS",
        },
        {
          path: "/tests/hidden/grade.py",
          source: "prompt-explicit-path",
          confidence: "explicit",
          provenance: "hidden grader path must never be evidence",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      readArtifact: virtualReader({
        "answer.txt": "done\n",
        "scripts/pass.sh": "echo PASS\n",
        "package.json": '{"scripts":{"test":"echo PASS"}}\n',
        "/tests/hidden/grade.py": "print('PASS')\n",
      }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking.map((issue) => issue.kind)).toEqual([
      "artifact-source-denied",
      "artifact-source-denied",
      "artifact-source-denied",
      "artifact-source-denied",
    ]);
  });

  it("denies invalid artifact paths before reading them", async () => {
    const readArtifact = vi.fn(async (): Promise<ArtifactReadResult> => {
      throw new Error("reader should not be called for denied paths");
    });
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredArtifacts: [
        { path: "/tmp/out.txt", source: "operator-config", confidence: "explicit" },
        { path: "../out.txt", source: "operator-config", confidence: "explicit" },
        { path: "artifacts/*.html", source: "operator-config", confidence: "explicit" },
        { path: "foo?.txt", source: "operator-config", confidence: "explicit" },
        { path: "[ab].txt", source: "operator-config", confidence: "explicit" },
        { path: "{a,b}.txt", source: "operator-config", confidence: "explicit" },
        { path: "hidden/grade.py", source: "operator-config", confidence: "explicit" },
        { path: ".hidden/grade.py", source: "operator-config", confidence: "explicit" },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, { readArtifact });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking.map((issue) => issue.kind)).toEqual([
      "artifact-path-denied",
      "artifact-path-denied",
      "artifact-path-denied",
      "artifact-path-denied",
      "artifact-path-denied",
      "artifact-path-denied",
      "artifact-source-denied",
      "artifact-source-denied",
    ]);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("turns artifact read errors into bounded blocking evidence", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredArtifacts: [
        { path: "unreadable.txt", source: "operator-config", confidence: "explicit" },
        { path: "huge.txt", source: "operator-config", confidence: "explicit" },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      readArtifact: async (path) => {
        if (path === "huge.txt") return { exists: true, tooLarge: true };
        throw new Error("EACCES: permission denied, open unreadable.txt");
      },
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking).toMatchObject([
      { kind: "required-artifact-unreadable", path: "unreadable.txt" },
      { kind: "required-artifact-too-large", path: "huge.txt" },
    ]);
    expect(renderAcceptanceFailurePrompt(contract, evaluation).length).toBeLessThan(1400);
  });

  it("bounds hanging artifact readers as unreadable evidence", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredArtifacts: [{ path: "slow.txt", source: "operator-config", confidence: "explicit" }],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      readTimeoutMs: 1,
      readArtifact: async () => await new Promise<ArtifactReadResult>(() => {}),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking).toMatchObject([
      { kind: "required-artifact-unreadable", path: "slow.txt" },
    ]);
    expect(evaluation.blocking[0]?.detail).toContain("exceeded 1ms");
  });

  it("treats an already-aborted artifact read as unreadable evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredArtifacts: [
        { path: "answer.txt", source: "operator-config", confidence: "explicit" },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      signal: controller.signal,
      readArtifact: async () => {
        throw new Error("aborted reads should not call the artifact reader");
      },
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking).toMatchObject([
      { kind: "required-artifact-unreadable", detail: "artifact read was aborted" },
    ]);
  });

  it("treats an in-flight aborted artifact read as unreadable evidence", async () => {
    const controller = new AbortController();
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredArtifacts: [
        { path: "answer.txt", source: "operator-config", confidence: "explicit" },
      ],
    };

    const evaluationPromise = evaluateAcceptanceContract(contract, {
      signal: controller.signal,
      readTimeoutMs: 5_000,
      readArtifact: async () => await new Promise<ArtifactReadResult>(() => {}),
    });
    controller.abort();

    await expect(evaluationPromise).resolves.toMatchObject({
      ok: false,
      blocking: [{ kind: "required-artifact-unreadable", detail: "artifact read was aborted" }],
    });
  });

  it("uses the default reader safely for missing relative artifacts", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredArtifacts: [
        {
          path: "missing-default-reader-artifact.txt",
          source: "operator-config",
          confidence: "explicit",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract);

    expect(evaluation.blocking).toMatchObject([
      { kind: "required-artifact-missing", path: "missing-default-reader-artifact.txt" },
    ]);
  });

  it("reads only regular workspace-contained artifacts from a rooted reader", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-acceptance-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "keel-acceptance-outside-"));
    fs.writeFileSync(path.join(root, "answer.txt"), "42\n");
    fs.writeFileSync(path.join(outside, "hidden.txt"), "secret\n");
    fs.writeFileSync(path.join(outside, "answer.txt"), "outside\n");
    fs.symlinkSync(path.join(outside, "hidden.txt"), path.join(root, "linked.txt"));
    fs.symlinkSync(path.join(root, "answer.txt"), path.join(root, "local-linked.txt"));
    fs.symlinkSync(outside, path.join(root, "linked-dir"), "dir");
    fs.writeFileSync(path.join(root, "huge.txt"), "x".repeat(70 * 1024));
    const readArtifact = artifactReaderForRoot(root);

    expect(await readArtifact("answer.txt")).toMatchObject({ exists: true, content: "42\n" });
    const outsideResult = await readArtifact("../keel-acceptance-outside/hidden.txt");
    expect(outsideResult.exists).toBe(false);
    expect(outsideResult.unreadableReason).toMatch(/outside/i);
    const absoluteResult = await readArtifact(path.join(outside, "hidden.txt"));
    expect(absoluteResult.exists).toBe(false);
    expect(absoluteResult.unreadableReason).toMatch(/absolute/i);
    const linkedResult = await readArtifact("linked.txt");
    expect(linkedResult.exists).toBe(true);
    expect(linkedResult.unreadableReason).toMatch(/outside/i);
    const localLinkedResult = await readArtifact("local-linked.txt");
    expect(localLinkedResult.exists).toBe(true);
    expect(localLinkedResult.unreadableReason).toMatch(/symbolic link/i);
    const linkedDirResult = await readArtifact("linked-dir/answer.txt");
    expect(linkedDirResult.exists).toBe(true);
    expect(linkedDirResult.unreadableReason).toMatch(/outside/i);
    expect(await readArtifact("huge.txt")).toMatchObject({
      exists: true,
      tooLarge: true,
    });
    const rootResult = await readArtifact("");
    expect(rootResult.exists).toBe(true);
    expect(rootResult.unreadableReason).toMatch(/regular file/i);
  });

  it("fails closed if an artifact path changes between realpath and open", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-acceptance-race-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "keel-acceptance-race-outside-"));
    const raceDir = path.join(root, "race");
    fs.mkdirSync(raceDir);
    fs.writeFileSync(path.join(raceDir, "answer.txt"), "inside\n");
    fs.writeFileSync(path.join(outside, "answer.txt"), "outside\n");
    const readArtifact = artifactReaderForRoot(root, {
      beforeOpen: async () => {
        fs.rmSync(raceDir, { recursive: true, force: true });
        fs.symlinkSync(outside, raceDir, "dir");
      },
    });

    const result = await readArtifact("race/answer.txt");

    expect(result.exists).toBe(true);
    expect(result.content).toBeUndefined();
    expect(result.unreadableReason).toMatch(/changed while opening/i);
  });

  it("caps direct acceptance contracts by artifact count before reading", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "oversized contract fixture",
      requiredArtifacts: Array.from({ length: 33 }, (_, index) => ({
        path: `artifact-${String(index)}.txt`,
        source: "operator-config" as const,
        confidence: "explicit" as const,
      })),
    };
    const evaluation = await evaluateAcceptanceContract(contract, {
      readArtifact: async () => {
        throw new Error("reader should not be called for an oversized acceptance contract");
      },
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "acceptance-contract-too-many-artifacts",
        path: "[acceptance contract]",
      },
    ]);
  });

  it("runs explicit operator acceptance commands through bounded command runners", async () => {
    const seenChecks: PreStopCheck[] = [];
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python -m pytest -q", timeoutMs: 2500, maxOutputBytes: 4096 },
          source: "operator-config",
          confidence: "explicit",
          provenance: "operator supplied KEEL_PRESTOP_CHECK_CMD",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async (check) => {
        seenChecks.push(check);
        return commandResult({ ok: true, output: "2 passed" });
      },
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.receiptStatus).toBe("VERIFIED");
    expect(seenChecks).toEqual([
      { command: "python -m pytest -q", timeoutMs: 2500, maxOutputBytes: 4096 },
    ]);
  });

  it("verifies named configurations only when successful commands cover each one", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      claimedConfigurations: ["world_size=2", "world_size=4"],
      requiredCommands: [
        {
          check: { command: "WORLD_SIZE=2 pytest -q" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
          coversConfigurations: ["world_size=2"],
        },
        {
          check: { command: "WORLD_SIZE=4 pytest -q" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
          coversConfigurations: ["world_size=4"],
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "passed" }),
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.receiptStatus).toBe("VERIFIED");
  });

  it("marks a claimed configuration NOT_RUN when no successful command covers it", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      claimedConfigurations: ["world_size=2", "world_size=4"],
      requiredCommands: [
        {
          check: { command: "WORLD_SIZE=2 pytest -q" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
          coversConfigurations: ["world_size=2"],
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "passed" }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "claimed-configuration-not-run",
        path: "world_size=4",
        detail:
          "claimed configuration was not covered by a successful authoritative acceptance command",
      },
    ]);
    const prompt = renderAcceptanceFailurePrompt(contract, evaluation);
    expect(prompt).toContain("world_size=4");
    expect(prompt).toContain("Run or add an operator-approved acceptance command");
  });

  it("uses full configuration identity, not the truncated display label", async () => {
    const covered = `cfg=${"x".repeat(200)}A`;
    const claimed = `cfg=${"x".repeat(200)}B`;
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      claimedConfigurations: [claimed],
      requiredCommands: [
        {
          check: { command: "pytest -q" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
          coversConfigurations: [covered],
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "passed" }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "claimed-configuration-not-run",
      },
    ]);
    expect(evaluation.blocking[0]?.path).toMatch(/^cfg=x+\.\.\.$/u);
  });

  it("deduplicates claimed configurations before reporting NOT_RUN", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      claimedConfigurations: ["world_size=4", " world_size=4\n"],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "passed" }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "claimed-configuration-not-run",
        path: "world_size=4",
      },
    ]);
  });

  it("does not count liveness commands as claimed-configuration verification", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      claimedConfigurations: ["world_size=2"],
      requiredCommands: [
        {
          check: { command: "curl -fsS http://127.0.0.1:8000/health" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "liveness",
          coversConfigurations: ["world_size=2"],
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "healthy" }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "claimed-configuration-not-run",
        path: "world_size=2",
      },
    ]);
  });

  it("bounds covered configuration labels across required commands", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      claimedConfigurations: ["world_size=2"],
      requiredCommands: [
        {
          check: { command: "pytest -q" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
          coversConfigurations: Array.from(
            { length: 33 },
            (_, index) => `world_size=${String(index)}`,
          ),
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "passed" }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "acceptance-contract-too-many-configurations",
        path: "[acceptance contract]",
      },
    ]);
  });

  it("blocks required commands as NOT_RUN when no verifier runner is available", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python -m pytest -q" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract);

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "acceptance-command-not-run",
        path: "python -m pytest -q",
      },
    ]);
    expect(evaluation.blocking[0]?.detail).toContain("runner");
  });

  it("turns failed acceptance commands into FAILED receipt evidence", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python verify.py", timeoutMs: 1000 },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () =>
        commandResult({
          ok: false,
          exitCode: 2,
          output: "ModuleNotFoundError: No module named 'pytest'",
        }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("FAILED");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "acceptance-command-failed",
        path: "python verify.py",
      },
    ]);
    expect(evaluation.blocking[0]?.detail).toContain("exit code 2");
  });

  it("blocks an empty successful verifier only when the contract requires output", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python verify_content.py" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
          requireNonEmptyOutput: true,
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "" }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("FAILED");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "acceptance-command-failed",
        path: "python verify_content.py",
      },
    ]);
    expect(evaluation.blocking[0]?.detail).toMatch(/produced no output/i);
  });

  it("keeps silent exit-status-only verifier success valid by default", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "test -s artifact.bin" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => commandResult({ ok: true, output: "" }),
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.receiptStatus).toBe("VERIFIED");
  });

  it("keeps executed verifier missing-file/library failures as FAILED, not NOT_RUN", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python verify.py", timeoutMs: 1000 },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    for (const output of [
      "FileNotFoundError: [Errno 2] No such file or directory: 'expected.json'",
      "ImportError: libcompcert.so: cannot open shared object file: No such file or directory",
    ]) {
      const evaluation = await evaluateAcceptanceContract(contract, {
        runCommand: async () =>
          commandResult({
            ok: false,
            exitCode: 1,
            output,
          }),
      });

      expect(evaluation.ok).toBe(false);
      expect(evaluation.receiptStatus).toBe("FAILED");
      expect(evaluation.blocking).toMatchObject([
        {
          kind: "acceptance-command-failed",
          path: "python verify.py",
        },
      ]);
    }
  });

  it("keeps executed verifier command exit 126/127 failures as FAILED unless the runner itself was unavailable", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python verify.py", timeoutMs: 1000 },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    for (const result of [
      commandResult({
        ok: false,
        exitCode: 127,
        output: "linker failed: cannot find -lcompcert",
      }),
      commandResult({
        ok: false,
        exitCode: 126,
        output: "verifier failed after loading project configuration",
      }),
      commandResult({
        ok: false,
        exitCode: 127,
        output: "verifier executed: permission denied while opening expected fixture",
      }),
      commandResult({
        ok: false,
        exitCode: 126,
        output: "bad interpreter reported by verifier fixture after startup",
      }),
    ]) {
      const evaluation = await evaluateAcceptanceContract(contract, {
        runCommand: async () => result,
      });

      expect(evaluation.ok).toBe(false);
      expect(evaluation.receiptStatus).toBe("FAILED");
      expect(evaluation.blocking).toMatchObject([
        {
          kind: "acceptance-command-failed",
          path: "python verify.py",
        },
      ]);
    }
  });

  it("turns command runner exceptions into NOT_RUN evidence and guidance", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python verify.py" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () => await Promise.reject(new Error("python is not installed")),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      { kind: "acceptance-command-not-run", path: "python verify.py" },
    ]);
    const prompt = renderAcceptanceFailurePrompt(contract, evaluation);
    expect(prompt).toContain("Receipt: NOT_RUN");
    expect(prompt).toContain("Provision the required fresh verifier context");
  });

  it("classifies shell-level unavailable verifier commands as NOT_RUN", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "python3 verify.py" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
        {
          check: { command: "./verify.sh" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async (check) =>
        check.command === "python3 verify.py"
          ? commandResult({ ok: false, exitCode: 127, output: "sh: python3: command not found" })
          : commandResult({
              ok: false,
              exitCode: 126,
              output: "sh: ./verify.sh: Permission denied",
            }),
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      { kind: "acceptance-command-not-run", path: "python3 verify.py" },
      { kind: "acceptance-command-not-run", path: "./verify.sh" },
    ]);
    expect(evaluation.blocking[0]?.detail).toContain("unavailable");
    expect(renderAcceptanceFailurePrompt(contract, evaluation)).toContain(
      "Provision the required fresh verifier context",
    );
  });

  it("reports timed-out and signalled command failures without converting them to NOT_RUN", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "slow-check", timeoutMs: 100 },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
        {
          check: { command: "killed-check" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "liveness",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async (check) =>
        check.command === "slow-check"
          ? commandResult({ ok: false, timedOut: true, exitCode: null, output: "" })
          : commandResult({
              ok: false,
              exitCode: null,
              signal: "SIGTERM",
              output: "terminated",
              truncated: true,
            }),
    });

    expect(evaluation.receiptStatus).toBe("FAILED");
    expect(evaluation.blocking[0]?.detail).toContain("timed out after 100ms");
    expect(evaluation.blocking[1]?.detail).toContain("signal SIGTERM");
    expect(evaluation.blocking[1]?.detail).toContain("output truncated");
  });

  it("reports ambiguous command failures with no output as FAILED evidence", async () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "ambiguous-check" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, {
      runCommand: async () =>
        commandResult({ ok: false, exitCode: null, signal: null, output: "" }),
    });

    expect(evaluation.receiptStatus).toBe("FAILED");
    expect(evaluation.blocking[0]?.detail).toContain("failed before exit");
    expect(evaluation.blocking[0]?.detail).toContain("(no output)");
  });

  it("rejects invalid command strings before invoking a runner", async () => {
    const runner = vi.fn(async () => commandResult({ ok: true }));
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator config",
      requiredCommands: [
        {
          check: { command: "" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
        {
          check: { command: "x".repeat(2_001) },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
        {
          check: { command: "bad\u0000command" },
          source: "operator-config",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, { runCommand: runner });

    expect(runner).not.toHaveBeenCalled();
    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking.map((issue) => issue.kind)).toEqual([
      "acceptance-command-not-run",
      "acceptance-command-not-run",
      "acceptance-command-not-run",
    ]);
    expect(evaluation.blocking.map((issue) => issue.detail)).toEqual([
      "acceptance command is empty",
      "acceptance command is too long",
      "acceptance command contains control characters",
    ]);
  });

  it("caps direct acceptance contracts by command count before running them", async () => {
    const runner = vi.fn(async () => commandResult({ ok: true }));
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "oversized command contract fixture",
      requiredCommands: Array.from({ length: 9 }, (_, index) => ({
        check: { command: `check-${String(index)}` },
        source: "operator-config" as const,
        confidence: "explicit" as const,
        purpose: "verification" as const,
      })),
    };

    const evaluation = await evaluateAcceptanceContract(contract, { runCommand: runner });

    expect(runner).not.toHaveBeenCalled();
    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking).toMatchObject([
      {
        kind: "acceptance-contract-too-many-commands",
        path: "[acceptance contract]",
      },
    ]);
  });

  it("denies model/project/package acceptance commands before invoking a runner", async () => {
    const runner = vi.fn(async () => commandResult({ ok: true }));
    const contract: AcceptanceContract = {
      source: "task-metadata",
      confidence: "high",
      provenance: "adversarial command fixture",
      requiredCommands: [
        {
          check: { command: "python hidden_pass.py" },
          source: "model-authored-path",
          confidence: "high",
          purpose: "verification",
        },
        {
          check: { command: "npm test" },
          source: "package-script",
          confidence: "explicit",
          purpose: "verification",
        },
        {
          check: { command: "scripts/check.sh" },
          source: "project-authored-script",
          confidence: "explicit",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, { runCommand: runner });

    expect(runner).not.toHaveBeenCalled();
    expect(evaluation.ok).toBe(false);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.blocking.map((issue) => issue.kind)).toEqual([
      "acceptance-command-source-denied",
      "acceptance-command-source-denied",
      "acceptance-command-source-denied",
    ]);
  });

  it("keeps advisory command evidence non-authoritative and unchecked", async () => {
    const runner = vi.fn(async () => commandResult({ ok: true }));
    const contract: AcceptanceContract = {
      source: "task-metadata",
      confidence: "advisory",
      provenance: "low-confidence command hint",
      requiredCommands: [
        {
          check: { command: "python -m pytest -q" },
          source: "task-metadata",
          confidence: "advisory",
          purpose: "verification",
        },
      ],
    };

    const evaluation = await evaluateAcceptanceContract(contract, { runCommand: runner });

    expect(runner).not.toHaveBeenCalled();
    expect(evaluation.ok).toBe(true);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.warnings).toMatchObject([
      { kind: "advisory-command-not-checked", path: "python -m pytest -q" },
    ]);
  });

  it("keeps model-supplied process lease probes advisory and unchecked", async () => {
    const contract = acceptanceContractFromProcessLeases(
      [
        {
          id: "lease_service",
          kind: "service",
          ownerToolCallId: "call_service",
          command: "python3 -m http.server 8000",
          pid: 1234,
          processGroupId: 1234,
          startIdentity: "start:1234",
          startedAtMs: 1,
          logPath: "/tmp/http.log",
          outputOffset: 0,
          scope: "until-verifier-handoff",
          cleanupOwner: "kernel",
          healthCommand: "curl -fsS http://127.0.0.1:8000/",
        },
        {
          id: "lease_job",
          kind: "job",
          ownerToolCallId: "call_job",
          command: "john hash.txt",
          pid: 4321,
          processGroupId: 4321,
          startIdentity: "start:4321",
          startedAtMs: 2,
          logPath: "/tmp/john.log",
          outputOffset: 0,
          scope: "until-verifier-handoff",
          cleanupOwner: "kernel",
          statusCommand: "john --show hash.txt",
        },
      ],
      { cwd: "/workspace/task" },
    );

    expect(contract).toMatchObject({
      source: "service/process-lease",
      confidence: "advisory",
      requiredCommands: [
        {
          check: { command: "curl -fsS http://127.0.0.1:8000/", cwd: "/workspace/task" },
          source: "service/process-lease",
          confidence: "advisory",
          purpose: "liveness",
        },
        {
          check: { command: "john --show hash.txt", cwd: "/workspace/task" },
          source: "service/process-lease",
          confidence: "advisory",
          purpose: "liveness",
        },
      ],
    });
    expect(contract?.provenance).toContain("lease_service");
    expect(contract?.provenance).toContain("lease_job");
    const runner = vi.fn(async () => commandResult({ ok: true }));
    const evaluation = await evaluateAcceptanceContract(contract!, { runCommand: runner });
    expect(runner).not.toHaveBeenCalled();
    expect(evaluation.ok).toBe(true);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
    expect(evaluation.warnings).toHaveLength(2);
    expect(
      acceptanceContractFromProcessLeases([{ ...contractlessLease(), id: "lease_no_probe" }]),
    ).toBeUndefined();
  });

  it("parses operator-config required artifacts without unsafe paths", () => {
    expect(requiredArtifactsFromEnv(" answer.txt, artifacts/report.html\nlogs/out.txt ")).toEqual([
      {
        path: "answer.txt",
        source: "operator-config",
        confidence: "explicit",
        provenance: "operator supplied KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS",
      },
      {
        path: "artifacts/report.html",
        source: "operator-config",
        confidence: "explicit",
        provenance: "operator supplied KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS",
      },
      {
        path: "logs/out.txt",
        source: "operator-config",
        confidence: "explicit",
        provenance: "operator supplied KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS",
      },
    ]);

    expect(() => requiredArtifactsFromEnv("artifacts/*.html")).toThrow(/glob/i);
    expect(() => requiredArtifactsFromEnv("/tests/hidden/grade.py")).toThrow(/hidden/i);
    expect(() => requiredArtifactsFromEnv("tests/hidden")).toThrow(/hidden/i);
    expect(() => requiredArtifactsFromEnv("tests/.hidden")).toThrow(/hidden/i);
    expect(() => requiredArtifactsFromEnv("/tmp/answer.txt")).toThrow(/relative/i);
    expect(() => requiredArtifactsFromEnv("../answer.txt")).toThrow(/relative/i);
    expect(() => requiredArtifactsFromEnv("hidden/grade.py")).toThrow(/hidden/i);
    expect(() => requiredArtifactsFromEnv("a".repeat(600))).toThrow(/too long/i);
    expect(() => requiredArtifactsFromEnv("bad\u0000path.txt")).toThrow(/control/i);
    expect(requiredArtifactsFromEnv("")).toEqual([]);
    expect(requiredArtifactsFromEnv(undefined)).toEqual([]);
    expect(() =>
      requiredArtifactsFromEnv(
        Array.from({ length: 33 }, (_, index) => `artifact-${String(index)}.txt`).join(","),
      ),
    ).toThrow(/at most 32/i);
  });

  it("returns NOT_RUN for an empty advisory contract with no authoritative evidence", async () => {
    const evaluation = await evaluateAcceptanceContract({
      source: "none",
      confidence: "advisory",
      provenance: "no visible acceptance evidence",
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.receiptStatus).toBe("NOT_RUN");
  });

  it("builds an acceptance contract only when authoritative artifacts are configured", () => {
    const [artifact] = requiredArtifactsFromEnv("answer.txt");

    expect(acceptanceContractFromRequiredArtifacts([])).toBeUndefined();
    expect(
      acceptanceContractFromRequiredArtifacts(artifact === undefined ? [] : [artifact]),
    ).toEqual({
      source: "operator-config",
      confidence: "explicit",
      provenance: "operator supplied KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS",
      requiredArtifacts: [
        {
          path: "answer.txt",
          source: "operator-config",
          confidence: "explicit",
          provenance: "operator supplied KEEL_ACCEPTANCE_REQUIRED_ARTIFACTS",
        },
      ],
    });
  });

  it("renders bounded artifact feedback without claiming semantic correctness", async () => {
    const contract: AcceptanceContract = {
      source: "prompt-explicit-path",
      confidence: "high",
      provenance: "visible prompt path",
      requiredArtifacts: [
        { path: "answer.txt", source: "prompt-explicit-path", confidence: "high" },
      ],
    };
    const evaluation = await evaluateAcceptanceContract(contract, {
      readArtifact: virtualReader({ "answer.txt": "TODO\n" }),
    });

    const prompt = renderAcceptanceFailurePrompt(contract, evaluation);

    expect(prompt).toContain("Acceptance contract failed");
    expect(prompt).toContain("answer.txt");
    expect(prompt).toContain("placeholder");
    expect(prompt).toContain("does not prove semantic correctness");
    expect(prompt.length).toBeLessThan(1200);
  });

  it("renders denied-source feedback without telling the model to fix hidden evidence", () => {
    const contract: AcceptanceContract = {
      source: "prompt-explicit-path",
      confidence: "high",
      provenance: "hidden path fixture",
      requiredArtifacts: [
        { path: "hidden/grade.py", source: "prompt-explicit-path", confidence: "high" },
      ],
    };
    const evaluation = {
      ok: false,
      receiptStatus: "NOT_RUN" as const,
      warnings: [],
      blocking: [
        {
          kind: "artifact-source-denied" as const,
          path: "hidden/grade.py",
          source: "prompt-explicit-path" as const,
          confidence: "high" as const,
          detail: "artifact source is model/project-controlled or hidden-grader-looking",
        },
      ],
    };

    const prompt = renderAcceptanceFailurePrompt(contract, evaluation);

    expect(prompt).toContain("cannot be used as completion evidence");
    expect(prompt).toContain("visible operator-approved artifact");
    expect(prompt).toContain("[denied evidence omitted]");
    expect(prompt).not.toContain("hidden/grade.py");
    expect(prompt).not.toContain("hidden path fixture");
    expect(prompt).not.toContain("Create or fix the required visible artifact");
  });

  it("caps long failure prompts and reports hidden extra issues", () => {
    const contract: AcceptanceContract = {
      source: "operator-config",
      confidence: "explicit",
      provenance: "many missing artifacts",
    };
    const evaluation = {
      ok: false,
      receiptStatus: "FAILED" as const,
      warnings: [],
      blocking: Array.from({ length: 10 }, (_, index) => ({
        kind: "required-artifact-missing" as const,
        path: `artifact-${String(index)}.txt`,
        source: "operator-config" as const,
        confidence: "explicit" as const,
        detail: "required artifact is missing",
      })),
    };

    const prompt = renderAcceptanceFailurePrompt(contract, evaluation);

    expect(prompt).toContain("... 2 more issue(s)");
    expect(prompt).toContain("artifact-7.txt");
    expect(prompt).not.toContain("artifact-8.txt");
  });
});

function commandResult(overrides: Partial<PreStopCheckResult>): PreStopCheckResult {
  return {
    ok: overrides.ok ?? false,
    exitCode:
      "exitCode" in overrides ? (overrides.exitCode ?? null) : overrides.ok === true ? 0 : 1,
    signal: "signal" in overrides ? (overrides.signal ?? null) : null,
    timedOut: overrides.timedOut ?? false,
    output: overrides.output ?? "",
    truncated: overrides.truncated ?? false,
  };
}

function contractlessLease() {
  return {
    id: "lease",
    kind: "service" as const,
    ownerToolCallId: "call_service",
    command: "python3 -m http.server 8000",
    pid: 1234,
    processGroupId: 1234,
    startIdentity: "start:1234",
    startedAtMs: 1,
    logPath: "/tmp/http.log",
    outputOffset: 0,
    scope: "until-verifier-handoff" as const,
    cleanupOwner: "kernel" as const,
  };
}
