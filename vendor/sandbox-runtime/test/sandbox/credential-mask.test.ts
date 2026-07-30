import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Server, AddressInfo } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SentinelRegistry,
  SENTINEL_PREFIX,
} from '../../src/sandbox/credential-sentinel.js'
import { createHttpProxyServer } from '../../src/sandbox/http-proxy.js'
import { createMitmCA, disposeMitmCA } from '../../src/sandbox/mitm-ca.js'
import { mintLeafCert } from '../../src/sandbox/mitm-leaf.js'
import { SandboxManager } from '../../src/sandbox/sandbox-manager.js'
import type { SandboxRuntimeConfig } from '../../src/sandbox/sandbox-config.js'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'
import { isLinux } from '../helpers/platform.js'

// Committed test-only CA — see test/fixtures/tls-terminate/README.md.
const FIXTURE_DIR = join(import.meta.dir, '..', 'fixtures', 'tls-terminate')
const CA_CERT = join(FIXTURE_DIR, 'ca.crt')
const CA_KEY = join(FIXTURE_DIR, 'ca.key')
const CA_PEM = readFileSync(CA_CERT, 'utf8')

const REAL_TOKEN = 'ghp_realsecret_abcdef0123456789'

/** Host matcher for unit tests: exact equality. */
const eq = (h: string, p: string) => h === p
/** Host matcher that always allows — for tests of the substitution itself. */
const any = () => true

describe('SentinelRegistry', () => {
  test('register mints a fake_value_<uuid> sentinel', () => {
    const reg = new SentinelRegistry()
    const s = reg.register('GH_TOKEN', 'hunter2', ['api.github.com'])
    expect(s.startsWith(SENTINEL_PREFIX)).toBe(true)
    // UUID v4 is 36 chars (8-4-4-4-12 with hyphens).
    expect(s.length).toBe(SENTINEL_PREFIX.length + 36)
    expect(reg.lookupReal(s)).toBe('hunter2')
  })

  test('register is idempotent on credential name', () => {
    const reg = new SentinelRegistry()
    const a = reg.register('GH_TOKEN', 'hunter2', ['api.github.com'])
    const b = reg.register('GH_TOKEN', 'hunter2', ['api.github.com'])
    expect(a).toBe(b)
    expect(reg.size).toBe(1)
  })

  test('re-registering a name updates value and hosts but keeps the sentinel', () => {
    const reg = new SentinelRegistry()
    const a = reg.register('T', 'old', ['old.example.com'])
    const b = reg.register('T', 'new', ['new.example.com'])
    expect(b).toBe(a)
    expect(reg.lookupReal(a)).toBe('new')
    const headers: IncomingHttpHeaders = { authorization: a }
    reg.substituteInHeaders(headers, 'new.example.com', eq)
    expect(headers.authorization).toBe('new')
  })

  test('different names get different sentinels even for the same value', () => {
    // Per-credential host gating must apply independently, so two env
    // vars carrying the same secret still need distinct sentinels.
    const reg = new SentinelRegistry()
    const a = reg.register('A', 'same', ['a.example.com'])
    const b = reg.register('B', 'same', ['b.example.com'])
    expect(a).not.toBe(b)
    expect(reg.size).toBe(2)
  })

  test('clear drops every mapping', () => {
    const reg = new SentinelRegistry()
    const s = reg.register('T', 'x', [])
    reg.clear()
    expect(reg.size).toBe(0)
    expect(reg.lookupReal(s)).toBeUndefined()
  })

  test('substituteInHeaders replaces sentinels in any header value', () => {
    const reg = new SentinelRegistry()
    const s = reg.register('GH_TOKEN', REAL_TOKEN, ['api.github.com'])
    const headers: IncomingHttpHeaders = {
      authorization: `Bearer ${s}`,
      'x-api-key': s,
      'set-cookie': [`token=${s}; Path=/`, 'unrelated=1'],
      'user-agent': 'curl/8',
    }
    reg.substituteInHeaders(headers, 'api.github.com', any)
    expect(headers.authorization).toBe(`Bearer ${REAL_TOKEN}`)
    expect(headers['x-api-key']).toBe(REAL_TOKEN)
    expect(headers['set-cookie']).toEqual([
      `token=${REAL_TOKEN}; Path=/`,
      'unrelated=1',
    ])
    expect(headers['user-agent']).toBe('curl/8')
  })

  test('substituteInHeaders leaves headers without sentinels unchanged', () => {
    const reg = new SentinelRegistry()
    reg.register('GH_TOKEN', REAL_TOKEN, ['api.github.com'])
    const headers: IncomingHttpHeaders = { authorization: 'Bearer plain' }
    reg.substituteInHeaders(headers, 'api.github.com', any)
    expect(headers.authorization).toBe('Bearer plain')
  })

  test("a sentinel only substitutes at its own credential's injectHosts", () => {
    // Anti-laundering: sending GH_TOKEN's sentinel to NPM_TOKEN's host
    // must NOT swap in the GH secret.
    const reg = new SentinelRegistry()
    const gh = reg.register('GH_TOKEN', 'gh-secret', ['api.github.com'])
    const npm = reg.register('NPM_TOKEN', 'npm-secret', ['registry.npmjs.org'])

    const toNpm: IncomingHttpHeaders = { authorization: `Bearer ${gh}` }
    reg.substituteInHeaders(toNpm, 'registry.npmjs.org', eq)
    expect(toNpm.authorization).toBe(`Bearer ${gh}`)

    const toGh: IncomingHttpHeaders = { authorization: `Bearer ${npm}` }
    reg.substituteInHeaders(toGh, 'api.github.com', eq)
    expect(toGh.authorization).toBe(`Bearer ${npm}`)

    // Each credential does swap at its own host.
    const ghOwn: IncomingHttpHeaders = { authorization: `Bearer ${gh}` }
    reg.substituteInHeaders(ghOwn, 'api.github.com', eq)
    expect(ghOwn.authorization).toBe('Bearer gh-secret')

    const npmOwn: IncomingHttpHeaders = { authorization: `Bearer ${npm}` }
    reg.substituteInHeaders(npmOwn, 'registry.npmjs.org', eq)
    expect(npmOwn.authorization).toBe('Bearer npm-secret')
  })

  test('mixed sentinels in one request: only the host-matched one swaps', () => {
    const reg = new SentinelRegistry()
    const gh = reg.register('GH_TOKEN', 'gh-secret', ['api.github.com'])
    const npm = reg.register('NPM_TOKEN', 'npm-secret', ['registry.npmjs.org'])
    const headers: IncomingHttpHeaders = {
      authorization: `Bearer ${gh}`,
      'x-npm-token': npm,
    }
    reg.substituteInHeaders(headers, 'api.github.com', eq)
    expect(headers.authorization).toBe('Bearer gh-secret')
    expect(headers['x-npm-token']).toBe(npm)
  })
})

