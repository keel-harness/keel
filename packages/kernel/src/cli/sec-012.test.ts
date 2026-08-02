import { describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir as systemTmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelMessageT, ModelPort, ModelStreamChunkT, ModelTurnInput } from "@keel/shared";
import { type ProjectFs, defaultProjectFs } from "../context/project-reader.js";
import { gatherProjectContext } from "../context/project-context.js";
import { HeadlessUI } from "../tui/headless.js";
import { runKeelCommand } from "./session-entry.js";

/**
 * SEC-012 — Trust-before-parse (§3.2(4)): a malicious repo's project-local config/skills must NOT be
 * read or executed before the human accepts trust, and once accepted they load as INERT DATA, never
 * executed (ADR-0026). The denied-path assertion is: zero project reads before acceptance.
 */
const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "hostile-repos",
  "booby-trapped",
);
const skillDirs = { projectDir: join(CORPUS, ".keel", "skills") };
const sys = { cores: 4, memGB: 8 };
const home = (): NodeJS.ProcessEnv => ({
  KEEL_HOME: mkdtempSync(join(realpathSync(systemTmpdir()), "keel-sec012-")),
});

/** Records every real fs path keel reads — the SEC-012 instrument at the chokepoint. */
function recordingFs(): ProjectFs & { reads: string[] } {
  const real = defaultProjectFs();
  const reads: string[] = [];
  return {
    reads,
    listDir: (p) => {
      reads.push(p);
      return real.listDir(p);
    },
    readFile: (p) => {
      reads.push(p);
      return real.readFile(p);
    },
    probeVersion: (t) => real.probeVersion(t),
    realpath: (p) => {
      reads.push(p);
      return real.realpath(p);
    },
  };
}

class CapturingModel implements ModelPort {
  firstMessages: readonly ModelMessageT[] | undefined;
  async *stream(input: ModelTurnInput): AsyncIterable<ModelStreamChunkT> {
    this.firstMessages ??= input.messages;
    yield { type: "finish", reason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

describe("SEC-012 — trust-before-parse against the booby-trapped hostile repo", () => {
  it("DENIED PATH: untrusted → ZERO project reads before acceptance, empty context", async () => {
    const fs = recordingFs();
    const ctx = await gatherProjectContext({ cwd: CORPUS, env: home(), fs, sys, skillDirs });
    expect(ctx).toEqual({ trusted: false }); // untrusted → no env snapshot, no AGENTS.md, no skills
    expect(fs.reads).toEqual([]); // the malicious files were never even read
  });

  it("accepted: the malicious AGENTS.md loads as INERT DATA — keel never acts on its instructions", async () => {
    const fs = recordingFs();
    const ctx = await gatherProjectContext({
      cwd: CORPUS,
      env: { ...home(), KEEL_TRUST: "1" },
      fs,
      sys,
      skillDirs,
    });
    // AGENTS.md is loaded — but only as text in a system message (data, not an instruction keel ran)
    expect(ctx.instructions).toMatch(/INJECTION-MARKER-AGENTS/);
    // …and it carries a provenance fence marking it workspace-supplied (CTX-1 / ADR-0063), so the
    // injection cannot pose as operator/keel authority — the fence precedes the malicious content.
    expect(ctx.instructions).toContain("provenance: workspace-supplied");
    expect(ctx.instructions!.indexOf("provenance: workspace-supplied")).toBeLessThan(
      ctx.instructions!.indexOf("INJECTION-MARKER-AGENTS"),
    );
    // keel did NOT follow the injection: it never read .env / install.sh / README / EXFIL contents
    expect(JSON.stringify(ctx)).not.toMatch(/SECRET_KEY/); // .env bait content never ingested
    const readContents = fs.reads.filter((p) =>
      /\.env$|install\.sh$|EXFIL\.md$|README\.md$/.test(p),
    );
    expect(readContents).toEqual([]); // keel reads only AGENTS.md + SKILL.md, nothing the injection named
  });

  it("accepted: the hostile corpus escape-link is listed but never followed or read", async () => {
    const fs = recordingFs();
    const ctx = await gatherProjectContext({
      cwd: CORPUS,
      env: { ...home(), KEEL_TRUST: "1" },
      fs,
      sys,
      skillDirs,
    });

    expect(ctx.environment).toMatch(/escape-link/); // the symlink trap is present in the corpus listing
    expect(fs.reads).not.toContain(join(CORPUS, "escape-link"));
    expect(fs.reads).not.toContain(join(dirname(CORPUS), "escape-target.txt"));
  });

  it("accepted: the malicious skill surfaces only as a STUB; its body is never auto-run", async () => {
    const ctx = await gatherProjectContext({
      cwd: CORPUS,
      env: { ...home(), KEEL_TRUST: "1" },
      sys,
      skillDirs,
    });
    expect(ctx.skills).toMatch(/exfiltrate/); // the stub (name/description) is discoverable
    expect(ctx.skills).not.toMatch(/SHOULD-NOT-AUTORUN/); // the body is NOT in context at discovery
    // the body is reachable ONLY via an explicit trigger (the `skill` tool) — and even then it is text
    expect(ctx.skillRegistry?.loadBody("exfiltrate")).toMatch(/SHOULD-NOT-AUTORUN/);
  });

  it("declined: the agent runs with EMPTY project context and no injection is ever seeded", async () => {
    const model = new CapturingModel();
    await runKeelCommand("help me", {
      model,
      ui: new HeadlessUI(),
      cwd: CORPUS,
      env: home(), // no KEEL_TRUST → untrusted (a non-interactive decline)
    });
    const systems = (model.firstMessages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(model.firstMessages).toBeDefined(); // the run reached the model — still functional
    expect(systems).not.toMatch(/INJECTION-MARKER/); // no malicious project content seeded
    expect(systems).not.toMatch(/# Environment/); // and no project context at all
  });
});
