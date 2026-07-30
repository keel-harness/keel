import { statSync } from "node:fs";
import type { Stats } from "node:fs";
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

export const WriteArgs = z
  .object({
    path: z.string().min(1),
    content: z
      .string()
      .refine(
        (content) => !content.includes("\0"),
        "content may not contain NUL bytes; refusing binary content",
      ),
  })
  .strict();

export const SPEC = {
  name: "write",
  description:
    "Write a UTF-8 text file in the workspace or a declared write root (atomic; creates parent " +
    "directories). Overwrites an existing file. Refuses directories and paths that escape allowed roots.",
  // Model-facing JSON Schema — mirrors `WriteArgs` (a drift-guard test asserts the two agree).
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "Workspace-relative or absolute file path under an allowed write root.",
      },
      content: {
        type: "string",
        description: "Full UTF-8 text file contents to write. NUL bytes are refused.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
} as const;

/** Injection seam (test determinism) — defaults to real `node:fs`. Mirrors `AtomicWriteDeps`. The
 *  `tracker` records the written content as known, so a follow-up `edit` to a just-written file is
 *  allowed without a re-read (§8.6). `createCoreTools` wires the shared per-session tracker. */
export interface WriteToolDeps extends AtomicWriteDeps {
  readonly statSync?: (path: string) => Stats;
  readonly tracker?: FileAccessTracker;
  /** Process environment — defaults to `process.env`. Inject in tests to control `KEEL_NO_EDIT_CHECK`. */
  readonly env?: NodeJS.ProcessEnv;
}

function writeGuidance(path: string, err: unknown): string {
  const source = err instanceof AtomicWriteError ? err.cause : err;
  const code = (source as NodeJS.ErrnoException).code;
  if (code === "ENOTDIR" || code === "EEXIST")
    return `write: a parent path component of '${path}' is a file, not a directory`;
  if (code === "EACCES" || code === "EPERM")
    return `write: '${path}' is not writable (permission denied)`;
  if (code === "EISDIR") return `write: '${path}' is a directory, not a file`;
  return `write: cannot write '${path}': ${errMessage(source)}`;
}

function mutationPossibleSuffix(err: unknown): string {
  return err instanceof AtomicWriteError && err.mutationPossible
    ? "; target may have changed - inspect it before retrying"
    : "";
}

export function createWriteTool(workspace: Workspace, deps: WriteToolDeps = {}): CoreTool {
  const stat = deps.statSync ?? statSync;
  const env = deps.env ?? process.env;
  const handler = (raw: JsonObjectT): string => {
    const args = parseArgs("write", WriteArgs, raw);
    const resolved = workspace.resolve(args.path, { operation: "write" });
    if (!resolved.ok) throw new ToolError(resolved.denial.guidance);
    const abs = resolved.path;

    let existed = false;
    try {
      const st = stat(abs);
      if (st.isDirectory()) throw new ToolError(`write: '${args.path}' is a directory, not a file`);
      existed = true;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ToolError(writeGuidance(args.path, err));
    }

    // Syntax gate: reject writes that introduce new syntax errors (Feature A).
    // `before` is undefined for a write — any syntax error in `content` is "new".
    if (!isOptedOut(env)) {
      const chk = checkCode(abs, undefined, args.content);
      if (!chk.ok) throw new ToolError(formatRejection(args.path, chk.newSyntaxErrors));
    }

    try {
      atomicWrite(abs, args.content, deps);
    } catch (err) {
      if (err instanceof AtomicWriteError && err.mutationPossible) deps.tracker?.forget(abs);
      throw new ToolError(`${writeGuidance(args.path, err)}${mutationPossibleSuffix(err)}`);
    }
    // The model authored this content — record it as known so a follow-up edit needs no re-read (§8.6).
    deps.tracker?.markKnown(abs, contentHash(args.content));
    const bytes = Buffer.byteLength(args.content, "utf8");
    return `write: ${existed ? "overwrote" : "created"} '${args.path}' (${String(bytes)} bytes)`;
  };
  return { spec: SPEC, handler, staticCapability: staticCapability(SPEC.name, ["fs_write"]) };
}