describe('macOS env preamble for masked credentials', () => {
  test('emits NAME=<sentinel> assignment and not the real value', () => {
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { allowOnly: ['/tmp'], denyWithinAllow: [] },
      setEnvVars: { GH_TOKEN: 'fake_value_test-sentinel' },
    })
    // shellquote escapes '=' so the env arg is GH_TOKEN\=fake_value_…
    expect(wrapped).toContain('GH_TOKEN\\=fake_value_test-sentinel')
    expect(wrapped.indexOf('GH_TOKEN')).toBeLessThan(
      wrapped.indexOf('sandbox-exec'),
    )
  })

  test('still sandboxes when masked env vars are the only restriction', () => {
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'echo hi',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: undefined,
      setEnvVars: { GH_TOKEN: 'fake_value_x' },
    })
    expect(wrapped).not.toBe('echo hi')
    expect(wrapped).toContain('GH_TOKEN\\=fake_value_x')
  })
})

/**
 * Proxy-level header injection: drive `createHttpProxyServer` directly
 * with a hand-built mutateHeaders, the same way SandboxManager wires it.
 * Reuses the tls-terminate-proxy.test.ts fixture pattern.
 */
describe('header injection through the TLS-terminating proxy', () => {
  const ca = createMitmCA({ caCertPath: CA_CERT, caKeyPath: CA_KEY })
  const reg = new SentinelRegistry()
  const sentinel = reg.register('GH_TOKEN', REAL_TOKEN, ['127.0.0.1'])

  let upstream: Server
  let upstreamPort: number
  let proxy: Server
  let proxyPort: number
  let lastHeaders: IncomingHttpHeaders | undefined

  beforeAll(async () => {
    const upCert = mintLeafCert(ca, '127.0.0.1')
    const upLeafOnly = upCert.certPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\r?\n?/,
    )![0]
    upstream = createHttpsServer(
      { cert: upLeafOnly, key: upCert.keyPem },
      (req, res) => {
        lastHeaders = req.headers
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      },
    )
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
    upstreamPort = (upstream.address() as AddressInfo).port

    proxy = createHttpProxyServer({
      filter: () => true,
      mitmCA: ca,
      tlsTerminateUpstreamCA: CA_PEM,
      // Per-sentinel host gating lives in the registry now; the closure
      // just forwards destHost.
      mutateHeaders: (headers, destHost) =>
        reg.substituteInHeaders(headers, destHost, eq),
    })
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()))
    proxyPort = (proxy.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>(r => proxy.close(() => r()))
    await new Promise<void>(r => upstream.close(() => r()))
    await disposeMitmCA(ca)
  })

  test('upstream receives the real value when the client sends the sentinel', async () => {
    lastHeaders = undefined
    const r = await curlViaProxy(
      proxyPort,
      `https://127.0.0.1:${upstreamPort}/`,
      { headers: ['Authorization: Bearer ' + sentinel] },
    )
    expect(r.exit).toBe(0)
    expect(r.status).toBe(200)
    expect(lastHeaders?.authorization).toBe(`Bearer ${REAL_TOKEN}`)
    // The real value never appears in anything the client (sandbox) sees.
    expect(r.body).not.toContain(REAL_TOKEN)
  })

  test('substitution covers arbitrary header names, not a fixed list', async () => {
    lastHeaders = undefined
    const r = await curlViaProxy(
      proxyPort,
      `https://127.0.0.1:${upstreamPort}/`,
      { headers: ['Private-Token: ' + sentinel] },
    )
    expect(r.exit).toBe(0)
    expect(lastHeaders?.['private-token']).toBe(REAL_TOKEN)
  })

  test('a non-matching destination receives the sentinel unchanged', async () => {
    // Same upstream server; mint a leaf for a second hostname that resolves
    // to 127.0.0.1 (curl --resolve) but is NOT in the injector's match set.
    const altCert = mintLeafCert(ca, 'localhost')
    const altLeaf = altCert.certPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\r?\n?/,
    )![0]
    const altUpstream = createHttpsServer(
      { cert: altLeaf, key: altCert.keyPem },
      (req, res) => {
        lastHeaders = req.headers
        res.writeHead(200)
        res.end('ok')
      },
    )
    await new Promise<void>(r => altUpstream.listen(0, '127.0.0.1', r))
    const altPort = (altUpstream.address() as AddressInfo).port
    try {
      lastHeaders = undefined
      const r = await curlViaProxy(proxyPort, `https://localhost:${altPort}/`, {
        headers: ['Authorization: Bearer ' + sentinel],
        resolve: `localhost:${altPort}:127.0.0.1`,
      })
      expect(r.exit).toBe(0)
      expect(r.status).toBe(200)
      // Fails closed: the upstream sees the useless fake.
      expect(lastHeaders?.authorization).toBe(`Bearer ${sentinel}`)
      expect(lastHeaders?.authorization).not.toContain(REAL_TOKEN)
    } finally {
      await new Promise<void>(r => altUpstream.close(() => r()))
    }
  })
})

