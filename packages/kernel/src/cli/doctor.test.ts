import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type DoctorCheckId,
  type DoctorInput,
  MIN_NODE_MAJOR,
  doctorRuntime,
  formatDoctorReport,
  nodeVersionFromProcess,
  runDoctor,
} from "./doctor.js";
import { KEEL_VERSION } from "../version.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// A deps-present baseline; individual tests override fields. Default runtime is the npx/node path
// (the standalone binary bundles its own runtime — see the runtime tests below).
const base: DoctorInput = {
  runtime: "node",
  nodeVersionRaw: "v20.20.1",
  rgVersionRaw: "ripgrep 14.1.1 (rev 2a41ca974b)",
  bwrapVersionRaw: null,
  socatVersionRaw: null,
  sandboxExecPresent: true,
  platform: "darwin",
  osReleaseRaw: null,
  procVersionRaw: null,
};
const debian = 'ID=debian\nID_LIKE=""\nPRETTY_NAME="Debian"\n';
const ubuntu = 'ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 24.04"\n';
const fedora = 'ID=fedora\nPRETTY_NAME="Fedora Linux 40"\n';
const rhel = 'ID=rhel\nID_LIKE="fedora"\n';
const arch = 'ID=arch\nPRETTY_NAME="Arch Linux"\n';
const mint = 'ID=linuxmint\nID_LIKE="ubuntu debian"\n';
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const check = (input: Partial<DoctorInput>, id: DoctorCheckId) =>
  runDoctor({ ...base, ...input }).checks.find((c) => c.id === id);

describe("doctorRuntime / nodeVersionFromProcess (pure probe-input helpers — lifted out of the bin)", () => {
  it("detects the standalone bun runtime vs the node runtime", () => {
    expect(doctorRuntime({ bun: "1.3.14", node: "20.20.1" })).toBe("standalone");
    expect(doctorRuntime({ node: "20.20.1" })).toBe("node");
    expect(doctorRuntime({})).toBe("node");
  });

  it("returns the v-prefixed node version when present, else null (caller then probes PATH)", () => {
    expect(nodeVersionFromProcess({ node: "20.20.1" })).toBe("v20.20.1");
    expect(nodeVersionFromProcess({ bun: "1.3.14" })).toBeNull();
    expect(nodeVersionFromProcess({})).toBeNull();
  });
});

describe("runDoctor — all dependencies present", () => {
  it("reports node/ripgrep plus the macOS sandbox primitive ok, exit 0, ok=true (node runtime)", () => {
    const r = runDoctor(base);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["node", "ok"],
      ["ripgrep", "ok"],
      ["macos-sandbox", "ok"],
    ]);
    expect(check({}, "node")?.detail).toBe("v20.20.1");
    expect(check({}, "ripgrep")?.detail).toBe("14.1.1");
    expect(check({}, "macos-sandbox")?.detail).toBe("sandbox-exec present");
  });

  it("validates an explicitly supplied credential proxy config without exposing source details", () => {
    const valid = runDoctor({
      ...base,
      credentialProxyConfigRaw: JSON.stringify({
        version: 1,
        rules: [
          {
            id: "fixture-api",
            mode: "swap_on_access",
            host: "api.example.com",
            scheme: "Bearer",
            source: { kind: "env", name: "KEEL_FIXTURE_TOKEN" },
          },
        ],
      }),
    });
    expect(valid.checks.map((c) => [c.id, c.status])).toContainEqual([
      "credential-proxy-config",
      "ok",
    ]);

    const invalid = runDoctor({
      ...base,
      credentialProxyConfigRaw: JSON.stringify({
        version: 1,
        rules: [
          {
            id: "fixture-api",
            mode: "placeholder",
            host: "127.0.0.1",
            scheme: "Bearer with space",
            source: { kind: "env", name: "KEEL_FIXTURE_TOKEN" },
          },
        ],
      }),
    });
    const row = invalid.checks.find((c) => c.id === "credential-proxy-config");
    expect(row).toMatchObject({
      status: "missing",
      detail: "invalid",
      fix: "fix KEEL_WARDEN_CREDENTIAL_PROXY_RULES and re-run: keel doctor",
    });
    expect(JSON.stringify(row)).not.toContain("KEEL_FIXTURE_TOKEN");
  });

  it("reports exception-store readiness and one bounded remediation without claiming activation", () => {
    const ready = runDoctor({
      ...base,
      egressAddressExceptionStore: { status: "ok", detail: "validated; 0 exceptions" },
    });
    expect(ready.checks.find((row) => row.id === "egress-address-exception-store")).toEqual({
      id: "egress-address-exception-store",
      label: "egress exceptions",
      status: "ok",
      detail: "validated; 0 exceptions",
    });

    const invalid = runDoctor({
      ...base,
      egressAddressExceptionStore: {
        status: "error",
        detail: "owner mode invalid\nsecret follow-on",
        fix: "chmod 600 -- '/tmp/egress-address-exceptions.v1.json' && keel doctor",
      },
    });
    const row = invalid.checks.find(
      (candidate) => candidate.id === "egress-address-exception-store",
    );
    expect(row).toEqual({
      id: "egress-address-exception-store",
      label: "egress exceptions",
      status: "missing",
      detail: "owner mode invalid secret follow-on",
      why: "private-address exception authority cannot be loaded safely",
      fix: "chmod 600 -- '/tmp/egress-address-exceptions.v1.json' && keel doctor",
    });
    expect(invalid.ok).toBe(false);
    expect(formatDoctorReport(invalid, { color: false })).not.toContain("address guard on");
  });
});

