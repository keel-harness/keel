#!/usr/bin/env node
// Thin headless entry for `keel` — argv → I/O composition only; coverage-excluded (binary smoke
// test is Epic 1.10). All the logic it composes is tested: parseKeelArgs/selectRenderer/buildUI/
// resolveModelConfig/createModelPort/runKeelCommand. Epic 1.6a Step 2 wires the real provider here.
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolveRgPath } from "../tools/index.js";
import { KEEL_VERSION } from "../version.js";
import { CREDENTIAL_PROXY_CONFIG_ENV } from "@keel/shared";
import {
  type DoctorInput,
  doctorRuntime,
  formatDoctorReport,
  nodeVersionFromProcess,
  runDoctor,
} from "./doctor.js";
import { HeadlessUI } from "../tui/headless.js";
import { interpretTrustAnswer, readTrustLine, trustPromptText } from "../trust/trust-prompt.js";
import { loadTrustDecision } from "../trust/trust-store.js";
import { defaultSecretStore } from "../secrets/secret-store.js";
import { runAuthCli } from "./auth.js";
import { runAutopilotGrantsCommandResult } from "./autopilot-grants.js";
import { runAutopilotModeCommandResult } from "./autopilot-mode.js";
import { runEgressExceptionCommandResult } from "./egress-exceptions.js";
import {
  interpretPlanApprovalConfirmationAnswer,
  renderRunPlanApprovalConfirmation,
  runAutopilotPlanCommandResult,
} from "./autopilot-plan.js";
import { feedSecretChar, initialSecretInput } from "./secret-input.js";
import { runKeelCliResult } from "./keel.js";
import { InputQueue } from "./input-queue.js";
import type { ModelPort } from "@keel/shared";
import {
  PROVIDER_KEY_ENV,
  createModelPort,
  createReplayModelPort,
  resolveApiKey,
  resolveModelConfig,
} from "./runtime.js";
import {
  HELP_TEXT,
  buildUI,
  type KeelCommand,
  parseKeelArgs,
  runAuditExportCommand,
  runAuditVerifyCommand,
  runKeelCommand,
  selectRenderer,
} from "./session-entry.js";
import { runMcpReviewCommand } from "./mcp.js";
import { completePath, completionTrustGate } from "../tui/at-complete.js";
import { openDraftInEditor } from "../tui/editor.js";
import { oneLineText } from "../control-strip.js";
import { keelHome } from "../session/paths.js";
import { wrapUiWithBootstrapClear } from "./bootstrap-ui.js";
import { shouldExitNonZeroForRunOutcome } from "./exit-code.js";
import { installNodeInteractiveTerminalLifecycle } from "./terminal-hooks.js";

const BOOTSTRAP_CLEAR = "__keelClearBootstrapPaint";

function bootstrapClear(): (() => void) | undefined {
  const globals = globalThis as Record<string, unknown>;
  const clear = globals[BOOTSTRAP_CLEAR];
  if (typeof clear !== "function") return undefined;
  return () => {
    (clear as () => void)();
    if (globals[BOOTSTRAP_CLEAR] === clear) delete globals[BOOTSTRAP_CLEAR];
  };
}

const out = (s: string): void => {
  bootstrapClear()?.();
  process.stdout.write(s + "\n");
};
type RunCommand = Extract<KeelCommand, { readonly kind: "run" }>;

/** Read one line from stdin with a prompt (the trust y/n). */
async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** Read a secret from stdin WITHOUT echoing it to the terminal (raw mode on a TTY; plain read when
 *  piped, where there is no echo concern). The secret is never placed in argv (no `ps` exposure). */
async function readSecretNoEcho(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return readLine(prompt); // piped — no echo to suppress
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve, reject) => {
    // The keystroke logic (submit/abort/backspace, swallowing escape sequences) lives in the pure,
    // unit-tested `feedSecretChar` reducer; the bin keeps only the raw-mode TTY plumbing (DX-1/DX-2).
    let state = initialSecretInput;
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        const r = feedSecretChar(state, ch);
        if (r.kind === "submit") {
          cleanup();
          stdout.write("\n");
          return resolve(r.value);
        }
        if (r.kind === "abort") {
          cleanup();
          stdout.write("\n");
          return reject(new Error("aborted"));
        }
        state = r.state;
      }
    };
    stdin.on("data", onData);
  });
}

/** Render the honest trust prompt and read one y/n line from stdin (runs before Ink takes the TTY).
 *  Only wired for interactive runs; non-interactive runs never prompt (fail closed). */