describe('header injection on the plain-HTTP path', () => {
  const reg = new SentinelRegistry()
  const sentinel = reg.register('GH_TOKEN', REAL_TOKEN, ['127.0.0.1'])
  const mutate = (headers: IncomingHttpHeaders, destHost: string) =>
    reg.substituteInHeaders(headers, destHost, eq)

  let upstream: Server
  let upstreamPort: number
  let lastHeaders: IncomingHttpHeaders | undefined

  beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      lastHeaders = req.headers
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>(r => upstream.close(() => r()))
  })

  test('without mutateHeadersPlaintext the sentinel passes through unchanged', async () => {
    const proxy = createHttpProxyServer({
      filter: () => true,
      mutateHeaders: mutate,
    })
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()))
    const port = (proxy.address() as AddressInfo).port
    try {
      lastHeaders = undefined
      const r = await curlViaProxy(port, `http://127.0.0.1:${upstreamPort}/`, {
        headers: ['Authorization: Bearer ' + sentinel],
      })
      expect(r.exit).toBe(0)
      expect(lastHeaders?.authorization).toBe(`Bearer ${sentinel}`)
      expect(lastHeaders?.authorization).not.toContain(REAL_TOKEN)
    } finally {
      await new Promise<void>(r => proxy.close(() => r()))
    }
  })

  test('with mutateHeadersPlaintext the real value is substituted', async () => {
    const proxy = createHttpProxyServer({
      filter: () => true,
      mutateHeadersPlaintext: mutate,
    })
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', () => r()))
    const port = (proxy.address() as AddressInfo).port
    try {
      lastHeaders = undefined
      const r = await curlViaProxy(port, `http://127.0.0.1:${upstreamPort}/`, {
        headers: ['Authorization: Bearer ' + sentinel],
      })
      expect(r.exit).toBe(0)
      expect(lastHeaders?.authorization).toBe(`Bearer ${REAL_TOKEN}`)
    } finally {
      await new Promise<void>(r => proxy.close(() => r()))
    }
  })
})

