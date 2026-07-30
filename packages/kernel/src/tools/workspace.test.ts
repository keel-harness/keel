import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, resolveRealPath } from "./workspace.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keel-ws-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "keel-out-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("Workspace.resolve — containment (SEC-004/005 typed-tool precursor)", () => {
  it("accepts an in-workspace path and brands it with the resolved absolute path", () => {
    const ws = new Workspace(root);
    const r = ws.resolve("a.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(join(root, "a.txt"));
  });

  it("accepts the workspace root itself", () => {
    const ws = new Workspace(root);
    expect(ws.resolve(".").ok).toBe(true);
  });

  it("accepts a nested path", () => {
    const ws = new Workspace(root);
    expect(ws.resolve("a/b/c.txt").ok).toBe(true);
  });

  it("refuses ../ traversal with outside-workspace guidance naming the root", () => {
    const ws = new Workspace(root);
    const r = ws.resolve("../escape.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.code).toBe("outside-workspace");
      expect(r.denial.guidance).toContain(root);
      expect(r.denial.guidance).toContain("outside the workspace");
    }
    expect(ws.resolve("..").ok).toBe(false);
  });

  it("refuses an absolute path outside the root", () => {
    const ws = new Workspace(root);
    const r = ws.resolve(join(outside, "secret"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("outside-workspace");
  });

  // F8: the write/edit/read containment surface is intentionally tighter than the (Phase-1
  // unsandboxed) bash tool — `write /tmp/x` denies while `bash 'cat > /tmp/x'` runs. The denial must
  // teach the boundary without implying that bash is a substitute for required artifacts the typed
  // tools must later read/edit.
  it("teaches self-correction in the outside-workspace guidance without broad bash substitution", () => {
    const ws = new Workspace(root);
    const r = ws.resolve("/tmp/scratch.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denial.code).toBe("outside-workspace");
      // Still names the allowed root (unchanged contract) …
      expect(r.denial.guidance).toContain(root);
      expect(r.denial.guidance).toContain("outside the workspace");
      // … and now also points at the valid moves without weakening the typed-tool root policy.
      expect(r.denial.guidance).toMatch(/workspace-relative/i);
      expect(r.denial.guidance).toMatch(/declared\/approved extra root/i);
      expect(r.denial.guidance).toContain("bash");
      expect(r.denial.guidance).toMatch(/transient scratch/i);
      expect(r.denial.guidance).toMatch(/typed tools must read or edit/i);
    }
  });

  it("does NOT false-positive on a dir literally named '..foo'", () => {
    const ws = new Workspace(root);
    expect(ws.resolve("..foo/bar.txt").ok).toBe(true);
  });
});

describe("Workspace.resolve — policy-controlled extra roots", () => {
  it("defaults to the primary workspace only", () => {
    const ws = new Workspace(root);
    const r = ws.resolve(join(outside, "allowed.txt"));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("outside-workspace");
  });

  it("accepts only declared extra-root descendants and rejects prefix siblings", () => {
    const ws = new Workspace(root, {
      extraRoots: [
        {
          root: outside,
          label: "tmp-compcert",
          source: "eval-extra-root",
          allow: ["read", "write"],
        },
      ],
    });

    expect(ws.resolve(join(outside, "artifact.txt"), { operation: "read" }).ok).toBe(true);
    const sibling = ws.resolve(`${outside}-sibling/artifact.txt`, { operation: "read" });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.denial.code).toBe("outside-workspace");
  });

  it("keeps protected denied roots stronger than declared extra roots", () => {
    const cfg = join(outside, "keelcfg");
    mkdirSync(cfg);
    const ws = new Workspace(root, {
      deniedRoots: [cfg],
      extraRoots: [
        {
          root: outside,
          label: "tmp-compcert",
          source: "eval-extra-root",
          allow: ["read", "write"],
        },
      ],
    });

    const r = ws.resolve(join(cfg, "token"), { operation: "read" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("denied-path");
  });

  it("refuses symlink escapes from an extra root and denies followSymlink there", () => {
    const ws = new Workspace(root, {
      extraRoots: [
        {
          root: outside,
          label: "tmp-compcert",
          source: "eval-extra-root",
          allow: ["read", "write"],
        },
      ],
    });
    const target = realpathSync(mkdtempSync(join(tmpdir(), "keel-extra-out-")));
    try {
      symlinkSync(target, join(outside, "link"));

      const escaped = ws.resolve(join(outside, "link", "secret.txt"), { operation: "read" });
      expect(escaped.ok).toBe(false);
      if (!escaped.ok) expect(escaped.denial.code).toBe("symlink-escape");

      const followed = ws.resolveLexical(join(outside, "link", "secret.txt"), {
        operation: "read",
      });
      expect(followed.ok).toBe(false);
      if (!followed.ok)
        expect(followed.denial.guidance).toMatch(/followSymlink|primary workspace/i);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("does not accept lexically outside symlinks that resolve back into allowed roots", () => {
    writeFileSync(join(root, "inside.txt"), "ok");
    symlinkSync(root, join(outside, "workspace-link"));
    const extra = realpathSync(mkdtempSync(join(tmpdir(), "keel-extra-")));
    try {
      writeFileSync(join(extra, "artifact.txt"), "ok");
      symlinkSync(extra, join(outside, "extra-link"));
      const ws = new Workspace(root, {
        extraRoots: [
          {
            root: extra,
            label: "eval-extra-root:fixture",
            source: "eval-extra-root",
            allow: ["read", "write"],
          },
        ],
      });

      const workspaceAlias = ws.resolve(join(outside, "workspace-link", "inside.txt"));
      const extraAlias = ws.resolve(join(outside, "extra-link", "artifact.txt"));

      expect(workspaceAlias.ok).toBe(false);
      if (!workspaceAlias.ok) expect(workspaceAlias.denial.code).toBe("outside-workspace");
      expect(extraAlias.ok).toBe(false);
      if (!extraAlias.ok) expect(extraAlias.denial.code).toBe("outside-workspace");
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it("enforces operation-scoped roots and blocks write symlink bypasses into read-only roots", () => {
    const ws = new Workspace(root, {
      extraRoots: [
        {
          root: outside,
          label: "eval-extra-root:readonly-fixture",
          source: "eval-extra-root",
          allow: ["read"],
        },
      ],
    });
    writeFileSync(join(outside, "artifact.txt"), "ok");
    symlinkSync(outside, join(root, "readonly-link"));

    expect(ws.resolve(join(outside, "artifact.txt"), { operation: "read" }).ok).toBe(true);
    const writeDenied = ws.resolve(join(outside, "artifact.txt"), { operation: "write" });
    expect(writeDenied.ok).toBe(false);
    if (!writeDenied.ok) expect(writeDenied.denial.code).toBe("outside-workspace");

    const symlinkWrite = ws.resolve("readonly-link/artifact.txt", { operation: "write" });
    expect(symlinkWrite.ok).toBe(false);
    if (!symlinkWrite.ok) expect(symlinkWrite.denial.code).toBe("symlink-escape");
  });
});

describe("Workspace.resolve — symlink containment", () => {
  it("refuses a symlink whose target is outside the workspace", () => {
    const ws = new Workspace(root);
    symlinkSync(outside, join(root, "link"));
    const r = ws.resolve("link/secret.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("symlink-escape");
  });

  it("accepts a symlink whose target is inside the workspace", () => {
    const ws = new Workspace(root);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(ws.resolve("link/x.txt").ok).toBe(true);
  });

  it("accepts a not-yet-existing write target under an existing in-workspace dir", () => {
    const ws = new Workspace(root);
    mkdirSync(join(root, "sub"));
    expect(ws.resolve("sub/new.txt").ok).toBe(true);
  });

  it("refuses a not-yet-existing target under a symlinked-out ancestor", () => {
    const ws = new Workspace(root);
    symlinkSync(outside, join(root, "escape"));
    const r = ws.resolve("escape/new.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("symlink-escape");
  });
});

describe("Workspace.resolve — cross-platform path hazards", () => {
  it("keeps a case-variant path contained (no escape on a case-insensitive FS)", () => {
    const ws = new Workspace(root);
    writeFileSync(join(root, "File.txt"), "x");
    // Case-insensitive (macOS APFS) or case-sensitive (Linux): neither variant escapes the root.
    expect(ws.resolve("file.txt").ok).toBe(true);
    expect(ws.resolve("FILE.TXT").ok).toBe(true);
  });

  it("keeps NFC and NFD unicode path forms contained", () => {
    const ws = new Workspace(root);
    const nfc = "café.txt"; // NFC: precomposed é (U+00E9)
    const nfd = "café.txt"; // NFD: e + combining acute (U+0301)
    expect(nfc).not.toBe(nfd); // lock the two forms as genuinely distinct byte sequences
    expect(ws.resolve(nfc).ok).toBe(true);
    expect(ws.resolve(nfd).ok).toBe(true);
  });

  it("refuses a path containing a NUL byte explicitly (invalid-path), on both resolve paths (FS-6)", () => {
    const ws = new Workspace(root, { deniedRoots: [join(root, "keelcfg")] });
    // A NUL must be rejected by an explicit, honest check — not incidentally via a downstream fs error
    // code — and the raw (NUL-bearing) input is never echoed back into the guidance.
    const r = ws.resolve("evil\0.txt");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.denial.code).toBe("invalid-path");
    expect(r.ok === false && r.denial.guidance).not.toContain("\0");
    // The followSymlink path must reject it too (denied roots are set, so it resolves real targets).
    const rl = ws.resolveLexical("a\0../../etc/passwd");
    expect(rl.ok).toBe(false);
    expect(rl.ok === false && rl.denial.code).toBe("invalid-path");
  });
});

describe("Workspace.resolve — fs faults (injected)", () => {
  it("fails closed (denial, not a throw) on a non-ENOENT/ENOTDIR realpath fault (EACCES)", () => {
    const realpath = (p: string): string => {
      if (p === root) return root; // constructor succeeds
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    const ws = new Workspace(root, { realpath });
    const r = ws.resolve("boom.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("unresolvable");
  });

  it("resolveRealPath itself rethrows a non-ENOENT/ENOTDIR fault (EACCES)", () => {
    const eacces = (): never => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    expect(() => resolveRealPath("/x/y", eacces)).toThrow(/denied/);
  });

  it("resolveRealPath treats ENOTDIR (a prefix component is a file) like ENOENT — walks up", () => {
    // The leaf throws ENOTDIR; the ancestor "/a" resolves — so the tail is re-appended.
    const realpath = (p: string): string => {
      if (p === "/a") return "/a";
      throw Object.assign(new Error("not a dir"), { code: p === "/a/b" ? "ENOTDIR" : "ENOENT" });
    };
    expect(resolveRealPath("/a/b", realpath)).toBe("/a/b");
  });
});

describe("resolveRealPath — fs-root edge", () => {
  it("returns the candidate when nothing along the path exists up to the fs root", () => {
    const enoent = (): never => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    };
    expect(resolveRealPath("/a/b/c", enoent)).toBe("/a/b/c");
  });
});

describe("Workspace.resolve — properties (SEC-005 precursor)", () => {
  const seg = fc.stringMatching(/^[a-z0-9_]+$/).filter((s) => s !== ".." && s !== ".");

  it("any safe relative path stays contained", () => {
    const ws = new Workspace(root);
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 6 }), (segs) => {
        expect(ws.resolve(segs.join("/")).ok).toBe(true);
      }),
    );
  });

  it("any path with enough leading ../ escapes and is refused", () => {
    const ws = new Workspace(root);
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 12 }), seg, (depth, name) => {
        const r = ws.resolve("../".repeat(depth) + name);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.denial.code).toBe("outside-workspace");
      }),
    );
  });
});

describe("Workspace.resolveLexical — lexical-only (read --followSymlink seam)", () => {
  it("accepts an in-workspace path", () => {
    const ws = new Workspace(root);
    const r = ws.resolveLexical("a.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(join(root, "a.txt"));
  });

  it("still rejects ../ traversal", () => {
    const ws = new Workspace(root);
    const r = ws.resolveLexical("../escape.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.code).toBe("outside-workspace");
  });

  it("ALLOWS a symlink whose target is outside (the escape resolve() refuses)", () => {
    const ws = new Workspace(root);
    symlinkSync(outside, join(root, "link"));
    // resolve() refuses this as symlink-escape; resolveLexical permits it (the model opted in).
    expect(ws.resolve("link/x.txt").ok).toBe(false);
    expect(ws.resolveLexical("link/x.txt").ok).toBe(true);
  });
});
