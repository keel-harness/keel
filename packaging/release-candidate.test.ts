import { describe, expect, it } from "vitest";
import {
  assertReleaseContext,
  candidateMetadata,
  releasePacklistProblems,
} from "./release-candidate.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("release-candidate authority", () => {
  const valid = {
    version: "0.1.1",
    tag: "v0.1.1",
    tagObjectType: "tag",
    headCommit: COMMIT,
    mainCommit: COMMIT,
    repository: "keel-harness/keel",
    sourceDirty: false,
    registryVersionExists: false,
  } as const;

  it("accepts only the exact public-main release identity", () => {
    expect(() => assertReleaseContext(valid)).not.toThrow();
    expect(
      candidateMetadata({
        ...valid,
        tarball: "keel-harness-0.1.1.tgz",
        tarballSha256: "a".repeat(64),
      }),
    ).toMatchObject({
      version: "0.1.1",
      tag: "v0.1.1",
      sourceCommit: COMMIT,
      repository: "keel-harness/keel",
      tarball: "keel-harness-0.1.1.tgz",
      tarballSha256: "a".repeat(64),
    });
  });

  it.each([
    ["missing v", { tag: "0.1.1" }, "expected release tag v0.1.1"],
    ["version mismatch", { tag: "v0.1.2" }, "expected release tag v0.1.1"],
    ["lightweight tag", { tagObjectType: "commit" }, "release tag is not annotated"],
    ["non-main commit", { mainCommit: "f".repeat(40) }, "tag commit is not exact main"],
    ["dirty source", { sourceDirty: true }, "source tree is dirty"],
    ["wrong repository", { repository: "private-owner/keel" }, "unexpected repository"],
    ["existing version", { registryVersionExists: true }, "already exists"],
  ])("rejects %s", (_label, change, reason) => {
    expect(() => assertReleaseContext({ ...valid, ...change })).toThrow(reason);
  });

  it("accepts the narrow npm packlist and rejects archives, binaries, and private paths", () => {
    const allowed = [
      "package/package.json",
      "package/README.md",
      "package/npm-shrinkwrap.json",
      "package/LICENSE",
      "package/NOTICE",
      "package/bin/keel.mjs",
      "package/bin/keel-kernel.mjs",
      "package/bin/keel-warden.mjs",
      "package/THIRD_PARTY_LICENSES/components.json",
      "package/THIRD_PARTY_LICENSES/ink-7.0.5-LICENSE",
    ];
    expect(releasePacklistProblems(allowed)).toEqual([]);
    expect(releasePacklistProblems([...allowed, "package/src/private.ts"])).toContain(
      "unexpected tarball member package/src/private.ts",
    );
    expect(releasePacklistProblems([...allowed, "package/keel-linux-x64"])).toContain(
      "standalone binary member package/keel-linux-x64",
    );
    expect(releasePacklistProblems([...allowed, "package/second.tgz"])).toContain(
      "nested archive member package/second.tgz",
    );
  });
});
