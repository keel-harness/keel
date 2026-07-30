import { PUBLIC_PACKAGE_NAME, PUBLIC_REPOSITORY } from "./release-metadata.js";

export interface ReleaseContext {
  readonly version: string;
  readonly tag: string;
  readonly tagObjectType: string;
  readonly headCommit: string;
  readonly mainCommit: string;
  readonly repository: string;
  readonly sourceDirty: boolean;
  readonly registryVersionExists: boolean;
}

export interface CandidateInput extends ReleaseContext {
  readonly tarball: string;
  readonly tarballSha256: string;
}

export function assertReleaseContext(context: ReleaseContext): void {
  const expectedTag = `v${context.version}`;
  if (context.tag !== expectedTag) throw new Error(`expected release tag ${expectedTag}`);
  if (context.tagObjectType !== "tag") throw new Error("release tag is not annotated");
  if (!/^[0-9a-f]{40}$/u.test(context.headCommit)) throw new Error("invalid release commit");
  if (context.headCommit !== context.mainCommit) throw new Error("tag commit is not exact main");
  if (context.repository !== PUBLIC_REPOSITORY) {
    throw new Error(`unexpected repository ${context.repository}`);
  }
  if (context.sourceDirty) throw new Error("source tree is dirty");
  if (context.registryVersionExists) {
    throw new Error(`${PUBLIC_PACKAGE_NAME}@${context.version} already exists`);
  }
}

export function candidateMetadata(input: CandidateInput) {
  assertReleaseContext(input);
  if (input.tarball !== `keel-harness-${input.version}.tgz`) {
    throw new Error(`unexpected tarball ${input.tarball}`);
  }
  if (!/^[0-9a-f]{64}$/u.test(input.tarballSha256)) throw new Error("invalid tarball SHA-256");
  return {
    schemaVersion: 1,
    package: "keel-harness",
    version: input.version,
    tag: input.tag,
    sourceCommit: input.headCommit,
    sourceDirty: false,
    repository: input.repository,
    tarball: input.tarball,
    tarballSha256: input.tarballSha256,
  } as const;
}

const EXACT_MEMBERS = new Set([
  "package/package.json",
  "package/README.md",
  "package/npm-shrinkwrap.json",
  "package/LICENSE",
  "package/NOTICE",
  "package/bin/keel.mjs",
  "package/bin/keel-kernel.mjs",
  "package/bin/keel-warden.mjs",
]);
const LICENSE_PREFIX = "package/THIRD_PARTY_LICENSES/";

export function releasePacklistProblems(members: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member)) problems.push(`duplicate tarball member ${member}`);
    seen.add(member);
    if (member.endsWith(".tgz") || member.endsWith(".tar.gz")) {
      problems.push(`nested archive member ${member}`);
      continue;
    }
    if (/\bkeel-(?:darwin|linux)-/u.test(member)) {
      problems.push(`standalone binary member ${member}`);
      continue;
    }
    if (member.includes("..") || member.startsWith("/") || member.includes("\\")) {
      problems.push(`unsafe tarball member ${member}`);
      continue;
    }
    if (!EXACT_MEMBERS.has(member) && !member.startsWith(LICENSE_PREFIX)) {
      problems.push(`unexpected tarball member ${member}`);
    }
  }
  for (const required of EXACT_MEMBERS) {
    if (!seen.has(required)) problems.push(`missing tarball member ${required}`);
  }
  if (!seen.has(`${LICENSE_PREFIX}components.json`)) {
    problems.push(`missing tarball member ${LICENSE_PREFIX}components.json`);
  }
  return problems;
}
