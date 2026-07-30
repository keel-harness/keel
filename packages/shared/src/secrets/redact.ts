/**
 * Secret redaction (SEC-014, §3.2(6)). A **best-effort defense-in-depth** filter that removes
 * well-known credential shapes from text before it is written to the session ledger (and, in Phase 2A,
 * the audit chain). Honest scope (ground rule 4) — this is **not** a guarantee against all secrets:
 *
 *   • **Catches:** PEM private-key blocks; the named provider-key formats below (Anthropic, OpenAI,
 *     Google, the AWS access-key **ID**, GitHub, Slack); URL-embedded credentials and `Authorization:`
 *     Bearer/Basic/Token headers; and a high-entropy net for long (≥44-char) mixed-charset tokens.
 *   • **Deliberately does NOT catch** (documented blind spots — the heuristic is a guard, not a
 *     boundary): the AWS **secret** access key (40 chars, contains `/` — below the entropy floor and
 *     not a fixed prefix), standalone JWTs outside an `Authorization:` header (only a long segment is
 *     hit), hex-only / digits-only secrets (spared as ids/hashes), short (<44-char) keys with no known
 *     prefix, and secrets split across fields. The entropy floor is a **false-positive guard, not a
 *     security boundary** — its blind spots are a known, evadable oracle. Treat the model's in-context
 *     view of a secret (e.g. a `read`/`bash` result) as exposed regardless; redaction only protects
 *     the ledger at rest.
 *
 * Every removal leaves an honest `[redacted:<kind>]` marker, never a silent drop. The markers contain
 * only JSON-safe characters (no `"`/`\`), but that is NOT sufficient to apply `redactText` directly to
 * an already-serialized JSON line: a match can begin or end INSIDE a JSON escape (e.g. the entropy net
 * matching the `n` of an escaped `\n`), leaving an orphan `\` and an invalid `\<char>` that a strict
 * parser silently drops (F1 integrity, structured-redaction regression). Redact the structured value BEFORE serializing, or use
 * `redactJsonLine` — both run `redactText` on each decoded string and let `JSON.stringify` (re)escape
 * afterward, so the result is valid JSON by construction. The keel write chokepoints do exactly this.
 */

/** Ordered catalog. Order matters where formats overlap: Anthropic (`sk-ant-…`) is matched before the
 *  generic OpenAI `sk-…`, and the PEM block is matched first as a whole. */
const PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35,}/g],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
];

/** Credentials identified by their textual CONTEXT (scheme / header), not the value's shape — the value
 *  alone may be too short or wrong-shaped for the catalog/entropy net. Prefix-preserving via group refs.
 *  Order-independent of `PATTERNS`; applied after it. */
interface ContextualRule {
  readonly kind: "url-credential" | "auth-header";
  readonly re: RegExp;
  readonly replacement: string;
  readonly span: (match: RegExpExecArray) => { readonly start: number; readonly end: number };
}

const CONTEXTUAL: readonly ContextualRule[] = [
  // URL-embedded userinfo: `<scheme>://user:pass@host` → keep scheme + host, redact the credential.
  // Any RFC-3986 scheme (http(s), but also postgres/redis/mongodb/amqp/… connection strings, which are
  // common in tool output + DB-client errors). Password is greedy to the LAST `@` so a `@` in it is
  // still fully removed.
  {
    kind: "url-credential",
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/]*(@)/gi,
    replacement: "$1[redacted:url-credential]$2",
    span: (match) => ({
      start: match.index + (match[1]?.length ?? 0),
      end: match.index + match[0].length - (match[2]?.length ?? 0),
    }),
  },
  // `Authorization:` / `Proxy-Authorization:` Bearer/Basic/Token/Digest values (also a header JWT).
  {
    kind: "auth-header",
    re: /((?:proxy-)?authorization:\s*(?:bearer|basic|token|digest)\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1[redacted:auth-header]",
    span: (match) => ({
      start: match.index + (match[1]?.length ?? 0),
      end: match.index + match[0].length,
    }),
  },
];

