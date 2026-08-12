import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
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

function socksEndpointFromArgv(argv: readonly string[]): {
  token: string
  port: number
} {
  const match = /socks5h:\/\/srt:([0-9a-f]{64})@localhost:(\d+)/u.exec(
    argv.join(' ').replaceAll('\\', ''),
  )
  if (!match) throw new Error('prepared launch did not contain an authenticated SOCKS proxy')
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

function runPreparedLaunch(launch: {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), {
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 5_000)
    timeout.unref?.()
    child.once('close', exitCode => {
      clearTimeout(timeout)
      if (timedOut) reject(new Error('prepared launch exceeded its host deadline'))
      else resolve({ exitCode, stdout, stderr })
    })
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
      initializeLaunchAuthority(endpointRegistryPath: string): void
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
    manager.initializeLaunchAuthority(registryPath)
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
      const firstSocks = socksEndpointFromArgv(first.argv)
      const secondSocks = socksEndpointFromArgv(second.argv)
      expect(firstProxy).not.toEqual(secondProxy)
      expect(firstSocks).not.toEqual(secondSocks)
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
          host: 'localhost.',
          port: secondProxy.port,
        }),
      ).toBe(403)
      expect(
        await connectThroughProxy(firstProxy, {
          host: '[::ffff:127.0.0.1]',
          port: secondProxy.port,
        }),
      ).not.toBe(200)
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

      const peerTokenAttack = await manager.prepareLaunchAuthority(
        config('one.invalid', address.port),
        {
          command:
            `own_http="$(curl --noproxy '' --proxy "$HTTP_PROXY" ` +
            `--connect-timeout 1 --max-time 2 --fail --silent --show-error ` +
            `http://one.invalid:${String(address.port)}/)" || exit 10; ` +
            `own_socks="$(curl --noproxy '' --proxy "$ALL_PROXY" ` +
            `--connect-timeout 1 --max-time 2 --fail --silent --show-error ` +
            `http://one.invalid:${String(address.port)}/)" || exit 11; ` +
            `printf 'own-http=%s\\nown-socks=%s\\n' "$own_http" "$own_socks"; ` +
            `if curl --noproxy '' --proxy ` +
            `http://srt:${firstProxy.token}@localhost:${String(firstProxy.port)} ` +
            `--connect-timeout 1 --max-time 2 --fail --silent --output /dev/null ` +
            `http://one.invalid:${String(address.port)}/; then exit 20; fi; ` +
            `if curl --noproxy '' --proxy ` +
            `socks5h://srt:${firstSocks.token}@localhost:${String(firstSocks.port)} ` +
            `--connect-timeout 1 --max-time 2 --fail --silent --output /dev/null ` +
            `http://one.invalid:${String(address.port)}/; then exit 21; fi`,
          binShell: '/bin/bash',
          endpointRegistryPath: registryPath,
        },
      )
      try {
        const attackResult = await runPreparedLaunch(peerTokenAttack)
        expect(attackResult.exitCode).toBe(0)
        expect(attackResult.stdout).toContain('own-http=none')
        expect(attackResult.stdout).toContain('own-socks=none')
        expect(attackResult.stdout).not.toContain('secret-one')
        expect(attackResult.stderr).not.toContain('secret-one')
      } finally {
        await peerTokenAttack.cleanup()
      }

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

  it('aborts pending launch resolution before the bounded listener drain', async () => {
    let resolverStarted!: () => void
    const started = new Promise<void>(resolve => {
      resolverStarted = resolve
    })
    let resolverAborted = false
    const runtimeConfig = config('stall.invalid', 443)
    runtimeConfig.network.resolveDestination = async (_hostname, _port, signal) => {
      resolverStarted()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            resolverAborted = true
            reject(new Error('resolver aborted'))
          },
          { once: true },
        )
      })
      return []
    }
    const manager = SandboxManager as typeof SandboxManager & {
      initializeLaunchAuthority(endpointRegistryPath: string): void
      prepareLaunchAuthority(
        config: SandboxRuntimeConfig,
        options: {
          command: string
          binShell?: string
          endpointRegistryPath: string
        },
      ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; cleanup(): Promise<void> }>
    }
    const registryPath = join(privateRoot(), 'leases.json')
    manager.initializeLaunchAuthority(registryPath)
    const launch = await manager.prepareLaunchAuthority(runtimeConfig, {
      command: 'true',
      binShell: '/bin/bash',
      endpointRegistryPath: registryPath,
    })
    const request = requestThroughProxy(endpointFromArgv(launch.argv), {
      host: 'stall.invalid',
      port: 443,
    })
    await started

    const cleanupStarted = Date.now()
    await launch.cleanup()

    expect(resolverAborted).toBe(true)
    expect(Date.now() - cleanupStarted).toBeLessThan(2_000)
    await expect(request).resolves.toBe('')
  })
})
