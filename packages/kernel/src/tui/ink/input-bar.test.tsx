import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { UserInput } from "@keel/shared";
import type { InputState } from "../input.js";
import { InputBar } from "./input-bar.js";

const CTRL_C = String.fromCharCode(3);
const CTRL_R = String.fromCharCode(18); // 0x12 — reverse-search
const CTRL_Z = String.fromCharCode(26); // 0x1a — raw-mode terminal suspension request
const CTRL_G = String.fromCharCode(7); // 0x07 — external editor
const CTRL_A = String.fromCharCode(1); // 0x01 — cursor to line start
const CTRL_K = String.fromCharCode(11); // 0x0b — kill to line end
const CTRL_U = String.fromCharCode(21); // 0x15 — kill to line start
const CTRL_W = String.fromCharCode(23); // 0x17 — kill word before cursor
const CTRL_Y = String.fromCharCode(25); // 0x19 — yank
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);
const LEFT = `${ESC}[D`;
const DELETE = `${ESC}[3~`;
const ENTER = "\r";
const LF = "\n"; // Ctrl-J / line-feed byte (a newline, never a submit)
// settle Ink's async input handling
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("Ink InputBar (driven via stdin)", () => {
  it("renders an idle first-class composer with a compact hint", () => {
    const { lastFrame } = render(<InputBar />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("input");
    expect(frame).toContain("type a task or /help");
    expect(frame).toContain("^G editor");
  });

  it("renders the running queue composer state without implying approval or verification", async () => {
    const { stdin, lastFrame } = render(<InputBar context={{ running: true }} />);
    stdin.write("one more constraint");
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("running");
    expect(frame).toContain("Enter queues for the next safe point");
    expect(frame).toContain("one more constraint");
    expect(frame).not.toMatch(/approved|verified|contained|safe by/i);
  });

  it("paints an end-of-buffer cursor on the final physical row of a wrapped composer", () => {
    const prompt =
      "Inspect only README.md, AGENTS.md, src/calc.js, test.mjs, and MANUAL-NOTES.md. " +
      "Make no changes and run no commands. Summarize the repository structure, its safe " +
      "disposable surfaces, and the test command in at most six bullets.";
    const frame =
      render(
        <InputBar
          initialState={{
            buffer: prompt,
            cursor: prompt.length,
            history: [],
            histIndex: null,
            kill: "",
          }}
        />,
      ).lastFrame() ?? "";
    const rows = frame.split("\n").slice(1);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(0, -1).every((row) => !row.endsWith(" "))).toBe(true);
    expect(rows.at(-1)).toMatch(/six bullets\.$/u);
  });

  it("types into the buffer and submits on enter", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin, lastFrame } = render(<InputBar onAction={onAction} />);
    stdin.write("hi there");
    await tick();
    expect(lastFrame() ?? "").toContain("hi there");
    stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "hi there" });
  });

  it("ctrl-c emits an interrupt", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin } = render(<InputBar onAction={onAction} />);
    stdin.write(CTRL_C);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });
  });

  it("routes raw-mode Ctrl-Z to terminal suspension without emitting model input", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onSuspendRequest = vi.fn();
    const rendered = render(<InputBar onAction={onAction} onSuspendRequest={onSuspendRequest} />);
    rendered.stdin.write("keep this draft");
    await tick();

    rendered.stdin.write(CTRL_Z);
    await tick();

    expect(onSuspendRequest).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    expect(rendered.lastFrame() ?? "").toContain("keep this draft");
  });

  it("reports local non-interrupt activity so the controller can disarm an idle exit", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onLocalInteraction = vi.fn();
    const composer = render(
      <InputBar onAction={onAction} onLocalInteraction={onLocalInteraction} />,
    );

    composer.stdin.write("x");
    await tick();
    expect(onLocalInteraction).toHaveBeenCalledTimes(1);

    composer.stdin.write(CTRL_C);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(onLocalInteraction).toHaveBeenCalledTimes(1);

    composer.unmount();
    const palette = render(
      <InputBar
        context={{ awaitingInput: true }}
        onAction={onAction}
        onLocalInteraction={onLocalInteraction}
      />,
    );
    palette.stdin.write("/cap");
    await tick();
    onLocalInteraction.mockClear();
    palette.stdin.write(CTRL_C);
    await tick();

    expect(onLocalInteraction).toHaveBeenCalledTimes(1);
  });

  it("ctrl-d on an empty idle composer emits a clean exit command", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin } = render(<InputBar onAction={onAction} context={{ awaitingInput: true }} />);
    stdin.write("\x04");
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/exit" });
  });

  it("keeps Escape inert when an idle composer has nothing to cancel", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin } = render(<InputBar onAction={onAction} context={{ awaitingInput: true }} />);
    stdin.write("\x1b");
    await tick();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps palette Ctrl-C local while idle, but Escape interrupts an active turn after closing it", async () => {
    const idleAction = vi.fn<(a: UserInput) => void>();
    const idleState = vi.fn<(state: InputState) => void>();
    const idle = render(
      <InputBar onAction={idleAction} onState={idleState} context={{ awaitingInput: true }} />,
    );
    idle.stdin.write("/cap");
    await tick();
    idle.stdin.write(CTRL_C);
    await tick();
    expect(idleAction).not.toHaveBeenCalled();
    expect(idleState.mock.calls.at(-1)?.[0]).toMatchObject({ buffer: "", cursor: 0 });
    expect(idleState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
    idle.unmount();

    const activeAction = vi.fn<(a: UserInput) => void>();
    const activeState = vi.fn<(state: InputState) => void>();
    const active = render(
      <InputBar onAction={activeAction} onState={activeState} context={{ running: true }} />,
    );
    active.stdin.write("/cap");
    await tick();
    active.stdin.write(ESC);
    await tick();
    expect(activeAction).toHaveBeenCalledTimes(1);
    expect(activeAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(activeState.mock.calls.at(-1)?.[0]).toMatchObject({ buffer: "", cursor: 0 });
    expect(activeState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
  });

  it("restores the exact queued draft after active palette dismissal and local command submission", async () => {
    const dismissedAction = vi.fn<(a: UserInput) => void>();
    const dismissedState = vi.fn();
    const dismissed = render(
      <InputBar onAction={dismissedAction} onState={dismissedState} context={{ running: true }} />,
    );
    dismissed.stdin.write("queued draft");
    await tick();
    dismissed.stdin.write(CTRL_A);
    dismissed.stdin.write("/");
    await tick();
    expect(dismissed.lastFrame() ?? "").toContain("commands");
    expect(dismissed.lastFrame() ?? "").not.toContain("queued draft");
    dismissed.stdin.write(ESC);
    await tick();
    expect(dismissedAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(dismissedState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "queued draft",
      cursor: 0,
    });
    dismissed.unmount();

    const submittedAction = vi.fn<(a: UserInput) => void>();
    const submittedInput = vi.fn();
    const submitted = render(
      <InputBar
        onAction={submittedAction}
        onInputState={submittedInput}
        context={{ running: true }}
      />,
    );
    submitted.stdin.write("queued draft");
    await tick();
    submitted.stdin.write(CTRL_A);
    submitted.stdin.write("/context");
    await tick();
    submitted.stdin.write(ENTER);
    await tick();
    expect(submittedAction).toHaveBeenCalledWith({ kind: "command", name: "/context" });
    expect(submittedInput.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "queued draft",
      cursor: 0,
    });
  });

  it("gives local help exclusive focus and applies context-sensitive dismissal", async () => {
    const idleAction = vi.fn<(a: UserInput) => void>();
    const idleState = vi.fn<(state: InputState) => void>();
    const idle = render(
      <InputBar onAction={idleAction} onState={idleState} context={{ awaitingInput: true }} />,
    );
    idle.stdin.write("?");
    await tick();
    idle.stdin.write("ignored");
    idle.stdin.write("\x1b[A");
    idle.stdin.write("\t");
    idle.stdin.write("\x1b[200~ignored paste\x1b[201~");
    await tick();
    expect(idleState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "",
      cursor: 0,
      overlay: { kind: "help" },
    });
    idle.stdin.write(CTRL_C);
    await tick();
    expect(idleAction).not.toHaveBeenCalled();
    expect(idleState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
    idle.unmount();

    const activeAction = vi.fn<(a: UserInput) => void>();
    const activeState = vi.fn<(state: InputState) => void>();
    const active = render(
      <InputBar onAction={activeAction} onState={activeState} context={{ running: true }} />,
    );
    active.stdin.write("?");
    await tick();
    active.stdin.write(ESC);
    await tick();
    expect(activeAction).toHaveBeenCalledTimes(1);
    expect(activeAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(activeState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
  });

  it("dismisses @file completion without losing the draft and interrupts only during a turn", async () => {
    const complete = () => ["src/index.ts"];
    const idleAction = vi.fn<(a: UserInput) => void>();
    const idleState = vi.fn<(state: InputState) => void>();
    const idle = render(
      <InputBar
        onAction={idleAction}
        onState={idleState}
        complete={complete}
        context={{ awaitingInput: true }}
      />,
    );
    idle.stdin.write("explain @src");
    await tick();
    idle.stdin.write(ESC);
    await tick();
    expect(idleAction).not.toHaveBeenCalled();
    expect(idleState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "explain @src",
      cursor: "explain @src".length,
    });
    expect(idleState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
    idle.stdin.write("/");
    await tick();
    expect(idleState.mock.calls.at(-1)?.[0]?.overlay).toMatchObject({
      kind: "at-complete",
      query: "src/",
    });
    idle.stdin.write(CTRL_C);
    await tick();
    expect(idleAction).toHaveBeenCalledTimes(1);
    expect(idleAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(idleState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "explain @src/",
      cursor: "explain @src/".length,
    });
    expect(idleState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
    idle.unmount();

    const activeAction = vi.fn<(a: UserInput) => void>();
    const activeState = vi.fn<(state: InputState) => void>();
    const active = render(
      <InputBar
        onAction={activeAction}
        onState={activeState}
        complete={complete}
        context={{ running: true }}
      />,
    );
    active.stdin.write("explain @src");
    await tick();
    active.stdin.write(ESC);
    await tick();
    expect(activeAction).toHaveBeenCalledTimes(1);
    expect(activeAction).toHaveBeenCalledWith({ kind: "interrupt" });
    expect(activeState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "explain @src",
      cursor: "explain @src".length,
    });
    expect(activeState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();
  });

  it("gives a foreground panel exclusive focus until Escape closes it", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn<(state: InputState) => void>();
    const editDraft = vi.fn<(draft: string) => Promise<string | undefined>>(() =>
      Promise.resolve("must not open"),
    );
    const { stdin, lastFrame } = render(
      <InputBar
        onAction={onAction}
        onState={onState}
        editDraft={editDraft}
        context={{ foregroundPanel: true, pendingReview: true, running: true }}
      />,
    );

    stdin.write("a");
    stdin.write(ENTER);
    stdin.write("?");
    stdin.write("\t");
    stdin.write("\x1b[A");
    stdin.write(CTRL_G);
    stdin.write("\x1b[200~pasted behind panel\x1b[201~");
    await tick();
    expect(onAction).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(editDraft).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").not.toContain("pasted behind panel");
    expect(lastFrame() ?? "").toContain("panel open");
    expect(lastFrame() ?? "").toContain("Esc closes · input paused");
    expect(lastFrame() ?? "").not.toContain("^G editor");
    expect(lastFrame() ?? "").not.toContain("↑ history");

    stdin.write(ESC);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "interrupt" });
  });

  it("routes bare ? to /why instead of Help while a live review is waiting", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const { stdin } = render(
      <InputBar onAction={onAction} onState={onState} context={{ pendingReview: true }} />,
    );

    stdin.write("?");
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/why" });
    expect(onState.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ overlay: { kind: "help" } }),
    );
  });

  it("gives a live review exclusive focus from editor, history, and paste controls", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const editDraft = vi.fn<(draft: string) => Promise<string | undefined>>(() =>
      Promise.resolve("must not open"),
    );
    const { stdin, lastFrame } = render(
      <InputBar
        onAction={onAction}
        onState={onState}
        history={["previous task"]}
        editDraft={editDraft}
        context={{ pendingReview: true }}
      />,
    );

    stdin.write(CTRL_G);
    stdin.write("\x1b[A");
    stdin.write(CTRL_R);
    stdin.write("\x1b[200~pasted behind review\x1b[201~");
    await tick();

    const frame = lastFrame() ?? "";
    expect(editDraft).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(frame).not.toContain("previous task");
    expect(frame).not.toContain("pasted behind review");
    expect(frame).not.toContain("^G editor");
    expect(frame).not.toContain("↑ history");

    stdin.write("a");
    stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "a" });
  });

  it("typing '/' opens the palette (reported via onState)", async () => {
    const onState = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onState={onState} />);
    stdin.write("/se");
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { overlay?: { kind: string; query: string } };
    expect(last.overlay).toEqual({ kind: "palette", query: "/se" });
    expect(lastFrame() ?? "").toContain("commands");
    expect(lastFrame() ?? "").toContain("Tab completes");
  });

  it("renders route-specific slash palette Enter hints", async () => {
    const cases = [
      ["/cap", "Enter opens"],
      ["/quiet", "Enter applies"],
      ["/goal", "Enter starts"],
      ["/approve", "Enter shows notice"],
      ["/exit", "Enter quits"],
      ["/zzz", "no matching command"],
    ] as const;

    for (const [query, hint] of cases) {
      const { stdin, lastFrame, unmount } = render(<InputBar />);
      stdin.write(query);
      await tick();
      const frame = lastFrame() ?? "";
      expect(frame).toContain("commands");
      expect(frame).toContain(hint);
      expect(frame).not.toMatch(/approved|grant|trusted|safe by/i);
      unmount();
    }
  });

  it("renders active-turn and live-review route hints instead of idle promises", async () => {
    const running = render(<InputBar context={{ running: true }} />);
    running.stdin.write("/goal");
    await tick();
    expect(running.lastFrame() ?? "").toContain("Enter closes");
    running.unmount();

    const review = render(<InputBar context={{ running: true, pendingReview: true }} />);
    review.stdin.write("/approve");
    await tick();
    expect(review.lastFrame() ?? "").toContain("Enter applies");
    review.unmount();
  });

  it("closes invalid active-turn palette choices locally but emits valid local and urgent actions", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn<(state: InputState) => void>();
    const rendered = render(
      <InputBar onAction={onAction} onState={onState} context={{ running: true }} />,
    );

    rendered.stdin.write("/goal");
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).not.toHaveBeenCalled();
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ buffer: "", cursor: 0 });
    expect(onState.mock.calls.at(-1)?.[0]?.overlay).toBeUndefined();

    rendered.stdin.write("/context");
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenLastCalledWith({ kind: "command", name: "/context" });

    rendered.stdin.write("/now stop before editing");
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenLastCalledWith({
      kind: "command",
      name: "/now",
      args: "stop before editing",
    });
  });

  it("Tab completes the top slash-command palette match without running it", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const { stdin } = render(<InputBar onAction={onAction} onState={onState} />);

    stdin.write("/cap");
    await tick();
    stdin.write("\t");
    await tick();

    const completed = onState.mock.calls.at(-1)?.[0] as {
      buffer: string;
      cursor: number;
      overlay?: { kind: string; query: string };
    };
    expect(completed.buffer).toBe("/capabilities");
    expect(completed.cursor).toBe("/capabilities".length);
    expect(completed.overlay).toEqual({ kind: "palette", query: "/capabilities" });
    expect(onAction).not.toHaveBeenCalled();

    stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/capabilities" });
  });

  it("uses Up/Down for bounded palette and @file selection, never prompt history", async () => {
    const paletteState = vi.fn();
    const palette = render(<InputBar history={["previous task"]} onState={paletteState} />);
    palette.stdin.write("/");
    await tick();
    palette.stdin.write("\x1b[B");
    await tick();
    palette.stdin.write("\t");
    await tick();
    expect(paletteState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "/diff",
      histIndex: null,
    });
    palette.unmount();

    const fileState = vi.fn();
    const file = render(
      <InputBar
        history={["previous task"]}
        onState={fileState}
        complete={() => ["src/a.ts", "src/b.ts"]}
      />,
    );
    file.stdin.write("inspect @src/");
    await tick();
    file.stdin.write("\x1b[B");
    await tick();
    file.stdin.write("\x1b[B");
    await tick();
    file.stdin.write("\t");
    await tick();
    expect(fileState.mock.calls.at(-1)?.[0]).toMatchObject({
      buffer: "inspect @src/b.ts",
      histIndex: null,
    });
  });

  it("rejects non-decision input and every movement/completion key while approval owns focus", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const rendered = render(
      <InputBar
        onAction={onAction}
        onState={onState}
        history={["previous task"]}
        context={{
          running: true,
          pendingReview: true,
          reviewActionable: true,
          reviewState: "pending",
        }}
      />,
    );

    rendered.stdin.write("xyz ");
    rendered.stdin.write("\x1b[A\x1b[B\x1b[C\x1b[D");
    rendered.stdin.write("\t");
    rendered.stdin.write("\x1b[200~pasted decision\x1b[201~");
    await tick();
    expect(onAction).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
    expect(rendered.lastFrame() ?? "").not.toMatch(/xyz|previous task|pasted decision/);

    rendered.stdin.write("a");
    await tick();
    rendered.stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "a" });
  });

  it("submits only a complete valid decision while approval owns focus", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const partial = render(
      <InputBar
        onAction={onAction}
        context={{
          running: true,
          pendingReview: true,
          reviewActionable: true,
          reviewState: "pending",
        }}
      />,
    );

    partial.stdin.write("/appro");
    await tick();
    partial.stdin.write(ENTER);
    await tick();
    expect(onAction).not.toHaveBeenCalled();
    partial.unmount();

    const complete = render(
      <InputBar
        onAction={onAction}
        context={{
          running: true,
          pendingReview: true,
          reviewActionable: true,
          reviewState: "pending",
        }}
      />,
    );
    complete.stdin.write("/approve");
    await tick();
    complete.stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/approve" });
  });

  it("keeps submitted decisions single-shot with only why available, and terminal outcomes inert", async () => {
    const submittedAction = vi.fn<(a: UserInput) => void>();
    const submittedState = vi.fn();
    const submitted = render(
      <InputBar
        onAction={submittedAction}
        onState={submittedState}
        context={{
          running: true,
          pendingReview: true,
          reviewActionable: false,
          reviewState: "submitted",
        }}
      />,
    );
    submitted.stdin.write("invalid");
    submitted.stdin.write("\x1b[A\t");
    await tick();
    expect(submittedAction).not.toHaveBeenCalled();
    expect(submittedState).not.toHaveBeenCalled();
    submitted.stdin.write("d");
    await tick();
    submitted.stdin.write(ENTER);
    await tick();
    expect(submittedAction).not.toHaveBeenCalled();
    submitted.stdin.write("?");
    await tick();
    expect(submittedAction).toHaveBeenCalledTimes(1);
    expect(submittedAction).toHaveBeenCalledWith({ kind: "command", name: "/why" });
    submitted.unmount();

    const terminalAction = vi.fn<(a: UserInput) => void>();
    const terminalState = vi.fn();
    const terminal = render(
      <InputBar
        onAction={terminalAction}
        onState={terminalState}
        context={{
          running: true,
          pendingReview: true,
          reviewActionable: false,
          reviewState: "confirmed",
        }}
      />,
    );
    terminal.stdin.write("a");
    terminal.stdin.write(ENTER);
    terminal.stdin.write(ESC);
    await tick();
    expect(terminalAction).not.toHaveBeenCalled();
    expect(terminalState).not.toHaveBeenCalled();
    terminal.stdin.write("\x1b[A\t");
    terminal.stdin.write("\x1b[200~ignored\x1b[201~");
    await tick();
    expect(terminalAction).not.toHaveBeenCalled();
    expect(terminalState).not.toHaveBeenCalled();

    terminal.stdin.write(CTRL_C);
    await tick();
    expect(terminalAction).toHaveBeenCalledTimes(1);
    expect(terminalAction).toHaveBeenCalledWith({ kind: "interrupt" });
  });

  it("keeps non-selection navigation inert while the command palette owns focus", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const rendered = render(<InputBar onAction={onAction} onState={onState} />);
    rendered.stdin.write("/pol");
    await tick();
    rendered.stdin.write(CTRL_U);
    rendered.stdin.write(CTRL_K);
    rendered.stdin.write(CTRL_W);
    rendered.stdin.write(CTRL_Y);
    rendered.stdin.write(LF);
    await tick();

    expect(rendered.lastFrame() ?? "").toContain("/pol");
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ buffer: "/pol" });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("returns to prompt history after cancelling command-palette focus", async () => {
    const { stdin, lastFrame } = render(<InputBar history={["previous task"]} />);
    stdin.write("/cap");
    await tick();
    stdin.write(ESC);
    await tick();
    stdin.write("\u001b[A");
    await tick();

    expect(lastFrame() ?? "").toContain("previous task");
    expect(lastFrame() ?? "").not.toContain("commands");
  });

  it("does not publish a cleared overlay frame before dispatching a slash command", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onAction={onAction} onState={onState} />);

    stdin.write("/about");
    await tick();
    const beforeSubmitCount = onState.mock.calls.length;
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({
      overlay: { kind: "palette", query: "/about" },
    });

    stdin.write(ENTER);
    await tick();

    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/about" });
    expect(onState.mock.calls).toHaveLength(beforeSubmitCount);
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({
      overlay: { kind: "palette", query: "/about" },
    });
    expect(lastFrame() ?? "").toContain("/about");
  });

  it("Ctrl-R opens reverse-search and typing matches history (reported via onState) (Epic 1.23 slice 3b)", async () => {
    const onState = vi.fn();
    const { stdin, lastFrame } = render(<InputBar history={["run the tests"]} onState={onState} />);
    stdin.write(CTRL_R); // open reverse-search
    await tick();
    stdin.write("test"); // chars refine the search query, not the buffer
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as {
      overlay?: { kind: string; query: string; match?: string };
      buffer: string;
    };
    expect(last.overlay).toEqual({ kind: "reverse-search", query: "test", match: "run the tests" });
    expect(last.buffer).toBe(""); // the buffer is untouched while searching
    expect(lastFrame() ?? "").toContain("history");
    expect(lastFrame() ?? "").toContain("Ctrl-R older");
  });

  it("Ctrl-G opens the injected editor and replaces the draft without submitting", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const editDraft = vi.fn<(draft: string) => Promise<string | undefined>>(() =>
      Promise.resolve("edited\nprompt"),
    );
    const { stdin } = render(
      <InputBar onAction={onAction} onState={onState} editDraft={editDraft} />,
    );
    stdin.write("current draft");
    await tick();
    stdin.write(CTRL_G);
    await tick();
    await tick();

    expect(editDraft).toHaveBeenCalledWith("current draft");
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string; cursor: number };
    expect(last.buffer).toBe("edited\nprompt");
    expect(last.cursor).toBe("edited\nprompt".length);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows editor state while the injected editor is open", async () => {
    let resolveEdit!: (value: string | undefined) => void;
    const editDraft = vi.fn<(draft: string) => Promise<string | undefined>>(
      () => new Promise((resolve) => (resolveEdit = resolve)),
    );
    const { stdin, lastFrame } = render(<InputBar editDraft={editDraft} />);
    stdin.write("draft");
    await tick();
    stdin.write(CTRL_G);
    await tick();
    expect(lastFrame() ?? "").toContain("editor");
    expect(lastFrame() ?? "").toContain("editing draft");

    resolveEdit("edited");
    await tick();
    await tick();
    expect(lastFrame() ?? "").toContain("edited");
  });

  it("Ctrl-A moves to line start and a typed char inserts AT the cursor (Epic 1.23 slice 4a)", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("bc");
    await tick();
    stdin.write(CTRL_A); // home → cursor 0
    await tick();
    stdin.write("a"); // insert at the start
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string; cursor: number };
    expect(last.buffer).toBe("abc"); // inserted at the cursor, not appended
    expect(last.cursor).toBe(1);
  });

  it("Ctrl-A stays on the current logical line in a multiline paste", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("\x1b[200~first\nsecond\x1b[201~");
    await tick();
    stdin.write(CTRL_A);
    await tick();
    stdin.write("X");
    await tick();

    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string; cursor: number };
    expect(last.buffer).toBe("first\nXsecond");
    expect(last.cursor).toBe("first\nX".length);
  });

  it("maps terminal Delete to forward deletion rather than Backspace", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("abc");
    await tick();
    stdin.write(LEFT); // cursor before c
    await tick();
    stdin.write(DELETE); // delete c, not b
    await tick();

    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string; cursor: number };
    expect(last).toMatchObject({ buffer: "ab", cursor: 2 });
  });

  it("keeps terminal Backspace distinct from forward Delete", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("abc");
    await tick();
    stdin.write(LEFT); // cursor before c
    await tick();
    stdin.write(BACKSPACE); // delete b, not c
    await tick();

    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string; cursor: number };
    expect(last).toMatchObject({ buffer: "ac", cursor: 1 });
  });

  it("deletes a whole ZWJ grapheme through the real terminal Delete sequence", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("\x1b[200~A👩🏽‍💻B\x1b[201~");
    await tick();
    stdin.write(LEFT); // before B
    await tick();
    stdin.write(LEFT); // before the whole emoji grapheme
    await tick();
    stdin.write(DELETE);
    await tick();

    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string; cursor: number };
    expect(last).toMatchObject({ buffer: "AB", cursor: 1 });
  });

  it("Ctrl-W kills the word before the cursor (Epic 1.23 slice 4a)", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("hello world");
    await tick();
    stdin.write(CTRL_W);
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string };
    expect(last.buffer).toBe("hello ");
  });

  it("a bracketed paste arrives atomically via usePaste — multi-line, no submit (Epic 1.23 slice 4b)", async () => {
    // Ink's input-parser detects ESC[200~ … ESC[201~ and emits one paste event. ink-testing-library
    // drives that SAME parser, so this validates the whole path end-to-end without a real pty.
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onAction={onAction} onState={onState} />);
    stdin.write("\x1b[200~line one\nline two\x1b[201~");
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string };
    expect(last.buffer).toBe("line one\nline two"); // inserted atomically, newline preserved
    expect(onAction).not.toHaveBeenCalled(); // a paste NEVER submits, even with embedded newlines
    expect(lastFrame() ?? "").toContain("paste added; review before Enter");
  });

  it("keeps a large multiline paste exact while bounding its visible composer rows", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const onState = vi.fn();
    const { stdin, lastFrame } = render(<InputBar onAction={onAction} onState={onState} />);
    const paste = Array.from({ length: 20 }, (_, index) => `pasted line ${index + 1}`).join("\n");

    stdin.write(`\x1b[200~${paste}\x1b[201~`);
    await tick();

    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string };
    const frame = lastFrame() ?? "";
    expect(last.buffer).toBe(paste);
    expect(onAction).not.toHaveBeenCalled();
    expect(frame).toContain("pasted line 20");
    expect(frame).not.toContain("pasted line 1\n");
    expect(frame).toContain("16 lines hidden");
    expect(frame).toContain(`${paste.length} chars`);
    expect(frame.split("\n").length).toBeLessThanOrEqual(6);

    stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: paste });
  });

  it("a bracketed-pasted slash command resolves locally when Enter is pressed", async () => {
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin } = render(<InputBar onAction={onAction} />);
    stdin.write("\x1b[200~/yolo\x1b[201~");
    await tick();
    expect(onAction).not.toHaveBeenCalled();

    stdin.write(ENTER);
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "command", name: "/yolo" });
  });

  it("does NOT drop an earlier event when two arrive in one read (burst: type then paste)", async () => {
    // Ink drains stdin and emits every parsed event synchronously in one tick with no re-render
    // between — a handler reading a closed-over `state` + setState(absolute) would clobber the first
    // event with the second. The driver must fold each event off the LATEST state (a synchronous ref).
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("x\x1b[200~YZ\x1b[201~"); // a typed 'x' + a paste, in ONE chunk
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string };
    expect(last.buffer).toBe("xYZ"); // the 'x' must survive
  });

  it("does NOT drop the first of two back-to-back pastes in one read (burst)", async () => {
    const onState = vi.fn();
    const { stdin } = render(<InputBar onState={onState} />);
    stdin.write("\x1b[200~AAA\x1b[201~\x1b[200~BBB\x1b[201~");
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string };
    expect(last.buffer).toBe("AAABBB");
  });

  it("@file completion: typing @ shows trust-gated matches; Tab completes the top one (slice 5)", async () => {
    const onState = vi.fn();
    const complete = (q: string): readonly string[] =>
      q === "src/" ? ["src/index.ts", "src/input.ts"] : [];
    const { stdin, lastFrame } = render(<InputBar onState={onState} complete={complete} />);
    stdin.write("@src/");
    await tick();
    const mid = onState.mock.calls.at(-1)?.[0] as {
      overlay?: { kind: string; matches?: readonly string[] };
    };
    expect(mid.overlay).toMatchObject({
      kind: "at-complete",
      matches: ["src/index.ts", "src/input.ts"],
    });
    expect(lastFrame() ?? "").toContain("files");
    expect(lastFrame() ?? "").toContain("Space ends");
    stdin.write("\t"); // Tab accepts the top match
    await tick();
    const last = onState.mock.calls.at(-1)?.[0] as { buffer: string };
    expect(last.buffer).toBe("@src/index.ts");
  });

  it("ER-020: a poisoned @file candidate never reaches the terminal raw, even via Tab (end-of-epic QC)", async () => {
    // The end-of-epic security review: a trusted-but-hostile repo can name a file with an OSC-8 link +
    // a BEL. Even if such a raw candidate reaches the InputBar (here injected directly, bypassing the
    // completer's own strip), the buffer render must strip it — Ink's sanitizer passes OSC/BEL through.
    const { stdin, lastFrame } = render(
      <InputBar complete={() => ["f\x1b]8;;http://evil\x07x.ts"]} />,
    );
    stdin.write("@f");
    await tick();
    stdin.write("\t"); // Tab completes the poisoned candidate into the buffer
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame.includes("\x1b")).toBe(false); // no raw ESC reaches the rendered frame
    expect(frame.includes("\x07")).toBe(false); // no raw BEL
  });

  it("the LF byte (Ctrl-J) inserts a newline without submitting; CR (Enter) submits the multi-line buffer", async () => {
    // Locks the multi-line seam end-to-end through the REAL Ink keypress parser (F6): on a legacy
    // terminal Ctrl-J arrives as the LF byte, which Ink reports as `enter` with `input="\n"` and
    // `key.return=false`, so `toKey` takes the char path and appends a newline (NOT a submit). Only CR
    // (`\r`) is a real submit, so the whole multi-line buffer is sent at once.
    const onAction = vi.fn<(a: UserInput) => void>();
    const { stdin } = render(<InputBar onAction={onAction} />);
    stdin.write("first");
    await tick();
    stdin.write(LF); // Ctrl-J / LF → newline, must NOT submit
    await tick();
    expect(onAction).not.toHaveBeenCalled();
    stdin.write("second");
    await tick();
    stdin.write(ENTER); // CR → submit the whole buffer
    await tick();
    expect(onAction).toHaveBeenCalledWith({ kind: "line", text: "first\nsecond" });
  });
});