describe("runDoctor — Phase 2A sandbox preflight", () => {
  it("activates Linux bwrap/socat checks and emits one distro-specific fix per missing dep", () => {
    const r = runDoctor({
      ...base,
      platform: "linux",
      osReleaseRaw: ubuntu,
      bwrapVersionRaw: null,
      socatVersionRaw: null,
      sandboxExecPresent: null,
    });

    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["node", "ok"],
      ["ripgrep", "ok"],
      ["bwrap", "missing"],
      ["socat", "missing"],
    ]);
    expect(check({ platform: "linux", osReleaseRaw: ubuntu }, "bwrap")?.fix).toBe(
      "sudo apt-get install -y bubblewrap",
    );
    expect(check({ platform: "linux", osReleaseRaw: ubuntu }, "socat")?.fix).toBe(
      "sudo apt-get install -y socat",
    );
  });

  it("maps Linux sandbox dependency fixes across supported distro families", () => {
    expect(check({ platform: "linux", osReleaseRaw: fedora }, "bwrap")?.fix).toBe(
      "sudo dnf install -y bubblewrap",
    );
    expect(check({ platform: "linux", osReleaseRaw: fedora }, "socat")?.fix).toBe(
      "sudo dnf install -y socat",
    );
    expect(check({ platform: "linux", osReleaseRaw: arch }, "bwrap")?.fix).toBe(
      "sudo pacman -S --noconfirm bubblewrap",
    );
    expect(check({ platform: "linux", osReleaseRaw: arch }, "socat")?.fix).toBe(
      "sudo pacman -S --noconfirm socat",
    );
  });

  it("reports Linux sandbox deps ok when present without claiming default enforcement", () => {
    const out = formatDoctorReport(
      runDoctor({
        ...base,
        platform: "linux",
        osReleaseRaw: debian,
        bwrapVersionRaw: "bubblewrap 0.10.0",
        socatVersionRaw: "socat by Gerhard Rieger and contributors",
        sandboxExecPresent: null,
      }),
      { color: false },
    );

    expect(out).toContain("  ✓ bwrap");
    expect(out).toContain("  ✓ socat");
    expect(out).toContain("default governed mode routes bash + file tools through warden");
    expect(out).not.toMatch(/sandbox active|sandbox enforced|default-on/i);
  });

  it("checks the macOS sandbox-exec primitive and fails closed when it is unavailable", () => {
    const r = runDoctor({ ...base, sandboxExecPresent: false });
    expect(check({ sandboxExecPresent: false }, "macos-sandbox")?.status).toBe("missing");
    expect(check({ sandboxExecPresent: false }, "macos-sandbox")?.fix).toBe(
      "use a macOS host with /usr/bin/sandbox-exec available",
    );
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("treats WSL1 as unsupported and WSL2 as Linux for bwrap/socat checks", () => {
    const wsl1 = runDoctor({
      ...base,
      platform: "linux",
      procVersionRaw: "Linux version 4.4.0-19041-Microsoft",
      bwrapVersionRaw: "bubblewrap 0.10.0",
      socatVersionRaw: "socat by Gerhard Rieger and contributors",
      sandboxExecPresent: null,
    });
    expect(wsl1.checks.map((c) => [c.id, c.status])).toContainEqual(["wsl2", "missing"]);
    expect(check({ platform: "linux", procVersionRaw: "WSL1" }, "wsl2")?.fix).toBe(
      "wsl --set-default-version 2",
    );
    expect(wsl1.exitCode).toBe(1);

    const wsl2 = runDoctor({
      ...base,
      platform: "linux",
      procVersionRaw: "Linux version 5.15.153.1-microsoft-standard-WSL2",
      bwrapVersionRaw: "bubblewrap 0.10.0",
      socatVersionRaw: "socat by Gerhard Rieger and contributors",
      sandboxExecPresent: null,
    });
    expect(wsl2.checks.some((c) => c.id === "wsl2")).toBe(false);
    expect(wsl2.ok).toBe(true);
  });

  it("keeps native Windows honest as reduced-enforcement with a WSL2 fix, not a failure", () => {
    const r = runDoctor({ ...base, platform: "win32", sandboxExecPresent: null });
    const check = r.checks.find((c) => c.id === "windows-sandbox");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toBe("native reduced-enforcement");
    expect(check?.why).toMatch(/WSL2/i);
    expect(check?.fix).toBe("wsl --install");
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });
});

