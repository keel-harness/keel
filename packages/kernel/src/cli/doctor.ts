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
import { resolve, sep } from "node:path";
import { Buffer } from "node:buffer";
import { isIP } from "node:net";
import { KEEL_VERSION } from "../version.js";
import { MINIMUM_GIT_PUSH_VERSION, supportedGitPushVersion } from "@keel/shared";
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
  /** How this carrier selected ripgrep; omitted retains standalone/system repair semantics. */
  readonly ripgrepSource?: "bundled" | "system" | "override";
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
  /** Non-secret Git availability output; omitted by callers that do not probe publication. */
  readonly gitVersionRaw?: string | null;
  /** Exact local `remote.origin.url` values joined by Git's line framing; never a credential. */
  readonly gitRemoteUrlRaw?: string | null;
  /** Presence only. Doctor never retains or renders helper configuration/output. */
  readonly gitCredentialHelperConfigured?: boolean;
  /** Bounded Warden-authored helper-authority denial and one remediation; no config/secret bytes. */
  readonly gitCredentialHelperAuthorityIssue?: {
    readonly detail: string;
    readonly fix: string;
  };
  /** Workspace root used only to resolve relative file source paths while validating explicit config. */
  readonly cwd?: string;
  /** Result of asking the process-separated Warden owner to validate this workspace's store. */
  readonly egressAddressExceptionStore?: {
    readonly status: "ok" | "error";
    readonly detail: string;
    readonly fix?: string;
  };
  /**
   * Absolute paths to keel's OWN executable bytes — the warden entry, the vendored sandbox runtime,
   * the resolved ripgrep. Supplied by the caller so this check stays pure (impure resolution lives
   * in `bin.ts`). Any of them inside the workspace is a reduced-enforcement posture, not a fault.
   */
  readonly harnessExecutablePaths?: readonly string[];
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
  | "harness-outside-workspace"
  | "credential-proxy-config"
  | "git-push"
  | "egress-address-exception-store";

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
const MAX_SOCAT_DETAIL_LENGTH = 96;
const PROBE_RECORD_BREAKS = /[\r\n\u2028\u2029]+/u;
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

