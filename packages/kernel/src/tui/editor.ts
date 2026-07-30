import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreHostNodeEnv } from "../tools/child-env.js";
import { stripControl } from "./view-model.js";

export interface DraftEditorDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: typeof spawnSync;
  readonly makeTempDir?: () => string;
  readonly stdin?: {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    readonly setRawMode?: (mode: boolean) => void;
  };
}

function editorCommand(env: NodeJS.ProcessEnv): string | undefined {
  const visual = env["VISUAL"]?.trim();
  if (visual !== undefined && visual.length > 0) return visual;
  const editor = env["EDITOR"]?.trim();
  return editor !== undefined && editor.length > 0 ? editor : undefined;
}

function withCookedTerminal<T>(stdin: NonNullable<DraftEditorDeps["stdin"]>, fn: () => T): T {
  const wasRaw = stdin.isRaw === true;
  if (stdin.isTTY && typeof stdin.setRawMode === "function" && wasRaw) stdin.setRawMode(false);
  try {
    return fn();
  } finally {
    if (stdin.isTTY && typeof stdin.setRawMode === "function" && wasRaw) stdin.setRawMode(true);
  }
}

/** Open the current composer draft in `$VISUAL`/`$EDITOR`, returning the edited text.
 *  Undefined means "leave the draft unchanged" (no editor configured, spawn failure, or non-zero exit).
 *  This is a local UI affordance only; it does not grant model authority or alter session semantics. */
export function openDraftInEditor(initial: string, deps: DraftEditorDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  const command = editorCommand(env);
  if (command === undefined) return undefined;

  const dir =
    deps.makeTempDir !== undefined
      ? deps.makeTempDir()
      : mkdtempSync(join(tmpdir(), "keel-draft-"));
  const file = join(dir, "draft.md");
  const spawn = deps.spawn ?? spawnSync;
  const stdin = deps.stdin ?? process.stdin;
  try {
    writeFileSync(file, initial, "utf8");
    const result = withCookedTerminal<SpawnSyncReturns<Buffer>>(stdin, () =>
      spawn(command, [file], {
        shell: true,
        stdio: "inherit",
        // Editor selection may use injected deps.env in tests, but the real child inherits the
        // host process env with the npx launcher's renderer-only state restored (ADR-0083).
        env: restoreHostNodeEnv(process.env),
      }),
    );
    if (result.error !== undefined || result.status !== 0) return undefined;
    return stripControl(readFileSync(file, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
