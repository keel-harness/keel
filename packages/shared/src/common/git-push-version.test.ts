import { describe, expect, it } from "vitest";
import { supportedGitPushVersion } from "./git-push-version.js";

describe("supportedGitPushVersion", () => {
  it("accepts only the exact qualified Git 2.39+ version family", () => {
    expect(supportedGitPushVersion("git version 2.39.0\n")).toBe("2.39.0");
    expect(supportedGitPushVersion("git version 2.50.1 (Apple Git-155)\n")).toBe("2.50.1");
    expect(supportedGitPushVersion("git version 2.38.5\n")).toBeUndefined();
    expect(supportedGitPushVersion("git version 3.0.0\n")).toBeUndefined();
    expect(supportedGitPushVersion("git version unknown\n")).toBeUndefined();
  });
});
