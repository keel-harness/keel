/**
 * `keel doctor` — the environment preflight (Epic 1.10, MASTER_SPEC §7 / Appendix G).
 *
 * This module is **pure**: `runDoctor` takes raw, injected probe facts (the output of `node
 * --version` / `rg --version`, the platform, and `/etc/os-release`) and decides the report;
 * `formatDoctorReport` renders it. All parsing, version comparison, distro→fix mapping, and the
 * exit-code decision live here so they are unit/golden tested — the bin holds only the thin,
 * coverage-excluded I/O that gathers the raw facts (spawn + read file). See §8.5: every
 * human-facing line is *what · why · the exact command*, and we **never emit a wall of docs**.
 *
 * Honesty (ground rule 4): doctor reports runtime dependencies and Phase-2A sandbox prerequisites,
 * plus one explicit default-enforcement scope row. It never claims all typed tools are sandboxed,
 * egress-governed, policy-gated, or audit-signed. The node check is omitted on the standalone binary
 * because the binary bundles its own runtime (ADR-0009); node is only required for the `npx`/`npm`
 * path.
 */
import { KEEL_VERSION } from "../version.js";
import { parseCredentialProxyConfig } from "@keel/warden";

/** How keel is running: the `npx`/`npm` Node path, or a `bun --compile` self-contained binary. */
export type DoctorRuntime = "node" | "standalone";

/**
 * Decide the runtime from `process.versions` (pure, so the one branch that gates whether the node
 * check appears is tested — not hidden in the coverage-excluded bin). The `bun --compile` binary sets
 * `process.versions.bun`; the npx/node path does not.
 */
export function doctorRuntime(
  versions: Readonly<Record<string, string | undefined>>,
): DoctorRuntime {
  return versions["bun"] !== undefined ? "standalone" : "node";
}

/**
 * The `v`-prefixed node version from `process.versions.node` when keel runs under node, else `null`
 * (the caller then probes `node --version` on PATH). Pure + tested; the bin keeps only the spawn.
 */
export function nodeVersionFromProcess(
  versions: Readonly<Record<string, string | undefined>>,
): string | null {
  const v = versions["node"];
  return v !== undefined ? `v${v}` : null;
}

/** Raw probe facts, gathered impurely by the bin and fed to the pure core. `*Raw` is the literal
 *  command output (or `null` when the tool is absent / the file does not exist). */
export interface DoctorInput {
  readonly runtime: DoctorRuntime;
  /** `node --version` output (e.g. `"v20.20.1"`) or `process.versions.node`; `null` if absent. */
  readonly nodeVersionRaw: string | null;
  /** `rg --version` first line (e.g. `"ripgrep 14.1.1 (rev …)"`); `null` if absent. */
  readonly rgVersionRaw: string | null;
  /** `bwrap --version` output on Linux; `null` if absent or not relevant to this platform. */
  readonly bwrapVersionRaw: string | null;
  /** `socat -V` output on Linux; `null` if absent or not relevant to this platform. */
  readonly socatVersionRaw: string | null;
  /** Whether macOS `/usr/bin/sandbox-exec` exists; `null` if not relevant to this platform. */
  readonly sandboxExecPresent: boolean | null;
  readonly platform: NodeJS.Platform;
  /** Contents of `/etc/os-release` on Linux (for distro detection); `null` otherwise/absent. */
  readonly osReleaseRaw: string | null;
  /** Contents of `/proc/version` on Linux (for WSL1/WSL2 detection); `null` otherwise/absent. */
  readonly procVersionRaw: string | null;
  /** Explicit env-forwarded credential proxy config, if present. Project config is not read by doctor. */
  readonly credentialProxyConfigRaw?: string | null;
  /** Workspace root used only to resolve relative file source paths while validating explicit config. */
  readonly cwd?: string;
}

