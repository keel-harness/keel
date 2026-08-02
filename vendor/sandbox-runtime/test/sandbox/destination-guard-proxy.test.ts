import { afterAll, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHttpProxyServer } from '../../src/sandbox/http-proxy.js'
import { createMitmCA } from '../../src/sandbox/mitm-ca.js'
import { createSocksProxyServer } from '../../src/sandbox/socks-proxy.js'
import type { ResolveDestination } from '../../src/sandbox/destination-dial.js'

const FIXTURE_HOST = 'guard-fixture.example'
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = join(TEST_DIR, '..', 'fixtures', 'tls-terminate')
const CA_CERT = join(FIXTURE_DIR, 'ca.crt')
const CA_KEY = join(FIXTURE_DIR, 'ca.key')

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

function absoluteRequest(
  proxyPort: number,
  target: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: target,
      },
      res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        )
      },
    )
    req.once('error', reject)
    req.end()
  })
}

function connectRequest(
  proxyPort: number,
  targetPort: number,
  hostname = FIXTURE_HOST,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1')
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk
      if (response.includes('\r\n\r\n')) socket.end()
    })
    socket.once('close', () => resolve(response))
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${hostname}:${String(targetPort)} HTTP/1.1\r\n` +
          `Host: ${hostname}:${String(targetPort)}\r\n\r\n`,
      )
    })
  })
}

function socksConnectStatus(
  proxyPort: number,
  targetPort: number,
  hostname = FIXTURE_HOST,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1')
    let stage: 'greeting' | 'request' = 'greeting'
    socket.once('error', reject)
    socket.on('data', (chunk: Buffer) => {
      if (stage === 'greeting') {
        expect([...chunk.subarray(0, 2)]).toEqual([5, 0])
        stage = 'request'
        const host = Buffer.from(hostname, 'ascii')
        socket.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 3, host.length]),
            host,
            Buffer.from([targetPort >> 8, targetPort & 0xff]),
          ]),
        )
        return
      }
      const status = chunk[1] ?? -1
      socket.destroy()
      resolve(status)
    })
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])))
  })
}

function curlTlsTerminated(proxyPort: number): Promise<{ exit: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn('curl', [
      '-sS',
      '--proxy',
      `http://127.0.0.1:${String(proxyPort)}`,
      '--noproxy',
      '',
      '--cacert',
      CA_CERT,
      '--max-time',
      '10',
      '-D',
      '-',
      `https://${FIXTURE_HOST}:443/`,
    ])
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', chunk => (output += chunk))
    child.once('close', code => resolve({ exit: code ?? 1, output }))
  })
}

