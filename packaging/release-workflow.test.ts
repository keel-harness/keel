import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
const installedCarrierSmoke = readFileSync(
  join(process.cwd(), "packaging", "smoke-release-carrier.sh"),
  "utf8",
);
const releaseRunbook = readFileSync(join(process.cwd(), "docs", "guide", "releasing.md"), "utf8");
const releaseAdr = readFileSync(
  join(process.cwd(), "docs", "adr", "0085-public-npm-release-authority-and-artifact-flow.md"),
  "utf8",
);
const releaseNotes = readFileSync(join(process.cwd(), "docs", "releases", "v0.1.2.md"), "utf8");
const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
const masterSpec = readFileSync(join(process.cwd(), "MASTER_SPEC.md"), "utf8");
const status = readFileSync(join(process.cwd(), "docs", "status.md"), "utf8");
const reference = readFileSync(join(process.cwd(), "docs", "guide", "reference.md"), "utf8");
const roadmap = readFileSync(join(process.cwd(), "docs", "roadmap.md"), "utf8");
const claimLedger = readFileSync(join(process.cwd(), "docs", "quality", "claim-ledger.md"), "utf8");
const bugReportTemplate = readFileSync(
  join(process.cwd(), ".github", "ISSUE_TEMPLATE", "bug_report.yml"),
  "utf8",
);
const questionTemplate = readFileSync(
  join(process.cwd(), ".github", "ISSUE_TEMPLATE", "question.yml"),
  "utf8",
);

function workflowJob(name: string): string {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`workflow job is absent: ${name}`);
  const remainder = workflow.slice(start + marker.length);
  const next = /^ {2}[a-zA-Z0-9_-]+:\n/mu.exec(remainder);
  return next === null ? remainder : remainder.slice(0, next.index);
}

function workflowStep(job: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  if (start < 0) throw new Error(`workflow step is absent: ${name}`);
  const remainder = job.slice(start + marker.length);
  const next = /^ {6}- /mu.exec(remainder);
  return next === null ? remainder : remainder.slice(0, next.index);
}

