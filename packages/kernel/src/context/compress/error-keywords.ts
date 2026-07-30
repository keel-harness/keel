/**
 * Lowercased substring keywords that force a line to survive compression (errors / warnings /
 * failures). Substring match is intentional — "fail" covers "failed"/"failure", "warn" covers
 * "warning". Used by the log compressor (force-keep) and the router's `bash` log-sniff. Keep this list
 * small and high-precision: a false positive only costs a few kept lines; a false negative could drop
 * the one line that mattered (needle-retention is a tested invariant).
 */
export const ERROR_KEYWORDS: readonly string[] = [
  "error",
  "exception",
  "fail",
  "fatal",
  "panic",
  "abort",
  "timeout",
  "denied",
  "rejected",
  "traceback",
  "warn",
];

export function isErrorLine(line: string): boolean {
  const l = line.toLowerCase();
  return ERROR_KEYWORDS.some((k) => l.includes(k));
}