async function promptTrustOnTty(info: { readonly cwd: string }): Promise<boolean> {
  out(trustPromptText(info.cwd));
  // Keep one Node stream owner for fd 0 across the pre-Ink prompt and Ink itself. A second
  // ReadStream over the same terminal descriptor can leave Ink's read side failing with EAGAIN.
  // `readTrustLine` stays in paused/readable mode, and any pasted composer bytes return to this
  // same stream before Ink mounts.
  const read = await readTrustLine(process.stdin, process.stdout);
  if (read.remainder.length > 0) process.stdin.unshift(read.remainder);
  return interpretTrustAnswer(read.answer);
}

async function confirmRunPlanApproval(cmd: RunCommand): Promise<boolean> {
  const planApproval = cmd.planApproval;
  if (planApproval?.confirm !== true) return true;
  const cwd = process.cwd();
  out(
    renderRunPlanApprovalConfirmation({
      workspace: cwd,
      planId: planApproval.planId,
      prompt: cmd.prompt,
      resources: planApproval.resources,
    }),
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.exitCode = 1;
    out("keel: --plan-confirm requires an interactive terminal");
    return false;
  }
  if (!interpretPlanApprovalConfirmationAnswer(await readLine("> "))) {
    process.exitCode = 1;
    out("keel: Plan Autopilot approval declined");
    return false;
  }
  return true;
}

/** Read a file, returning `null` if it does not exist / is unreadable (for `/etc/os-release`). */
function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Gather the raw `keel doctor` probe facts impurely — spawn `node`/`rg`, read `/etc/os-release`.
 *  All decision logic lives in the pure, tested `runDoctor`; this is the thin I/O layer (the bin is
 *  coverage-excluded). `runtime` is the standalone `bun --compile` binary vs the node/npx path. */
