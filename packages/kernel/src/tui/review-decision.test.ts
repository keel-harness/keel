import { describe, expect, it } from "vitest";
import type { ToolInvocationT, UserInput } from "@keel/shared";
import {
  createInteractiveReviewDecisionController,
  parseReviewDecisionInput,
  type InteractiveReviewDecisionController,
  type ReviewPresentationEvent,
} from "./review-decision.js";
import { approvalNoticePlan } from "./approval-notice.js";
import { abortForToolDeadline } from "../infra.js";

const commandKey = `sha256:${"a".repeat(64)}`;

const toolCall: ToolInvocationT = {
  id: "call_review",
  name: "bash",
  args: { command: "python3 tools/check.py" },
};

const review = {
  reviewId: "command_review_1",
  summary: "command review for python3 in workspace /repo",
  allowCommand: `keel approve command_review_1 --scope once --command-key ${commandKey}`,
};

const genericReview = {
  reviewId: "generic_review_1",
  summary: "generic review requires one-time approval",
  allowCommand: "keel approve generic_review_1 --scope once",
};

const mcpReview = {
  reviewId: "mcp_review_1",
  summary:
    "opaque local MCP call requires exact once-only approval: mcp__fixture__echo; arguments are not displayed; the MCP sandbox and live pin check remain enforced",
  allowCommand: "keel approve mcp_review_1 --scope once",
};

const consoleReview = {
  reviewId: "console_review_1",
  summary: "console review for qemu target build-vm",
  allowCommand: `keel approve console_review_1 --scope once --console-target build-vm --console-key ${commandKey}`,
};

function line(text: string): UserInput {
  return { kind: "line", text };
}

function recordPresentation(controller: InteractiveReviewDecisionController): {
  readonly events: ReviewPresentationEvent[];
  readonly disconnect: () => void;
} {
  const events: ReviewPresentationEvent[] = [];
  return {
    events,
    disconnect: controller.connect({ presentation: (event) => events.push(event) }),
  };
}

function eventText(event: ReviewPresentationEvent | undefined): string {
  if (event === undefined) return "";
  return event.kind === "opened" ? event.detail : (event.content ?? "");
}

