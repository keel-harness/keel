import type { LookupAddress } from 'node:dns'
import { connect as netConnect, isIP, type LookupFunction, type Socket } from 'node:net'
import { URL } from 'node:url'

export interface ResolvedDestinationAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type ResolveDestination = (
  hostname: string,
  port: number,
  signal: AbortSignal,
) => Promise<readonly ResolvedDestinationAddress[]>

export interface PreparedDestinationDial {
  readonly hostname: string
  readonly port: number
  readonly lookup?: LookupFunction
}

export const MAX_DESTINATION_ADDRESSES = 16
const CONNECT_TIMEOUT_MS = 30_000

/**
 * Stable fail-closed error for an unavailable, rejected, or defective
 * destination resolver. Raw resolver diagnostics are deliberately discarded:
 * they may contain private addresses or host-specific NSS details.
 */
export class DestinationAddressPolicyError extends Error {
  constructor() {
    super('destination address policy denied the connection')
    this.name = 'DestinationAddressPolicyError'
  }
}

export function isDestinationAddressPolicyError(
  error: unknown,
): error is DestinationAddressPolicyError {
  return error instanceof DestinationAddressPolicyError
}

function deny(): never {
  throw new DestinationAddressPolicyError()
}

function normalizeAddress(address: string, family: 4 | 6): string {
  if (address.includes('%') || isIP(address) !== family) return deny()
  try {
    const parsed =
      family === 6
        ? new URL(`http://[${address}]/`).hostname.slice(1, -1)
        : new URL(`http://${address}/`).hostname
    if (isIP(parsed) !== family) return deny()
    return parsed.toLowerCase()
  } catch {
    return deny()
  }
}

function validateAnswers(
  hostname: string,
  raw: readonly ResolvedDestinationAddress[],
): readonly LookupAddress[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DESTINATION_ADDRESSES) {
    return deny()
  }

  const seen = new Set<string>()
  const answers: LookupAddress[] = []
  for (const item of raw) {
    if (
      typeof item !== 'object' ||
      item === null ||
      (item.family !== 4 && item.family !== 6) ||
      typeof item.address !== 'string'
    ) {
      return deny()
    }
    const address = normalizeAddress(item.address, item.family)
    const key = `${String(item.family)}:${address}`
    if (seen.has(key)) return deny()
    seen.add(key)
    answers.push({ address, family: item.family })
  }

  const literalFamily = isIP(hostname)
  if (literalFamily !== 0) {
    const family = literalFamily as 4 | 6
    const literal = normalizeAddress(hostname, family)
    if (
      answers.length !== 1 ||
      answers[0]!.family !== family ||
      answers[0]!.address !== literal
    ) {
      return deny()
    }
  }
  return answers
}

function pinnedLookup(answers: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily =
      options.family === 4 || options.family === 6 ? options.family : 0
    const eligible =
      requestedFamily === 0
        ? answers
        : answers.filter(answer => answer.family === requestedFamily)
    if (eligible.length === 0) {
      const error = new DestinationAddressPolicyError() as NodeJS.ErrnoException
      error.code = 'EAI_NONAME'
      callback(error, '', 0)
      return
    }
    if (options.all) {
      callback(null, eligible.map(answer => ({ ...answer })))
      return
    }
    const selected = eligible[0]!
    callback(null, selected.address, selected.family)
  }
}

/**
 * Resolve exactly once before a destination dial and build a lookup function
 * backed only by that immutable vetted set. With no resolver the function
 * preserves upstream SRT behaviour for consumers that have not enabled the
 * guard.
 */
export async function prepareDestinationDial(
  hostname: string,
  port: number,
  resolveDestination: ResolveDestination | undefined,
  signal: AbortSignal,
): Promise<PreparedDestinationDial> {
  if (resolveDestination === undefined) return { hostname, port }
  if (signal.aborted) return deny()

  let raw: readonly ResolvedDestinationAddress[]
  try {
    raw = await resolveDestination(hostname, port, signal)
  } catch {
    return deny()
  }
  if (signal.aborted) return deny()
  try {
    const answers = validateAnswers(hostname, raw)
    return { hostname, port, lookup: pinnedLookup(answers) }
  } catch {
    return deny()
  }
}

/** Open one direct TCP destination using only the prepared pinned lookup. */
export async function dialDestination(
  hostname: string,
  port: number,
  resolveDestination: ResolveDestination | undefined,
  signal: AbortSignal,
): Promise<Socket> {
  const prepared = await prepareDestinationDial(
    hostname,
    port,
    resolveDestination,
    signal,
  )
  return await new Promise((resolve, reject) => {
    const socket = netConnect({
      host: prepared.hostname,
      port: prepared.port,
      ...(prepared.lookup === undefined ? {} : { lookup: prepared.lookup }),
      signal,
    })
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    const onClose = () => fail(new Error('socket closed before connect'))
    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      fail(new Error('Direct connection timed out')),
    )
    socket.once('error', fail)
    socket.once('close', onClose)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      socket.setTimeout(0)
      socket.removeListener('error', fail)
      socket.removeListener('close', onClose)
      resolve(socket)
    })
  })
}