/** Parse the version from socat's multiline build report. Unknown formats stay useful but bounded. */
function socatVersion(raw: string): string {
  for (const rawLine of raw.split(PROBE_RECORD_BREAKS)) {
    const line = safeProbeDetail(rawLine);
    const version = /^socat\s+version\s+(\d{1,6}(?:\.\d{1,6}){1,7})(?=\s|$)/iu.exec(line)?.[1];
    if (version !== undefined) return version;
  }
  const detail = safeProbeDetail(raw);
  if (detail.length <= MAX_SOCAT_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_SOCAT_DETAIL_LENGTH - 1).trimEnd()}…`;
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
    if (input.ripgrepSource === "bundled") {
      return {
        id: "ripgrep",
        label: "ripgrep",
        status: "missing",
        detail: "bundled package unavailable",
        why: "required by the search tool; the npm carrier does not execute PATH fallbacks",
        fix: `npm install --global --ignore-scripts --include=optional keel-harness@${KEEL_VERSION}`,
      };
    }
    if (input.ripgrepSource === "override") {
      return {
        id: "ripgrep",
        label: "ripgrep",
        status: "missing",
        detail: "KEEL_RG_PATH is unavailable",
        why: "required by the search tool",
        fix:
          input.platform === "win32"
            ? "Remove-Item Env:KEEL_RG_PATH; keel doctor"
            : "unset KEEL_RG_PATH && keel doctor",
      };
    }
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
    detail: socatVersion(input.socatVersionRaw),
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

function canonicalGitHttpsRemote(input: string): boolean {
  if (
    Buffer.byteLength(input, "utf8") > 512 ||
    !/^[\x20-\x7e]+$/u.test(input) ||
    !input.startsWith("https://")
  ) {
    return false;
  }
  const authorityAndPath = input.slice("https://".length);
  const pathOffset = authorityAndPath.indexOf("/");
  if (pathOffset <= 0) return false;
  const host = authorityAndPath.slice(0, pathOffset);
  const path = authorityAndPath.slice(pathOffset);
  const labels = host.split(".");
  if (
    host.length > 253 ||
    host !== host.toLowerCase() ||
    isIP(host) !== 0 ||
    labels.some((label) => label === "" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
  ) {
    return false;
  }
  if (Buffer.byteLength(path, "utf8") > 384) return false;
  const segments = path.slice(1).split("/");
  return !segments.some(
    (segment) =>
      segment === "" || segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/u.test(segment),
  );
}

function gitVersion(raw: string): string {
  const detail = safeProbeDetail(raw).slice(0, 96);
  return /^git version (\d{1,6}(?:\.\d{1,6}){1,3})(?=\s|$)/iu.exec(detail)?.[1] ?? detail;
}

function gitPushTransportReady(input: DoctorInput): boolean {
  if (input.platform === "darwin") return input.sandboxExecPresent === true;
  if (input.platform !== "linux" || wslVersion(input.procVersionRaw) === "1") return false;
  return input.bwrapVersionRaw !== null && input.socatVersionRaw !== null;
}

function gitPushTransportFix(input: DoctorInput): string {
  if (input.platform === "linux") {
    if (input.bwrapVersionRaw === null) {
      return `${linuxPackageFix("bubblewrap", input.osReleaseRaw)}, then run: keel doctor`;
    }
    if (input.socatVersionRaw === null) {
      return `${linuxPackageFix("socat", input.osReleaseRaw)}, then run: keel doctor`;
    }
  }
  if (input.platform === "win32") return "wsl --install && keel doctor";
  return "use a supported macOS or Linux host with the sandbox prerequisites, then run: keel doctor";
}

/** One optional-capability row with one remediation; helper output and credentials never enter it. */
function gitPushCheck(input: DoctorInput): DoctorCheck | undefined {
  const versionRaw = input.gitVersionRaw;
  if (versionRaw === undefined) return undefined;
  const base = { id: "git-push" as const, label: "git.push" };
  if (versionRaw === null) {
    return {
      ...base,
      status: "warn",
      detail: "Git not found",
      why: "typed HTTPS publication is unavailable without an identified Git executable",
      fix: "install Git, then run: keel doctor",
    };
  }
  const version = gitVersion(versionRaw);
  if (supportedGitPushVersion(versionRaw) === undefined) {
    return {
      ...base,
      status: "warn",
      detail: `Git ${version || "version unrecognized"} is outside the supported v1 matrix`,
      why: "git.push is advertised only for the Git family exercised by the publication suite",
      fix: `install a supported Git 2.x release (${MINIMUM_GIT_PUSH_VERSION.major}.${MINIMUM_GIT_PUSH_VERSION.minor} or newer), then run: keel doctor`,
    };
  }
  const remote = input.gitRemoteUrlRaw;
  if (remote === undefined || remote === null || remote === "") {
    return {
      ...base,
      status: "warn",
      detail: "origin remote not found",
      why: "git.push v1 requires one canonical origin HTTPS repository",
      fix: "git remote add origin https://github.com/OWNER/REPO.git && keel doctor",
    };
  }
  if (!canonicalGitHttpsRemote(remote)) {
    return {
      ...base,
      status: "warn",
      detail: "origin is not one canonical HTTPS URL",
      why: "git.push v1 rejects SSH, credentials, ports, redirects, and multiple URLs",
      fix: "git remote set-url origin https://github.com/OWNER/REPO.git && keel doctor",
    };
  }
  if (input.gitCredentialHelperConfigured !== true) {
    const authorityIssue = input.gitCredentialHelperAuthorityIssue;
    return {
      ...base,
      status: "warn",
      detail: authorityIssue?.detail ?? "operator Git credential helper not configured",
      why: "git.push resolves credentials parent-side without exposing them to the model or child",
      fix:
        authorityIssue?.fix ??
        "gh auth login --git-protocol https && gh auth setup-git && keel doctor",
    };
  }
  if (!gitPushTransportReady(input)) {
    return {
      ...base,
      status: "warn",
      detail: "SRT/TLS/address guard prerequisites unavailable",
      why: "git.push is advertised only through the enforcing verified-HTTPS transport",
      fix: gitPushTransportFix(input),
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `Git ${version} · canonical origin HTTPS · helper command structurally eligible; path-scoped credentials not checked (resolved only after approval) · SRT/TLS/address guard session-gated`,
  };
}

function egressAddressExceptionStoreCheck(input: DoctorInput): DoctorCheck | undefined {
  const probe = input.egressAddressExceptionStore;
  if (probe === undefined) return undefined;
  const detail = safeProbeDetail(probe.detail).slice(0, 240);
  if (probe.status === "ok") {
    return {
      id: "egress-address-exception-store",
      label: "egress exceptions",
      status: "ok",
      detail,
    };
  }
  return {
    id: "egress-address-exception-store",
    label: "egress exceptions",
    status: "missing",
    detail,
    why: "private-address exception authority cannot be loaded safely",
    ...(probe.fix === undefined ? {} : { fix: safeProbeDetail(probe.fix).slice(0, 512) }),
  };
}

/**
 * Warn when keel's OWN executable bytes sit inside the model-writable workspace.
 *
 * The warden entry, the vendored sandbox runtime and the resolved ripgrep are all executed with the
 * harness's authority — the warden entry and the vendored runtime IN the process that decides
 * policy. `npx`/global installs keep them outside the workspace, where no governed tool can reach
 * them. An in-tree install (keel as a project devDependency, or keel developing itself) puts them
 * under the workspace root, which `allowWrite` covers and no `denyWrite` token protects, so a
 * governed write can replace the code that enforces the boundary.
 *
 * keel cannot contain this. Deny-writing the paths would break `npm install`, and when the
 * workspace IS the harness source, editing it is the task. Per §3.4 ("real enforcement or honest
 * absence — never theater") this is therefore a reduced-enforcement POSTURE, reported the way
 * native Windows is: a `warn` with a remedy, never a hard failure that would break the workflow.
 */
function harnessOutsideWorkspaceCheck(input: DoctorInput): DoctorCheck | undefined {
  const workspace = input.cwd;
  const paths = input.harnessExecutablePaths ?? [];
  if (workspace === undefined || paths.length === 0) return undefined;
  const root = resolve(workspace);
  const inside = paths.filter((candidate) => {
    const resolved = resolve(candidate);
    return resolved === root || resolved.startsWith(`${root}${sep}`);
  });
  if (inside.length === 0) return undefined;
  return {
    id: "harness-outside-workspace",
    label: "keel install location",
    status: "warn",
    detail: "reduced enforcement: keel's own code is workspace-writable",
    why: "a governed write can replace the warden/runtime bytes keel executes",
    fix: "install keel outside the workspace (npx keel-harness, or a global install)",
  };
}

/** Decide the doctor report from raw probe facts (pure). */
export function runDoctor(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];
  // The node check is omitted on the standalone binary — it bundles its own runtime (ADR-0009).
  if (input.runtime === "node") checks.push(nodeCheck(input));
  checks.push(ripgrepCheck(input));
  checks.push(...platformSandboxChecks(input));
  const harness = harnessOutsideWorkspaceCheck(input);
  if (harness !== undefined) checks.push(harness);
  const credentialProxy = credentialProxyConfigCheck(input);
  if (credentialProxy !== undefined) checks.push(credentialProxy);
  const gitPush = gitPushCheck(input);
  if (gitPush !== undefined) checks.push(gitPush);
  const egressExceptions = egressAddressExceptionStoreCheck(input);
  if (egressExceptions !== undefined) checks.push(egressExceptions);
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