describe("runDoctor — harness install inside the workspace", () => {
  it("stays silent when keel's own code lives outside the workspace (npx/global)", () => {
    const r = runDoctor({
      ...base,
      cwd: "/project",
      harnessExecutablePaths: [
        "/home/dev/.npm/_npx/a/node_modules/keel-harness/bin/keel-warden.mjs",
      ],
    });
    expect(r.checks.some((c) => c.id === "harness-outside-workspace")).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("reports reduced enforcement when keel's own code is inside the workspace", () => {
    // In an in-tree install the harness's own bytes sit in the model-writable workspace, so a
    // governed write can replace the code that decides policy. keel cannot contain this — when the
    // workspace IS the harness source that is the whole point of the task — so it must say so
    // rather than let the assumption stay invisible.
    const r = runDoctor({
      ...base,
      cwd: "/project",
      harnessExecutablePaths: [
        "/project/node_modules/keel-harness/bin/keel-warden.mjs",
        "/opt/elsewhere/rg",
      ],
    });
    const check = r.checks.find((c) => c.id === "harness-outside-workspace");
    expect(check?.status).toBe("warn");
    expect(check?.detail).toBe("reduced enforcement: keel's own code is workspace-writable");
    expect(check?.why).toMatch(/governed write/i);
    expect(check?.fix).toMatch(/npx|global/i);
    // A posture warning, not a hard failure: it must not break an in-tree dev workflow.
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("treats the workspace root itself as inside (self-hosting keel)", () => {
    const r = runDoctor({
      ...base,
      cwd: "/keel",
      harnessExecutablePaths: ["/keel/packages/warden/src/bin-entry.ts"],
    });
    expect(r.checks.find((c) => c.id === "harness-outside-workspace")?.status).toBe("warn");
  });
});

describe("runDoctor — ripgrep missing (required → failure)", () => {
  it("flags ripgrep missing, fails the exit code, names why it matters", () => {
    const r = runDoctor({ ...base, rgVersionRaw: null });
    const rg = r.checks.find((c) => c.id === "ripgrep");
    expect(rg?.status).toBe("missing");
    expect(rg?.why).toMatch(/search/i);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("repairs a missing npm-carried optional package instead of silently switching to PATH", () => {
    const rg = check(
      { rgVersionRaw: null, ripgrepSource: "bundled", platform: "darwin" },
      "ripgrep",
    );
    expect(rg).toMatchObject({
      status: "missing",
      detail: "bundled package unavailable",
      why: "required by the search tool; the npm carrier does not execute PATH fallbacks",
      fix: `npm install --global --ignore-scripts --include=optional keel-harness@${KEEL_VERSION}`,
    });
  });

  it("recovers from an unavailable explicit KEEL_RG_PATH without installing a second ripgrep", () => {
    expect(
      check({ rgVersionRaw: null, ripgrepSource: "override", platform: "darwin" }, "ripgrep"),
    ).toMatchObject({
      detail: "KEEL_RG_PATH is unavailable",
      fix: "unset KEEL_RG_PATH && keel doctor",
    });
    expect(
      check({ rgVersionRaw: null, ripgrepSource: "override", platform: "win32" }, "ripgrep")?.fix,
    ).toBe("Remove-Item Env:KEEL_RG_PATH; keel doctor");
  });

  it("emits the right one-line fix per distro/OS", () => {
    expect(check({ rgVersionRaw: null, platform: "darwin" }, "ripgrep")?.fix).toBe(
      "brew install ripgrep",
    );
    expect(
      check({ rgVersionRaw: null, platform: "linux", osReleaseRaw: debian }, "ripgrep")?.fix,
    ).toBe("sudo apt-get install -y ripgrep");
    expect(
      check({ rgVersionRaw: null, platform: "linux", osReleaseRaw: ubuntu }, "ripgrep")?.fix,
    ).toBe("sudo apt-get install -y ripgrep");
    expect(
      check({ rgVersionRaw: null, platform: "linux", osReleaseRaw: mint }, "ripgrep")?.fix,
    ).toBe("sudo apt-get install -y ripgrep");
    expect(
      check({ rgVersionRaw: null, platform: "linux", osReleaseRaw: fedora }, "ripgrep")?.fix,
    ).toBe("sudo dnf install -y ripgrep");
    expect(
      check({ rgVersionRaw: null, platform: "linux", osReleaseRaw: rhel }, "ripgrep")?.fix,
    ).toBe("sudo dnf install -y ripgrep");
    expect(
      check({ rgVersionRaw: null, platform: "linux", osReleaseRaw: arch }, "ripgrep")?.fix,
    ).toBe("sudo pacman -S --noconfirm ripgrep");
  });

  it("falls back to a single honest line for an unknown linux distro (never a wall)", () => {
    const fix = check(
      { rgVersionRaw: null, platform: "linux", osReleaseRaw: "ID=void\n" },
      "ripgrep",
    )?.fix;
    expect(fix).toMatch(/ripgrep/i);
    expect(fix?.split("\n")).toHaveLength(1);
  });

  it("falls back to a single honest line when /etc/os-release is absent", () => {
    const fix = check(
      { rgVersionRaw: null, platform: "linux", osReleaseRaw: null },
      "ripgrep",
    )?.fix;
    expect(fix).toMatch(/ripgrep/i);
    expect(fix?.split("\n")).toHaveLength(1);
  });

  it("emits a winget one-liner on Windows", () => {
    expect(check({ rgVersionRaw: null, platform: "win32" }, "ripgrep")?.fix).toBe(
      "winget install BurntSushi.ripgrep.MSVC",
    );
  });

  it("emits a single honest line on any other platform", () => {
    const fix = check({ rgVersionRaw: null, platform: "freebsd" }, "ripgrep")?.fix;
    expect(fix).toMatch(/ripgrep/i);
    expect(fix?.split("\n")).toHaveLength(1);
  });

  it("shows the raw output when rg --version is in an unexpected shape", () => {
    expect(check({ rgVersionRaw: "rg (custom build)" }, "ripgrep")?.detail).toBe(
      "rg (custom build)",
    );
  });
});

describe("runDoctor — probe output sanitization", () => {
  it("sanitizes unexpected probe output before it reaches terminal-rendered details", () => {
    const report = runDoctor({
      ...base,
      nodeVersionRaw: `v20.20.1${ESC}]2;node-owned${BEL}\n  ○ sandbox active`,
      rgVersionRaw: `rg custom build${ESC}[2J\n  ✓ policy approved`,
    });
    const node = report.checks.find((c) => c.id === "node");
    const rg = report.checks.find((c) => c.id === "ripgrep");

    expect(node?.detail).not.toContain(ESC);
    expect(node?.detail).not.toContain(BEL);
    expect(node?.detail).not.toContain("\n");
    expect(rg?.detail).not.toContain(ESC);
    expect(rg?.detail).not.toContain(BEL);
    expect(rg?.detail).not.toContain("\n");

    const out = formatDoctorReport(report, { color: false });
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out.split("\n")).not.toContain("  ○ sandbox active");
    expect(out.split("\n")).not.toContain("  ✓ policy approved");
  });
});

describe("runDoctor — node version handling", () => {
  it("uses the same minimum node major as the root package engines field", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      engines?: { node?: string };
    };
    const major = /^>=\s*(\d+)$/.exec(pkg.engines?.node ?? "")?.[1];
    expect(major).toBeDefined();
    const engineMajor = Number(major);

    expect(MIN_NODE_MAJOR).toBe(engineMajor);
    expect(check({ nodeVersionRaw: `v${engineMajor}.0.0` }, "node")?.status).toBe("ok");
    expect(check({ nodeVersionRaw: `v${engineMajor - 1}.99.0` }, "node")?.status).toBe("warn");
  });

  it("warns (does not fail) when node is older than 20", () => {
    const r = runDoctor({ ...base, nodeVersionRaw: "v18.19.0" });
    const node = r.checks.find((c) => c.id === "node");
    expect(node?.status).toBe("warn");
    expect(node?.why).toMatch(/>=?\s*20/);
    expect(node?.fix).toBeDefined();
    expect(r.exitCode).toBe(0); // advisory: keel is already running, so it does run
    expect(r.ok).toBe(true);
  });

  it("accepts node >= 20 with or without the leading 'v'", () => {
    expect(check({ nodeVersionRaw: "v22.1.0" }, "node")?.status).toBe("ok");
    expect(check({ nodeVersionRaw: "20.0.0" }, "node")?.status).toBe("ok");
  });

  it("warns when node is present but unparseable", () => {
    const node = check({ nodeVersionRaw: "not-a-version" }, "node");
    expect(node?.status).toBe("warn");
    expect(node?.fix).toBeDefined();
  });

  it("warns with an install hint when node is not detected on the node runtime", () => {
    // Defensive: keel is, by definition, already running under node here; this proves the branch is
    // honest rather than crashing.
    const node = check({ nodeVersionRaw: null }, "node");
    expect(node?.status).toBe("warn");
    expect(node?.detail).toMatch(/not detected/i);
    expect(node?.fix).toMatch(/install Node/i);
  });

  it("omits the node check entirely on the standalone binary (runtime bundled)", () => {
    const r = runDoctor({ ...base, runtime: "standalone", nodeVersionRaw: null });
    expect(r.checks.map((c) => c.id)).toEqual(["ripgrep", "macos-sandbox"]);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });
});

describe("formatDoctorReport — render goldens", () => {
  it("renders the all-passed report (plain)", () => {
    const out = formatDoctorReport(runDoctor(base), { color: false });
    expect(out).toBe(
      [
        `keel doctor ${KEEL_VERSION}`,
        "",
        "readiness",
        "  ✓ node          v20.20.1",
        "  ✓ ripgrep       14.1.1",
        "  ✓ macOS sandbox sandbox-exec present",
        "  ○ enforcement default governed mode routes bash + file tools through warden · ungoverned tools fail closed",
        "",
        "All checks passed.",
      ].join("\n"),
    );
    expect(out).not.toMatch(/trusted|autopilot|policy review|approved|integrity verified/i);
  });

  it("renders a missing-dep report with exactly one fix line (plain)", () => {
    const out = formatDoctorReport(
      runDoctor({
        ...base,
        rgVersionRaw: null,
        platform: "linux",
        osReleaseRaw: debian,
        bwrapVersionRaw: "bubblewrap 0.10.0",
        socatVersionRaw: "socat by Gerhard Rieger and contributors",
        sandboxExecPresent: null,
      }),
      { color: false },
    );
    expect(out).toBe(
      [
        `keel doctor ${KEEL_VERSION}`,
        "",
        "readiness",
        "  ✓ node    v20.20.1",
        "  ✗ ripgrep not found — required by the search tool",
        "      fix: sudo apt-get install -y ripgrep",
        "  ✓ bwrap   0.10.0",
        "  ✓ socat   socat by Gerhard Rieger and contributors",
        "  ○ enforcement default governed mode routes bash + file tools through warden · ungoverned tools fail closed",
        "",
        "1 issue found. Run the fix above, then re-run: keel doctor",
      ].join("\n"),
    );
  });

  it("never emits a wall of docs — at most one fix line per non-ok check", () => {
    const out = formatDoctorReport(
      runDoctor({
        ...base,
        rgVersionRaw: null,
        nodeVersionRaw: "v18.0.0",
        platform: "linux",
        osReleaseRaw: fedora,
      }),
      { color: false },
    );
    const fixLines = out.split("\n").filter((l) => l.trim().startsWith("fix:"));
    // one per non-ok check (node warn + ripgrep missing + bwrap missing + socat missing)
    expect(fixLines).toHaveLength(4);
  });

  it("emits zero ANSI control bytes when color is off (NO_COLOR / non-TTY)", () => {
    const plain = formatDoctorReport(runDoctor({ ...base, rgVersionRaw: null }), { color: false });
    // eslint-disable-next-line no-control-regex
    expect(plain).not.toMatch(/\x1b\[/);
  });

  it("uses ANSI color for status glyphs when color is on", () => {
    const colored = formatDoctorReport(runDoctor({ ...base, rgVersionRaw: null }), { color: true });
    // eslint-disable-next-line no-control-regex
    expect(colored).toMatch(/\x1b\[/);
  });

  it("summarizes warnings-only (no failure) when a check warns but none are missing", () => {
    const out = formatDoctorReport(runDoctor({ ...base, nodeVersionRaw: "v18.0.0" }), {
      color: false,
    });
    expect(out).toContain("All required checks passed (1 warning).");
  });

  // The renderer is general-purpose: Phase 2 adds more checks (bubblewrap/socat) that can be missing
  // or warn together, so the plural summaries must be correct now. `runDoctor` can only produce ≤1 of
  // each today, so these feed synthetic reports directly.
  it("pluralizes the issue/fix summary for multiple missing checks", () => {
    const out = formatDoctorReport(
      {
        checks: [
          { id: "ripgrep", label: "ripgrep", status: "missing", detail: "not found", fix: "a" },
          { id: "node", label: "node", status: "missing", detail: "not found", fix: "b" },
        ],
        ok: false,
        exitCode: 1,
      },
      { color: false },
    );
    expect(out).toContain("2 issues found. Run the fixes above");
  });

  it("pluralizes the warning summary for multiple warnings", () => {
    const out = formatDoctorReport(
      {
        checks: [
          { id: "node", label: "node", status: "warn", detail: "old", fix: "x" },
          { id: "ripgrep", label: "ripgrep", status: "warn", detail: "old", fix: "y" },
        ],
        ok: true,
        exitCode: 0,
      },
      { color: false },
    );
    expect(out).toContain("All required checks passed (2 warnings).");
  });
});