/**
 * SandboxManager-level masking on Linux: the sandboxed process sees the
 * sentinel in its environment; the real value never appears in the wrapped
 * command string.
 */
describe.if(isLinux)('env masking on Linux (bwrap)', () => {
  const MASKED_VAR = 'SRT_TEST_MASKED_TOKEN'

  function baseConfig(
    overrides: Partial<SandboxRuntimeConfig> = {},
  ): SandboxRuntimeConfig {
    return {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
      ...overrides,
    }
  }

  beforeAll(async () => {
    process.env[MASKED_VAR] = REAL_TOKEN
    await SandboxManager.reset()
    await SandboxManager.initialize(
      baseConfig({
        // injectHosts is unused here (this block tests env-side masking
        // only); the credential defaults to allowedDomains.
        network: { allowedDomains: ['localhost'], deniedDomains: [] },
        credentials: {
          envVars: [{ name: MASKED_VAR, mode: 'mask' }],
          allowPlaintextInject: true,
        },
      }),
    )
  })

  afterAll(async () => {
    await SandboxManager.reset()
    delete process.env[MASKED_VAR]
  })

  test('bwrap argv sets the masked var to a sentinel', async () => {
    const wrapped = await SandboxManager.wrapWithSandbox('true')
    expect(wrapped).toMatch(
      new RegExp(`--setenv ${MASKED_VAR} ${SENTINEL_PREFIX}[0-9a-f-]{36}`),
    )
  })

  test('the real value never appears in the wrapped command string', async () => {
    const wrapped = await SandboxManager.wrapWithSandbox('true')
    expect(wrapped).not.toContain(REAL_TOKEN)
  })

  test('a masked env var that is unset on the host is skipped', async () => {
    await SandboxManager.reset()
    await SandboxManager.initialize(
      baseConfig({
        network: { allowedDomains: ['localhost'], deniedDomains: [] },
        credentials: {
          envVars: [{ name: 'SRT_TEST_NEVER_SET', mode: 'mask' }],
          allowPlaintextInject: true,
        },
      }),
    )
    const wrapped = await SandboxManager.wrapWithSandbox('true')
    expect(wrapped).not.toContain('--setenv SRT_TEST_NEVER_SET')

    // Restore the suite-level config for the remaining tests.
    await SandboxManager.reset()
    process.env[MASKED_VAR] = REAL_TOKEN
    await SandboxManager.initialize(
      baseConfig({
        network: { allowedDomains: ['localhost'], deniedDomains: [] },
        credentials: {
          envVars: [{ name: MASKED_VAR, mode: 'mask' }],
          allowPlaintextInject: true,
        },
      }),
    )
  })

  test('the sandboxed process sees the sentinel, not the real value', async () => {
    const wrapped = await SandboxManager.wrapWithSandbox(
      `printenv ${MASKED_VAR}`,
    )
    const result = spawnSync(wrapped, {
      shell: true,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, [MASKED_VAR]: REAL_TOKEN },
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().startsWith(SENTINEL_PREFIX)).toBe(true)
    expect(result.stdout).not.toContain(REAL_TOKEN)
  })

  test('reset clears the sentinel registry', async () => {
    expect(SandboxManager.getSentinelRegistry().size).toBeGreaterThan(0)
    await SandboxManager.reset()
    expect(SandboxManager.getSentinelRegistry().size).toBe(0)
    // Re-initialize for any following tests.
    process.env[MASKED_VAR] = REAL_TOKEN
    await SandboxManager.initialize(
      baseConfig({
        network: { allowedDomains: ['localhost'], deniedDomains: [] },
        credentials: {
          envVars: [{ name: MASKED_VAR, mode: 'mask' }],
          allowPlaintextInject: true,
        },
      }),
    )
  })
})