/** Shannon-entropy floor (bits/char). Random secrets sit ~4.5–6; structured ids / repetitive runs sit
 *  lower. Conservative so benign tokens are not redacted. */
const ENTROPY_MIN_BITS = 3.5;
/**
 * The entropy net's token-run floor, in chars. This is the **ledger-safe-id invariant**: any
 * first-party identifier that can appear as a string VALUE at a redacting write chokepoint (the
 * session ledger, the audit chain, receipts) must either stay BELOW this length — including every
 * composite derived from it (`<id>_exit_<n>`, `tool_result:<id>`) — or be a shape `looksLikeSecret`
 * structurally spares (all-hex, pure-decimal). An id that violates this is redacted into
 * `[redacted:high-entropy]`; where the field is schema-validated on read (RunControlId, exact
 * domains) that bricks the record (2026-07-18 audit: /goal ids corrupted the session ledger —
 * SessionCorruptError on resume). Mint new id formats against this constant, not a copied literal:
 * ULID (26) / uuid (36) / git-sha (40) sit below it; Ed25519 sig/pubkey encodings sit AT/above it
 * and must never transit a value-redacting chokepoint (see the landmine pin in redact.test.ts).
 */
export const ENTROPY_NET_MIN_TOKEN_CHARS = 44;
/** A maximal run of secret-plausible chars (base64url / base64 / token alphabets). The floor sits
 *  above ULID (26) / uuid (36) / git-sha (40), so those benign ids never even enter the net. */
const TOKEN_RUN = new RegExp(`[A-Za-z0-9_+/=-]{${String(ENTROPY_NET_MIN_TOKEN_CHARS)},}`, "g");

