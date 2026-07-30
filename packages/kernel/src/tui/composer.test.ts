import { describe, expect, it } from "vitest";
import { emptyInput, inputReduce } from "./input.js";
import { composerBufferPresentation, composerPresentation } from "./composer.js";

function type(text: string) {
  let state = emptyInput();
  for (const ch of text) state = inputReduce(state, { kind: "char", value: ch }).state;
  return state;
}

describe("composer presentation contract", () => {
  it("plans the cursor on the true wrapped cell without changing the buffer", () => {
    const exactWidth = composerBufferPresentation("abcd", 4, 4);
    expect(exactWidth).toEqual({
      rows: [
        { cursor: false, before: "abcd" },
        { cursor: true, before: "", atCursor: " ", after: "" },
      ],
      hidden: 0,
      total: 2,
    });

    const wide = composerBufferPresentation("ab界cd", "ab界cd".length, 4);
    expect(wide.rows).toEqual([
      { cursor: false, before: "ab界" },
      { cursor: true, before: "cd", atCursor: " ", after: "" },
    ]);

    const combining = composerBufferPresentation("e\u0301x", 0, 4);
    expect(combining.rows[0]).toEqual({
      cursor: true,
      before: "",
      atCursor: "e\u0301",
      after: "x",
    });
  });

  it("explains idle, running, queued, review, and stopping states without safety overclaims", () => {
    const idle = composerPresentation(emptyInput(), { awaitingInput: true });
    expect(idle).toMatchObject({
      state: "idle",
      label: "input",
      hint: "type a task or /help",
    });

    const exitArmed = composerPresentation(emptyInput(), {
      awaitingInput: true,
      exitArmed: true,
    });
    expect(exitArmed).toMatchObject({
      state: "exit",
      label: "quit armed",
      hint: "Ctrl-C again exits · any other input cancels",
      tone: "warning",
    });

    const running = composerPresentation(type("one more constraint"), { running: true });
    expect(running).toMatchObject({
      state: "running",
      label: "running",
      hint: "Enter queues for the next safe point",
    });

    const queued = composerPresentation(emptyInput(), { running: true, pendingInputs: 2 });
    expect(queued).toMatchObject({
      state: "queued",
      label: "queued",
      hint: "2 follow-ups queued",
    });

    const review = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewSessionAvailable: true,
    });
    expect(review).toMatchObject({
      state: "review",
      label: "decision required",
      hint: "choose above",
    });

    const reviewWithoutSession = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewSessionAvailable: false,
    });
    expect(reviewWithoutSession).toMatchObject({
      state: "review",
      label: "decision required",
      hint: "choose above",
    });

    const submittedReview = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewActionable: false,
    });
    expect(submittedReview).toMatchObject({
      state: "review",
      label: "decision sent",
      hint: "input paused",
    });

    const failedReview = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewActionable: false,
      reviewState: "failed",
    });
    expect(failedReview).toMatchObject({
      state: "review",
      label: "review unavailable",
      hint: "not confirmed · restart the governed session",
    });

    const partialReview = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewActionable: false,
      reviewState: "indeterminate",
    });
    expect(partialReview).toMatchObject({
      state: "review",
      label: "outcome unknown",
      hint: "do not retry · restart and inspect audit",
    });

    const deniedReview = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewActionable: false,
      reviewState: "denied",
    });
    expect(deniedReview).toMatchObject({
      state: "review",
      label: "review denied",
      hint: "warden confirmed · action not executed",
    });

    const governedDenyReview = composerPresentation(emptyInput(), {
      pendingReview: true,
      reviewActionable: false,
      reviewState: "governed-deny",
    });
    expect(governedDenyReview).toMatchObject({
      state: "review",
      label: "governed deny",
      hint: "human approval consumed · inspect tool result for effects",
    });

    const stopping = composerPresentation(emptyInput(), { stopping: true });
    expect(stopping).toMatchObject({
      state: "stopping",
      label: "stopping",
      hint: "reaching a safe stop",
    });

    const panel = composerPresentation(emptyInput(), { foregroundPanel: true });
    expect(panel).toMatchObject({
      state: "panel",
      label: "panel open",
      hint: "Esc closes · input paused",
    });

    for (const p of [
      idle,
      running,
      queued,
      review,
      submittedReview,
      failedReview,
      stopping,
      panel,
    ]) {
      expect(`${p.label} ${p.hint}`).not.toMatch(/approved|verified|contained|safe by/i);
    }
  });

  it("explains slash, reverse-search, @file, paste, editor, and multiline states", () => {
    expect(composerPresentation(type("/cap"))).toMatchObject({
      state: "slash",
      label: "commands",
      hint: "Tab completes · Enter opens · Esc cancels",
    });

    const searching = inputReduce(emptyInput(["run the tests"]), { kind: "reverse-search" }).state;
    expect(composerPresentation(searching)).toMatchObject({
      state: "reverse-search",
      label: "history",
      hint: "type to search · Enter accepts · Ctrl-R older",
    });

    expect(composerPresentation(type("explain @src/"))).toMatchObject({
      state: "file",
      label: "files",
      hint: "Tab completes · Space ends the file token",
    });

    expect(composerPresentation(type("line one\nline two"))).toMatchObject({
      state: "multiline",
      label: "multiline",
      hint: "Enter submits · Ctrl-J adds a line",
    });

    expect(composerPresentation(type("pasted text"), { pasted: true })).toMatchObject({
      state: "paste",
      label: "paste",
      hint: "paste added; review before Enter",
    });

    expect(composerPresentation(type("draft"), { editing: true })).toMatchObject({
      state: "editor",
      label: "editor",
      hint: "editing draft",
    });
  });

  it("makes slash-palette Enter semantics route-specific and non-approving", () => {
    const panel = composerPresentation(type("/cap"));
    const localAction = composerPresentation(type("/quiet"));
    const startsTurn = composerPresentation(type("/goal"));
    const notice = composerPresentation(type("/approve"));
    const exit = composerPresentation(type("/exit"));
    const noMatch = composerPresentation(type("/zzz"));

    expect(panel.hint).toBe("Tab completes · Enter opens · Esc cancels");
    expect(localAction.hint).toBe("Tab completes · Enter applies · Esc cancels");
    expect(startsTurn.hint).toBe("Tab completes · Enter starts · Esc cancels");
    expect(notice.hint).toBe("Tab completes · Enter shows notice · Esc cancels");
    expect(exit.hint).toBe("Tab completes · Enter quits · Esc cancels");
    expect(noMatch.hint).toBe("no matching command · Esc cancels");
    for (const presentation of [panel, localAction, startsTurn, notice, exit, noMatch]) {
      expect(`${presentation.label} ${presentation.hint}`).not.toMatch(
        /approve|approved|grant|trusted|safe by/i,
      );
    }
  });

  it("makes palette hints truthful while a turn or live review is active", () => {
    expect(composerPresentation(type("/goal write docs"), { running: true }).hint).toBe(
      "Tab completes · Enter closes · Esc cancels",
    );
    expect(composerPresentation(type("/help"), { running: true }).hint).toBe(
      "Tab completes · Enter closes · Esc cancels",
    );
    expect(composerPresentation(type("/policies"), { running: true }).hint).toBe(
      "Tab completes · Enter opens · Esc cancels",
    );
    expect(
      composerPresentation(type("/approve"), { running: true, pendingReview: true }).hint,
    ).toBe("Tab completes · Enter applies · Esc cancels");
  });
});
