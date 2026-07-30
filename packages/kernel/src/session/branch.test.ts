import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, readSession } from "./store.js";
import { branch } from "./branch.js";
import { sessionPath, sessionsDir } from "./paths.js";

const env = (): NodeJS.ProcessEnv => ({ KEEL_HOME: mkdtempSync(join(tmpdir(), "keel-")) });
const userEv = (content: string) =>
  ({ type: "user", v: 1, ts: "2026-06-14T00:00:00.000Z", content }) as const;

const invalidIndices: readonly { readonly name: string; readonly value: unknown }[] = [
  { name: "negative", value: -1 },
  { name: "fractional", value: 1.5 },
  { name: "NaN", value: Number.NaN },
  { name: "positive infinity", value: Number.POSITIVE_INFINITY },
  { name: "negative infinity", value: Number.NEGATIVE_INFINITY },
  { name: "unsafe integer", value: Number.MAX_SAFE_INTEGER + 1 },
  { name: "coercible object", value: { valueOf: () => 1 } },
];

describe("branch", () => {
  it("copies the event prefix, records lineage, and leaves the source unmutated", () => {
    const e = env();
    const src = SessionStore.create({ cwd: "/w" }, e);
    src.append(userEv("a"));
    src.append(userEv("b"));
    src.append(userEv("c"));
    src.close();
    const before = readSession(src.id, e).events;

    const newId = branch(src.id, 2, e);
    expect(newId).not.toBe(src.id);

    const branched = readSession(newId, e);
    expect(branched.events.map((x) => x.type)).toEqual(["user", "user"]);
    expect(branched.events[0]).toMatchObject({ content: "a" });
    expect(branched.events[1]).toMatchObject({ content: "b" });
    expect(branched.meta.parent).toEqual({ id: src.id, atIndex: 2 });
    expect(branched.meta.cwd).toBe("/w"); // cwd inherited from the source

    // the source ledger is untouched
    expect(readSession(src.id, e).events).toEqual(before);
  });

  it("branching at 0 yields an empty-prefix session that still shares lineage", () => {
    const e = env();
    const src = SessionStore.create({ cwd: "/w" }, e);
    src.append(userEv("a"));
    src.close();

    const newId = branch(src.id, 0, e);
    const branched = readSession(newId, e);
    expect(branched.events).toEqual([]);
    expect(branched.meta.parent).toEqual({ id: src.id, atIndex: 0 });
  });

  it("accepts the exact end boundary and copies the complete source prefix", () => {
    const e = env();
    const src = SessionStore.create({ cwd: "/w" }, e);
    src.append(userEv("a"));
    src.append(userEv("b"));
    src.append(userEv("c"));
    src.close();

    const newId = branch(src.id, 3, e);
    const branched = readSession(newId, e);
    expect(branched.events).toEqual(readSession(src.id, e).events);
    expect(branched.meta.parent).toEqual({ id: src.id, atIndex: 3 });
  });

  it.each([4, Number.MAX_SAFE_INTEGER])(
    "rejects out-of-range index %s without creating a child or changing the source",
    (atIndex) => {
      const e = env();
      const src = SessionStore.create({ cwd: "/w" }, e);
      src.append(userEv("a"));
      src.append(userEv("b"));
      src.append(userEv("c"));
      src.close();
      const beforeSource = readFileSync(sessionPath(src.id, e));
      const beforeFiles = readdirSync(sessionsDir(e));

      expect(() => branch(src.id, atIndex, e)).toThrow(/out of range.*expected 0\.\.3/i);
      expect(readdirSync(sessionsDir(e))).toEqual(beforeFiles);
      expect(readFileSync(sessionPath(src.id, e))).toEqual(beforeSource);
    },
  );

  it.each(invalidIndices)(
    "rejects a $name direct-API index without coercion or a child artifact",
    ({ value }) => {
      const e = env();
      const src = SessionStore.create({ cwd: "/w" }, e);
      src.append(userEv("a"));
      src.close();
      const beforeSource = readFileSync(sessionPath(src.id, e));
      const beforeFiles = readdirSync(sessionsDir(e));

      expect(() => branch(src.id, value as number, e)).toThrow(/safe integer/i);
      expect(readdirSync(sessionsDir(e))).toEqual(beforeFiles);
      expect(readFileSync(sessionPath(src.id, e))).toEqual(beforeSource);
    },
  );

  it("uses one loaded prefix when the append-only source grows before child creation", () => {
    const e = env();
    const src = SessionStore.create({ cwd: "/w" }, e);
    src.append(userEv("a"));
    src.append(userEv("b"));
    src.close();

    const originalCreate = SessionStore.create.bind(SessionStore);
    let interleaved = false;
    const createSpy = vi.spyOn(SessionStore, "create").mockImplementation((opts, createEnv) => {
      if (opts.parent?.id === src.id && !interleaved) {
        interleaved = true;
        const writer = SessionStore.open(src.id, e);
        writer.append(userEv("late"));
        writer.close();
      }
      return originalCreate(opts, createEnv);
    });

    let newId: string;
    try {
      newId = branch(src.id, 2, e);
    } finally {
      createSpy.mockRestore();
    }

    expect(interleaved).toBe(true);
    const branched = readSession(newId, e);
    expect(
      branched.events.map((event) => (event.type === "user" ? event.content : event.type)),
    ).toEqual(["a", "b"]);
    expect(branched.meta.parent).toEqual({ id: src.id, atIndex: 2 });
    expect(
      readSession(src.id, e).events.map((event) =>
        event.type === "user" ? event.content : event.type,
      ),
    ).toEqual(["a", "b", "late"]);
  });
});
