import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS,
  settleLaunchAuthorityDrain,
} from '../../src/sandbox/sandbox-manager.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('launch authority cleanup deadline', () => {
  it('fails closed at the absolute two-second bound when any drain never settles', async () => {
    vi.useFakeTimers()
    const neverSettles = new Promise<void>(() => undefined)
    const result = settleLaunchAuthorityDrain([
      Promise.resolve(),
      neverSettles,
    ])
    let settled = false
    void result.finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe(false)
  })

  it('reports only a completely fulfilled drain as clean', async () => {
    await expect(
      settleLaunchAuthorityDrain([Promise.resolve(), Promise.resolve()]),
    ).resolves.toBe(true)
    await expect(
      settleLaunchAuthorityDrain([
        Promise.resolve(),
        Promise.reject(new Error('bridge close failed')),
      ]),
    ).resolves.toBe(false)
  })
})
