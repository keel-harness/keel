import { spawnSync } from "node:child_process";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(result.status)}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

export function restoreAnnotatedReleaseTag(options: {
  readonly cwd: string;
  readonly tag: string;
  readonly expectedTag: string;
}): string {
  if (options.tag !== options.expectedTag) {
    throw new Error(`expected release tag ${options.expectedTag}`);
  }
  const ref = `refs/tags/${options.tag}`;
  // actions/checkout compares an annotated tag-object SHA with the peeled event commit and can
  // replace the local tag ref with that commit. Restore only the exact protected remote ref.
  git(options.cwd, ["fetch", "--force", "--no-tags", "origin", `+${ref}:${ref}`]);
  if (git(options.cwd, ["cat-file", "-t", ref]) !== "tag") {
    throw new Error("release tag is not annotated");
  }
  const tagCommit = git(options.cwd, ["rev-list", "-n", "1", ref]);
  if (tagCommit !== git(options.cwd, ["rev-parse", "HEAD"])) {
    throw new Error("release tag does not match the checked-out commit");
  }
  return tagCommit;
}
