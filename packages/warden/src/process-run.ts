import { z } from "zod";

export const PROCESS_RUN_CAPABILITY_V1 = "process-run/v1";
export const PROCESS_RUN_MAX_ARGS = 64;
export const PROCESS_RUN_MAX_ARG_BYTES = 1_024;

export interface ProcessRunArgs {
  readonly argv: readonly string[];
}

export class ProcessRunResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessRunResolutionError";
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

const DISALLOWED_ARG_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const ProcessRunArg = z.string().superRefine((value, context) => {
  if (hasUnpairedSurrogate(value)) {
    context.addIssue({ code: "custom", message: "must contain well-formed Unicode scalars" });
  }
  if (DISALLOWED_ARG_CODE_POINT.test(value)) {
    context.addIssue({
      code: "custom",
      message:
        "must not contain control, format, line-separator, or paragraph-separator code points",
    });
  }
  if (Buffer.byteLength(value, "utf8") > PROCESS_RUN_MAX_ARG_BYTES) {
    context.addIssue({
      code: "custom",
      message: `must not exceed ${String(PROCESS_RUN_MAX_ARG_BYTES)} UTF-8 bytes`,
    });
  }
});

const ProcessRunArgsSchema = z
  .object({
    argv: z.array(ProcessRunArg).min(1).max(PROCESS_RUN_MAX_ARGS),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.argv[0] === "") {
      context.addIssue({
        code: "custom",
        path: ["argv", 0],
        message: "executable must not be empty",
      });
    }
  });

export function parseProcessRunArgs(value: unknown): ProcessRunArgs {
  const parsed = ProcessRunArgsSchema.safeParse(value);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new ProcessRunResolutionError(`invalid process.run args: ${reasons}`);
  }
  return { argv: [...parsed.data.argv] };
}

function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function renderProcessRunArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}