/**
 * SandboxManager-level wiring: initialize() builds the injector and wires
 * it into the proxy it starts; wrapWithSandbox() registers the sentinel.
 * Verified by talking to SandboxManager's own proxy port. The bwrap leg
 * (sandbox sees the sentinel) is covered by the previous describe; the
 * TLS leg by the createHttpProxyServer describe. Uses allowPlaintextInject
 * so the upstream doesn't need a system-trusted cert.
 */
describe.if(isLinux)('end-to-end credential masking via SandboxManager', () => {
  const MASKED_VAR = 'SRT_TEST_E2E_TOKEN'
  let upstream: Server
  let upstreamPort: number
  let lastHeaders: IncomingHttpHeaders | undefined

  beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      lastHeaders = req.headers
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()))
    upstreamPort = (upstream.address() as AddressInfo).port

    process.env[MASKED_VAR] = REAL_TOKEN
    await SandboxManager.reset()
    await SandboxManager.initialize({
      network: { allowedDomains: ['localhost'], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
      credentials: {
        envVars: [
          { name: MASKED_VAR, mode: 'mask', injectHosts: ['localhost'] },
        ],
        allowPlaintextInject: true,
      },
    })
  })

  afterAll(async () => {
    await SandboxManager.reset()
    delete process.env[MASKED_VAR]
    await new Promise<void>(r => upstream.close(() => r()))
  })

  test('the manager-started proxy substitutes sentinel→real for an injectHost', async () => {
    // wrapWithSandbox registers the sentinel as a side effect.
    const wrapped = await SandboxManager.wrapWithSandbox(
      `printenv ${MASKED_VAR}`,
    )
    expect(wrapped).not.toContain(REAL_TOKEN)
    const sentinel = [...SandboxManager.getSentinelRegistry().entries()].find(
      ([, real]) => real === REAL_TOKEN,
    )?.[0]
    expect(sentinel?.startsWith(SENTINEL_PREFIX)).toBe(true)

    // The sandbox itself reads the sentinel.
    const inSandbox = spawnSync(wrapped, {
      shell: true,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, [MASKED_VAR]: REAL_TOKEN },
    })
    expect(inSandbox.stdout.trim()).toBe(sentinel)

    // A request carrying the sentinel through SandboxManager's proxy
    // reaches the upstream with the real value.
    const proxyPort = SandboxManager.getProxyPort()!
    const authToken = SandboxManager.getProxyAuthToken()!
    lastHeaders = undefined
    const r = await curlViaProxy(
      proxyPort,
      `http://localhost:${upstreamPort}/`,
      {
        headers: ['Authorization: Bearer ' + sentinel],
        proxyAuth: `srt:${authToken}`,
      },
    )
    expect(r.exit).toBe(0)
    expect(r.status).toBe(200)
    expect(lastHeaders?.authorization).toBe(`Bearer ${REAL_TOKEN}`)
  }, 20000)

  test('a non-injectHost destination through the manager proxy receives the sentinel', async () => {
    // Reconfigure with an injectHosts that does NOT cover localhost.
    await SandboxManager.reset()
    process.env[MASKED_VAR] = REAL_TOKEN
    await SandboxManager.initialize({
      network: {
        allowedDomains: ['localhost', 'api.github.com'],
        deniedDomains: [],
      },
      filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
      credentials: {
        envVars: [
          { name: MASKED_VAR, mode: 'mask', injectHosts: ['api.github.com'] },
        ],
        allowPlaintextInject: true,
      },
    })
    await SandboxManager.wrapWithSandbox('true')
    const sentinel = [...SandboxManager.getSentinelRegistry().entries()].find(
      ([, real]) => real === REAL_TOKEN,
    )?.[0]

    const proxyPort = SandboxManager.getProxyPort()!
    const authToken = SandboxManager.getProxyAuthToken()!
    lastHeaders = undefined
    const r = await curlViaProxy(
      proxyPort,
      `http://localhost:${upstreamPort}/`,
      {
        headers: ['Authorization: Bearer ' + sentinel],
        proxyAuth: `srt:${authToken}`,
      },
    )
    expect(r.exit).toBe(0)
    expect(lastHeaders?.authorization).toBe(`Bearer ${sentinel}`)
    expect(lastHeaders?.authorization).not.toContain(REAL_TOKEN)
  }, 20000)
})