export type CheckStatus = "ok" | "warn" | "missing";
export type DoctorCheckId =
  | "node"
  | "ripgrep"
  | "bwrap"
  | "socat"
  | "macos-sandbox"
  | "wsl2"
  | "windows-sandbox"
  | "credential-proxy-config";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly label: string;
  readonly status: CheckStatus;
  /** The short value/state shown inline (e.g. `"v20.20.1"` or `"not found"`). */
  readonly detail: string;
  /** Why it matters — present for non-ok checks. */
  readonly why?: string;
  /** The one-line remediation — present for non-ok checks. Prefer a copy-paste command when one exists. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when no *required* check is missing (warnings do not flip it). */
  readonly ok: boolean;
  readonly exitCode: number;
}

export const MIN_NODE_MAJOR = 20;
const PROBE_LINE_BREAKS = /[\r\n\t\u2028\u2029]+/gu;
// eslint-disable-next-line no-control-regex
const PROBE_CONTROL_BYTES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

function safeProbeDetail(raw: string): string {
  return raw.replace(PROBE_LINE_BREAKS, " ").replace(PROBE_CONTROL_BYTES, "").trim();
}

/** Parse a major version from `node --version` output (`"v20.20.1"` or `"20.0.0"`). */
function nodeMajor(raw: string): number | undefined {
  const major = /^v?(\d+)\./.exec(raw.trim())?.[1];
  return major === undefined ? undefined : Number(major);
}

/** Parse the bare version out of `rg --version`'s first line (`"ripgrep 14.1.1 (rev …)"`), falling
 *  back to the raw string when the output is in an unexpected shape. */
function rgVersion(raw: string): string {
  const detail = safeProbeDetail(raw);
  const version = /ripgrep\s+(\d+\.\d+\.\d+)/.exec(detail)?.[1];
  return version ?? detail;
}

/** The Linux package manager for a distro, from `/etc/os-release` ID / ID_LIKE. */
type PkgManager = "apt" | "dnf" | "pacman";
const PKG_MANAGER_BY_ID: Readonly<Record<string, PkgManager>> = {
  debian: "apt",
  ubuntu: "apt",
  linuxmint: "apt",
  raspbian: "apt",
  pop: "apt",
  fedora: "dnf",
  rhel: "dnf",
  centos: "dnf",
  rocky: "dnf",
  almalinux: "dnf",
  amzn: "dnf",
  arch: "pacman",
  manjaro: "pacman",
  endeavouros: "pacman",
};