function shannonBits(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether a long token looks like a credential rather than a benign id/hash/number. Conservative —
 *  it spares all-hex (sha/git), pure-decimal, and anything lacking BOTH letters and digits. */
function looksLikeSecret(tok: string): boolean {
  if (/^[0-9a-f]+$/i.test(tok)) return false; // hex hash / git sha
  if (/^[0-9]+$/.test(tok)) return false; // pure number
  if (!/[A-Za-z]/.test(tok) || !/[0-9]/.test(tok)) return false; // mixed letters+digits only
  return shannonBits(tok) >= ENTROPY_MIN_BITS;
}

function redactEntropyToken(tok: string): string {
  // Absolute filesystem paths share `/`, `-`, letters, and digits with token alphabets. Treat the
  // separators as structure so ordinary provenance survives, while a secret-shaped path component
  // is still removed. This does not apply to free-standing slash-bearing tokens that are not paths.
  if (tok.startsWith("/")) {
    return tok
      .split("/")
      .map((component) =>
        component.length >= ENTROPY_NET_MIN_TOKEN_CHARS && looksLikeSecret(component)
          ? "[redacted:high-entropy]"
          : component,
      )
      .join("/");
  }
  return looksLikeSecret(tok) ? "[redacted:high-entropy]" : tok;
}

/** Options for `redactText`. */
export interface RedactOptions {
  /**
   * Whether to run the high-entropy heuristic net (the secondary catch for long mixed-charset tokens
   * with no known format). **Defaults to `true`** — every existing caller (the SEC-014 session-ledger
   * chokepoint, the scoreboard, the spend-ledger note) keeps full protection. Pass `false` ONLY where
   * the heuristic would corrupt faithful content AND the context cannot contain an unknown-format host
   * secret — currently just the `@keel/eval` benchmark **trajectory store**, whose only injected host
   * credential is the known-format `ANTHROPIC_API_KEY` (caught by the catalog) and whose high-entropy
   * task content (artifact hashes, and the secret-themed TB-2 tasks themselves) must reach the §2.3
   * analysis loop faithfully. The format catalog + contextual filters still run when this is `false`.
   */
  readonly entropyNet?: boolean;
}

/** A typed source span produced directly by the redaction catalog, never by marker-text search. */
export interface PresentationRedactionSpan {
  /** Inclusive UTF-16 code-unit offset in the input string. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset in the input string. */
  readonly end: number;
  readonly kind: string;
}

function forEachMatch(input: string, re: RegExp, visit: (match: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  let match = re.exec(input);
  while (match !== null) {
    visit(match);
    if (match[0].length === 0) re.lastIndex += 1;
    match = re.exec(input);
  }
  re.lastIndex = 0;
}

/**
 * Return direct catalog/context/entropy spans over one bounded presentation window. Callers that
 * process larger producer text must window cooperatively and merge overlap spans themselves.
 */
export function presentationRedactionSpans(
  input: string,
  opts?: RedactOptions,
): readonly PresentationRedactionSpan[] {
  const occupied = new Uint8Array(input.length);
  const spans: PresentationRedactionSpan[] = [];

  const accept = (start: number, end: number, kind: string): boolean => {
    if (start < 0 || end <= start || end > input.length) return false;
    let overlaps = false;
    for (let index = start; index < end; index += 1) {
      if (occupied[index] !== 0) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      occupied.fill(1, start, end);
      spans.push({ start, end, kind });
      return true;
    }

    // Later contextual rules may safely widen an earlier catalog match (for example a provider key
    // inside URL userinfo). Union every overlap while retaining the first catalog kind, so no
    // credential prefix survives and catalog precedence remains deterministic.
    let mergedStart = start;
    let mergedEnd = end;
    let mergedKind = kind;
    for (let index = spans.length - 1; index >= 0; index -= 1) {
      const span = spans[index]!;
      if (span.start >= end || span.end <= start) continue;
      mergedStart = Math.min(mergedStart, span.start);
      mergedEnd = Math.max(mergedEnd, span.end);
      mergedKind = span.kind;
      spans.splice(index, 1);
    }
    occupied.fill(1, mergedStart, mergedEnd);
    spans.push({ start: mergedStart, end: mergedEnd, kind: mergedKind });
    return true;
  };

  for (const [kind, re] of PATTERNS) {
    forEachMatch(input, re, (match) => {
      accept(match.index, match.index + match[0].length, kind);
    });
  }
  for (const rule of CONTEXTUAL) {
    forEachMatch(input, rule.re, (match) => {
      const span = rule.span(match);
      accept(span.start, span.end, rule.kind);
    });
  }

  if (opts?.entropyNet !== false) {
    const acceptEntropyFragments = (start: number, end: number): void => {
      let fragmentStart = start;
      for (let index = start; index <= end; index += 1) {
        if (index < end && occupied[index] === 0) continue;
        if (index > fragmentStart) {
          const fragment = input.slice(fragmentStart, index);
          if (fragment.length >= ENTROPY_NET_MIN_TOKEN_CHARS && looksLikeSecret(fragment)) {
            accept(fragmentStart, index, "high-entropy");
          }
        }
        fragmentStart = index + 1;
      }
    };

    forEachMatch(input, TOKEN_RUN, (match) => {
      const start = match.index;
      const end = start + match[0].length;
      if (!match[0].startsWith("/")) {
        acceptEntropyFragments(start, end);
        return;
      }
      let componentStart = start + 1;
      for (let index = componentStart; index <= end; index += 1) {
        if (index < end && input[index] !== "/") continue;
        acceptEntropyFragments(componentStart, index);
        componentStart = index + 1;
      }
    });
  }

  return spans.sort((left, right) => left.start - right.start || left.end - right.end);
}

/**
 * Redact known credential formats and high-entropy token-like secrets in `s`, replacing each with
 * `[redacted:<kind>]`. The format catalog runs first (high precision); then the contextual (URL /
 * `Authorization:`) filters; then — unless `entropyNet: false` — the entropy net catches long mixed
 * high-entropy tokens not covered by a format, while sparing benign high-entropy ids (ULID/uuid/sha/
 * git-sha/numbers) via the length bar + `looksLikeSecret` guards. Honest scope: this is known-formats +
 * a heuristic, not a guarantee against every secret shape. With `entropyNet: false` the scope narrows to
 * known-format + contextual credentials only (see `RedactOptions.entropyNet` for when that is correct).
 */
export function redactText(s: string, opts?: RedactOptions): string {
  let out = s;
  for (const [kind, re] of PATTERNS) out = out.replace(re, `[redacted:${kind}]`);
  for (const { re, replacement } of CONTEXTUAL) out = out.replace(re, replacement);
  if (opts?.entropyNet !== false) {
    out = out.replace(TOKEN_RUN, redactEntropyToken);
  }
  return out;
}

/**
 * Recursively redact every string leaf of a JSON value with `redactText`, returning a fresh value
 * (the input is not mutated). Object/array structure, numbers, booleans, and null pass through.
 *
 * This is the **JSON-safe** way to redact (F1 integrity, structured-redaction regression): redacting a value *before*
 * `JSON.stringify` means every escape is (re)introduced by serialization *after* redaction, so a
 * redaction can never split a JSON escape. Redacting an *already-serialized* line with `redactText`
 * is structurally unsafe — a regex match (notably the entropy net) can begin or end inside an escape
 * (e.g. the `n` of an escaped `\n` newline), leaving an orphan `\` and an invalid `\<char>` escape
 * that makes a strict parser (`jq` / `json.loads`) *silently drop the whole line*. Same redaction
 * power (every string leaf passes through the identical filter; `entropyNet` honored), now valid by
 * construction. Only values are redacted; object **keys** pass through. That is correct where keys
 * are fixed schema field names (the session/trajectory/scoreboard/spend chokepoints) — but NOT where
 * keys are model-controlled (a tool call's `args` object). For those, use `redactJsonKeysAndValues`
 * (QC §6); the audit write path does.
 */
export function redactJsonValue(value: unknown, opts?: RedactOptions): unknown {
  if (typeof value === "string") return redactText(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactJsonValue(v, opts));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJsonValue(v, opts);
    return out;
  }
  return value; // number | boolean | null
}

/**
 * Like `redactJsonValue`, but ALSO redacts object **keys** — for chokepoints where keys are
 * model-controlled and could carry a secret (a tool call's `args` object reaches the signed audit
 * record verbatim; QC §6). Values are redacted with the caller's options (entropy net honored, as
 * usual); KEYS are redacted with the **format catalog + contextual filters only** (`entropyNet`
 * forced off), so a real credential *shape* in a key is removed while a benign high-entropy id used
 * as a key is NOT corrupted (corrupting a key would mangle the record structure and its hash). The
 * entropyNet-off choice is load-bearing for LONG ids (a ≥44-char high-entropy `toolCallId`/uuid/sha
 * that the net would otherwise flag); short ids like a 26-char ULID are spared regardless (below the
 * net's length floor). Honest residual: the trade-off means a novel-format (non-catalog) secret ≥44
 * chars sitting in a KEY is NOT caught here (it would be caught as a VALUE) — same "known-formats +
 * heuristic, not a guarantee" scope as `redactText`. A key that redacts to the same marker as a
 * sibling collapses onto it (both were secrets — losing one is the intended outcome).
 */
export function redactJsonKeysAndValues(value: unknown, opts?: RedactOptions): unknown {
  if (typeof value === "string") return redactText(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactJsonKeysAndValues(v, opts));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[redactText(k, { ...opts, entropyNet: false })] = redactJsonKeysAndValues(v, opts);
    }
    return out;
  }
  return value; // number | boolean | null
}

/**
 * Redact secrets in an **already-serialized JSON line**, guaranteeing the result is still exactly one
 * valid JSON value (F1 integrity, structured-redaction regression) — by parsing, redacting each decoded string value via
 * `redactJsonValue`, and re-serializing compactly. Use this at a write chokepoint that already holds a
 * compact serialized line; for callers that control formatting (e.g. pretty-printed eval artifacts),
 * prefer `JSON.stringify(redactJsonValue(value, opts), null, 2)` so the layout is preserved. `line`
 * MUST be a valid JSON document; an invalid input surfaces as a `SyntaxError` rather than being
 * silently mangled.
 */
export function redactJsonLine(line: string, opts?: RedactOptions): string {
  return JSON.stringify(redactJsonValue(JSON.parse(line), opts));
}
