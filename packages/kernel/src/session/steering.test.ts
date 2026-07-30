import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, readSession } from "./store.js";
import { sessionPath } from "./paths.js";
import { applySteering, recordSteering } from "./steering.js";
import { rebuild } from "./resume.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const ts = "2026-06-14T00:00:00.000Z";

describe("recordSteering", () => {
  it("appends a pending queued steering event and returns its id", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const id = recordSteering(store, { class: "queued", content: "hold on" });
    store.close();
    expect(id).toMatch(/^inp_/);
    const ev = readSession(store.id, e).events.find((x) => x.type === "steering");
    expect(ev).toMatchObject({
      inputId: id,
      class: "queued",
      content: "hold on",
      insertedAt: null,
      changedTaskState: false,
      invalidatedPlan: false,
    });
  });

  it("honors a provided inputId and the input class", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    const id = recordSteering(store, { class: "urgent", content: "now", inputId: "inp_custom" });
    store.close();
    expect(id).toBe("inp_custom");
    expect(readSession(store.id, e).events.find((x) => x.type === "steering")).toMatchObject({
      class: "urgent",
    });
  });

  // The spec's slice-6 test: a queued comment persisted mid-run survives a kill + resume
  // as still-pending.
  it("a queued steering input survives a kill and rehydrates as pending", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    recordSteering(store, { class: "queued", content: "remember to test" });
    store.close();
    // simulate a crash mid-append after the steering input
    const path = sessionPath(store.id, e);
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"user","v":1,"ts":"2026');

    const r = rebuild(readSession(store.id, e));
    expect(r.pendingSteering).toHaveLength(1);
    expect(r.pendingSteering[0]).toMatchObject({
      class: "queued",
      content: "remember to test",
      insertedAt: null,
    });
  });
});

describe("applySteering", () => {
  it("appends the injected user message + an applied marker; rebuild shows it applied, not pending", () => {
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    const id = recordSteering(store, { class: "queued", content: "focus on a.ts" });
    // application at a safe boundary (slice 7): inject as a user message + mark the input applied
    applySteering(store, { inputId: id, class: "queued", content: "focus on a.ts" }, 1);
    store.close();

    const events = readSession(store.id, e).events;
    // the applied marker carries the boundary index and the same inputId
    expect(events.find((x) => x.type === "steering" && x.insertedAt === 1)).toMatchObject({
      inputId: id,
      class: "queued",
      content: "focus on a.ts",
    });

    const r = rebuild(readSession(store.id, e));
    expect(r.pendingSteering).toEqual([]); // superseded
    expect(r.messages).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: "focus on a.ts" }, // injected as a real conversation message
    ]);
  });

  it("fails safe on a crash between the marker and the injected message (drop, never duplicate)", () => {
    // applySteering writes the applied marker FIRST, then the user message. A crash that loses the
    // final line (the message) must leave the input applied-but-dropped — NOT pending-with-a-message
    // (which a future re-drive would inject twice).
    const e = env();
    const store = SessionStore.create({ cwd: "/w" }, e);
    store.append({ type: "user", v: 1, ts, content: "go" });
    const id = recordSteering(store, { class: "queued", content: "hold the API stable" });
    applySteering(store, { inputId: id, class: "queued", content: "hold the API stable" }, 1);
    store.close();
    // simulate a crash that tore off the final line (the injected user message)
    const path = sessionPath(store.id, e);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, lines.slice(0, -1).join("\n") + "\n");

    const r = rebuild(readSession(store.id, e));
    expect(r.pendingSteering).toEqual([]); // applied marker superseded the pending event — not re-applied
    expect(r.messages).toEqual([{ role: "user", content: "go" }]); // the message was dropped, not duplicated
  });
});
