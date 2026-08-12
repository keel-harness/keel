import { Socket, type Server } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createSocksProxyServer } from '../../src/sandbox/socks-proxy.js'

describe('SOCKS proxy server lifecycle', () => {
  it('destroys a client delivered after close entered persistent drain mode', async () => {
    const proxy = createSocksProxyServer({
      filter: () => true,
      proxyAuthToken: 'a'.repeat(64),
      isProxyAuthActive: () => true,
    })
    const internal = (proxy.server as unknown as { server: Server }).server

    await proxy.close()
    const lateSocket = new Socket()
    internal.emit('connection', lateSocket)

    expect(lateSocket.destroyed).toBe(true)
  })
})