describe('destination resolver across SRT proxy paths', () => {
  const rejectingResolver = (calls: string[]): ResolveDestination =>
    async (hostname, port) => {
      calls.push(`${hostname}:${String(port)}`)
      throw new Error('private diagnostic 127.0.0.1')
    }

  test.each([
    ['absolute HTTP', 'http:'],
    ['absolute HTTPS', 'https:'],
  ])('%s returns the stable address-policy denial', async (_name, protocol) => {
    const calls: string[] = []
    const proxy = createHttpProxyServer({
      filter: () => true,
      resolveDestination: rejectingResolver(calls),
    })
    const proxyPort = await listen(proxy)
    try {
      const result = await absoluteRequest(
        proxyPort,
        `${protocol}//${FIXTURE_HOST}:8443/`,
      )
      expect(result.status).toBe(403)
      expect(result.headers['x-proxy-error']).toBe('blocked-address-policy')
      expect(result.body).not.toContain('127.0.0.1')
      expect(calls).toEqual([`${FIXTURE_HOST}:8443`])
    } finally {
      await close(proxy)
    }
  })

  test('opaque CONNECT returns 403 before opening an upstream socket', async () => {
    const calls: string[] = []
    const proxy = createHttpProxyServer({
      filter: () => true,
      resolveDestination: rejectingResolver(calls),
    })
    const proxyPort = await listen(proxy)
    try {
      const response = await connectRequest(
        proxyPort,
        443,
        'GUARD-FIXTURE.EXAMPLE.',
      )
      expect(response).toContain('HTTP/1.1 403 Forbidden')
      expect(response).toContain('X-Proxy-Error: blocked-address-policy')
      expect(response).not.toContain('127.0.0.1')
      expect(calls).toEqual([`${FIXTURE_HOST}:443`])
    } finally {
      await close(proxy)
    }
  })

  test('SOCKS returns host-unreachable and resolves once', async () => {
    const calls: string[] = []
    const proxy = createSocksProxyServer({
      filter: () => true,
      resolveDestination: rejectingResolver(calls),
    })
    const proxyPort = await proxy.listen(0, '127.0.0.1')
    try {
      // SOCKS5 reply 0x04 is HOST_UNREACHABLE.
      expect(
        await socksConnectStatus(proxyPort, 443, 'GUARD-FIXTURE.EXAMPLE.'),
      ).toBe(4)
      expect(calls).toEqual([`${FIXTURE_HOST}:443`])
    } finally {
      await proxy.close()
    }
  })

  test('TLS termination returns the stable denial inside verified client TLS', async () => {
    const calls: string[] = []
    const ca = createMitmCA({ caCertPath: CA_CERT, caKeyPath: CA_KEY })
    const proxy = createHttpProxyServer({
      filter: () => true,
      mitmCA: ca,
      resolveDestination: rejectingResolver(calls),
    })
    const proxyPort = await listen(proxy)
    try {
      const result = await curlTlsTerminated(proxyPort)
      expect(result.exit).toBe(0)
      expect(result.output).toContain('HTTP/1.1 403 Forbidden')
      expect(result.output.toLowerCase()).toContain(
        'x-proxy-error: blocked-address-policy',
      )
      expect(result.output).not.toContain('private diagnostic')
      expect(calls).toEqual([`${FIXTURE_HOST}:443`])
    } finally {
      await close(proxy)
    }
  }, 15_000)

  test('dials the vetted address while preserving the original HTTP Host', async () => {
    let observedHost: string | undefined
    const upstream = (await import('node:http')).createServer((req, res) => {
      observedHost = req.headers.host
      res.end('PINNED_OK')
    })
    const upstreamPort = await listen(upstream)
    let calls = 0
    const proxy = createHttpProxyServer({
      filter: () => true,
      resolveDestination: async () => {
        calls += 1
        return [{ address: '127.0.0.1', family: 4 }]
      },
    })
    const proxyPort = await listen(proxy)
    try {
      const result = await absoluteRequest(
        proxyPort,
        `http://${FIXTURE_HOST}:${String(upstreamPort)}/pinned`,
      )
      expect(result.status).toBe(200)
      expect(result.body).toBe('PINNED_OK')
      expect(observedHost).toBe(`${FIXTURE_HOST}:${String(upstreamPort)}`)
      expect(calls).toBe(1)
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })
})

describe('destination dial source contract', () => {
  const root = join(TEST_DIR, '..', '..', 'src', 'sandbox')
  const source = (name: string) => readFileSync(join(root, name), 'utf8')

  test('every SRT direct destination path is threaded through the central helper', () => {
    expect(source('http-proxy.ts')).toContain('dialDestination(')
    expect(source('http-proxy.ts')).toContain('prepareDestinationDial(')
    expect(source('socks-proxy.ts')).toContain('dialDestination(')
    expect(source('tls-terminate-proxy.ts')).toContain(
      'prepareDestinationDial(',
    )
    expect(source('http-proxy.ts')).toMatch(
      /trackPreparedDestinationRequest\(proxyReq, prepared, /,
    )
    expect(source('tls-terminate-proxy.ts')).toMatch(
      /trackPreparedDestinationRequest\(upstream, prepared, true\)/,
    )
    for (const name of [
      'http-proxy.ts',
      'socks-proxy.ts',
      'tls-terminate-proxy.ts',
      'parent-proxy.ts',
    ]) {
      expect(source(name)).not.toContain('dialDirect(')
    }
  })
})

afterAll(() => {
  // The imported fixture is read to make the committed CA dependency explicit
  // and fail early if vendor verification ever drops it.
  expect(readFileSync(CA_CERT, 'utf8')).toContain('BEGIN CERTIFICATE')
})
