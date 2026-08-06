export const PROCESS_RUN_CAPABILITY_V1 = "process-run/v1";
export const PROCESS_RUN_TOOL_NAME = "process.run";

function quoteArg(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Human-facing exact argv rendering only; the spawned Warden independently parses and enforces. */
export function renderProcessRunArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}