/**
 * Per-credential injectHosts through SandboxManager: GH_TOKEN and NPM_TOKEN
 * each declare their own per-entry injectHosts. Each sentinel only swaps at
 * its own credential's injectHosts — sending GH_TOKEN's sentinel to
 * NPM_TOKEN's host (or vice versa) must NOT substitute, even though both
 * hosts are allowlisted.
 */
describe.if(isLinux)('per-credential injectHosts via SandboxManager', () => {
  const GH_VAR = 'SRT_TEST_GH_TOKEN'
  const NPM_VAR = 'SRT_TEST_NPM_TOKEN'
  const GH_REAL = 'gh-real-secret'
  const NPM_REAL = 'npm-real-secret'

  // Two upstreams, two hostnames that both resolve to 127.0.0.1: the
  // proxy distinguishes them by the absolute-URI host on the plain-HTTP
  // path, which is what destHost gating sees.
  const GH_HOST = 'localhost'
  const NPM_HOST = 'localtest.me'

  let ghUp: Server, ghPort: number, ghHeaders: IncomingHttpHeaders | undefined
  let npmUp: Server,
    npmPort: number,
    npmHeaders: IncomingHttpHeaders | undefined
  let ghSentinel: string, npmSentinel: string
  let proxyPort: number, authToken: string

  beforeAll(async () => {
    ghUp = createHttpServer((req, res) => {
      ghHeaders = req.headers
      res.writeHead(200)
      res.end('ok')
    })
    npmUp = createHttpServer((req, res) => {
      npmHeaders = req.headers
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>(r => ghUp.listen(0, '127.0.0.1', () => r()))
    await new Promise<void>(r => npmUp.listen(0, '127.0.0.1', () => r()))
    ghPort = (ghUp.address() as AddressInfo).port
    npmPort = (npmUp.address() as AddressInfo).port

    process.env[GH_VAR] = GH_REAL
    process.env[NPM_VAR] = NPM_REAL
    await SandboxManager.reset()
    await SandboxManager.initialize({
      network: { allowedDomains: [GH_HOST, NPM_HOST], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
      credentials: {
        // Each credential narrows to its own host via per-entry injectHosts.
        envVars: [
          { name: GH_VAR, mode: 'mask', injectHosts: [GH_HOST] },
          { name: NPM_VAR, mode: 'mask', injectHosts: [NPM_HOST] },
        ],
        allowPlaintextInject: true,
      },
    })
    await SandboxManager.wrapWithSandbox('true')
    const reg = SandboxManager.getSentinelRegistry()
    ghSentinel = [...reg.entries()].find(([, r]) => r === GH_REAL)![0]
    npmSentinel = [...reg.entries()].find(([, r]) => r === NPM_REAL)![0]
    proxyPort = SandboxManager.getProxyPort()!
    authToken = SandboxManager.getProxyAuthToken()!
  })

  afterAll(async () => {
    await SandboxManager.reset()
    delete process.env[GH_VAR]
    delete process.env[NPM_VAR]
    await new Promise<void>(r => ghUp.close(() => r()))
    await new Promise<void>(r => npmUp.close(() => r()))
  })

  test('two masked vars register two distinct sentinels', () => {
    expect(ghSentinel).not.toBe(npmSentinel)
    expect(SandboxManager.getSentinelRegistry().size).toBe(2)
  })

  test('GH sentinel swaps at its own per-entry injectHost', async () => {
    ghHeaders = undefined
    const r = await curlViaProxy(proxyPort, `http://${GH_HOST}:${ghPort}/`, {
      headers: ['Authorization: Bearer ' + ghSentinel],
      proxyAuth: `srt:${authToken}`,
    })
    expect(r.exit).toBe(0)
    expect(ghHeaders?.authorization).toBe(`Bearer ${GH_REAL}`)
  }, 20000)

  test('NPM sentinel swaps only at its own per-entry injectHost', async () => {
    npmHeaders = undefined
    const r = await curlViaProxy(proxyPort, `http://${NPM_HOST}:${npmPort}/`, {
      headers: ['Authorization: Bearer ' + npmSentinel],
      proxyAuth: `srt:${authToken}`,
      resolve: `${NPM_HOST}:${npmPort}:127.0.0.1`,
    })
    expect(r.exit).toBe(0)
    expect(npmHeaders?.authorization).toBe(`Bearer ${NPM_REAL}`)

    // Per-entry injectHosts is exclusive: NPM's sentinel sent to GH_HOST
    // (not in NPM's list) stays a fake.
    ghHeaders = undefined
    const r2 = await curlViaProxy(proxyPort, `http://${GH_HOST}:${ghPort}/`, {
      headers: ['Authorization: Bearer ' + npmSentinel],
      proxyAuth: `srt:${authToken}`,
    })
    expect(r2.exit).toBe(0)
    expect(ghHeaders?.authorization).toBe(`Bearer ${npmSentinel}`)
    expect(ghHeaders?.authorization).not.toContain(NPM_REAL)
  }, 20000)

  test("anti-laundering: GH sentinel sent to NPM's host is not swapped", async () => {
    npmHeaders = undefined
    const r = await curlViaProxy(proxyPort, `http://${NPM_HOST}:${npmPort}/`, {
      headers: ['Authorization: Bearer ' + ghSentinel],
      proxyAuth: `srt:${authToken}`,
      resolve: `${NPM_HOST}:${npmPort}:127.0.0.1`,
    })
    expect(r.exit).toBe(0)
    expect(npmHeaders?.authorization).toBe(`Bearer ${ghSentinel}`)
    expect(npmHeaders?.authorization).not.toContain(GH_REAL)
  }, 20000)
})

/**
 * No per-entry injectHosts → defaults to network.allowedDomains.
 * injectHosts is an optional narrowing; absent it, the credential is
 * injectable at *every* host the sandbox can reach. The second test
 * makes the security implication explicit.
 */
describe.if(isLinux)(
  'injectHosts defaults to allowedDomains via SandboxManager',
  () => {
    const VAR = 'SRT_TEST_DEFAULT_TOKEN'
    const REAL = 'default-real-secret'
    const HOST_A = 'localhost'
    const HOST_B = 'localtest.me'

    let upA: Server, portA: number, hdrA: IncomingHttpHeaders | undefined
    let upB: Server, portB: number, hdrB: IncomingHttpHeaders | undefined

    beforeAll(async () => {
      upA = createHttpServer((req, res) => {
        hdrA = req.headers
        res.writeHead(200)
        res.end('ok')
      })
      upB = createHttpServer((req, res) => {
        hdrB = req.headers
        res.writeHead(200)
        res.end('ok')
      })
      await new Promise<void>(r => upA.listen(0, '127.0.0.1', () => r()))
      await new Promise<void>(r => upB.listen(0, '127.0.0.1', () => r()))
      portA = (upA.address() as AddressInfo).port
      portB = (upB.address() as AddressInfo).port
    })

    afterAll(async () => {
      await SandboxManager.reset()
      delete process.env[VAR]
      await new Promise<void>(r => upA.close(() => r()))
      await new Promise<void>(r => upB.close(() => r()))
    })

    test('with no injectHosts, sentinel swaps at the sole allowedDomain', async () => {
      process.env[VAR] = REAL
      await SandboxManager.reset()
      await SandboxManager.initialize({
        network: { allowedDomains: [HOST_A], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
        credentials: {
          envVars: [{ name: VAR, mode: 'mask' }],
          // No per-entry injectHosts → defaults to allowedDomains.
          allowPlaintextInject: true,
        },
      })
      await SandboxManager.wrapWithSandbox('true')
      const sentinel = [...SandboxManager.getSentinelRegistry().entries()].find(
        ([, r]) => r === REAL,
      )![0]
      const proxyPort = SandboxManager.getProxyPort()!
      const authToken = SandboxManager.getProxyAuthToken()!

      hdrA = undefined
      const r = await curlViaProxy(proxyPort, `http://${HOST_A}:${portA}/`, {
        headers: ['Authorization: Bearer ' + sentinel],
        proxyAuth: `srt:${authToken}`,
      })
      expect(r.exit).toBe(0)
      expect(hdrA?.authorization).toBe(`Bearer ${REAL}`)
    }, 20000)

    test('without injectHosts, credential is injected at every allowedDomain', async () => {
      // Security trade-off made explicit: two reachable hosts, no
      // narrowing → the real value goes to BOTH. A credential intended
      // for one host must set injectHosts to keep it from the other.
      process.env[VAR] = REAL
      await SandboxManager.reset()
      await SandboxManager.initialize({
        network: { allowedDomains: [HOST_A, HOST_B], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
        credentials: {
          envVars: [{ name: VAR, mode: 'mask' }],
          allowPlaintextInject: true,
        },
      })
      await SandboxManager.wrapWithSandbox('true')
      const sentinel = [...SandboxManager.getSentinelRegistry().entries()].find(
        ([, r]) => r === REAL,
      )![0]
      const proxyPort = SandboxManager.getProxyPort()!
      const authToken = SandboxManager.getProxyAuthToken()!

      hdrA = undefined
      const ra = await curlViaProxy(proxyPort, `http://${HOST_A}:${portA}/`, {
        headers: ['Authorization: Bearer ' + sentinel],
        proxyAuth: `srt:${authToken}`,
      })
      expect(ra.exit).toBe(0)
      expect(hdrA?.authorization).toBe(`Bearer ${REAL}`)

      hdrB = undefined
      const rb = await curlViaProxy(proxyPort, `http://${HOST_B}:${portB}/`, {
        headers: ['Authorization: Bearer ' + sentinel],
        proxyAuth: `srt:${authToken}`,
        resolve: `${HOST_B}:${portB}:127.0.0.1`,
      })
      expect(rb.exit).toBe(0)
      expect(hdrB?.authorization).toBe(`Bearer ${REAL}`)
    }, 20000)
  },
)

type CurlResult = {
  exit: number
  status: number
  body: string
}

async function curlViaProxy(
  proxyPort: number,
  url: string,
  opts: { headers?: string[]; resolve?: string; proxyAuth?: string } = {},
): Promise<CurlResult> {
  const auth = opts.proxyAuth ? `${opts.proxyAuth}@` : ''
  const args = [
    '-sS',
    '--proxy',
    `http://${auth}127.0.0.1:${proxyPort}`,
    '--max-time',
    '10',
    '-D',
    '-',
  ]
  if (url.startsWith('https://')) args.push('--cacert', CA_CERT)
  for (const h of opts.headers ?? []) args.push('-H', h)
  if (opts.resolve) args.push('--resolve', opts.resolve)
  args.push(url)

  const child = spawn('curl', args)
  let out = ''
  child.stdout.setEncoding('utf8').on('data', c => (out += c))
  child.stderr.setEncoding('utf8').on('data', () => {})
  await Promise.all([
    new Promise<void>(r => child.stdout.once('end', r)),
    new Promise<void>(r => child.stderr.once('end', r)),
  ])
  const exit = await new Promise<number>(r =>
    child.on('close', code => r(code ?? 1)),
  )

  const sep = out.lastIndexOf('\r\n\r\n')
  const headerPart = sep >= 0 ? out.slice(0, sep) : ''
  const body = sep >= 0 ? out.slice(sep + 4) : out
  const blocks = headerPart.split(/\r\n\r\n/)
  const lastHdr = blocks[blocks.length - 1] ?? ''
  const m = /HTTP\/[\d.]+ (\d+)/.exec(lastHdr)
  const status = m ? Number(m[1]) : 0
  return { exit, status, body }
}
