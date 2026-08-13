import shellquote from 'shell-quote'

function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Quote one POSIX-shell argv layer without letting shell-quote's defensive
 * history-expansion escape become a retained argument byte.
 *
 * shell-quote double-quotes values that contain both whitespace and a single
 * quote, then emits `\!` inside that double-quoted value. POSIX shells preserve
 * that backslash because `!` is not one of the characters for which a
 * backslash is removed inside double quotes. SRT passes already-rendered
 * command strings through exactly that shape, so the governed child otherwise
 * receives an extra byte. Single quotes are lossless for the affected value;
 * all other values keep the upstream rendering unchanged.
 */
export function quotePosixShellArgs(values: readonly string[]): string {
  return values
    .map(value => (value.includes('!') ? singleQuote(value) : shellquote.quote([value])))
    .join(' ')
}
