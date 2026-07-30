import { EventEmitter } from "node:events";
import process from "node:process";
import { render } from "../../packages/kernel/node_modules/ink/build/index.js";
import { createElement } from "../../packages/kernel/node_modules/react/index.js";
import { App } from "../../packages/kernel/src/tui/ink/app.js";
import { PHASE1_POSTURE } from "../../packages/kernel/src/tui/view-model.js";

const requestedColumns = Number(process.env["KEEL_DIFF_FIXTURE_COLUMNS"] ?? "80");
const fixtureColumns =
  Number.isInteger(requestedColumns) && requestedColumns >= 20 && requestedColumns <= 240
    ? requestedColumns
    : 80;

class CaptureStream extends EventEmitter {
  isTTY = true;
  columns = fixtureColumns;
  rows = 24;
  chunks = [];

  write = (chunk) => {
    this.chunks.push(String(chunk));
    return true;
  };
}

class TestStdin extends EventEmitter {
  isTTY = true;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

const stdout = new CaptureStream();
const stderr = new CaptureStream();
const view = {
  items: [
    {
      kind: "tool",
      id: "visual-diff",
      name: "edit",
      status: "ok",
      summary: "src/visual.ts",
      diff: [
        {
          kind: "del",
          text: "return total + tax;",
          observedBeforeLine: 7,
          hunkStart: true,
        },
        { kind: "add", text: "return total - tax;", installedAfterLine: 7 },
      ],
    },
  ],
  status: { model: "fixture", tokens: 0, posture: PHASE1_POSTURE },
  streaming: false,
  density: "verbose",
  diffMode: "full",
};

const rendered = render(createElement(App, { view, showHintFooter: false }), {
  stdout,
  stderr,
  stdin: new TestStdin(),
  debug: false,
  interactive: true,
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 1000,
});

await rendered.waitUntilRenderFlush();
rendered.unmount();
process.stdout.write(stdout.chunks.join(""));
