import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import type { SandboxRuntimeConfig } from '../../src/sandbox/sandbox-config.js'

const roots: string[] = []
const suite = process.env.KEEL_REQUIRE_REAL_SANDBOX === '1' ? describe : describe.skip

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keel-srt-launch-authority-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

afterEach(async () => {
  await SandboxManager.reset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function endpointFromArgv(argv: readonly string[]): { token: string; port: number } {
  const match = /srt:([0-9a-f]{64})@localhost:(\d+)/u.exec(
    argv.join(' ').replaceAll('\\', ''),
  )
  if (!match) throw new Error('prepared launch did not contain an authenticated HTTP proxy')
  return { token: match[1]!, port: Number(match[2]!) }
}

function connectThroughProxy(
  proxy: { token: string; port: number },
  target: { host: string; port: number },
  username = 'srt',
): Promise<number> {
  return new Promise(resolve => {
    const socket = connect(proxy.port, '127.0.0.1', () => {
      const auth = Buffer.from(`${username}:${proxy.token}`).toString('base64')
      socket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      )
    })
    let response = ''
    socket.on('data', chunk => {
      response += chunk.toString()
      const match = /HTTP\/1\.1 (\d{3})/u.exec(response)
      if (match) {
        socket.destroy()
        resolve(Number(match[1]))
      }
    })
    socket.on('error', () => resolve(0))
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(0)
    })
  })
}

function config(
  host: string,
  fixturePort: number,
  secret?: string,
): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [host, 'localhost'],
      deniedDomains: [],
      strictAllowlist: true,
      inheritProxyEnv: false,
      resolveDestination: async (_hostname, port) => [
        { address: '127.0.0.1', family: 4 as const, ...(port === fixturePort ? {} : {}) },
      ],
    },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    ...(secret === undefined
      ? {}
      : {
          credentials: {
            authorizationHeaders: [
              { host, scheme: 'Bearer', value: secret },
            ],
            allowPlaintextInject: true,
          },
        }),
  }
}

function requestThroughProxy(
  proxy: { token: string; port: number },
  target: { host: string; port: number },
): Promise<string> {
  return new Promise(resolve => {
    const socket = connect(proxy.port, '127.0.0.1', () => {
      const auth = Buffer.from(`srt:${proxy.token}`).toString('base64')
      socket.write(
        `GET http://${target.host}:${target.port}/ HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n` +
          'Connection: close\r\n\r\n',
      )
    })
    let response = ''
    socket.on('data', chunk => {
      response += chunk.toString()
    })
    socket.on('close', () => resolve(response.split('\r\n\r\n')[1] ?? ''))
    socket.on('error', () => resolve(''))
    socket.setTimeout(2000, () => socket.destroy())
  })
}

function openTunnelThroughProxy(
  proxy: { token: string; port: number },
  target: { host: string; port: number },
): Promise<ReturnType<typeof connect>> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, '127.0.0.1', () => {
      const auth = Buffer.from(`srt:${proxy.token}`).toString('base64')
      socket.write(
        `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
          `Host: ${target.host}:${target.port}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      )
    })
    let response = ''
    socket.on('data', chunk => {
      response += chunk.toString()
      if (response.includes('HTTP/1.1 200')) resolve(socket)
    })
    socket.once('error', reject)
    socket.setTimeout(2000, () => reject(new Error('proxy tunnel timed out')))
  })
}

