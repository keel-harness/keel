import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restoreAnnotatedReleaseTag } from "./release-tag.js";

const TAG = "v0.1.2";
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixture(options: { readonly annotated: boolean; readonly tagAtHead: boolean }): {
  readonly checkout: string;
  readonly tagCommit: string;
} {
  const root = mkdtempSync(join(tmpdir(), "keel-release-tag-"));
  roots.push(root);
  const remote = join(root, "origin.git");
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  mkdirSync(source);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Keel Test");
  git(source, "config", "user.email", "test@keel.invalid");
  writeFileSync(join(source, "fixture.txt"), "first\n");
  git(source, "add", "fixture.txt");
  git(source, "commit", "-m", "first");
  const tagCommit = git(source, "rev-parse", "HEAD");
  if (options.annotated) git(source, "tag", "-a", TAG, "-m", "keel v0.1.2");
  else git(source, "tag", TAG);
  if (!options.tagAtHead) {
    writeFileSync(join(source, "fixture.txt"), "second\n");
    git(source, "add", "fixture.txt");
    git(source, "commit", "-m", "second");
  }
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "origin", "main", `refs/tags/${TAG}`);
  git(root, "clone", "--branch", "main", remote, checkout);
  return { checkout, tagCommit };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release tag restoration", () => {
  it("restores the annotated tag after actions/checkout overwrites its local ref with the commit", () => {
    const { checkout, tagCommit } = createFixture({ annotated: true, tagAtHead: true });
    git(checkout, "update-ref", `refs/tags/${TAG}`, tagCommit);
    expect(git(checkout, "cat-file", "-t", `refs/tags/${TAG}`)).toBe("commit");

    expect(restoreAnnotatedReleaseTag({ cwd: checkout, tag: TAG, expectedTag: TAG })).toBe(
      tagCommit,
    );
    expect(git(checkout, "cat-file", "-t", `refs/tags/${TAG}`)).toBe("tag");
    expect(git(checkout, "rev-parse", `refs/tags/${TAG}^{}`)).toBe(tagCommit);
  });

  it("fails closed when the remote release tag is lightweight", () => {
    const { checkout } = createFixture({ annotated: false, tagAtHead: true });
    expect(() => restoreAnnotatedReleaseTag({ cwd: checkout, tag: TAG, expectedTag: TAG })).toThrow(
      "release tag is not annotated",
    );
  });

  it("fails closed when the restored tag does not peel to the checked-out commit", () => {
    const { checkout } = createFixture({ annotated: true, tagAtHead: false });
    expect(() => restoreAnnotatedReleaseTag({ cwd: checkout, tag: TAG, expectedTag: TAG })).toThrow(
      "release tag does not match the checked-out commit",
    );
  });

  it("rejects an unexpected tag before fetching a ref", () => {
    const { checkout } = createFixture({ annotated: true, tagAtHead: true });
    expect(() =>
      restoreAnnotatedReleaseTag({ cwd: checkout, tag: "v0.1.1", expectedTag: TAG }),
    ).toThrow("expected release tag v0.1.2");
  });
});
