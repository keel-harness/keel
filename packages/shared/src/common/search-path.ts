// @ts-expect-error picomatch does not ship TypeScript types; the local interface below is the API used here.
import picomatchUntyped from "picomatch";

interface PicomatchModule {
  isMatch(
    input: string,
    patterns: string | readonly string[],
    options?: { readonly dot?: boolean; readonly matchBase?: boolean; readonly nocase?: boolean },
  ): boolean;
}

const picomatch = picomatchUntyped as unknown as PicomatchModule;

const PICOMATCH_GLOB_LITERAL_RE = /[\\*?[\]{}!()+@|]/gu;
const PICOMATCH_GLOB_META = new Set(["*", "?", "[", "]", "{", "}", "!", "(", ")", "+", "@", "|"]);

export function escapeSearchGlobLiteral(path: string): string {
  return path.replace(PICOMATCH_GLOB_LITERAL_RE, "\\$&");
}

export function normalizeSearchPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+/g, "/");
}

export function isVisibleSearchPath(path: string): boolean {
  const normalized = normalizeSearchPath(path);
  if (normalized === "" || normalized.startsWith("/") || normalized.startsWith("../")) return false;
  return normalized.split("/").every((segment) => segment.length > 0 && !segment.startsWith("."));
}

function hasUnescapedSearchGlobMeta(glob: string): boolean {
  let escaped = false;
  for (const char of glob) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (PICOMATCH_GLOB_META.has(char)) return true;
  }
  return false;
}

export function matchesVisibleSearchGlob(path: string, glob: string): boolean {
  const normalized = normalizeSearchPath(path);
  if (!isVisibleSearchPath(normalized)) return false;
  const basenameOnly = !glob.includes("/") && hasUnescapedSearchGlobMeta(glob);
  return picomatch.isMatch(normalized, glob, {
    dot: false,
    matchBase: basenameOnly,
    nocase: false,
  });
}

function unescapedLiteralPrefix(glob: string): {
  readonly value: string;
  readonly complete: boolean;
} {
  let escaped = false;
  let value = "";
  for (const char of glob) {
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (PICOMATCH_GLOB_META.has(char)) return { value, complete: false };
    value += char;
  }
  if (escaped) value += "\\";
  return { value, complete: true };
}

function parentSearchPath(path: string): string | undefined {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? undefined : trimmed.slice(0, index);
}

export function searchExecutionScopeFromGlob(glob: string): string | undefined {
  const normalizedGlob = glob.replace(/^\.\/+/u, "").replace(/\/+/g, "/");
  if (normalizedGlob === "" || normalizedGlob.startsWith("!")) return undefined;
  const literalPrefix = unescapedLiteralPrefix(normalizedGlob);
  const candidate = literalPrefix.complete
    ? literalPrefix.value
    : literalPrefix.value.endsWith("/")
      ? literalPrefix.value.slice(0, -1)
      : (parentSearchPath(literalPrefix.value) ?? "");
  const normalizedCandidate = normalizeSearchPath(candidate).replace(/\/+$/u, "");
  if (normalizedCandidate === "" || !isVisibleSearchPath(normalizedCandidate)) return undefined;
  return normalizedCandidate;
}

function isSearchResultPathControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

function escapeSearchResultPathChar(char: string): string {
  switch (char) {
    case "\\":
      return "\\\\";
    case '"':
      return '\\"';
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default: {
      const code = char.codePointAt(0) ?? 0;
      if (isSearchResultPathControl(char)) {
        return `\\u${code.toString(16).padStart(4, "0")}`;
      }
      return char;
    }
  }
}

export function formatSearchResultPath(path: string): string {
  if (!Array.from(path).some(isSearchResultPathControl)) return path;
  return `"${Array.from(path, escapeSearchResultPathChar).join("")}"`;
}
