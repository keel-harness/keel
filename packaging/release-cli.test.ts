import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "packaging", "release-cli.ts"), "utf8");

describe("release candidate orchestration", () => {
  it("uses a byte-identical package-lock mirror only for Syft and removes it before npm pack", () => {
    const mirror = source.indexOf("copyFile(shrinkwrapPath, syftLockMirrorPath)");
    const scan = source.indexOf('"scan"');
    const remove = source.indexOf("rm(syftLockMirrorPath");
    const pack = source.indexOf('"pack", "--json"');
    expect(mirror).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(mirror);
    expect(remove).toBeGreaterThan(scan);
    expect(pack).toBeGreaterThan(remove);
  });
});
