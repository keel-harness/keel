import type { Readable, Writable } from "node:stream";

/**
 * The first-open workspace-trust prompt copy (Appendix G item 1). One screen, honest by construction:
 * it states what trust unlocks (project context) and the shipped enforcement surface — bash AND the
 * trusted file tools (read/search/write/edit) route through the warden for policy, sandbox, and
 * per-session audit (Epic 2.15). It must never imply containment that does not exist (the §4.9.1 /
 * §8.6 honesty invariant), and must stay consistent with `--help`, `doctor`, and the README.
 *
 * Pure (golden-tested). The interactive y/n effect (stdin read) lives in the bin; this is only the text.
 */
export function trustPromptText(cwd: string): string {
  return [
    "Trust this workspace?",
    "",
    `  ${cwd}`,
    "",
    "If you trust it, keel reads this folder's project context to help you —",
    "AGENTS.md, skills, and your files (read · edit · run commands).",
    "",
    "Governed mode routes bash and the file tools (read · search · write ·",
    "edit) through the warden for policy, sandbox, and per-session audit.",
    "Trust only a workspace you would run code from.",
    "",
    "Decline to continue with EMPTY project context (keel still works).",
    "keel remembers your choice for this workspace.",
    "",
    "  [y] trust    [N] decline (default)",
  ].join("\n");
}

/** Interpret a typed answer to the trust prompt. Only an explicit `y`/`yes` trusts; everything else
 *  — including empty input — declines (fail closed; the default is decline). */
export function interpretTrustAnswer(line: string): boolean {
  const a = line.trim().toLowerCase();
  return a === "y" || a === "yes";
}

export interface TrustLineRead {
  readonly answer: string;
  readonly remainder: Buffer;
}

/** Read one trust line from the same paused stream that the interactive renderer takes next.
 * `readable` mode avoids a flowing `data` handoff, and one stream owner avoids constructing a
 * second libuv TTY reader over fd 0. The caller unshifts `remainder` before mounting Ink so a single
 * pasted trust answer + command stays lossless. */
export function readTrustLine(
  input: Readable,
  output: Pick<Writable, "write">,
  prompt = "> ",
): Promise<TrustLineRead> {
  output.write(prompt);
  return new Promise<TrustLineRead>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = (): void => {
      input.off("readable", onReadable);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const finish = (line: Buffer, remainder = Buffer.alloc(0)): void => {
      cleanup();
      resolve({ answer: line.toString(), remainder });
    };
    const onReadable = (): void => {
      let chunk: Buffer | string | null;
      while ((chunk = input.read() as Buffer | string | null) !== null) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buffered = Buffer.concat([buffered, bytes]);
        const carriageReturn = buffered.indexOf(0x0d);
        const lineFeed = buffered.indexOf(0x0a);
        const delimiterIndex =
          carriageReturn < 0
            ? lineFeed
            : lineFeed < 0
              ? carriageReturn
              : Math.min(carriageReturn, lineFeed);
        if (delimiterIndex < 0) continue;
        const delimiterLength =
          buffered[delimiterIndex] === 0x0d && buffered[delimiterIndex + 1] === 0x0a ? 2 : 1;
        finish(
          buffered.subarray(0, delimiterIndex),
          buffered.subarray(delimiterIndex + delimiterLength),
        );
        return;
      }
    };
    const onEnd = (): void => finish(buffered);
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    input.on("readable", onReadable);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}