suite('immutable per-launch SRT authority', () => {
  it('isolates concurrent config and token authority, then revokes only the cleaned launch', async () => {
    const targetServer = createHttpServer((request, response) => {
      response.end(request.headers.authorization ?? 'none')
    })
    await new Promise<void>((resolve, reject) => {
      targetServer.once('error', reject)
      targetServer.listen(0, '127.0.0.1', resolve)
    })
    const address = targetServer.address()
    if (!address || typeof address === 'string') throw new Error('fixture did not bind')

    const manager = SandboxManager as typeof SandboxManager & {
      supportsLaunchAuthority(): boolean
      prepareLaunchAuthority(
        config: SandboxRuntimeConfig,
        options: {
          command: string
          binShell?: string
          endpointRegistryPath: string
        },
      ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; cleanup(): Promise<void> }>
    }
    expect(manager.supportsLaunchAuthority()).toBe(true)
    const registryPath = join(privateRoot(), 'leases.json')
    const [first, second] = await Promise.all([
      manager.prepareLaunchAuthority(config('one.invalid', address.port, 'secret-one'), {
        command: 'true',
        binShell: '/bin/bash',
        endpointRegistryPath: registryPath,
      }),
      manager.prepareLaunchAuthority(config('two.invalid', address.port, 'secret-two'), {
        command: 'true',
        binShell: '/bin/bash',
        endpointRegistryPath: registryPath,
      }),
    ])

    try {
      const firstProxy = endpointFromArgv(first.argv)
      const secondProxy = endpointFromArgv(second.argv)
      expect(firstProxy).not.toEqual(secondProxy)
      expect(
        await connectThroughProxy(firstProxy, { host: 'one.invalid', port: address.port }),
      ).toBe(200)
      expect(
        await connectThroughProxy(secondProxy, { host: 'one.invalid', port: address.port }),
      ).toBe(403)
      expect(
        await connectThroughProxy(
          { token: firstProxy.token, port: secondProxy.port },
          { host: 'two.invalid', port: address.port },
        ),
      ).toBe(407)
      expect(
        await connectThroughProxy(
          firstProxy,
          { host: 'one.invalid', port: address.port },
          'not-srt',
        ),
      ).toBe(407)
      expect(
        await connectThroughProxy(firstProxy, {
          host: 'localhost',
          port: secondProxy.port,
        }),
      ).toBe(403)
      expect(
        await connectThroughProxy(firstProxy, {
          host: 'one.invalid',
          port: secondProxy.port,
        }),
      ).not.toBe(200)
      expect(
        await requestThroughProxy(firstProxy, {
          host: 'one.invalid',
          port: address.port,
        }),
      ).toBe('Bearer secret-one')
      expect(
        await requestThroughProxy(secondProxy, {
          host: 'two.invalid',
          port: address.port,
        }),
      ).toBe('Bearer secret-two')

      const liveTunnel = await openTunnelThroughProxy(firstProxy, {
        host: 'one.invalid',
        port: address.port,
      })
      liveTunnel.setTimeout(0)
      const tunnelClosed = once(liveTunnel, 'close')
      const cleanupStarted = Date.now()
      await first.cleanup()
      await tunnelClosed
      expect(Date.now() - cleanupStarted).toBeLessThan(2_000)
      await first.cleanup()
      const durable = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        entries: Record<string, { state: string; endpoints: string[] }>
      }
      const firstLease = Object.values(durable.entries).find(entry =>
        entry.endpoints.includes(`tcp:127.0.0.1:${firstProxy.port}`),
      )
      expect(firstLease?.state).toBe('tombstone')
      expect(
        await connectThroughProxy(firstProxy, { host: 'one.invalid', port: address.port }),
      ).toBe(0)
      expect(
        await connectThroughProxy(secondProxy, { host: 'one.invalid', port: address.port }),
      ).toBe(403)
      expect(
        await requestThroughProxy(secondProxy, {
          host: 'two.invalid',
          port: address.port,
        }),
      ).toBe('Bearer secret-two')

      const third = await manager.prepareLaunchAuthority(
        config('three.invalid', address.port),
        {
          command: 'true',
          binShell: '/bin/bash',
          endpointRegistryPath: registryPath,
        },
      )
      try {
        expect(endpointFromArgv(third.argv).port).not.toBe(firstProxy.port)
      } finally {
        await third.cleanup()
      }
    } finally {
      await second.cleanup()
      await new Promise<void>(resolve => targetServer.close(() => resolve()))
    }
  })
})
