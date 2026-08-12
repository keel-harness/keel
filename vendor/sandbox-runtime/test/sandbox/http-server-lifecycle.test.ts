import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpProxyServer } from '../../src/sandbox/http-proxy.js'
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
  it('drains a Node CONNECT-upgraded client before server close settles', async () => {
    const server = createHttpProxyServer({ filter: () => true })
    server.removeAllListeners('connect')
    const accepted = new Promise<Socket>(resolve => {
      server.once('connect', (_request, socket) => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        resolve(socket)
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('HTTP proxy test listener did not expose a TCP port')
    }
    const client = connect(address.port, '127.0.0.1')
    await once(client, 'connect')
    client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n')
    const upgraded = await accepted
    await once(client, 'data')

    const clientClosed = once(client, 'close')
    const closing = forceCloseHttpServer(server)
    let timeout: NodeJS.Timeout | undefined
    try {
      await expect(
        Promise.race([
          closing,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('HTTP proxy close left a CONNECT tunnel alive')),
              100,
            )
          }),
        ]),
      ).resolves.toBeUndefined()
      await clientClosed
      expect(client.destroyed).toBe(true)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      client.destroy()
      upgraded.destroy()
      await closing
    }
  })

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
