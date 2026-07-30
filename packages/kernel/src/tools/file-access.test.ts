import { describe, expect, it } from "vitest";
import { contentHash, FileAccessTracker } from "./file-access.js";

describe("FileAccessTracker", () => {
  const path = "/repo/a.txt";

  it("records whole-file knowledge and preserves it across edits", () => {
    const before = contentHash("alpha beta");
    const after = contentHash("alpha gamma");
    const tracker = new FileAccessTracker();

    tracker.markKnown(path, before);
    expect(tracker.knownHash(path)).toBe(before);
    expect(tracker.coversRange(path, before, { start: 0, end: 10 }, "alpha beta")).toBe(true);
    expect(tracker.coversFullFile(path, before)).toBe(true);

    tracker.markEdited(
      path,
      before,
      after,
      { start: 6, end: 10 },
      "gamma".length,
      "alpha beta",
      "alpha gamma",
    );
    expect(tracker.knownHash(path)).toBe(after);
    expect(tracker.coversRange(path, after, { start: 0, end: 11 }, "alpha gamma")).toBe(true);
    expect(tracker.coversFullFile(path, after)).toBe(true);
  });

  it("tracks and merges observed ranges without upgrading gaps", () => {
    const content = "0123456789abcdef";
    const tracker = new FileAccessTracker();

    tracker.markKnown(path, contentHash("0123"), { start: 0, end: 4 });
    tracker.markKnown(path, contentHash("4567"), { start: 4, end: 8 });

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.hasKnownCoverage(path)).toBe(true);
    expect(tracker.coversRange(path, contentHash(content), { start: 0, end: 8 }, content)).toBe(
      true,
    );
    expect(tracker.coversRange(path, contentHash(content), { start: 8, end: 9 }, content)).toBe(
      false,
    );
    expect(
      tracker.coversRange(
        path,
        contentHash("0123ZZZZ89abcdef"),
        { start: 0, end: 1 },
        "0123ZZZZ89abcdef",
      ),
    ).toBe(true);
    expect(
      tracker.coversRange(
        path,
        contentHash("012X456789abcdef"),
        { start: 0, end: 1 },
        "012X456789abcdef",
      ),
    ).toBe(false);
    expect(tracker.coversFullFile(path, contentHash(content))).toBe(false);
    expect(tracker.coversFullFile(path, "stale")).toBe(false);
    expect(
      tracker.coversRange("/repo/missing.txt", contentHash(content), { start: 0, end: 1 }, content),
    ).toBe(false);
    expect(tracker.coversFullFile("/repo/missing.txt", contentHash(content))).toBe(false);
  });

  it("keeps range observations independent of whole-file hash drift outside the observed bytes", () => {
    const current = "abcXYZghi";
    const tracker = new FileAccessTracker();

    tracker.markKnown(path, contentHash("abc"), { start: 0, end: 3 });
    tracker.markKnown(path, contentHash("XYZ"), { start: 3, end: 6 });

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.coversRange(path, contentHash(current), { start: 0, end: 6 }, current)).toBe(
      true,
    );
    expect(
      tracker.coversRange(path, contentHash("abcXYZzzz"), { start: 0, end: 6 }, "abcXYZzzz"),
    ).toBe(true);
    expect(
      tracker.coversRange(path, contentHash("abcxYZghi"), { start: 0, end: 6 }, "abcxYZghi"),
    ).toBe(false);
  });

  it("preserves prior full-file coverage when a later range read proves the same whole-file hash", () => {
    const content = "line one\nline two\n";
    const full = contentHash(content);
    const tracker = new FileAccessTracker();

    tracker.markKnown(path, full);
    tracker.markKnown(path, contentHash("line one"), { start: 0, end: 8 }, full);

    expect(tracker.knownHash(path)).toBe(full);
    expect(tracker.coversRange(path, full, { start: 9, end: 17 }, content)).toBe(true);
  });

  it("downgrades stale full-file coverage when a later range read cannot prove the full hash", () => {
    const content = "line one\nline two\n";
    const tracker = new FileAccessTracker();

    tracker.markKnown(path, contentHash("old file"));
    tracker.markKnown(path, contentHash("line one"), { start: 0, end: 8 });

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.coversRange(path, contentHash(content), { start: 0, end: 8 }, content)).toBe(
      true,
    );
    expect(tracker.coversRange(path, contentHash(content), { start: 9, end: 17 }, content)).toBe(
      false,
    );
  });

  it("transforms known ranges across regional edits", () => {
    const beforeContent = "0123456789-----abcde";
    const afterContent = "012345XXXXX89-----abcde";
    const before = contentHash(beforeContent);
    const after = contentHash(afterContent);
    const tracker = new FileAccessTracker();

    tracker.markKnown(path, contentHash("01"), { start: 0, end: 2 });
    tracker.markKnown(path, contentHash("56789"), { start: 5, end: 10 });
    tracker.markKnown(path, contentHash("abcde"), { start: 15, end: 20 });
    tracker.markEdited(
      path,
      before,
      after,
      { start: 6, end: 8 },
      "XXXXX".length,
      beforeContent,
      afterContent,
    );

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.coversRange(path, after, { start: 0, end: 2 }, afterContent)).toBe(true);
    expect(tracker.coversRange(path, after, { start: 5, end: 13 }, afterContent)).toBe(true);
    expect(tracker.coversRange(path, after, { start: 18, end: 23 }, afterContent)).toBe(true);
    expect(tracker.coversRange(path, after, { start: 2, end: 5 }, afterContent)).toBe(false);
    expect(tracker.coversRange(path, after, { start: 14, end: 17 }, afterContent)).toBe(false);
  });

  it("drops stale range state when an edit is recorded against the wrong hash", () => {
    const tracker = new FileAccessTracker();
    tracker.markKnown(path, contentHash("abc"), { start: 0, end: 3 });

    tracker.markEdited(path, "wrong", contentHash("xyz"), { start: 0, end: 1 }, 1, "xyz", "xyz");

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.hasKnownCoverage(path)).toBe(false);
  });

  it("drops stale whole-file state instead of upgrading it across an edit", () => {
    const tracker = new FileAccessTracker();
    tracker.markKnown(path, contentHash("alpha beta"));

    tracker.markEdited(
      path,
      contentHash("different"),
      contentHash("alpha gamma"),
      { start: 6, end: 10 },
      "gamma".length,
      "alpha beta",
      "alpha gamma",
    );

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.hasKnownCoverage(path)).toBe(false);
  });

  it("drops range state when deleting the only known bytes leaves no observed content", () => {
    const tracker = new FileAccessTracker();
    tracker.markKnown(path, contentHash("abc"), { start: 0, end: 3 });

    tracker.markEdited(
      path,
      contentHash("abc"),
      contentHash(""),
      { start: 0, end: 3 },
      0,
      "abc",
      "",
    );

    expect(tracker.knownHash(path)).toBeUndefined();
    expect(tracker.hasKnownCoverage(path)).toBe(false);
  });
});
