import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  forceCloseHttpServer,
  type ForceCloseHttpServer,
} from '../../src/sandbox/sandbox-manager.js'

const bunDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Bun')
const originalSrtDebug = process.env.SRT_DEBUG

afterEach(() => {
  if (bunDescriptor === undefined) delete (globalThis as { Bun?: unknown }).Bun
  else Object.defineProperty(globalThis, 'Bun', bunDescriptor)
  if (originalSrtDebug === undefined) delete process.env.SRT_DEBUG
  else process.env.SRT_DEBUG = originalSrtDebug
  vi.restoreAllMocks()
})

function selectBunRuntime(): void {
  Object.defineProperty(globalThis, 'Bun', {
    configurable: true,
    value: {},
  })
}

describe('HTTP proxy server lifecycle', () => {
  it('stops a Node listener before force-closing its established connections', async () => {
    const calls: string[] = []
    let accepting = true
    const server: ForceCloseHttpServer = {
      close(callback) {
        calls.push('close')
        accepting = false
        queueMicrotask(callback)
      },
      closeAllConnections() {
        calls.push('closeAllConnections')
        if (accepting) throw new Error('force-close raced an accepting Node listener')
      },
    }

    await expect(forceCloseHttpServer(server)).resolves.toBeUndefined()
    expect(calls).toEqual(['close', 'closeAllConnections'])
  })

  it('rejects a force-close failure after a synchronous Node close callback', async () => {
    const forceCloseError = new Error('force-close failed')
    const server: ForceCloseHttpServer = {
      close(callback) {
        callback()
      },
      closeAllConnections() {
        throw forceCloseError
      },
    }

    await expect(forceCloseHttpServer(server)).rejects.toBe(forceCloseError)
  })

  it('logs and resolves a synchronous Node close callback error', async () => {
    process.env.SRT_DEBUG = '1'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server: ForceCloseHttpServer = {
      close(callback) {
        callback(new Error('close callback failed'))
      },
      closeAllConnections() {},
    }

    await expect(forceCloseHttpServer(server)).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith(
      '[SandboxDebug] Error closing HTTP proxy server: close callback failed',
    )
  })

  it('force-closes Bun connections before close detaches the listener handle', async () => {
    selectBunRuntime()
    const calls: string[] = []
    let detached = false
    const server: ForceCloseHttpServer = {
      close(callback) {
        calls.push('close')
        detached = true
        queueMicrotask(callback)
      },
      closeAllConnections() {
        calls.push('closeAllConnections')
        if (detached) throw new Error('Bun close detached before force-close')
      },
    }

    await expect(forceCloseHttpServer(server)).resolves.toBeUndefined()
    expect(calls).toEqual(['closeAllConnections', 'close'])
  })
})
