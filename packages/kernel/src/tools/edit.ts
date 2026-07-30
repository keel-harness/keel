import { readFileSync } from "node:fs";
import { z } from "zod";
import type { JsonObjectT } from "@keel/shared";
import { AtomicWriteError, atomicWrite, type AtomicWriteDeps } from "./atomic-write.js";
import { parseArgs } from "./args.js";
import { checkCode, formatRejection, isOptedOut } from "./code-check.js";
import { ToolError } from "./errors.js";
import { contentHash, type FileAccessTracker } from "./file-access.js";
import { staticCapability, type CoreTool } from "./registry.js";
import { errMessage } from "./strings.js";
import { Workspace } from "./workspace.js";

export const EditArgs = z
  .object({
    path: z.string().min(1),
    oldString: z.string().min(1),
    newString: z
      .string()
      .refine(
        (text) => !text.includes("\0"),
        "newString may not contain NUL bytes; refusing binary content",
      ),
  })
  .strict()
  .refine((a) => a.oldString !== a.newString, {
    message: "oldString and newString are identical (no-op)",
    path: ["newString"],
  });

export const SPEC = {
  name: "edit",
  description:
    "Replace a UNIQUE exact substring (`oldString`) with `newString` in a workspace file or declared " +
    "write root. Fails if the anchor is absent or matches more than once (add surrounding context to " +
    "disambiguate). Matches byte-for-byte (whitespace and line endings are significant).",
  // Model-facing JSON Schema — mirrors `EditArgs` (a drift-guard test asserts the two agree).
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Workspace-relative or absolute file path under an allowed write root.",
      },
      oldString: {
        type: "string",
        minLength: 1,
        description: "Exact substring to replace; must be unique in the file.",
      },
      newString: {
        type: "string",
        description: "Replacement text (may be empty to delete); NUL bytes are refused.",
      },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
} as const;

/** Injection seam (test determinism) — defaults to real `node:fs`. Mirrors `AtomicWriteDeps`. When a
 *  `tracker` is present the read-before-edit invariant (§8.6) + staleness (§4.7.10) are enforced; omit
 *  it (standalone use / unit tests) to disable the gate. `createCoreTools` wires the shared tracker. */
export interface EditToolDeps extends AtomicWriteDeps {
  readonly readFileSync?: (path: string) => Buffer;
  readonly tracker?: FileAccessTracker;
  /** Process environment — defaults to `process.env`. Inject `{}` in tests to control `KEEL_NO_EDIT_CHECK`. */
  readonly env?: NodeJS.ProcessEnv;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count += 1;
    from = i + needle.length;
  }
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function decodeEditableText(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ToolError(`edit: '${path}' is not complete UTF-8 text; refusing to edit`);
  }
}