/** Extract the `ID=`/`ID_LIKE=` tokens (quotes stripped) from os-release contents. */
function osReleaseIds(osReleaseRaw: string | null): readonly string[] {
  if (osReleaseRaw === null) return [];
  const ids: string[] = [];
  for (const key of ["ID", "ID_LIKE"]) {
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(osReleaseRaw);
    if (m?.[1] !== undefined)
      ids.push(...m[1].replace(/["']/g, "").trim().split(/\s+/).filter(Boolean));
  }
  return ids;
}

function detectPkgManager(osReleaseRaw: string | null): PkgManager | undefined {
  for (const id of osReleaseIds(osReleaseRaw)) {
    const pm = PKG_MANAGER_BY_ID[id.toLowerCase()];
    if (pm) return pm;
  }
  return undefined;
}

const RG_DOCS = "https://github.com/BurntSushi/ripgrep#installation";

/** The single one-line install command for ripgrep on this platform/distro (§7: one per distro). */
function ripgrepFix(platform: NodeJS.Platform, osReleaseRaw: string | null): string {
  if (platform === "darwin") return "brew install ripgrep";
  if (platform === "win32") return "winget install BurntSushi.ripgrep.MSVC";
  if (platform === "linux") {
    switch (detectPkgManager(osReleaseRaw)) {
      case "apt":
        return "sudo apt-get install -y ripgrep";
      case "dnf":
        return "sudo dnf install -y ripgrep";
      case "pacman":
        return "sudo pacman -S --noconfirm ripgrep";
      default:
        return `install ripgrep with your package manager — ${RG_DOCS}`;
    }
  }
  return `install ripgrep — ${RG_DOCS}`;
}

function linuxPackageFix(packageName: string, osReleaseRaw: string | null): string {
  switch (detectPkgManager(osReleaseRaw)) {
    case "apt":
      return `sudo apt-get install -y ${packageName}`;
    case "dnf":
      return `sudo dnf install -y ${packageName}`;
    case "pacman":
      return `sudo pacman -S --noconfirm ${packageName}`;
    default:
      return `install ${packageName} with your package manager`;
  }
}

function wslVersion(procVersionRaw: string | null): string | undefined {
  if (procVersionRaw === null) return undefined;
  const detail = procVersionRaw.toLowerCase();
  const match = /wsl(\d+)/i.exec(procVersionRaw)?.[1];
  if (match !== undefined) return match;
  return detail.includes("microsoft") ? "1" : undefined;
}

function nodeCheck(input: DoctorInput): DoctorCheck {
  if (input.nodeVersionRaw === null) {
    // Only reachable on the node runtime (the standalone binary omits this check) — and keel is, by
    // definition, already running under node here, so this is a defensive branch.
    return {
      id: "node",
      label: "node",
      status: "warn",
      detail: "not detected",
      why: `keel needs Node >= ${MIN_NODE_MAJOR} for the npx/npm path`,
      fix: `install Node.js >= ${MIN_NODE_MAJOR} — https://nodejs.org`,
    };
  }
  const detail = safeProbeDetail(input.nodeVersionRaw);
  const major = nodeMajor(detail);
  if (major !== undefined && major >= MIN_NODE_MAJOR) {
    return { id: "node", label: "node", status: "ok", detail };
  }
  return {
    id: "node",
    label: "node",
    status: "warn",
    detail,
    why: `keel needs Node >= ${MIN_NODE_MAJOR}`,
    fix: `update Node.js to >= ${MIN_NODE_MAJOR} — https://nodejs.org`,
  };
}

function ripgrepCheck(input: DoctorInput): DoctorCheck {
  if (input.rgVersionRaw === null) {
    return {
      id: "ripgrep",
      label: "ripgrep",
      status: "missing",
      detail: "not found",
      why: "required by the search tool",
      fix: ripgrepFix(input.platform, input.osReleaseRaw),
    };
  }
  return { id: "ripgrep", label: "ripgrep", status: "ok", detail: rgVersion(input.rgVersionRaw) };
}

function bwrapCheck(input: DoctorInput): DoctorCheck {
  if (input.bwrapVersionRaw === null) {
    return {
      id: "bwrap",
      label: "bwrap",
      status: "missing",
      detail: "not found",
      why: "required by the Linux warden sandbox",
      fix: linuxPackageFix("bubblewrap", input.osReleaseRaw),
    };
  }
  const detail = safeProbeDetail(input.bwrapVersionRaw);
  const version = /bubblewrap\s+(\S+)/i.exec(detail)?.[1];
  return { id: "bwrap", label: "bwrap", status: "ok", detail: version ?? detail };
}

function socatCheck(input: DoctorInput): DoctorCheck {
  if (input.socatVersionRaw === null) {
    return {
      id: "socat",
      label: "socat",
      status: "missing",
      detail: "not found",
      why: "required by the Linux warden sandbox proxy bridge",
      fix: linuxPackageFix("socat", input.osReleaseRaw),
    };
  }
  return {
    id: "socat",
    label: "socat",
    status: "ok",
    detail: safeProbeDetail(input.socatVersionRaw),
  };
}

function macosSandboxCheck(input: DoctorInput): DoctorCheck {
  if (input.sandboxExecPresent === true) {
    return {
      id: "macos-sandbox",
      label: "macOS sandbox",
      status: "ok",
      detail: "sandbox-exec present",
    };
  }
  return {
    id: "macos-sandbox",
    label: "macOS sandbox",
    status: "missing",
    detail: "sandbox-exec not found",
    why: "required by the macOS warden sandbox",
    fix: "use a macOS host with /usr/bin/sandbox-exec available",
  };
}

function platformSandboxChecks(input: DoctorInput): readonly DoctorCheck[] {
  if (input.platform === "darwin") return [macosSandboxCheck(input)];
  if (input.platform === "win32") {
    return [
      {
        id: "windows-sandbox",
        label: "Windows sandbox",
        status: "warn",
        detail: "native reduced-enforcement",
        why: "v1 OS sandbox enforcement is the WSL2 path",
        fix: "wsl --install",
      },
    ];
  }
  if (input.platform !== "linux") return [];

  if (wslVersion(input.procVersionRaw) === "1") {
    return [
      {
        id: "wsl2",
        label: "WSL2",
        status: "missing",
        detail: "WSL1 detected",
        why: "Linux warden sandbox requires WSL2 or native Linux",
        fix: "wsl --set-default-version 2",
      },
    ];
  }
  return [bwrapCheck(input), socatCheck(input)];
}

function credentialProxyConfigCheck(input: DoctorInput): DoctorCheck | undefined {
  const raw = input.credentialProxyConfigRaw;
  if (raw === undefined || raw === null || raw.trim() === "") return undefined;
  try {
    const rules = parseCredentialProxyConfig(raw, {
      workspaceRoot: input.cwd ?? process.cwd(),
      env: {},
    });
    return {
      id: "credential-proxy-config",
      label: "credential proxy",
      status: "ok",
      detail: `${rules.length} rule${rules.length === 1 ? "" : "s"}`,
    };
  } catch {
    return {
      id: "credential-proxy-config",
      label: "credential proxy",
      status: "missing",
      detail: "invalid",
      why: "configured secretless egress proxy rules cannot be parsed",
      fix: "fix KEEL_WARDEN_CREDENTIAL_PROXY_RULES and re-run: keel doctor",
    };
  }
}

/** Decide the doctor report from raw probe facts (pure). */
export function runDoctor(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];
  // The node check is omitted on the standalone binary — it bundles its own runtime (ADR-0009).
  if (input.runtime === "node") checks.push(nodeCheck(input));
  checks.push(ripgrepCheck(input));
  checks.push(...platformSandboxChecks(input));
  const credentialProxy = credentialProxyConfigCheck(input);
  if (credentialProxy !== undefined) checks.push(credentialProxy);
  const ok = !checks.some((c) => c.status === "missing");
  return { checks, ok, exitCode: ok ? 0 : 1 };
}

const GLYPH: Readonly<Record<CheckStatus, string>> = { ok: "✓", warn: "!", missing: "✗" };
const COLOR: Readonly<Record<CheckStatus, string>> = { ok: "32", warn: "33", missing: "31" };
const ENFORCEMENT_HONESTY_ROW =
  "  ○ enforcement default governed mode routes bash + file tools through warden · ungoverned tools fail closed";

function paint(text: string, status: CheckStatus, color: boolean): string {
  return color ? `\x1b[${COLOR[status]}m${text}\x1b[0m` : text;
}

/** Render a report to a plain or colored string (§8.6 output honesty — color is opt-in; the plain
 *  form has zero ANSI control bytes for `NO_COLOR`/non-TTY). */
export function formatDoctorReport(report: DoctorReport, opts: { color: boolean }): string {
  const width = Math.max(...report.checks.map((c) => c.label.length));
  const lines: string[] = [`keel doctor ${KEEL_VERSION}`, "", "readiness"];
  for (const c of report.checks) {
    const head = `  ${paint(GLYPH[c.status], c.status, opts.color)} ${c.label.padEnd(width)} ${c.detail}`;
    lines.push(c.why ? `${head} — ${c.why}` : head);
    if (c.fix) lines.push(`      fix: ${c.fix}`);
  }
  lines.push(ENFORCEMENT_HONESTY_ROW);
  lines.push("");
  const missing = report.checks.filter((c) => c.status === "missing").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  if (missing > 0) {
    lines.push(
      `${missing} issue${missing === 1 ? "" : "s"} found. Run the fix${missing === 1 ? "" : "es"} above, then re-run: keel doctor`,
    );
  } else if (warns > 0) {
    lines.push(`All required checks passed (${warns} warning${warns === 1 ? "" : "s"}).`);
  } else {
    lines.push("All checks passed.");
  }
  return lines.join("\n");
}