describe("public npm release workflow authority", () => {
  it("records the published 0.1.2 carrier while preserving the 0.1.1 history", () => {
    expect(workflow).toContain('KEEL_VERSION: "0.1.2"');
    expect(workflow).toContain("--notes-file docs/releases/v0.1.2.md");
    expect(releaseRunbook).toContain("protected `v0.1.2` tag");
    expect(releaseAdr).toContain("current release target is");
    expect(releaseAdr).toContain("`keel-harness@0.1.2`");
    expect(releaseAdr).toContain("`0.1.0` was staged but never approved");
    expect(releaseNotes).toContain("# keel v0.1.2");
    expect(releaseNotes).toContain("published on npm and GitHub on 2026-08-13");
    expect(releaseNotes).toContain("separate maintainer 2FA approval");
    expect(releaseNotes).toContain("P1-007");
    expect(installedCarrierSmoke.match(/keel 0\.1\.2/gu)).toHaveLength(2);
    expect(installedCarrierSmoke).toContain('chmod 700 "$KEEL_HOME"');
    expect(bugReportTemplate).toContain("placeholder: keel 0.1.2");
    expect(questionTemplate).toContain("placeholder: keel 0.1.2");
    expect(readme).toContain("`keel-harness@0.1.2` is published on npm");
    expect(status).toContain("`keel-harness@0.1.2` is published on npm and tagged `latest`");
    expect(reference).toContain("The published `keel-harness@0.1.2` carrier includes both");
    expect(roadmap).toContain("Published in `keel-harness@0.1.2`");
    expect(masterSpec).toContain("`keel-harness@0.1.2` was published 2026-08-13");
    expect(claimLedger).toContain("**Packaging — `keel-harness@0.1.2` npm release carrier");
  });

  it("is exact-tag, public-repository, public-main, and protected-environment bound", () => {
    expect(workflow).toContain("tags:\n      - v*.*.*");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("keel-harness/keel");
    expect(workflow).toContain("npm-production");
    expect(workflow).toContain("assert-release-context");
  });

  it("pins the toolchain and every action to immutable identifiers", () => {
    expect(workflow).toContain('NODE_VERSION: "24.18.1"');
    expect(workflow).toContain('NPM_VERSION: "11.16.0"');
    expect(workflow).toContain('SYFT_VERSION: "1.49.0"');
    for (const uses of workflow.matchAll(/^\s*uses:\s*(\S+)/gmu)) {
      expect(uses[1]).toMatch(/@[0-9a-f]{40}$/u);
    }
    expect(workflow).not.toContain("cache:");
    expect(workflow).toContain("7aa2f03ee92739cf643279ba3990548b9925d4e22cae13f46831ee62821147fe");
  });

  it("starts the real-sandbox release gate with the committed credential-TLS fixture CA", () => {
    const verify = workflowJob("verify");
    const sourceGates = workflowStep(verify, "Full source and security gates");
    const realSandbox = workflowStep(
      verify,
      "Real OS-sandbox denial probes (fail closed if the backend is unavailable)",
    );

    expect(sourceGates).not.toContain("pnpm test:sandbox:real");
    expect(realSandbox).toContain(
      "NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/vendor/sandbox-runtime/test/fixtures/tls-terminate/ca.crt",
    );
    expect(realSandbox).toContain("run: pnpm test:sandbox:real");
  });

  it("isolates build, attestation, draft, and stage authority in separate jobs", () => {
    const candidate = workflowJob("candidate");
    const attest = workflowJob("attest");
    const draft = workflowJob("draft");
    const stage = workflowJob("stage");

    expect(candidate).toContain("permissions:\n      contents: read");
    expect(candidate).not.toContain("contents: write");
    expect(candidate).not.toContain("id-token: write");
    expect(candidate).toContain("actions/upload-artifact@");

    expect(attest).toContain("permissions:\n      contents: read");
    expect(attest).toContain("id-token: write");
    expect(attest).toContain("attestations: write");
    expect(attest).toContain("artifact-metadata: write");
    expect(attest).not.toContain("contents: write");
    expect(attest).toContain("actions/download-artifact@");

    expect(draft).toContain("permissions:\n      contents: write");
    expect(draft).not.toContain("id-token: write");
    expect(draft).not.toContain("attestations: write");
    expect(draft).toContain("gh release create --draft");

    expect(stage).toContain("permissions:\n      contents: read\n      id-token: write");
    expect(stage).not.toContain("contents: write");
    expect(stage).not.toContain("attestations: write");
    expect(stage).toContain("environment: npm-production");
    expect(stage).toContain("npm stage publish");
    expect(workflow).not.toContain("packages: write");
  });

  it("builds the npm carrier once, attests it, drafts a release, and stages only", () => {
    expect(workflow.match(/bun packaging\/build\.ts npx/gu)).toHaveLength(1);
    expect(workflow).toContain("pack-release-candidate");
    expect(workflow).toContain("actions/attest@");
    expect(workflow).toContain("gh release create --draft");
    expect(workflow).toContain("npm stage publish");
    expect(workflow.indexOf("pack-release-candidate")).toBeLessThan(
      workflow.indexOf("npm stage publish"),
    );
    expect(workflow).not.toMatch(/\bnpm publish\b/u);
    expect(workflow).not.toContain("npm stage approve");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toContain("retry");
    expect(workflow).not.toContain("build/bin/keel-");
  });

  it("requires the installed carrier to export and independently verify signed audit evidence", () => {
    expect(installedCarrierSmoke).toContain('"$KEEL_BIN" audit export');
    expect(installedCarrierSmoke).toContain('"$KEEL_BIN" audit verify');
    expect(installedCarrierSmoke).toContain('node "$BUNDLE/verify/verify-bundle.mjs" "$BUNDLE"');
    expect(installedCarrierSmoke).toContain("OK sha256:");
  });

  it("makes the operator verify provenance and both SBOM predicate types", () => {
    expect(releaseRunbook).toContain("https://spdx.dev/Document/v2.3");
    expect(releaseRunbook).toContain("https://cyclonedx.org/bom");
    expect(releaseRunbook.match(/gh attestation verify/gu)).toHaveLength(3);
  });
});