function normalizeLineForHint(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function previewLineForHint(s: string): string {
  const oneLine = normalizeLineForHint(s);
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117).trimEnd()}...`;
}

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9_$]+/g) ?? []);
}

function commonPrefixRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 0;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i / max;
}

function lineSimilarity(anchor: string, candidate: string): number {
  if (anchor === candidate) return 1;
  if (candidate.includes(anchor) || anchor.includes(candidate)) {
    return Math.min(anchor.length, candidate.length) / Math.max(anchor.length, candidate.length);
  }
  const aTokens = tokenSet(anchor);
  const bTokens = tokenSet(candidate);
  let tokenScore = 0;
  if (aTokens.size > 0 && bTokens.size > 0) {
    let intersection = 0;
    for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
    tokenScore = intersection / new Set([...aTokens, ...bTokens]).size;
  }
  return Math.max(commonPrefixRatio(anchor, candidate), tokenScore);
}

function notFoundHint(content: string, oldString: string): string {
  const anchor = oldString
    .split(/\r?\n/)
    .map(normalizeLineForHint)
    .filter((line) => line.length > 0)
    .sort((a, b) => b.length - a.length)[0];
  if (anchor === undefined) {
    return " Re-read the target region and copy exact surrounding context into oldString.";
  }

  let best: { lineNumber: number; preview: string; score: number } | undefined;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const normalized = normalizeLineForHint(lines[i] ?? "");
    if (normalized.length === 0) continue;
    const score = lineSimilarity(anchor, normalized);
    if (best === undefined || score > best.score) {
      best = { lineNumber: i + 1, preview: previewLineForHint(lines[i] ?? ""), score };
    }
  }
  if (best !== undefined && best.score >= 0.35) {
    return (
      ` Closest line ${String(best.lineNumber)}: "${best.preview}". ` +
      "Re-read around that line and copy exact surrounding context into oldString."
    );
  }
  return " Re-read the target region and copy exact surrounding context into oldString.";
}

function partialReadEditGuidance(path: string): string {
  return (
    `edit: Re-read the target range in '${path}' before editing it — keel cannot validate this ` +
    `edit against partially read file content (read-before-edit, §8.6).`
  );
}

function mutationPossibleSuffix(err: unknown): string {
  return err instanceof AtomicWriteError && err.mutationPossible
    ? "; target may have changed - inspect it before retrying"
    : "";
}

export function createEditTool(workspace: Workspace, deps: EditToolDeps = {}): CoreTool {
  const read: (path: string) => Buffer = deps.readFileSync ?? ((path) => readFileSync(path));
  const env = deps.env ?? process.env;
  const handler = (raw: JsonObjectT): string => {
    const args = parseArgs("edit", EditArgs, raw);
    const resolved = workspace.resolve(args.path, { operation: "write" });
    if (!resolved.ok) throw new ToolError(resolved.denial.guidance);
    const abs = resolved.path;

    let content: string;
    try {
      content = decodeEditableText(args.path, read(abs));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new ToolError(`edit: '${args.path}' does not exist`);
      if (code === "ENOTDIR")
        throw new ToolError(
          `edit: a parent path component of '${args.path}' is a file, not a directory`,
        );
      throw new ToolError(`edit: cannot read '${args.path}': ${errMessage(err)}`);
    }
    if (content.includes("\0")) {
      throw new ToolError(`edit: '${args.path}' appears to be a binary file; refusing to edit`);
    }

    // Read-before-edit (§8.6) + staleness (§4.7.10 / SEC-025): the model must have read this file
    // this session (or re-read it after a resume), and its content must not have changed on disk
    // since — otherwise it would be editing a region it has not validated against current content.
    const currentHash = contentHash(content);
    let partialCoverage = false;
    if (deps.tracker !== undefined) {
      const known = deps.tracker.knownHash(abs);
      if (!deps.tracker.hasKnownCoverage(abs)) {
        throw new ToolError(
          `edit: read '${args.path}' before editing it — keel requires reading a file this ` +
            `session before editing it (read-before-edit, §8.6).`,
        );
      }
      if (known !== undefined && known !== currentHash) {
        throw new ToolError(
          `edit: '${args.path}' changed on disk since you read it — re-read it before editing ` +
            `(its content is stale; §4.7.10).`,
        );
      }
      partialCoverage = !deps.tracker.coversFullFile(abs, currentHash);
    }

    const count = countOccurrences(content, args.oldString);
    if (partialCoverage && count !== 1) {
      throw new ToolError(partialReadEditGuidance(args.path));
    }
    if (count === 0) {
      const mayShowNearestLine =
        deps.tracker === undefined || deps.tracker.coversFullFile(abs, currentHash);
      throw new ToolError(
        `edit: oldString not found in '${args.path}' — the anchor must match byte-for-byte; ` +
          `check whitespace and line endings.${
            mayShowNearestLine
              ? notFoundHint(content, args.oldString)
              : " Re-read the target region and copy exact surrounding context into oldString."
          }`,
      );
    }
    if (count > 1) {
      throw new ToolError(
        `edit: oldString matches ${String(count)} times in '${args.path}'; ` +
          `add surrounding context to make it unique.`,
      );
    }
    const i = content.indexOf(args.oldString);
    const previousHash = currentHash;
    const replacedStart = utf8ByteLength(content.slice(0, i));
    const replaced = { start: replacedStart, end: replacedStart + utf8ByteLength(args.oldString) };
    if (
      deps.tracker !== undefined &&
      !deps.tracker.coversRange(abs, previousHash, replaced, content)
    ) {
      if (partialCoverage) throw new ToolError(partialReadEditGuidance(args.path));
      throw new ToolError(
        `edit: read the target range in '${args.path}' before editing it — keel refuses edits to ` +
          `an unread region (§8.6).`,
      );
    }
    const updated = content.slice(0, i) + args.newString + content.slice(i + args.oldString.length);
    if (updated.includes("\0")) {
      throw new ToolError("edit: replacement would create NUL bytes; refusing binary content");
    }

    // Syntax gate: reject edits that introduce NEW syntax errors (Feature A). The baseline is the
    // pre-edit content so pre-existing errors are never re-reported — only errors the change adds.
    // This throw is strictly before atomicWrite AND before tracker.markKnown, so a rejected edit
    // leaves both the file on disk AND the FileAccessTracker byte-identical to their pre-call state
    // (no tracker desync: the next valid edit on the same file still passes without a re-read).
    if (!isOptedOut(env)) {
      const chk = checkCode(abs, content, updated);
      if (!chk.ok) throw new ToolError(formatRejection(args.path, chk.newSyntaxErrors));
    }

    try {
      atomicWrite(abs, updated, deps);
    } catch (err) {
      if (err instanceof AtomicWriteError && err.mutationPossible) deps.tracker?.forget(abs);
      throw new ToolError(
        `edit: cannot write '${args.path}': ${errMessage(err)}${mutationPossibleSuffix(err)}`,
      );
    }
    // The model authored this new content — it now knows the post-edit file (no re-read needed before
    // a follow-up edit in the covered region, but a later external change still re-trips the staleness
    // gate above and unseen regions stay unread.
    deps.tracker?.markEdited(
      abs,
      previousHash,
      contentHash(updated),
      replaced,
      utf8ByteLength(args.newString),
      content,
      updated,
    );
    return `edit: replaced 1 occurrence in '${args.path}'`;
  };
  return {
    spec: SPEC,
    handler,
    staticCapability: staticCapability(SPEC.name, ["fs_read", "fs_write"]),
  };
}
