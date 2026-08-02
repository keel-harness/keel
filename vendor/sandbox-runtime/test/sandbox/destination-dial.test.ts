import { describe, expect, test } from 'vitest'
import {
  DestinationAddressPolicyError,
  MAX_DESTINATION_ADDRESSES,
  prepareDestinationDial,
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

    expect(calls).toEqual([
      { hostname: 'api.example.com', port: 443, signal: abortSignal },
    ])
    expect(await lookupAll(prepared.lookup!)).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ])
    expect(await lookupAll(prepared.lookup!)).toEqual([
      { address: '203.0.113.7', family: 4 },
      { address: '2001:db8::7', family: 6 },
    ])
    expect(calls).toHaveLength(1)
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
    controller.abort()
    finish([{ address: '192.0.2.1', family: 4 }])
    await expect(pending).rejects.toBeInstanceOf(
      DestinationAddressPolicyError,
    )
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
})
