import { afterEach, describe, expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  DestinationAddressPolicyError,
  MAX_CONCURRENT_GUARDED_CONNECTIONS,
  MAX_DESTINATION_ADDRESSES,
  TOTAL_GUARDED_DIAL_TIMEOUT_MS,
  dialDestination,
  prepareDestinationDial,
  resetDestinationGuardConnections,
  trackPreparedDestinationRequest,
  type ResolveDestination,
} from '../../src/sandbox/destination-dial.js'

function signal(): AbortSignal {
  return new AbortController().signal
}

function lookupAll(
  lookup: NonNullable<Awaited<ReturnType<typeof prepareDestinationDial>>['lookup']>,
  hostname = 'ignored.example',
): Promise<readonly { address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error)
      else if (!Array.isArray(addresses)) reject(new Error('expected all-address lookup result'))
      else resolve(addresses)
    })
  })
}

describe('prepareDestinationDial', () => {
  afterEach(() => {
    resetDestinationGuardConnections()
    vi.useRealTimers()
  })

  test('resolves once and pins the exact normalized answer set', async () => {
    const calls: Array<{ hostname: string; port: number; signal: AbortSignal }> = []
    const resolveDestination: ResolveDestination = async (
      hostname,
      port,
      abortSignal,
    ) => {
      calls.push({ hostname, port, signal: abortSignal })
      return [
        { address: '203.0.113.7', family: 4 },
        { address: '2001:0DB8:0:0:0:0:0:7', family: 6 },
      ]
    }
    const abortSignal = signal()

    const prepared = await prepareDestinationDial(
      'api.example.com',
      443,
      resolveDestination,
      abortSignal,
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ hostname: 'api.example.com', port: 443 })
    expect(calls[0]!.signal).not.toBe(abortSignal)
    expect(calls[0]!.signal.aborted).toBe(false)
    expect(await lookupAll(prepared.lookup!)).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ])
    expect(await lookupAll(prepared.lookup!)).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ])
    expect(calls).toHaveLength(1)
    prepared.release()
  })

  test('invokes the resolver for an IP literal and requires the answer to match it', async () => {
    let calls = 0
    const prepared = await prepareDestinationDial(
      '192.0.2.9',
      80,
      async () => {
        calls += 1
        return [{ address: '192.0.2.9', family: 4 }]
      },
      signal(),
    )
    expect(calls).toBe(1)
    expect(await lookupAll(prepared.lookup!)).toEqual([
      { address: '192.0.2.9', family: 4 },
    ])
    prepared.release()

    await expect(
      prepareDestinationDial(
        '192.0.2.9',
        80,
        async () => [{ address: '192.0.2.10', family: 4 }],
        signal(),
      ),
    ).rejects.toBeInstanceOf(DestinationAddressPolicyError)
  })

  test('fails closed on resolver rejection without exposing its diagnostic', async () => {
    const rawDiagnostic = 'resolver-secret-private-address=10.0.0.8'
    await expect(
      prepareDestinationDial(
        'api.example.com',
        443,
        async () => {
          throw new Error(rawDiagnostic)
        },
        signal(),
      ),
    ).rejects.toMatchObject({
      name: 'DestinationAddressPolicyError',
      message: 'destination address policy denied the connection',
    })
    try {
      await prepareDestinationDial(
        'api.example.com',
        443,
        async () => {
          throw new Error(rawDiagnostic)
        },
        signal(),
      )
    } catch (error) {
      expect(String(error)).not.toContain(rawDiagnostic)
    }
  })

  test.each([
    ['empty', []],
    ['malformed address', [{ address: 'not-an-ip', family: 4 }]],
    ['family mismatch', [{ address: '2001:db8::1', family: 4 }]],
    [
      'duplicate after normalization',
      [
        { address: '2001:db8::1', family: 6 },
        { address: '2001:0DB8:0:0:0:0:0:1', family: 6 },
      ],
    ],
    [
      'oversized',
      Array.from({ length: MAX_DESTINATION_ADDRESSES + 1 }, (_, index) => ({
        address: `192.0.2.${String(index + 1)}`,
        family: 4,
      })),
    ],
  ])('rejects a %s answer set', async (_label, answers) => {
    await expect(
      prepareDestinationDial(
        'api.example.com',
        443,
        async () => answers as readonly { address: string; family: 4 | 6 }[],
        signal(),
      ),
    ).rejects.toBeInstanceOf(DestinationAddressPolicyError)
  })

  test('rejects a pre-aborted signal without calling the resolver', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    await expect(
      prepareDestinationDial(
        'api.example.com',
        443,
        async () => {
          called = true
          return [{ address: '192.0.2.1', family: 4 }]
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(DestinationAddressPolicyError)
    expect(called).toBe(false)
  })

  test('rejects an answer that arrives after the caller aborts', async () => {
    const controller = new AbortController()
    let finish!: (
      answers: readonly { address: string; family: 4 | 6 }[],
    ) => void
    const pending = prepareDestinationDial(
      'api.example.com',
      443,
      async () =>
        await new Promise(resolve => {
          finish = resolve
      }),
      controller.signal,
    )
    const rejection = expect(pending).rejects.toBeInstanceOf(
      DestinationAddressPolicyError,
    )
    await Promise.resolve()
    controller.abort()
    finish([{ address: '192.0.2.1', family: 4 }])
    await rejection
  })

  test('converts a hostile answer getter into the stable policy denial', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('private getter diagnostic 10.0.0.9')
        },
      },
    )
    await expect(
      prepareDestinationDial(
        'api.example.com',
        443,
        async () => [hostile] as never,
        signal(),
      ),
    ).rejects.toMatchObject({
      name: 'DestinationAddressPolicyError',
      message: 'destination address policy denied the connection',
    })
  })

  test('holds a fixed connection permit until release and rejects beyond capacity', async () => {
    const resolveDestination: ResolveDestination = async () => [
      { address: '192.0.2.1', family: 4 },
    ]
    const prepared = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_GUARDED_CONNECTIONS }, () =>
        prepareDestinationDial(
          'capacity.example',
          443,
          resolveDestination,
          signal(),
        ),
      ),
    )

    await expect(
      prepareDestinationDial(
        'over-capacity.example',
        443,
        resolveDestination,
        signal(),
      ),
    ).rejects.toBeInstanceOf(DestinationAddressPolicyError)

    prepared[0]!.release()
    prepared[0]!.release()
    const replacement = await prepareDestinationDial(
      'replacement.example',
      443,
      resolveDestination,
      signal(),
    )
    replacement.release()
    for (const item of prepared.slice(1)) item.release()
  })

  test('aborts and releases a hung guarded dial at the fixed total deadline', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    const pending = prepareDestinationDial(
      'hung.example',
      443,
      async (_hostname, _port, abortSignal) => {
        observedSignal = abortSignal
        return await new Promise((resolve, reject) => {
          abortSignal.addEventListener(
            'abort',
            () => reject(new Error('late private resolver diagnostic')),
            { once: true },
          )
        })
      },
      signal(),
    )
    const rejection = expect(pending).rejects.toBeInstanceOf(
      DestinationAddressPolicyError,
    )
    await vi.advanceTimersByTimeAsync(TOTAL_GUARDED_DIAL_TIMEOUT_MS)
    await rejection
    expect(observedSignal?.aborted).toBe(true)

    const next = await prepareDestinationDial(
      'after-timeout.example',
      443,
      async () => [{ address: '192.0.2.1', family: 4 }],
      signal(),
    )
    next.release()
  })

  test('terminal reset aborts pending guard work and restores an empty limiter', async () => {
    let observedSignal: AbortSignal | undefined
    const pending = prepareDestinationDial(
      'reset.example',
      443,
      async (_hostname, _port, abortSignal) => {
        observedSignal = abortSignal
        return await new Promise((resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('reset')), {
            once: true,
          })
        })
      },
      signal(),
    )
    resetDestinationGuardConnections()
    await expect(pending).rejects.toBeInstanceOf(
      DestinationAddressPolicyError,
    )
    expect(observedSignal?.aborted).toBe(true)

    const next = await prepareDestinationDial(
      'after-reset.example',
      443,
      async () => [{ address: '192.0.2.1', family: 4 }],
      signal(),
    )
    next.release()
  })

  test('request tracking holds a permit through connect and releases it on close', async () => {
    const resolveDestination: ResolveDestination = async () => [
      { address: '192.0.2.1', family: 4 },
    ]
    const prepared = await prepareDestinationDial(
      'tracked.example',
      443,
      resolveDestination,
      signal(),
    )
    const request = new EventEmitter()
    const socket = Object.assign(new EventEmitter(), { connecting: true })
    trackPreparedDestinationRequest(request as never, prepared, false)
    request.emit('socket', socket)
    socket.connecting = false
    socket.emit('connect')

    const rest = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_GUARDED_CONNECTIONS - 1 }, () =>
        prepareDestinationDial(
          'other.example',
          443,
          resolveDestination,
          signal(),
        ),
      ),
    )
    await expect(
      prepareDestinationDial(
        'still-full.example',
        443,
        resolveDestination,
        signal(),
      ),
    ).rejects.toBeInstanceOf(DestinationAddressPolicyError)

    request.emit('close')
    const replacement = await prepareDestinationDial(
      'after-close.example',
      443,
      resolveDestination,
      signal(),
    )
    replacement.release()
    for (const item of rest) item.release()
  })

  test('releases guarded permits when net.connect throws before returning a socket', async () => {
    const resolveDestination: ResolveDestination = async () => [
      { address: '192.0.2.1', family: 4 },
    ]
    for (let index = 0; index < MAX_CONCURRENT_GUARDED_CONNECTIONS; index += 1) {
      await expect(
        dialDestination(
          'invalid-port.example',
          -1,
          resolveDestination,
          signal(),
        ),
      ).rejects.toThrow()
    }

    const replacement = await prepareDestinationDial(
      'after-sync-throw.example',
      443,
      resolveDestination,
      signal(),
    )
    replacement.release()
  })
})