function gatherDoctorInput(): DoctorInput {
  const versions = process.versions as Record<string, string | undefined>;
  const runtime = doctorRuntime(versions); // pure + tested (doctor.ts)
  const probe = (cmd: string, args: readonly string[]): string | null => {
    try {
      return execFileSync(cmd, [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const probeOrPresent = (cmd: string, args: readonly string[]): string | null => {
    const raw = probe(cmd, args);
    return raw === null ? null : raw.trim() || "present";
  };
  // node version: from process.versions when under node (pure helper), else probe PATH.
  const nodeVersionRaw =
    (runtime === "node" ? nodeVersionFromProcess(versions) : null) ?? probe("node", ["--version"]);
  // Probe the EXACT ripgrep the `search` tool resolves (bundled on npx/dev, system `rg` on the
  // standalone binary, or a KEEL_RG_PATH override) — so doctor reports the binary keel will actually
  // run, never a different one (QC: doctor/search must agree).
  const rgVersionRaw = probe(resolveRgPath(process.env), ["--version"]);
  const osReleaseRaw = process.platform === "linux" ? readFileOrNull("/etc/os-release") : null;
  const procVersionRaw = process.platform === "linux" ? readFileOrNull("/proc/version") : null;
  const bwrapVersionRaw =
    process.platform === "linux" ? probeOrPresent("bwrap", ["--version"]) : null;
  const socatVersionRaw = process.platform === "linux" ? probeOrPresent("socat", ["-V"]) : null;
  const sandboxExecPresent =
    process.platform === "darwin" ? existsSync("/usr/bin/sandbox-exec") : null;
  return {
    runtime,
    nodeVersionRaw,
    rgVersionRaw,
    bwrapVersionRaw,
    socatVersionRaw,
    sandboxExecPresent,
    platform: process.platform,
    osReleaseRaw,
    procVersionRaw,
    credentialProxyConfigRaw: process.env[CREDENTIAL_PROXY_CONFIG_ENV] ?? null,
    cwd: process.cwd(),
  };
}

async function main(): Promise<void> {
  const cmd = parseKeelArgs(process.argv.slice(2));
  if (cmd.kind === "version") return out(`keel ${KEEL_VERSION}`);
  if (cmd.kind === "help") return out(HELP_TEXT);
  if (cmd.kind === "doctor") {
    const report = runDoctor(gatherDoctorInput());
    // Color only on a real TTY and when NO_COLOR is unset (§8.6 output honesty; the NO_COLOR std).
    const color = Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined;
    out(formatDoctorReport(report, { color }));
    process.exitCode = report.exitCode;
    return;
  }
  if (cmd.kind === "sessions") {
    const result = runKeelCliResult(["sessions", ...cmd.args]);
    if (!result.ok) process.exitCode = 1;
    return out(result.output);
  }
  if (cmd.kind === "audit-export") {
    try {
      return out(
        await runAuditExportCommand({
          sessionId: cmd.sessionId,
          cwd: process.cwd(),
          env: process.env,
          ...(cmd.outPath === undefined ? {} : { outPath: cmd.outPath }),
        }),
      );
    } catch (e) {
      process.exitCode = 1;
      return out(`keel audit export: ${(e as Error).message}`);
    }
  }
  if (cmd.kind === "audit-verify") {
    try {
      return out(runAuditVerifyCommand({ bundlePath: cmd.bundlePath }));
    } catch (e) {
      process.exitCode = 1;
      return out(`keel audit verify: ${(e as Error).message}`);
    }
  }
  if (cmd.kind === "auth") {
    // `runAuthCli` already returns a clean message on a cancelled read or a failed store write (M5);
    // the try/catch is a belt-and-suspenders net so any unforeseen throw still exits 1 with one line,
    // never an unhandled rejection / stack dump (mirrors the run-path handling below).
    try {
      return out(
        await runAuthCli(cmd.args, {
          store: defaultSecretStore(process.env),
          env: process.env,
          readSecret: () => readSecretNoEcho(`paste the ${cmd.args[1] ?? "provider"} API key: `),
        }),
      );
    } catch (e) {
      process.exitCode = 1;
      return out(`keel auth: ${(e as Error).message}`);
    }
  }
  if (cmd.kind === "autopilot-grants") {
    const result = runAutopilotGrantsCommandResult({
      cwd: process.cwd(),
      env: process.env,
      args: cmd.args,
    });
    if (!result.ok) process.exitCode = 1;
    return out(result.output);
  }
  if (cmd.kind === "autopilot-mode") {
    const result = runAutopilotModeCommandResult({
      cwd: process.cwd(),
      env: process.env,
      args: cmd.args,
    });
    if (!result.ok) process.exitCode = 1;
    return out(result.output);
  }
  if (cmd.kind === "autopilot-plan") {
    const result = runAutopilotPlanCommandResult({
      cwd: process.cwd(),
      env: process.env,
      args: cmd.args,
    });
    if (!result.ok) process.exitCode = 1;
    return out(result.output);
  }
  if (cmd.kind === "egress-exception") {
    const result = runEgressExceptionCommandResult({ env: process.env, args: cmd.args });
    if (!result.ok) process.exitCode = 1;
    return out(result.output);
  }
  if (cmd.kind === "mcp-review") {
    try {
      return out(
        await runMcpReviewCommand({
          cwd: process.cwd(),
          env: process.env,
          serverKey: cmd.serverKey,
          // Trust-before-parse (SEC-012): only review/spawn from a workspace the human has trusted.
          trusted: loadTrustDecision(process.cwd(), process.env) === "trusted",
        }),
      );
    } catch (e) {
      process.exitCode = 1;
      return out(`keel mcp review: ${(e as Error).message}`);
    }
  }
  if (cmd.kind === "usage") {
    process.exitCode = 1;
    return out(cmd.message);
  }

  // run | interactive — a live model run. Phase 2A default governed mode routes bash through
  // the spawned warden; broader typed-tool hosting remains a follow-up.
  if (cmd.kind === "run" && !(await confirmRunPlanApproval(cmd))) return;
  const replayFile = cmd.kind === "run" ? cmd.replay : undefined;
  let model: ModelPort;
  let modelLabel: string | undefined; // provider/model shown in the HUD (live runs; undefined for replay)
  if (replayFile !== undefined) {
    // Offline replay (Epic 1.10 / ADR-0031): drive the REAL loop from a recorded `Recording` — no
    // key, no network. Powers the hermetic one-task smoke + offline repro/demos.
    try {
      model = createReplayModelPort(replayFile);
    } catch (e) {
      process.exitCode = 1;
      return out(`keel: ${(e as Error).message}`);
    }
  } else {
    let config;
    try {
      config = resolveModelConfig(process.env);
    } catch (e) {
      process.exitCode = 1;
      return out((e as Error).message);
    }
    // Resolve the API key: the 0600 secret-store file → provider env var (Epic 1.9).
    const apiKey = resolveApiKey(config.provider, process.env);
    if (apiKey === undefined) {
      process.exitCode = 1;
      const currentHome = oneLineText(keelHome(process.env));
      return out(
        `keel: no ${config.provider} API key found — run ` +
          `\`keel auth set ${config.provider}\` with the same KEEL_HOME ` +
          `(current KEEL_HOME: ${currentHome}) ` +
          `(or set ${PROVIDER_KEY_ENV[config.provider]}).`,
      );
    }
    model = createModelPort(config, apiKey);
    modelLabel = `${config.provider}/${config.model}`;
  }

  const oneShot = cmd.kind === "run";
  const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const renderer = selectRenderer({ isTTY, ci: process.env["CI"] === "true", oneShot });
  // C-stream (Epic 1.20): give the headless UI a stdout sink so the transcript streams incrementally
  // and survives a hard kill (the harbor wall-clock SIGKILL) instead of being printed once at the end.
  // The seeded system preamble (prompt · env · AGENTS.md · skills) is scaffolding, not transcript —
  // hidden by default in BOTH the one-shot (`keel run -p`) and the interactive TUI; dumping it buries
  // the actual turn under a wall of text (Epic 1.24 slice 0). `--verbose` opts in (one-shot today).
  const verbose = cmd.kind === "run" ? (cmd.verbose ?? false) : false;
  // The trust-gated `@file` completer (Epic 1.23 slice 5). Explicit `--trust` is a human opt-in for
  // this run and need not be persisted; every other path re-checks the user-scope decision on each
  // call and fail-closes to [] when untrusted. Interactive (Ink) only.
  const completionTrust = completionTrustGate(cmd.trust);
  const complete = (query: string): readonly string[] =>
    completePath(query, { cwd: process.cwd(), env: process.env, trust: completionTrust });
  const inputQueue = new InputQueue();
  const baseUi = buildUI(
    renderer,
    inputQueue,
    (chunk) => void process.stdout.write(chunk),
    verbose,
    complete,
    (draft) => Promise.resolve(openDraftInEditor(draft)),
    // Interactive-session chrome (rail · current-turn · turn-summary card · keyboard hints) renders only
    // for an interactive session, never one-shot `keel run -p` machine output (Epic 1.24 Tier-A QC).
    cmd.kind === "interactive",
  );
  const clearBootstrap = bootstrapClear();
  const ui =
    renderer === "ink"
      ? wrapUiWithBootstrapClear(baseUi, clearBootstrap)
      : (clearBootstrap?.(), baseUi);
  const terminalLifecycle = installNodeInteractiveTerminalLifecycle({
    renderer,
    queue: inputQueue,
    ui,
    sources: { process, input: process.stdin, output: process.stdout },
  });
  const runUi = terminalLifecycle?.ui ?? ui;
  // Trust resolution + project-context loading (env snapshot, AGENTS.md, skills) happen INSIDE
  // runKeelCommand, behind the trust gate (Epic 1.7 — trust-before-parse / SEC-012). The bin no
  // longer reads the workspace pre-trust. The interactive trust prompt runs only on a real TTY
  // (before Ink takes the terminal); non-interactive runs fail closed to untrusted (use --trust).
  try {
    const outcome = await runKeelCommand(oneShot ? cmd.prompt : undefined, {
      model,
      ui: runUi,
      ...(modelLabel !== undefined ? { modelLabel } : {}),
      cwd: process.cwd(),
      env: process.env,
      isTTY,
      ...(cmd.trust ? { trustFlag: true } : {}),
      ...(cmd.autonomy === undefined ? {} : { autonomy: cmd.autonomy }),
      ...(cmd.kind === "run" && cmd.goal !== undefined ? { goal: cmd.goal } : {}),
      ...(cmd.kind === "run" && cmd.loop !== undefined ? { loop: cmd.loop } : {}),
      ...(cmd.kind === "run" && cmd.planApproval !== undefined
        ? { planApproval: cmd.planApproval }
        : {}),
      ...(isTTY ? { promptTrust: promptTrustOnTty } : {}),
      ...(cmd.kind === "interactive" && cmd.resume !== undefined ? { resume: cmd.resume } : {}),
    });
    // Honest exit code (INT-2): abnormal terminal stops and attention-coded answers are failures for
    // script/CI callers; clean model-stop / no-terminal outcomes succeed.
    if (shouldExitNonZeroForRunOutcome(outcome)) {
      process.exitCode = 1;
    }
  } catch (e) {
    process.exitCode = 1;
    out(`keel: ${(e as Error).message}`);
  } finally {
    const terminalExitCode = terminalLifecycle?.exitCode();
    terminalLifecycle?.dispose();
    if (terminalExitCode !== undefined) process.exitCode = terminalExitCode;
  }
  // C-stream (Epic 1.20): the headless transcript streamed item-by-item during the run; flush the
  // trailer (status/footer) here. A completed run's stdout is byte-identical to the legacy one-shot
  // `frame()` print; a killed run keeps whatever streamed before the SIGKILL.
  if (runUi instanceof HeadlessUI) runUi.finalize();
}

void main();
