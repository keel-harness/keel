/**
 * Per-session sentinel registry for credential masking.
 *
 * A masked credential's real value is replaced inside the sandbox with a
 * sentinel of the form `fake_value_<uuid4>`. The sandboxed process sees only
 * the sentinel; the host-side proxy substitutes sentinel→real on egress to
 * allowlisted destinations. The map lives only in process memory — it is
 * never written to disk and never logged.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const SENTINEL_PREFIX = 'fake_value_'

/** Predicate matching a destination host against one injectHosts pattern. */
export type HostMatcher = (host: string, pattern: string) => boolean

interface SentinelEntry {
  readonly name: string
  readonly sentinel: string
  realValue: string
  injectHosts: readonly string[]
}

/**
 * Sentinel↔real-value map for one sandbox session, keyed by credential name.
 *
 * Each credential carries its own `injectHosts` list, and substitution is
 * gated per sentinel: a sentinel is swapped to its real value only when the
 * destination matches THAT credential's hosts. This prevents laundering
 * credential A through credential B's allowlisted host by sending A's
 * sentinel there — the proxy leaves A's sentinel intact on B's host.
 *
 * Keying on name (not value) means two env vars holding the same secret get
 * distinct sentinels, so each can have an independent host list.
 */
export class SentinelRegistry {
  private readonly byName = new Map<string, SentinelEntry>()
  private readonly bySentinel = new Map<string, SentinelEntry>()

  /**
   * Return the sentinel for the credential named `name`, minting a fresh one
   * on first use. The sentinel is `fake_value_<uuid4>`: long enough that an
   * accidental collision with legitimate header content is negligible, and
   * free of shell/URL metacharacters so it survives `--setenv` and
   * `env NAME=value` unquoted.
   *
   * Idempotent on `name`: a repeat call returns the same sentinel and updates
   * `realValue`/`injectHosts` in place so `updateConfig()` can change either
   * without invalidating sentinels the sandboxed process has already read.
   */
  register(
    name: string,
    realValue: string,
    injectHosts: readonly string[],
  ): string {
    const existing = this.byName.get(name)
    if (existing !== undefined) {
      existing.realValue = realValue
      existing.injectHosts = injectHosts
      return existing.sentinel
    }
    const sentinel = SENTINEL_PREFIX + randomUUID()
    const entry: SentinelEntry = { name, sentinel, realValue, injectHosts }
    this.byName.set(name, entry)
    this.bySentinel.set(sentinel, entry)
    return sentinel
  }

  /** Real value for `sentinel`, or undefined if not registered. */
  lookupReal(sentinel: string): string | undefined {
    return this.bySentinel.get(sentinel)?.realValue
  }

  /** Iterate registered `[sentinel, realValue]` pairs. */
  *entries(): IterableIterator<[string, string]> {
    for (const e of this.bySentinel.values()) yield [e.sentinel, e.realValue]
  }

  /** Number of registered sentinels. */
  get size(): number {
    return this.bySentinel.size
  }

  /** Drop every mapping. Called on session teardown. */
  clear(): void {
    this.byName.clear()
    this.bySentinel.clear()
  }

  /**
   * Replace registered sentinels found in `headers` with their real values,
   * in place. Each sentinel substitutes only when `destHost` matches one of
   * THAT credential's `injectHosts` patterns (via `matches`); a sentinel
   * whose host list does not cover `destHost` is left as the useless fake.
   *
   * Scans all header values rather than a fixed set — a sentinel showing up
   * anywhere is the substitution trigger, regardless of header name
   * (Authorization, X-Api-Key, Private-Token, ...).
   *
   * The caller remains responsible for transport gating (TLS-terminated path
   * unless `allowPlaintextInject`).
   */
  substituteInHeaders(
    headers: IncomingHttpHeaders,
    destHost: string,
    matches: HostMatcher,
  ): void {
    if (this.bySentinel.size === 0) return
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          value[i] = this.substituteInString(value[i]!, destHost, matches)
        }
      } else {
        headers[name] = this.substituteInString(value, destHost, matches)
      }
    }
  }

  private substituteInString(
    s: string,
    destHost: string,
    matches: HostMatcher,
  ): string {
    // Fast path: the sentinel prefix is fixed, so a header value that
    // doesn't contain it cannot contain any sentinel.
    if (!s.includes(SENTINEL_PREFIX)) return s
    let out = s
    for (const e of this.bySentinel.values()) {
      if (!out.includes(e.sentinel)) continue
      if (!e.injectHosts.some(p => matches(destHost, p))) continue
      out = out.split(e.sentinel).join(e.realValue)
    }
    return out
  }
}
