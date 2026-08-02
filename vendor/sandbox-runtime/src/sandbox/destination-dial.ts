import type { LookupAddress } from 'node:dns'
import type { ClientRequest } from 'node:http'
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
  /** Guard-owned signal combining caller cancellation with the fixed dial deadline. */
  readonly signal: AbortSignal
  /** Stop the dial deadline after the transport connection is established. */
  markConnected(): void
  /** Release the fixed guarded-connection permit. Idempotent. */
  release(): void
}

export const MAX_DESTINATION_ADDRESSES = 16
export const MAX_CONCURRENT_GUARDED_CONNECTIONS = 64
export const TOTAL_GUARDED_DIAL_TIMEOUT_MS = 30_000
// Preserve the pre-ADR legacy socket deadline even when no guard is configured.
const LEGACY_CONNECT_TIMEOUT_MS = 30_000

interface GuardedConnectionLease {
  readonly signal: AbortSignal
  markConnected(): void
  release(): void
}

const activeGuardedConnections = new Set<GuardedConnectionLease>()

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

function unguardedLease(signal: AbortSignal): GuardedConnectionLease {
  return { signal, markConnected: () => {}, release: () => {} }
}

function acquireGuardedConnection(
  resolveDestination: ResolveDestination | undefined,
  callerSignal: AbortSignal,
): GuardedConnectionLease {
  if (resolveDestination === undefined) return unguardedLease(callerSignal)
  if (
    callerSignal.aborted ||
    activeGuardedConnections.size >= MAX_CONCURRENT_GUARDED_CONNECTIONS
  ) {
    return deny()
  }

  const controller = new AbortController()
  let released = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const abortFromCaller = () => controller.abort()
  callerSignal.addEventListener('abort', abortFromCaller, { once: true })

  const lease: GuardedConnectionLease = {
    signal: controller.signal,
    markConnected(): void {
      if (deadline !== undefined) clearTimeout(deadline)
      deadline = undefined
    },
    release(): void {
      if (released) return
      released = true
      if (deadline !== undefined) clearTimeout(deadline)
      deadline = undefined
      callerSignal.removeEventListener('abort', abortFromCaller)
      controller.abort()
      activeGuardedConnections.delete(lease)
    },
  }
  activeGuardedConnections.add(lease)
  deadline = setTimeout(
    () => controller.abort(),
    TOTAL_GUARDED_DIAL_TIMEOUT_MS,
  )
  deadline.unref?.()
  return lease
}

/** Abort and forget all guarded dials during manager reset or terminal quarantine. */
export function resetDestinationGuardConnections(): void {
  for (const lease of [...activeGuardedConnections]) lease.release()
}

/**
 * Retain a guarded-connection permit for an agent:false request until its
 * one-shot transport closes. The dial deadline ends only after TCP (or TLS)
 * establishment; request lifetime remains bounded by the fixed permit cap.
 */
export function trackPreparedDestinationRequest(
  request: ClientRequest,
  prepared: PreparedDestinationDial,
  secure: boolean,
): void {
  request.once('socket', socket => {
    if (secure) {
      socket.once('secureConnect', prepared.markConnected)
    } else if (socket.connecting) {
      socket.once('connect', prepared.markConnected)
    } else {
      prepared.markConnected()
    }
  })
  request.once('error', prepared.release)
  request.once('close', prepared.release)
}

function resolveWithAbort(
  resolveDestination: ResolveDestination,
  hostname: string,
  port: number,
  signal: AbortSignal,
): Promise<readonly ResolvedDestinationAddress[]> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      result:
        | { kind: 'resolve'; answers: readonly ResolvedDestinationAddress[] }
        | { kind: 'reject' },
    ): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (result.kind === 'resolve') resolve(result.answers)
      else reject(new DestinationAddressPolicyError())
    }
    const onAbort = () => finish({ kind: 'reject' })
    if (signal.aborted) {
      finish({ kind: 'reject' })
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => resolveDestination(hostname, port, signal))
      .then(
        answers => finish({ kind: 'resolve', answers }),
        () => finish({ kind: 'reject' }),
      )
  })
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
  if (signal.aborted) return deny()
  const lease = acquireGuardedConnection(resolveDestination, signal)
  if (resolveDestination === undefined) {
    return {
      hostname,
      port,
      signal: lease.signal,
      markConnected: lease.markConnected,
      release: lease.release,
    }
  }

  let raw: readonly ResolvedDestinationAddress[]
  try {
    raw = await resolveWithAbort(
      resolveDestination,
      hostname,
      port,
      lease.signal,
    )
  } catch {
    lease.release()
    return deny()
  }
  if (lease.signal.aborted) {
    lease.release()
    return deny()
  }
  try {
    const answers = validateAnswers(hostname, raw)
    return {
      hostname,
      port,
      lookup: pinnedLookup(answers),
      signal: lease.signal,
      markConnected: lease.markConnected,
      release: lease.release,
    }
  } catch {
    lease.release()
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
    let socket: Socket
    try {
      socket = netConnect({
        host: prepared.hostname,
        port: prepared.port,
        ...(prepared.lookup === undefined ? {} : { lookup: prepared.lookup }),
        signal: prepared.signal,
      })
    } catch (error) {
      prepared.release()
      reject(error)
      return
    }
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      prepared.release()
      socket.destroy()
      reject(error)
    }
    const onClose = () => fail(new Error('socket closed before connect'))
    socket.setTimeout(LEGACY_CONNECT_TIMEOUT_MS, () =>
      fail(new Error('Direct connection timed out')),
    )
    socket.once('error', fail)
    socket.once('close', onClose)
    socket.once('connect', () => {
      if (settled) return
      settled = true
      prepared.markConnected()
      socket.setTimeout(0)
      socket.removeListener('error', fail)
      socket.removeListener('close', onClose)
      socket.once('close', prepared.release)
      resolve(socket)
    })
  })
}