describe("interactive review-decision input", () => {
  it("emits typed presentation events rather than actionable notice strings", () => {
    const events: unknown[] = [];
    const controller = createInteractiveReviewDecisionController();
    controller.connect({ presentation: (event) => events.push(event) });

    void controller.onReviewRequired({ toolCall, review: genericReview });

    expect(events).toEqual([
      {
        kind: "opened",
        detail: "bash generic review requires one-time approval",
        sessionAvailable: false,
        information: {
          requestedAction: { status: "available", value: "bash" },
          effectiveTarget: {
            status: "available",
            value: "generic review requires one-time approval",
            completeness: "complete",
          },
          reason: {
            status: "available",
            value: "Warden requires human authorization before execution",
          },
          policyDetail: {
            status: "unavailable",
            reason: "matched policy rule not reported by protocol 1.1",
          },
          exactResource: {
            status: "unavailable",
            reason: "no exact reusable resource in the Warden review",
          },
        },
      },
    ]);
  });

  it("preserves an exact once-only process.run summary byte-for-byte through the controller", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const summary =
      "Workspace files changed. This exact argv may run changed repository-controlled code and may " +
      "read or write the workspace and Warden temporary roots. Network access, enumerated home " +
      "credentials, discovered `.env*` files, Warden/audit writes, and writes outside those roots " +
      "remain denied. Other unrecognized sensitive workspace files may be readable. Approving runs " +
      "it once: 'git' 'diff' ' leading  repeated  trailing ' ''.";

    void controller.onReviewRequired({
      toolCall: { id: "process-review", name: "process.run", args: { argv: ["forged"] } },
      review: {
        reviewId: "process_review_1",
        summary,
        allowCommand: "keel approve process_review_1 --scope once",
      },
    });

    expect(events.at(-1)).toMatchObject({
      kind: "opened",
      detail: summary,
      sessionAvailable: false,
      information: {
        requestedAction: { status: "available", value: "process.run" },
        effectiveTarget: { status: "available", value: summary, completeness: "complete" },
      },
    });
  });

  it("preserves and resolves exact git.push keyboard and slash decisions without eating prose", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const oid = "0123456789abcdef0123456789abcdef01234567";
    const summary = [
      "Git push requires approval.",
      "Repository: https://localhost:54321/repo.git",
      "Destination: refs/heads/feature/walking-skeleton",
      `Commit: ${oid}`,
      "Subject: walking skeleton commit",
      "Commit facts: 2026-08-10T12:00:00Z; 1; 2 files; +3 -1",
      "Workspace: clean; uncommitted changes are excluded",
      "Effect: create this branch or fast-forward it to this commit; the remote may receive every missing object reachable from the commit",
      "Blocked: force, deletion, tags, hooks, submodule recursion, redirects, and remote-default-branch writes",
      "Credential: deterministic test fixture (release capability withheld); secret stays in the Warden/SRT path",
      "Approval: this occurrence once; expires in 120 seconds",
    ].join("\n");

    const approved = controller.onReviewRequired({
      toolCall: {
        id: "git-push-review",
        name: "git.push",
        args: { remote: "origin", branch: "feature/walking-skeleton", expectedHead: oid },
      },
      review: {
        reviewId: "git_push_review_1",
        summary,
        allowCommand: "keel approve git_push_review_1 --scope once",
      },
    });

    const opened = events.at(-1);
    expect(opened).toMatchObject({
      kind: "opened",
      detail: summary,
      sessionAvailable: false,
      losslessGitPushSummary: summary,
      information: {
        requestedAction: { status: "available", value: "git.push" },
        effectiveTarget: { status: "available", value: summary, completeness: "complete" },
      },
    });
    if (opened?.kind !== "opened") throw new Error("expected exact git.push review presentation");
    expect(approvalNoticePlan({ ...opened, state: "pending" })).toMatchObject({
      state: "pending",
      losslessGitPushSummary: summary,
      actions: [
        "[a] Approve once · this action only",
        "[d] Deny · action will not run",
        "[?] Explain why",
      ],
    });
    expect(controller.handleInput(line("also update the release notes"))).toBe(false);
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(approved).resolves.toEqual({ approved: true, scope: "once" });

    const denied = controller.onReviewRequired({
      toolCall: {
        id: "git-push-review-2",
        name: "git.push",
        args: { remote: "origin", branch: "feature/walking-skeleton", expectedHead: oid },
      },
      review: {
        reviewId: "git_push_review_2",
        summary,
        allowCommand: "keel approve git_push_review_2 --scope once",
      },
    });
    expect(controller.handleInput({ kind: "command", name: "/deny" })).toBe(true);
    await expect(denied).resolves.toEqual({ approved: false });
  });

  it("refuses to open git.push without the exact ADR-0091 envelope and summary", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({
      toolCall: {
        id: "git-push-review",
        name: "git.push",
        args: { remote: "origin", branch: "feature/x", expectedHead: "0".repeat(40) },
      },
      review: {
        reviewId: "git_push_review_1",
        summary: "generic or normalized git push review",
        allowCommand: "keel approve git_push_review_1 --scope once",
      },
    });

    expect(decision).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("does not mistake a literal omitted-marker argv byte sequence for Warden abbreviation", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const summary =
      "Workspace files changed. This exact argv may run changed repository-controlled code and may " +
      "read or write the workspace and Warden temporary roots. Network access, enumerated home " +
      "credentials, discovered `.env*` files, Warden/audit writes, and writes outside those roots " +
      "remain denied. Other unrecognized sensitive workspace files may be readable. Approving runs " +
      "it once: 'printf' '[123 chars omitted]'.";

    void controller.onReviewRequired({
      toolCall: { id: "process-review-marker", name: "process.run", args: { argv: ["forged"] } },
      review: {
        reviewId: "process_review_2",
        summary,
        allowCommand: "keel approve process_review_2 --scope once",
      },
    });

    const opened = events.at(-1);
    expect(opened).toMatchObject({
      kind: "opened",
      detail: summary,
      sessionAvailable: false,
      information: {
        effectiveTarget: { status: "available", value: summary, completeness: "complete" },
      },
    });
    if (opened?.kind !== "opened") throw new Error("expected exact process review presentation");
    expect(approvalNoticePlan({ ...opened, state: "pending" })).toMatchObject({
      state: "pending",
      losslessProcessRunSummary: summary,
      actions: [
        "[a] Approve once · this action only",
        "[d] Deny · action will not run",
        "[?] Explain why",
      ],
    });
  });

  it("refuses to open an exact process.run review when its summary cannot be shown losslessly", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({
      toolCall: { id: "process-review", name: "process.run", args: { argv: ["git", "diff"] } },
      review: {
        reviewId: "process_review_2",
        summary: "Workspace files changed. Approving runs it once:\n'git' 'diff'.",
        allowCommand: "keel approve process_review_2 --scope once",
      },
    });

    expect(decision).toBeUndefined();
    expect(events).toEqual([]);
    expect(controller.handleInput(line("a"))).toBe(false);
  });

  it("refuses to open a process.run review without the exact once-only ADR-0090 envelope", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({
      toolCall: { id: "process-review", name: "process.run", args: { argv: ["git", "diff"] } },
      review: {
        reviewId: "generic_review_2",
        summary: "generic process review",
        allowCommand: "keel approve generic_review_2 --scope once",
      },
    });

    expect(decision).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("separates requested intent, Warden-effective target, and exact scope without reading model arguments", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    void controller.onReviewRequired({
      toolCall: {
        ...toolCall,
        args: { command: "printf model-secret-never-presented" },
      },
      review,
    });

    expect(events.at(-1)).toMatchObject({
      kind: "opened",
      sessionAvailable: true,
      information: {
        requestedAction: { status: "available", value: "bash" },
        effectiveTarget: {
          status: "available",
          value: "command review for python3 in workspace /repo",
          completeness: "complete",
        },
        reason: {
          status: "available",
          value: "Warden requires human authorization before execution",
        },
        policyDetail: {
          status: "unavailable",
          reason: "matched policy rule not reported by protocol 1.1",
        },
        exactResource: {
          status: "available",
          kind: "command-envelope",
          value: commandKey,
        },
      },
    });
    expect(JSON.stringify(events.at(-1))).not.toContain("model-secret-never-presented");
    expect(JSON.stringify(events.at(-1))).not.toContain("allowCommand");
    expect(JSON.stringify(events.at(-1))).not.toContain("reviewId");
  });

  it("uses explicit unavailable states when protocol 1.1 omits human-readable approval facts", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    void controller.onReviewRequired({
      toolCall: { ...toolCall, name: "\u001b[31m\n" },
      review: {
        reviewId: "generic_empty",
        summary: "\u001b[31m\n",
        allowCommand: "keel approve generic_empty --scope once",
      },
    });

    expect(events.at(-1)).toMatchObject({
      kind: "opened",
      detail: "",
      sessionAvailable: false,
      information: {
        requestedAction: {
          status: "unavailable",
          reason: "requested tool name unavailable",
        },
        effectiveTarget: {
          status: "unavailable",
          reason: "effective target unavailable from the Warden review",
        },
        exactResource: {
          status: "unavailable",
          reason: "no exact reusable resource in the Warden review",
        },
      },
    });
  });

  it("labels an abbreviated Warden target and withholds persistent approval", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    void controller.onReviewRequired({
      toolCall,
      review: {
        ...review,
        summary: "command review: prefix [93 chars omitted] dangerous-suffix",
      },
    });

    expect(events.at(-1)).toMatchObject({
      kind: "opened",
      sessionAvailable: false,
      information: {
        effectiveTarget: {
          status: "available",
          value: "command review: prefix [93 chars omitted] dangerous-suffix",
          completeness: "abbreviated",
        },
        exactResource: {
          status: "available",
          kind: "command-envelope",
          value: commandKey,
        },
      },
    });
  });

  it("parses only explicit review commands for approval authority", () => {
    expect(parseReviewDecisionInput({ kind: "interrupt" })).toBeUndefined();
    expect(parseReviewDecisionInput(line(""))).toBeUndefined();
    expect(parseReviewDecisionInput({ kind: "command", name: "/help" })).toBeUndefined();
    expect(parseReviewDecisionInput(line("o"))).toBeUndefined();
    expect(parseReviewDecisionInput(line("yes"))).toBeUndefined();
    expect(parseReviewDecisionInput(line("project"))).toBeUndefined();
    expect(parseReviewDecisionInput(line("no"))).toBeUndefined();
    expect(parseReviewDecisionInput({ kind: "command", name: "/approve" })).toEqual({
      kind: "decision",
      decision: { approved: true, scope: "once" },
    });
    expect(parseReviewDecisionInput({ kind: "command", name: "/approve", args: "once" })).toEqual({
      kind: "decision",
      decision: { approved: true, scope: "once" },
    });
    expect(
      parseReviewDecisionInput({ kind: "command", name: "/approve", args: "later" }),
    ).toBeUndefined();
    expect(
      parseReviewDecisionInput({ kind: "command", name: "/approve", args: "project" }),
    ).toEqual({ kind: "decision", decision: { approved: true, scope: "project" } });
    expect(
      parseReviewDecisionInput({ kind: "command", name: "/approve", args: "session" }),
    ).toEqual({
      kind: "decision",
      decision: { approved: true, scope: "session" },
    });
    expect(parseReviewDecisionInput({ kind: "command", name: "/deny" })).toEqual({
      kind: "decision",
      decision: { approved: false },
    });
    expect(parseReviewDecisionInput(line("?"))).toEqual({ kind: "explain" });
    expect(parseReviewDecisionInput({ kind: "command", name: "/why" })).toEqual({
      kind: "explain",
    });
  });

  it("keeps project approval explicit while session approval requires a slash command", () => {
    expect(
      parseReviewDecisionInput({ kind: "command", name: "/approve", args: "project" }),
    ).toEqual({ kind: "decision", decision: { approved: true, scope: "project" } });
    expect(parseReviewDecisionInput(line("s"))).toBeUndefined();
    expect(
      parseReviewDecisionInput({ kind: "command", name: "/approve", args: "session" }),
    ).toEqual({
      kind: "decision",
      decision: { approved: true, scope: "session" },
    });
  });

  it("waits for one active review answer and emits honest notices", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events, disconnect } = recordPresentation(controller);
    const pending = controller.onReviewRequired({ toolCall, review });

    const opened = events.at(-1);
    expect(opened?.kind).toBe("opened");
    if (opened?.kind !== "opened") throw new Error("expected opened presentation");
    const prompt = approvalNoticePlan({ ...opened, state: "pending" });
    expect(prompt).toMatchObject({
      heading: "approval required · not executed",
      actions: [
        "[a] Approve once · this action only",
        "[s] Session · exact target until exit",
        "[d] Deny · action will not run",
        "[?] Explain why",
      ],
      confirmation: "a/s/d Enter · ? why · Esc stops turn",
    });
    expect(prompt?.actions).not.toContain("[p] project · exact command · persists");
    expect(prompt).not.toHaveProperty("context");
    expect(prompt?.detail).toContain("bash command review for python3 in workspace /repo");
    expect(prompt?.detail).not.toMatch(/trusted|approved|safe by/i);
    expect(controller.handleInput(line("why"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("explanation shown above");
    expect(controller.handleInput(line("project"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("approval is active");
    expect(controller.handleInput({ kind: "command", name: "/approve", args: "session" })).toBe(
      true,
    );
    await expect(pending).resolves.toEqual({ approved: true, scope: "session" });
    expect(events.at(-1)?.kind).toBe("closed");

    disconnect();
    expect(controller.handleInput(line("o"))).toBe(false);
  });

  it("presents MCP review as once-only and withholds session authority", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const pending = controller.onReviewRequired({
      toolCall: { id: "call_mcp", name: "mcp__fixture__echo", args: { text: "not-presented" } },
      review: mcpReview,
    });

    const opened = events.at(-1);
    expect(opened).toMatchObject({
      kind: "opened",
      sessionAvailable: false,
      information: {
        requestedAction: { status: "available", value: "mcp__fixture__echo" },
        effectiveTarget: {
          status: "available",
          value: mcpReview.summary,
          completeness: "complete",
        },
        exactResource: {
          status: "unavailable",
          reason: "no exact reusable resource in the Warden review",
        },
      },
    });
    if (opened?.kind !== "opened") throw new Error("expected opened MCP review presentation");
    const prompt = approvalNoticePlan({ ...opened, state: "pending" });
    expect(prompt?.actions).toEqual([
      "[a] Approve once · this action only",
      "[d] Deny · action will not run",
      "[?] Explain why",
    ]);
    expect(prompt?.detail).toContain("arguments are not displayed");
    expect(JSON.stringify(prompt)).not.toContain("not-presented");
    expect(controller.handleInput(line("s"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("session approval is unavailable");
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, scope: "once" });
  });

  it("routes the registered /why command to the active review without resolving it", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const pending = controller.onReviewRequired({ toolCall, review });

    expect(controller.handleInput({ kind: "command", name: "/why" })).toBe(true);
    expect(eventText(events.at(-1))).toContain(
      "explanation shown above · still pending · no authority granted",
    );
    expect(eventText(events.at(-1))).not.toContain("command review for python3");

    expect(controller.handleInput({ kind: "command", name: "/deny" })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it("shows the warden-reviewed target instead of a stale model-authored command", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    void controller.onReviewRequired({
      toolCall: { ...toolCall, args: { command: "printf harmless" } },
      review: {
        ...review,
        summary: "command review requires approval: curl https://api.example.com/data",
      },
    });

    expect(eventText(events.at(-1))).toContain("curl https://api.example.com/data");
    expect(eventText(events.at(-1))).not.toContain("printf harmless");
  });

  it("accepts visible active-review shortcut keys only while a review is pending", async () => {
    const controller = createInteractiveReviewDecisionController();
    const once = controller.onReviewRequired({ toolCall, review });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(once).resolves.toEqual({ approved: true, scope: "once" });

    const session = controller.onReviewRequired({ toolCall, review });
    expect(controller.handleInput(line("s"))).toBe(true);
    await expect(session).resolves.toEqual({ approved: true, scope: "session" });

    const deny = controller.onReviewRequired({ toolCall, review });
    expect(controller.handleInput(line("d"))).toBe(true);
    await expect(deny).resolves.toEqual({ approved: false });

    expect(controller.handleInput(line("a"))).toBe(false);
    expect(parseReviewDecisionInput(line("a"))).toBeUndefined();
    expect(parseReviewDecisionInput(line("d"))).toBeUndefined();
    expect(parseReviewDecisionInput(line("s"))).toBeUndefined();
  });

  it("keeps a submitted decision pending and non-actionable until the warden settles it", async () => {
    let settle!: (value: { readonly status: "resolved"; readonly verdict: "allow" }) => void;
    const settlement = new Promise<{ readonly status: "resolved"; readonly verdict: "allow" }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({
      toolCall,
      review,
      settlement,
    });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });

    expect(events.map((event) => event.kind)).toEqual(["opened", "submitted"]);
    expect(events.at(-1)).toMatchObject({ kind: "submitted", choice: "once" });
    expect(eventText(events.at(-1))).toContain("waiting for warden confirmation");
    for (const shortcut of ["a", "d", "s", "p"] as const) {
      expect(controller.handleInput(line(shortcut))).toBe(true);
      expect(eventText(events.at(-1))).toContain("already submitted");
    }
    for (const name of ["/approve", "/deny"] as const) {
      expect(controller.handleInput({ kind: "command", name })).toBe(true);
      expect(eventText(events.at(-1))).toContain("already submitted");
    }
    expect(controller.handleInput(line("wait for it"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("already submitted");
    expect(controller.handleInput(line("d"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("already submitted");
    expect(controller.handleInput({ kind: "command", name: "/why" })).toBe(true);
    expect(eventText(events.at(-1))).toContain("explanation shown above");
    expect(eventText(events.at(-1))).toContain("decision already submitted");
    expect(eventText(events.at(-1))).not.toMatch(/actions:|\[[ads?]\]|allow: keel approve/i);

    settle({ status: "resolved", verdict: "allow" });
    await settlement;
    await Promise.resolve();
    expect(events.at(-1)?.kind).toBe("confirmed");
    expect(eventText(events.at(-1))).toContain("confirmed by warden");
  });

  it("revokes an unsubmitted review at the tool deadline and rejects late approval", async () => {
    let settle!: (value: { readonly status: "resolved"; readonly verdict: "deny" }) => void;
    const settlement = new Promise<{ readonly status: "resolved"; readonly verdict: "deny" }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const abort = new AbortController();
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const decision = controller.onReviewRequired({
      toolCall,
      review,
      settlement,
      signal: abort.signal,
    });

    abortForToolDeadline(abort);
    await expect(decision).resolves.toBeUndefined();
    expect(events.at(-1)?.kind).toBe("submitted");
    expect(eventText(events.at(-1))).toContain("expired at the tool deadline");
    expect(eventText(events.at(-1))).toContain("late decisions are rejected");

    expect(controller.handleInput(line("a"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("late decisions are rejected");

    const authoritative = controller.awaitTimedOutReviewSettlement();
    let released = false;
    void authoritative.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);

    settle({ status: "resolved", verdict: "deny" });
    await expect(authoritative).resolves.toEqual({ status: "resolved", verdict: "deny" });
    expect(events.at(-1)?.kind).toBe("denied");
    expect(eventText(events.at(-1))).toContain("action not executed");
    expect(controller.handleInput(line("a"))).toBe(false);
  });

  it("does not claim denial when the deadline follows an already-submitted approval", async () => {
    let settle!: (value: { readonly status: "indeterminate"; readonly message: string }) => void;
    const settlement = new Promise<{
      readonly status: "indeterminate";
      readonly message: string;
    }>((resolve) => {
      settle = resolve;
    });
    const abort = new AbortController();
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const decision = controller.onReviewRequired({
      toolCall,
      review,
      settlement,
      signal: abort.signal,
    });

    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });
    abortForToolDeadline(abort);

    expect(eventText(events.at(-1))).toContain("deadline reached after review decision submission");
    expect(eventText(events.at(-1))).toContain("waiting for authoritative warden outcome");
    expect(eventText(events.at(-1))).not.toContain("waiting for authoritative warden denial");

    const authoritative = controller.awaitTimedOutReviewSettlement();
    settle({ status: "indeterminate", message: "response lost after submission" });
    await expect(authoritative).resolves.toEqual({
      status: "indeterminate",
      message: "response lost after submission",
    });
    expect(events.at(-1)?.kind).toBe("indeterminate");
    expect(eventText(events.at(-1))).toContain("action may have executed");
  });

  it("keeps a submitted decision visible through interruption until settlement is known", async () => {
    let settle!: (value: { readonly status: "cancelled" }) => void;
    const settlement = new Promise<{ readonly status: "cancelled" }>((resolve) => {
      settle = resolve;
    });
    const abort = new AbortController();
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({
      toolCall,
      review,
      settlement,
      signal: abort.signal,
    });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });

    expect(controller.handleInput({ kind: "interrupt" })).toBe(false);
    abort.abort();
    expect(events.at(-1)?.kind).toBe("submitted");
    settle({ status: "cancelled" });
    await settlement;
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("indeterminate");
    expect(eventText(events.at(-1))).toContain("outcome unavailable after interruption");
    expect(eventText(events.at(-1))).toContain("action may have executed");
    expect(eventText(events.at(-1))).toContain("do not retry automatically");
  });

  it("treats a rejected settlement channel after submission as indeterminate", async () => {
    let reject!: (error: Error) => void;
    const settlement = new Promise<never>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const decision = controller.onReviewRequired({ toolCall, review, settlement });

    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });
    reject(new Error("settlement channel closed"));
    await expect(settlement).rejects.toThrow("settlement channel closed");
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("indeterminate");
    expect(eventText(events.at(-1))).toContain("action may have executed");
    expect(eventText(events.at(-1))).toContain("do not retry automatically");
  });

  it("keeps an unconfirmed review visible but non-actionable after settlement delivery fails", async () => {
    let fail!: (value: { readonly status: "failed"; readonly message: string }) => void;
    const settlement = new Promise<{ readonly status: "failed"; readonly message: string }>(
      (resolve) => {
        fail = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({
      toolCall,
      review,
      settlement,
    });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });
    fail({ status: "failed", message: "warden connection closed" });
    await settlement;
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("failed");
    expect(eventText(events.at(-1))).toContain("not confirmed");
    expect(eventText(events.at(-1))).toContain("restart the governed session");
    expect(controller.handleInput(line("a"))).toBe(false);
  });

  it("renders a resolved deny as non-execution rather than approval confirmation", async () => {
    let settle!: (value: { readonly status: "resolved"; readonly verdict: "deny" }) => void;
    const settlement = new Promise<{ readonly status: "resolved"; readonly verdict: "deny" }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({ toolCall, review, settlement });
    expect(controller.handleInput(line("d"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: false });
    settle({ status: "resolved", verdict: "deny" });
    await settlement;
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("denied");
    expect(eventText(events.at(-1))).toContain("denied by you");
    expect(eventText(events.at(-1))).toContain("action not executed");
    expect(eventText(events.at(-1))).toContain("rerun the request to reconsider");
    expect(eventText(events.at(-1))).not.toContain("approval confirmed");
  });

  it("preserves the approved decision while deferring governed deny effect truth to the tool result", async () => {
    let settle!: (value: { readonly status: "resolved"; readonly verdict: "deny" }) => void;
    const settlement = new Promise<{ readonly status: "resolved"; readonly verdict: "deny" }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({ toolCall, review, settlement });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });
    settle({ status: "resolved", verdict: "deny" });
    await settlement;
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("governed-deny");
    expect(eventText(events.at(-1))).toBe(
      "review decision confirmed by warden · governed result deny · inspect the tool result for effect truth",
    );
    expect(eventText(events.at(-1))).not.toContain("action not executed");
  });

  it("fails closed when settlement remains review instead of claiming approval confirmation", async () => {
    let settle!: (value: { readonly status: "resolved"; readonly verdict: "review" }) => void;
    const settlement = new Promise<{ readonly status: "resolved"; readonly verdict: "review" }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    const decision = controller.onReviewRequired({ toolCall, review, settlement });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(decision).resolves.toEqual({ approved: true, scope: "once" });
    settle({ status: "resolved", verdict: "review" });
    await settlement;
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("failed");
    expect(eventText(events.at(-1))).toContain("warden did not authorize the action");
    expect(eventText(events.at(-1))).toContain("action did not run");
    expect(eventText(events.at(-1))).not.toContain("confirmed by warden");
  });

  it("does not offer or accept persistent scopes for console reviews", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const pending = controller.onReviewRequired({ toolCall, review: consoleReview });

    expect(events.at(-1)).toMatchObject({
      kind: "opened",
      sessionAvailable: false,
    });
    expect(events.at(-1)).not.toHaveProperty("project");
    expect(controller.handleInput(line("s"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("session approval is unavailable");
    expect(eventText(events.at(-1))).not.toContain("approve project");
    expect(controller.handleInput(line("p"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("project approval is unavailable in live reviews");
    expect(controller.handleInput({ kind: "command", name: "/approve", args: "project" })).toBe(
      true,
    );
    expect(eventText(events.at(-1))).toContain("project approval is unavailable in live reviews");
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, scope: "once" });
  });

  it("does not advertise project scope as a live review action", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const pending = controller.onReviewRequired({ toolCall, review });

    const opened = events.at(-1);
    expect(opened).toMatchObject({ kind: "opened", sessionAvailable: true });
    expect(opened).not.toHaveProperty("project");
    expect(controller.handleInput(line("p"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("unavailable in live reviews");
    expect(controller.handleInput(line("d"))).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it("does not advertise session approval for generic reviews without exact resources", () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);

    void controller.onReviewRequired({ toolCall, review: genericReview });

    const opened = events.at(-1);
    expect(opened?.kind).toBe("opened");
    if (opened?.kind !== "opened") throw new Error("expected opened presentation");
    expect(approvalNoticePlan({ ...opened, state: "pending" })).toMatchObject({
      sessionAvailable: false,
      actions: [
        "[a] Approve once · this action only",
        "[d] Deny · action will not run",
        "[?] Explain why",
      ],
      sessionNote: "Broader approval unavailable · use once or deny",
    });
    expect(controller.handleInput(line("s"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("session approval is unavailable");
  });

  it("applies the same scope eligibility to shortcuts and slash commands", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const pending = controller.onReviewRequired({ toolCall, review: genericReview });

    expect(controller.handleInput({ kind: "command", name: "/approve", args: "session" })).toBe(
      true,
    );
    expect(eventText(events.at(-1))).toContain("session approval is unavailable");
    expect(controller.handleInput({ kind: "command", name: "/approve", args: "project" })).toBe(
      true,
    );
    expect(eventText(events.at(-1))).toContain("project approval is unavailable in live reviews");
    expect(controller.handleInput({ kind: "command", name: "/deny" })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it("keeps unrelated slash commands from stealing focus from an active approval", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const pending = controller.onReviewRequired({ toolCall, review: genericReview });

    expect(controller.handleInput({ kind: "command", name: "/reviews" })).toBe(true);
    expect(eventText(events.at(-1))).toContain("approval is active");
    expect(controller.handleInput({ kind: "command", name: "/deny" })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it("does not claim a concurrent review remains pending after declining to open it", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const first = controller.onReviewRequired({ toolCall, review });

    expect(controller.onReviewRequired({ toolCall, review: genericReview })).toBeUndefined();
    expect(eventText(events.at(-1))).toContain("will not execute");
    expect(eventText(events.at(-1))).not.toContain("remains pending");

    expect(controller.handleInput({ kind: "command", name: "/deny" })).toBe(true);
    await expect(first).resolves.toEqual({ approved: false });
  });

  it("clears a failed settlement without assuming approval or stranding later reviews", async () => {
    let fail!: (value: { readonly status: "failed"; readonly message: string }) => void;
    const settlement = new Promise<{ readonly status: "failed"; readonly message: string }>(
      (resolve) => {
        fail = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const first = controller.onReviewRequired({ toolCall, review, settlement });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(first).resolves.toEqual({ approved: true, scope: "once" });
    fail({ status: "failed", message: "warden connection closed" });
    await settlement;
    await Promise.resolve();
    expect(events.at(-1)?.kind).toBe("failed");
    expect(controller.handleInput(line("a"))).toBe(false);

    const later = controller.onReviewRequired({ toolCall, review });
    expect(events.at(-1)?.kind).toBe("opened");
    expect(controller.handleInput(line("d"))).toBe(true);
    await expect(later).resolves.toEqual({ approved: false });
  });

  it("ignores a late settlement from a cancelled review while a newer review is pending", async () => {
    let settle!: (value: { readonly status: "resolved"; readonly verdict: "allow" }) => void;
    const settlement = new Promise<{ readonly status: "resolved"; readonly verdict: "allow" }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const stale = controller.onReviewRequired({ toolCall, review, settlement });
    expect(controller.handleInput(line("a"))).toBe(true);
    await expect(stale).resolves.toEqual({ approved: true, scope: "once" });
    expect(controller.cancelPending()).toBe(true);
    expect(events.at(-1)?.kind).toBe("indeterminate");
    expect(eventText(events.at(-1))).toContain("action may have executed");
    expect(eventText(events.at(-1))).toContain("do not retry automatically");

    const current = controller.onReviewRequired({ toolCall, review: genericReview });
    settle({ status: "resolved", verdict: "allow" });
    await settlement;
    await Promise.resolve();

    expect(events.at(-1)?.kind).toBe("opened");
    expect(events.some((event) => event.kind === "confirmed")).toBe(false);
    expect(controller.handleInput(line("d"))).toBe(true);
    await expect(current).resolves.toEqual({ approved: false });
  });

  it("fails closed for duplicate reviews, unknown answers, and already-aborted requests", async () => {
    const controller = createInteractiveReviewDecisionController();
    const { events } = recordPresentation(controller);
    const abort = new AbortController();
    abort.abort();
    expect(
      await controller.onReviewRequired({ toolCall, review, signal: abort.signal }),
    ).toBeUndefined();

    const pending = controller.onReviewRequired({ toolCall, review });
    expect(await controller.onReviewRequired({ toolCall, review })).toBeUndefined();
    expect(eventText(events.at(-1))).toContain("review is active");
    expect(eventText(events.at(-1))).toContain("will not execute");
    expect(controller.handleInput(line("maybe"))).toBe(true);
    expect(eventText(events.at(-1))).toContain("approval is active");
    expect(controller.handleInput({ kind: "command", name: "/approve", args: "later" })).toBe(true);
    expect(eventText(events.at(-1))).toContain("needs an explicit scope");
    expect(controller.handleInput({ kind: "command", name: "/deny" })).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false });
  });

  it("does not consume interrupts so cancellation still reaches the runner", async () => {
    const controller = createInteractiveReviewDecisionController();
    const abort = new AbortController();
    const pending = controller.onReviewRequired({ toolCall, review, signal: abort.signal });

    expect(controller.handleInput({ kind: "interrupt" })).toBe(false);
    abort.abort();
    await expect(pending).resolves.toBeUndefined();
  });

  it("passes slash interrupt through and exposes fail-closed cancellation for closed input", async () => {
    const controller = createInteractiveReviewDecisionController();
    const interruptPending = controller.onReviewRequired({ toolCall, review });

    expect(controller.handleInput({ kind: "command", name: "/interrupt" })).toBe(false);
    await expect(interruptPending).resolves.toBeUndefined();

    const closedPending = controller.onReviewRequired({ toolCall, review });
    expect(controller.cancelPending()).toBe(true);
    expect(controller.cancelPending()).toBe(false);
    await expect(closedPending).resolves.toBeUndefined();
  });
});

describe("typed-ahead during a pending review is queued, not lost (F8)", () => {
  // Users type ahead constantly. A real follow-up instruction submitted while an approval was open
  // ("also please add a README") was consumed by the review controller, answered with a generic
  // "approval is active" notice, and never queued — so it was silently discarded even though
  // ADR-0034 specifies a mid-run steering queue and the runner already implements one with a
  // visible ack.
  //
  // The security property is unchanged and load-bearing: arbitrary prose must NEVER be read as a
  // decision. Decision shortcuts and near-miss decision words are still consumed here, before any
  // steering path can see them; only text that is clearly not a decision attempt falls through to
  // the runner, which classifies it as steering and queues it.
  const pendingController = () => {
    const controller = createInteractiveReviewDecisionController();
    const { events, disconnect } = recordPresentation(controller);
    const decision = controller.onReviewRequired({ toolCall, review });
    return { controller, events, disconnect, decision };
  };

  it("does not consume a real instruction, so the runner can queue it as steering", () => {
    const { controller, decision } = pendingController();
    expect(controller.handleInput(line("also please add a README"))).toBe(false);
    expect(controller.handleInput(line("run the tests when you are done"))).toBe(false);
    // The review is still pending — falling through must not resolve or cancel it.
    let settled = false;
    void Promise.resolve(decision).then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
  });

  it("still consumes single-token answers so a fumbled shortcut gets the hint, not the queue", () => {
    const { controller } = pendingController();
    for (const near of ["project", "approve", "deny", "session", "once", "yes", "no", "maybe"]) {
      expect(controller.handleInput(line(near)), near).toBe(true);
    }
  });

  // The submitted/settle-window case is already pinned by "keeps a submitted decision pending and
  // non-actionable until the warden settles it", which drives a real settlement channel: there
  // `line("wait for it")` stays consumed with the already-submitted acknowledgement.

  it("never lets prose beginning with a decision letter become a decision", async () => {
    const { controller, decision } = pendingController();
    // "add a README" starts with "a" — the approve shortcut. It must be queued, never approved.
    expect(controller.handleInput(line("add a README"))).toBe(false);
    expect(controller.handleInput(line("deny the request in the issue tracker too"))).toBe(false);
    controller.handleInput(line("d"));
    await expect(decision).resolves.toEqual({ approved: false });
  });
});
