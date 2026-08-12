import {
  createHttpProxyServer,
  destroyTrackedHttpProxyConnections,
} from './http-proxy.js'
import { createSocksProxyServer } from './socks-proxy.js'
import type { SocksProxyWrapper } from './socks-proxy.js'
import { SentinelRegistry } from './credential-sentinel.js'
import { createMitmCA, disposeMitmCA, type MitmCA } from './mitm-ca.js'
import { logForDebugging } from '../utils/debug.js'
import { whichSync } from '../utils/which.js'
import { getPlatform, getWslVersion } from '../utils/platform.js'
import * as fs from 'fs'
import { randomBytes } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { dirname, join } from 'node:path'
import type {
  CredentialsConfig,
  NetworkConfig,
  SandboxRuntimeConfig,
  SeccompConfig,
} from './sandbox-config.js'
import type {
  SandboxAskCallback,
  CredentialRestrictionConfig,
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  NetworkRestrictionConfig,
} from './sandbox-schemas.js'
import {
  wrapCommandWithSandboxLinux,
  initializeLinuxNetworkBridge,
  type LinuxNetworkBridgeContext,
  checkLinuxDependencies,
  type SandboxDependencyCheck,
  cleanupBwrapMountPoints,
  stopLinuxBridgeProcess,
} from './linux-sandbox-utils.js'
import {
  wrapCommandWithSandboxMacOS,
  startMacOSSandboxLogMonitor,
} from './macos-sandbox-utils.js'
import {
  checkWindowsDependencies,
  wrapCommandWithSandboxWindows,
  parseWindowsBinShell,
  DEFAULT_WINDOWS_GROUP_NAME,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  type WindowsGroupRef,
} from './windows-sandbox-utils.js'
import {
  getDefaultWritePaths,
  containsGlobChars,
  removeTrailingGlobSuffix,
  expandGlobPattern,
} from './sandbox-utils.js'
import { SandboxViolationStore } from './sandbox-violation-store.js'
import type {
  FilterRequestCallback,
  MutateForwardedHeaders,
  RequestDecision,
} from './request-filter.js'
import {
  canonicalizeHost,
  isValidHost,
  redactUrl,
  resolveParentProxy,
} from './parent-proxy.js'
import { matchesDomainPattern } from './domain-pattern.js'
import type { ResolvedParentProxy } from './parent-proxy.js'
import { EOL } from 'node:os'
import {
  resetDestinationGuardConnections,
  type ResolveDestination,
} from './destination-dial.js'
import {
  EndpointLeaseRegistry,
  type EndpointLease,
} from './endpoint-lease-registry.js'

interface HostNetworkManagerContext {
  httpProxyPort: number
  socksProxyPort: number
  linuxBridge: LinuxNetworkBridgeContext | undefined
}

export interface LaunchAuthorityOptions {
  readonly command: string
  readonly binShell?: string
  readonly abortSignal?: AbortSignal
  readonly endpointRegistryPath: string
}

export interface PreparedLaunchAuthority {
  readonly argv: string[]
  readonly env: NodeJS.ProcessEnv
  cleanup(): Promise<void>
}

interface LaunchAuthorityState {
  readonly generationId: string
  readonly managerContext: HostNetworkManagerContext
  readonly httpProxyServer: ReturnType<typeof createHttpProxyServer>
  readonly socksProxyServer: SocksProxyWrapper
  readonly mitmCA: MitmCA | undefined
  readonly sentinelRegistry: SentinelRegistry
  readonly leaseRegistry: EndpointLeaseRegistry
  readonly lease: EndpointLease
  readonly abortController: AbortController
  readonly readiness: { active: boolean }
  cleanupPromise?: Promise<void>
}

export const LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS = 2_000

export function settleLaunchAuthorityDrain(
  operations: readonly Promise<unknown>[],
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (clean: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(clean)
    }
    const timer = setTimeout(
      () => finish(false),
      LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS,
    )
    timer.unref?.()
    void Promise.allSettled(operations).then(results =>
      finish(results.every(result => result.status === 'fulfilled')),
    )
  })
}

// ============================================================================
// Private Module State
// ============================================================================

let config: SandboxRuntimeConfig | undefined
let httpProxyServer: ReturnType<typeof createHttpProxyServer> | undefined
let socksProxyServer: SocksProxyWrapper | undefined
let managerContext: HostNetworkManagerContext | undefined
let initializationPromise: Promise<HostNetworkManagerContext> | undefined
let cleanupRegistered = false
let logMonitorShutdown: (() => void) | undefined
let parentProxy: ResolvedParentProxy | undefined
let mitmCA: MitmCA | undefined
// Connect-time authority is captured only by initialize(). Live profile
// updates may change name policy but cannot replace or remove this resolver.
let destinationResolver: ResolveDestination | undefined
// Per-session proxy auth token. Generated at proxy start, exported only into
// the sandbox child env, checked on every CONNECT/request — so a host process
// dialing 127.0.0.1:<proxyPort> can't reach the filter callback.
let proxyAuthToken: string | undefined
const sandboxViolationStore = new SandboxViolationStore()
// Per-session sentinel↔real-value map for masked credentials. Lives only in
// process memory; never written to disk or logged. Cleared on reset().
const sentinelRegistry = new SentinelRegistry()
const activeLaunchAuthorities = new Set<LaunchAuthorityState>()
let launchAuthorityRegistry: EndpointLeaseRegistry | undefined
let launchAuthorityRegistryPath: string | undefined
let launchAuthorityGenerationId: string | undefined
let launchLifecycleTail: Promise<void> = Promise.resolve()
let launchResetPromise: Promise<void> | undefined
let launchAuthorityAccepting = false
let launchAuthorityEpoch = 0
const LAUNCH_PROXY_PORT_RANGE = [40000, 65535] as const
const PROXY_ENVIRONMENT_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'RSYNC_PROXY',
  'GRPC_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'ftp_proxy',
  'grpc_proxy',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_USERNAME',
  'CLOUDSDK_PROXY_PASSWORD',
  'GIT_CONFIG_PARAMETERS',
  'GIT_SSH_COMMAND',
  'CLAUDE_CODE_HOST_HTTP_PROXY_PORT',
  'CLAUDE_CODE_HOST_SOCKS_PROXY_PORT',
] as const

// ============================================================================
// Private Helper Functions (not exported)
// ============================================================================

function assertDestinationGuardRoutesCompatible(network: NetworkConfig): void {
  const incompatible = [
    network.parentProxy === undefined ? undefined : 'parentProxy',
    network.mitmProxy === undefined ? undefined : 'mitmProxy',
    network.httpProxyPort === undefined ? undefined : 'httpProxyPort',
    network.socksProxyPort === undefined ? undefined : 'socksProxyPort',
  ].filter((name): name is string => name !== undefined)
  if (incompatible.length > 0) {
    throw new Error(
      `network.${incompatible.join(', network.')} is incompatible with network.resolveDestination`,
    )
  }
}

function registerCleanup(): void {
  if (cleanupRegistered) {
    return
  }
  const cleanupHandler = () =>
    reset().catch(e => {
      logForDebugging(`Cleanup failed in registerCleanup ${e}`, {
        level: 'error',
      })
    })
  process.once('exit', cleanupHandler)
  process.once('SIGINT', cleanupHandler)
  process.once('SIGTERM', cleanupHandler)
  cleanupRegistered = true
}

async function filterNetworkRequest(
  port: number,
  host: string,
  sandboxAskCallback?: SandboxAskCallback,
): Promise<boolean> {
  if (!config) {
    logForDebugging('No config available, denying network request')
    return false
  }
  return filterNetworkRequestForConfig(
    config,
    port,
    host,
    sandboxAskCallback,
  )
}

async function filterNetworkRequestForConfig(
  runtimeConfig: Pick<SandboxRuntimeConfig, 'network'>,
  port: number,
  host: string,
  sandboxAskCallback?: SandboxAskCallback,
  denyInternalEndpoint?: (host: string, port: number) => boolean,
): Promise<boolean> {

  // Reject hosts containing control characters before pattern matching.
  // `matchesDomainPattern` uses string suffix matching which is trivially
  // fooled by e.g. `evil.com\x00.allowed.com` — the null byte passes
  // `.endsWith()` but truncates at the libc DNS layer. The SOCKS path is the
  // main exposure (DOMAINNAME is unvalidated bytes); HTTP is protected by
  // llhttp/URL parsing, but we check here for defence in depth.
  if (!isValidHost(host)) {
    logForDebugging(`Denying malformed host: ${JSON.stringify(host)}:${port}`, {
      level: 'error',
    })
    return false
  }

  if (denyInternalEndpoint?.(host, port) === true) {
    logForDebugging(`Denying internal proxy endpoint: ${host}:${port}`, {
      level: 'error',
    })
    return false
  }

  // Check denied domains first
  for (const deniedDomain of runtimeConfig.network.deniedDomains) {
    if (matchesDomainPattern(host, deniedDomain)) {
      logForDebugging(`Denied by config rule: ${host}:${port}`)
      return false
    }
  }

  // Check allowed domains
  for (const allowedDomain of runtimeConfig.network.allowedDomains) {
    if (matchesDomainPattern(host, allowedDomain)) {
      logForDebugging(`Allowed by config rule: ${host}:${port}`)
      return true
    }
  }

  // No matching rules - ask user or deny. strictAllowlist makes the
  // allowlist deterministic enforcement: never fall through to the callback.
  if (!sandboxAskCallback || runtimeConfig.network.strictAllowlist) {
    logForDebugging(`No matching config rule, denying: ${host}:${port}`)
    return false
  }

  logForDebugging(`No matching config rule, asking user: ${host}:${port}`)
  try {
    const userAllowed = await sandboxAskCallback({ host, port })
    if (userAllowed) {
      logForDebugging(`User allowed: ${host}:${port}`)
      return true
    } else {
      logForDebugging(`User denied: ${host}:${port}`)
      return false
    }
  } catch (error) {
    logForDebugging(`Error in permission callback: ${error}`, {
      level: 'error',
    })
    return false
  }
}

/**
 * Get the MITM proxy socket path for a given host, if configured.
 * Returns the socket path if the host matches any MITM domain pattern,
 * otherwise returns undefined.
 */
/**
 * Build the header-mutation callback that substitutes sentinel→real for
 * masked credentials. Returns undefined when no `credentials` block is
 * configured — wiring the seam at all is unnecessary then.
 *
 * Per-host gating happens inside the registry: each sentinel carries its
 * own injectHosts list and substitutes independently, so credential A's
 * sentinel cannot be laundered through credential B's allowed host. The
 * returned closure does not log header values; the registry holds the only
 * copy of the real value.
 */
function buildCredentialInjector(options: {
  requirePlaintextOptIn?: boolean
} = {}): MutateForwardedHeaders {
  return buildCredentialInjectorForConfig(config, sentinelRegistry, options)
}

function buildCredentialInjectorForConfig(
  runtimeConfig: SandboxRuntimeConfig | undefined,
  launchSentinelRegistry: SentinelRegistry,
  options: { requirePlaintextOptIn?: boolean } = {},
): MutateForwardedHeaders {
  return (headers, destHost) => {
    const credentials = runtimeConfig?.credentials
    if (!credentials) return
    if (options.requirePlaintextOptIn && !credentials.allowPlaintextInject) {
      return
    }
    launchSentinelRegistry.substituteInHeaders(
      headers,
      destHost,
      matchesDomainPattern,
    )
    substituteAuthorizationPlaceholder(headers, destHost, credentials)
    injectAuthorizationHeaderCredentials(headers, destHost, credentials)
  }
}

const CREDENTIAL_PLACEHOLDER_PREFIX = 'keelcred_'

function firstHeaderValue(value: IncomingHttpHeaders[string]): string | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value[0] : value
}

function hasHeader(headers: IncomingHttpHeaders, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some(k => k.toLowerCase() === lower)
}

function authorizationHeaderValue(
  headers: IncomingHttpHeaders,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue
    return firstHeaderValue(value)
  }
  return undefined
}

function parsePlaceholderAuthorization(
  authorization: string | undefined,
): { scheme: string; placeholder: string } | undefined {
  const match = /^([A-Za-z][A-Za-z0-9._~-]*)\s+(\S+)\s*$/.exec(
    authorization ?? '',
  )
  if (!match) return undefined
  const placeholder = match[2]!
  if (!placeholder.startsWith(CREDENTIAL_PLACEHOLDER_PREFIX)) return undefined
  return { scheme: match[1]!, placeholder }
}

function findAuthorizationPlaceholderCredential(
  credentials: CredentialsConfig | undefined,
  placeholder: string,
) {
  return (credentials?.authorizationPlaceholders ?? []).find(
    credential => credential.placeholder === placeholder,
  )
}

function credentialPlaceholderDecision(
  authorization: string | undefined,
  destHost: string,
  credentials: CredentialsConfig | undefined,
): RequestDecision | undefined {
  const parsed = parsePlaceholderAuthorization(authorization)
  if (!parsed) return undefined
  const credential = findAuthorizationPlaceholderCredential(
    credentials,
    parsed.placeholder,
  )
  if (!credential) {
    return {
      action: 'deny',
      reason: 'credential placeholder is unknown',
    }
  }
  if (
    parsed.scheme !== credential.scheme ||
    !matchesDomainPattern(destHost, credential.host)
  ) {
    return {
      action: 'deny',
      reason: 'credential placeholder is not valid for this destination',
    }
  }
  return undefined
}

function substituteAuthorizationPlaceholder(
  headers: IncomingHttpHeaders,
  destHost: string,
  credentials: CredentialsConfig,
): void {
  const parsed = parsePlaceholderAuthorization(authorizationHeaderValue(headers))
  if (!parsed) return
  const credential = findAuthorizationPlaceholderCredential(
    credentials,
    parsed.placeholder,
  )
  if (
    !credential ||
    parsed.scheme !== credential.scheme ||
    !matchesDomainPattern(destHost, credential.host)
  ) {
    return
  }
  headers.authorization = `${credential.scheme} ${credential.value}`
}

function injectAuthorizationHeaderCredentials(
  headers: IncomingHttpHeaders,
  destHost: string,
  credentials: CredentialsConfig,
): void {
  if (hasHeader(headers, 'authorization')) return
  for (const credential of credentials.authorizationHeaders ?? []) {
    if (!matchesDomainPattern(destHost, credential.host)) continue
    headers.authorization = `${credential.scheme} ${credential.value}`
    return
  }
}

function buildRequestFilter(): FilterRequestCallback {
  return buildRequestFilterForConfig(config)
}

function buildRequestFilterForConfig(
  runtimeConfig: SandboxRuntimeConfig | undefined,
): FilterRequestCallback {
  return async request => {
    const decision = credentialPlaceholderDecision(
      request.headers.get('authorization') ?? undefined,
      new URL(request.url).hostname,
      runtimeConfig?.credentials,
    )
    if (decision) return decision
    return runtimeConfig?.network.filterRequest?.(request) ?? { action: 'allow' }
  }
}

function getMitmSocketPath(host: string): string | undefined {
  return getMitmSocketPathForConfig(config, host)
}

function getMitmSocketPathForConfig(
  runtimeConfig: SandboxRuntimeConfig | undefined,
  host: string,
): string | undefined {
  if (!runtimeConfig?.network.mitmProxy) {
    return undefined
  }

  const { socketPath, domains } = runtimeConfig.network.mitmProxy

  for (const pattern of domains) {
    if (matchesDomainPattern(host, pattern)) {
      logForDebugging(`Host ${host} matches MITM pattern ${pattern}`)
      return socketPath
    }
  }

  return undefined
}

/**
 * Bind `server.listen()` to the first free port in `[lo, hi]`,
 * skipping `EADDRINUSE`. With `range` undefined, binds to ephemeral
 * port 0 (the previous behaviour).
 *
 * Used on Windows: the WFP loopback permit only covers a fixed port
 * range (default 60080–60089), so the JS proxies must bind inside it
 * for the sandboxed child to reach them. On other platforms the
 * sandbox layer (seatbelt rule, namespace+socat) targets whatever
 * port we landed on, so ephemeral is fine.
 */
function listenInRange(
  server: {
    once(ev: 'error' | 'listening', cb: (e?: Error) => void): unknown
    removeListener(ev: 'error' | 'listening', cb: (e?: Error) => void): unknown
  },
  doListen: (port: number) => void,
  range: readonly [number, number] | undefined,
  exclude: ReadonlySet<number>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [lo, hi] = range ?? [0, 0]
    let port = lo
    const tryNext = (): void => {
      while (exclude.has(port) && port <= hi) port++
      if (port > hi) {
        reject(
          new Error(
            `No free port in range ${lo}-${hi} (excluding ${[...exclude].join(',')})`,
          ),
        )
        return
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      const onError = (err?: Error): void => {
        // The paired 'listening' once-listener never fired; drop it
        // so retries don't accumulate stale listeners.
        server.removeListener('listening', onListening)
        if (
          range &&
          (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE' &&
          port < hi
        ) {
          port++
          tryNext()
          return
        }
        reject(err ?? new Error('listen error'))
      }
      server.once('error', onError)
      server.once('listening', onListening)
      doListen(range ? port : 0)
    }
    tryNext()
  })
}

async function startHttpProxyServer(
  sandboxAskCallback: SandboxAskCallback | undefined,
  portRange: readonly [number, number] | undefined,
  excludePorts: ReadonlySet<number>,
): Promise<number> {
  const injectCredentials = buildCredentialInjector()
  const injectPlaintextCredentials = buildCredentialInjector({
    requirePlaintextOptIn: true,
  })
  httpProxyServer = createHttpProxyServer({
    filter: (port: number, host: string) =>
      filterNetworkRequest(port, host, sandboxAskCallback),
    getMitmSocketPath,
    mitmCA,
    filterRequest: buildRequestFilter(),
    // TLS-terminated path always gets the injector; the plain-HTTP path
    // only when explicitly opted in. Without the opt-in, a sentinel sent
    // over plain HTTP reaches the upstream unchanged (fails closed).
    mutateHeaders: injectCredentials,
    mutateHeadersPlaintext: injectPlaintextCredentials,
    parentProxy,
    resolveDestination: destinationResolver,
    proxyAuthToken,
  })

  const server = httpProxyServer
  await listenInRange(
    server,
    p => server.listen(p, '127.0.0.1'),
    portRange,
    excludePorts,
  )
  const address = server.address()
  if (!address || typeof address !== 'object') {
    throw new Error('Failed to get HTTP proxy server address')
  }
  server.unref()
  logForDebugging(`HTTP proxy listening on localhost:${address.port}`)
  return address.port
}

async function startSocksProxyServer(
  sandboxAskCallback: SandboxAskCallback | undefined,
  portRange: readonly [number, number] | undefined,
  excludePorts: ReadonlySet<number>,
): Promise<number> {
  socksProxyServer = createSocksProxyServer({
    filter: (port: number, host: string) =>
      filterNetworkRequest(port, host, sandboxAskCallback),
    parentProxy,
    resolveDestination: destinationResolver,
    proxyAuthToken,
  })

  const wrapper = socksProxyServer
  // SocksProxyWrapper.listen() resolves with the bound port; we
  // adapt it to the listenInRange shape by retrying on EADDRINUSE
  // here directly rather than via the once('error') path.
  if (!portRange) {
    const port = await wrapper.listen(0, '127.0.0.1')
    wrapper.unref()
    return port
  }
  let lastErr: unknown
  for (let p = portRange[0]; p <= portRange[1]; p++) {
    if (excludePorts.has(p)) continue
    try {
      const port = await wrapper.listen(p, '127.0.0.1')
      wrapper.unref()
      return port
    } catch (err) {
      lastErr = err
      if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err
    }
  }
  throw new Error(
    `No free SOCKS port in range ${portRange[0]}-${portRange[1]}: ${
      (lastErr as Error)?.message ?? 'all in use'
    }`,
  )
}

function cloneRuntimeConfigForLaunch(
  runtimeConfig: SandboxRuntimeConfig,
): SandboxRuntimeConfig {
  const { filterRequest, resolveDestination, ...networkRest } =
    runtimeConfig.network
  const cloned = structuredClone({
    ...runtimeConfig,
    network: networkRest,
  }) as SandboxRuntimeConfig
  cloned.network.filterRequest = filterRequest
  cloned.network.resolveDestination = resolveDestination
  return cloned
}

function structurallyDeniesAllNetwork(runtimeConfig: SandboxRuntimeConfig): boolean {
  return (
    runtimeConfig.network.allowedDomains.length === 0 &&
    runtimeConfig.network.deniedDomains.includes('*') &&
    runtimeConfig.network.strictAllowlist === true
  )
}

function endpointlessCredentialRestrictions(
  restrictions: CredentialRestrictionConfig,
): CredentialRestrictionConfig {
  const proxyNames = new Set<string>(PROXY_ENVIRONMENT_VARIABLES)
  return {
    ...restrictions,
    unsetEnvVars: [...new Set([...restrictions.unsetEnvVars, ...proxyNames])],
    setEnvVars: Object.fromEntries(
      Object.entries(restrictions.setEnvVars).filter(([name]) => !proxyNames.has(name)),
    ),
  }
}

function endpointKey(port: number): string {
  return `tcp:127.0.0.1:${port}`
}

function isLoopbackEndpointHost(host: string): boolean {
  const normalized = canonicalizeHost(host)?.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:7f00:1'
  )
}

function launchEndpointIsInternal(
  leaseRegistry: EndpointLeaseRegistry,
  host: string,
  port: number,
): boolean {
  return isLoopbackEndpointHost(host) && leaseRegistry.isTcpPortExcluded(port)
}

function excludedTcpPorts(endpoints: ReadonlySet<string>): Set<number> {
  const ports = new Set<number>()
  for (const endpoint of endpoints) {
    const match = /^tcp:127\.0\.0\.1:(\d+)$/u.exec(endpoint)
    if (match !== null) ports.add(Number(match[1]))
  }
  return ports
}

function launchResolveDestination(
  runtimeConfig: SandboxRuntimeConfig,
  leaseRegistry: EndpointLeaseRegistry,
  launchSignal: AbortSignal,
): ResolveDestination | undefined {
  const resolver = runtimeConfig.network.resolveDestination
  if (resolver === undefined) return undefined
  return async (hostname, port, requestSignal) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    requestSignal.addEventListener('abort', abort, { once: true })
    launchSignal.addEventListener('abort', abort, { once: true })
    try {
      if (requestSignal.aborted || launchSignal.aborted) {
        throw new Error('launch proxy authority is revoked')
      }
      const answers = await resolver(hostname, port, controller.signal)
      if (controller.signal.aborted) {
        throw new Error('launch proxy authority is revoked')
      }
      if (
        answers.some(answer =>
          launchEndpointIsInternal(leaseRegistry, answer.address, port),
        )
      ) {
        throw new Error('internal launch proxy endpoint denied')
      }
      return answers
    } finally {
      requestSignal.removeEventListener('abort', abort)
      launchSignal.removeEventListener('abort', abort)
    }
  }
}

async function closeLaunchAuthorityUnserialized(
  state: LaunchAuthorityState,
): Promise<void> {
  state.readiness.active = false
  state.abortController.abort()
  state.sentinelRegistry.clear()
  await (async () => {
    let clean = await settleLaunchAuthorityDrain([
      forceCloseHttpServer(state.httpProxyServer),
      state.socksProxyServer.close(),
      ...(state.managerContext.linuxBridge === undefined
        ? []
        : [
            stopLinuxBridgeProcess(
              state.managerContext.linuxBridge.httpBridgeProcess,
              'launch HTTP',
            ),
            stopLinuxBridgeProcess(
              state.managerContext.linuxBridge.socksBridgeProcess,
              'launch SOCKS',
            ),
          ]),
      ...(state.mitmCA === undefined ? [] : [disposeMitmCA(state.mitmCA)]),
    ])
    if (clean) {
      // The listener and all tracked connections are confirmed closed. Drop
      // request callbacks so their immutable credential snapshot is released.
      state.httpProxyServer.removeAllListeners()
    }
    if (state.managerContext.linuxBridge !== undefined) {
      for (const socketPath of [
        state.managerContext.linuxBridge.httpSocketPath,
        state.managerContext.linuxBridge.socksSocketPath,
      ]) {
        try {
          fs.rmSync(socketPath, { force: true })
        } catch {
          clean = false
        }
      }
    }
    cleanupBwrapMountPoints()
    // V1 conservatively tombstones every authority. A direct child exit does
    // not prove that no detached descendant still inherits its exact profile.
    const transitioned = state.leaseRegistry.retire(state.lease)
    if (!transitioned || !clean) {
      throw new Error('launch proxy authority cleanup failed')
    }
    activeLaunchAuthorities.delete(state)
  })()
}

function closeLaunchAuthority(state: LaunchAuthorityState): Promise<void> {
  if (state.cleanupPromise !== undefined) return state.cleanupPromise
  if (launchResetPromise !== undefined) {
    state.cleanupPromise = launchResetPromise
    return launchResetPromise
  }
  const operation = launchLifecycleTail.then(() =>
    closeLaunchAuthorityUnserialized(state),
  )
  state.cleanupPromise = operation
  void operation.catch(() => {
    if (state.cleanupPromise === operation) state.cleanupPromise = undefined
  })
  launchLifecycleTail = operation.then(
    () => undefined,
    () => undefined,
  )
  return operation
}

async function prepareLaunchAuthorityUnserialized(
  runtimeConfig: SandboxRuntimeConfig,
  options: LaunchAuthorityOptions,
  expectedEpoch: number,
): Promise<PreparedLaunchAuthority> {
  const assertLifecycleActive = () => {
    if (!launchAuthorityAccepting || launchAuthorityEpoch !== expectedEpoch) {
      throw new Error('per-launch proxy authority is stopped')
    }
  }
  assertLifecycleActive()
  const platform = getPlatform()
  if (platform === 'windows') {
    throw new Error('per-launch proxy authority is unavailable on Windows')
  }
  if (
    runtimeConfig.network.httpProxyPort !== undefined ||
    runtimeConfig.network.socksProxyPort !== undefined ||
    runtimeConfig.network.allowLocalBinding === true ||
    runtimeConfig.network.parentProxy !== undefined ||
    runtimeConfig.network.mitmProxy !== undefined ||
    runtimeConfig.network.inheritProxyEnv !== false ||
    runtimeConfig.enableWeakerNetworkIsolation === true ||
    runtimeConfig.enableWeakerNestedSandbox === true
  ) {
    throw new Error('per-launch proxy authority requires exclusive enforcing endpoints')
  }
  if (
    runtimeConfig.network.tlsTerminate !== undefined &&
    runtimeConfig.network.mitmProxy !== undefined
  ) {
    throw new Error(
      'network.tlsTerminate and network.mitmProxy are mutually exclusive',
    )
  }
  if (runtimeConfig.network.resolveDestination === undefined) {
    throw new Error('per-launch proxy authority requires a destination resolver')
  }

  const leaseRegistry = launchAuthorityRegistry
  const generationId = launchAuthorityGenerationId
  if (
    leaseRegistry === undefined ||
    generationId === undefined ||
    launchAuthorityRegistryPath !== options.endpointRegistryPath
  ) {
    throw new Error('per-launch proxy authority is not initialized')
  }

  const snapshot = cloneRuntimeConfigForLaunch(runtimeConfig)
  if (structurallyDeniesAllNetwork(snapshot)) {
    const restrictions = endpointlessCredentialRestrictions(
      getCredentialRestrictionsForConfig(
        snapshot.credentials,
        snapshot.network.allowedDomains,
        new SentinelRegistry(),
      ),
    )
    const wrapped = await wrapLaunchCommand(
      options,
      snapshot,
      undefined,
      undefined,
      undefined,
      restrictions,
    )
    assertLifecycleActive()
    let cleaned = false
    return {
      argv: wrapped.argv,
      env: wrapped.env,
      async cleanup() {
        if (cleaned) return
        cleaned = true
        cleanupBwrapMountPoints()
      },
    }
  }
  const networkSnapshot = { network: snapshot.network }
  leaseRegistry.assertCapacityAvailable()
  const launchMitmCA = snapshot.network.tlsTerminate
    ? createMitmCA(snapshot.network.tlsTerminate)
    : undefined
  const launchSentinelRegistry = new SentinelRegistry()
  const token = randomBytes(32).toString('hex')
  const readiness = { active: false }
  const abortController = new AbortController()
  const guardedResolver = launchResolveDestination(
    snapshot,
    leaseRegistry,
    abortController.signal,
  )

  const createLaunchHttpServer = () =>
    createHttpProxyServer({
      filter: (port, host) =>
        filterNetworkRequestForConfig(
          networkSnapshot,
          port,
          host,
          undefined,
          (candidateHost, candidatePort) =>
            launchEndpointIsInternal(leaseRegistry, candidateHost, candidatePort),
        ),
      getMitmSocketPath: host => getMitmSocketPathForConfig(snapshot, host),
      mitmCA: launchMitmCA,
      filterRequest: buildRequestFilterForConfig(snapshot),
      mutateHeaders: buildCredentialInjectorForConfig(
        snapshot,
        launchSentinelRegistry,
      ),
      mutateHeadersPlaintext: buildCredentialInjectorForConfig(
        snapshot,
        launchSentinelRegistry,
        { requirePlaintextOptIn: true },
      ),
      parentProxy: undefined,
      resolveDestination: guardedResolver,
      proxyAuthToken: token,
      isProxyAuthActive: () => readiness.active,
    })
  const createLaunchSocksServer = () =>
    createSocksProxyServer({
      filter: (port, host) =>
        filterNetworkRequestForConfig(
          networkSnapshot,
          port,
          host,
          undefined,
          (candidateHost, candidatePort) =>
            launchEndpointIsInternal(leaseRegistry, candidateHost, candidatePort),
        ),
      parentProxy: undefined,
      resolveDestination: guardedResolver,
      proxyAuthToken: token,
      isProxyAuthActive: () => readiness.active,
    })

  let lease: EndpointLease | undefined
  let state: LaunchAuthorityState | undefined
  let linuxBridge: LinuxNetworkBridgeContext | undefined
  let httpServer: ReturnType<typeof createHttpProxyServer> | undefined
  let socksServer: SocksProxyWrapper | undefined
  try {
    const excludedEndpoints = leaseRegistry.excludedEndpoints()
    const excludedPorts = excludedTcpPorts(excludedEndpoints)
    httpServer = createLaunchHttpServer()
    socksServer = createLaunchSocksServer()
    await listenInRange(
      httpServer,
      port => httpServer!.listen(port, '127.0.0.1'),
      LAUNCH_PROXY_PORT_RANGE,
      excludedPorts,
    )
    const httpAddress = httpServer.address()
    if (!httpAddress || typeof httpAddress === 'string') {
      throw new Error('failed to allocate launch HTTP proxy')
    }
    const httpPort = httpAddress.port
    excludedPorts.add(httpPort)
    let socksPort: number | undefined
    let lastSocksError: unknown
    for (
      let port = LAUNCH_PROXY_PORT_RANGE[0];
      port <= LAUNCH_PROXY_PORT_RANGE[1];
      port++
    ) {
      if (excludedPorts.has(port)) continue
      try {
        socksPort = await socksServer.listen(port, '127.0.0.1')
        break
      } catch (error) {
        lastSocksError = error
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      }
    }
    if (socksPort === undefined) {
      throw new Error(
        `no launch SOCKS proxy endpoint is available: ${String(lastSocksError)}`,
      )
    }
    const socketId = platform === 'linux' ? `${String(httpPort)}-${String(socksPort)}` : undefined
    // Both OS sockets are exclusively held but readiness remains false, so no
    // request can authenticate. Durably exclude the selected endpoints before
    // installing a profile-bearing child or activating this authority.
    lease = leaseRegistry.reserve([
      endpointKey(httpPort),
      endpointKey(socksPort),
    ])
    httpServer.unref()
    socksServer.unref()

    if (platform === 'linux') {
      linuxBridge = await initializeLinuxNetworkBridge(
        httpPort,
        socksPort,
        snapshot.socatPath,
        dirname(options.endpointRegistryPath),
        socketId,
      )
    }
    assertLifecycleActive()

    const context: HostNetworkManagerContext = {
      httpProxyPort: httpPort,
      socksProxyPort: socksPort,
      linuxBridge,
    }
    const credentialRestrictions = getCredentialRestrictionsForConfig(
      snapshot.credentials,
      snapshot.network.allowedDomains,
      launchSentinelRegistry,
    )
    const wrapped = await wrapLaunchCommand(
      options,
      snapshot,
      context,
      token,
      launchMitmCA,
      credentialRestrictions,
    )
    assertLifecycleActive()
    state = {
      generationId,
      managerContext: context,
      httpProxyServer: httpServer,
      socksProxyServer: socksServer,
      mitmCA: launchMitmCA,
      sentinelRegistry: launchSentinelRegistry,
      leaseRegistry,
      lease,
      abortController,
      readiness,
    }
    activeLaunchAuthorities.add(state)
    readiness.active = true
    return {
      argv: wrapped.argv,
      env: wrapped.env,
      cleanup: () => closeLaunchAuthority(state!),
    }
  } catch (error) {
    readiness.active = false
    abortController.abort()
    if (state !== undefined) activeLaunchAuthorities.delete(state)
    let partialCleanupConfirmed = false
    try {
      partialCleanupConfirmed = await settleLaunchAuthorityDrain([
        ...(httpServer === undefined ? [] : [forceCloseHttpServer(httpServer)]),
        ...(socksServer === undefined ? [] : [socksServer.close()]),
        ...(linuxBridge === undefined
          ? []
          : [
              stopLinuxBridgeProcess(
                linuxBridge.httpBridgeProcess,
                'launch HTTP',
              ),
              stopLinuxBridgeProcess(
                linuxBridge.socksBridgeProcess,
                'launch SOCKS',
              ),
            ]),
      ])
      if (linuxBridge !== undefined) {
        fs.rmSync(linuxBridge.httpSocketPath, { force: true })
        fs.rmSync(linuxBridge.socksSocketPath, { force: true })
      }
      if (lease !== undefined && !leaseRegistry.retire(lease)) {
        partialCleanupConfirmed = false
      }
      launchSentinelRegistry.clear()
      if (launchMitmCA !== undefined) await disposeMitmCA(launchMitmCA)
    } catch {
      partialCleanupConfirmed = false
      // The original preparation error remains primary; the durable lease is
      // already active/tombstoned and therefore fails closed across restart.
    }
    if (!partialCleanupConfirmed) {
      throw new AggregateError(
        [error],
        'launch authority preparation failed and partial cleanup was not confirmed',
      )
    }
    throw error
  }
}

function launchFilesystemConfig(runtimeConfig: SandboxRuntimeConfig): {
  readConfig: FsReadRestrictionConfig | undefined
  writeConfig: FsWriteRestrictionConfig | undefined
} {
  if (runtimeConfig.filesystem.disabled) {
    return { readConfig: undefined, writeConfig: undefined }
  }
  const stripWriteGlobs = (paths: string[]): string[] =>
    paths
      .map(path => removeTrailingGlobSuffix(path))
      .filter(path => getPlatform() !== 'linux' || !containsGlobChars(path))
  const writeConfig: FsWriteRestrictionConfig = {
    allowOnly: [
      ...getDefaultWritePaths(),
      ...stripWriteGlobs(runtimeConfig.filesystem.allowWrite),
    ],
    denyWithinAllow: stripWriteGlobs(runtimeConfig.filesystem.denyWrite),
  }
  const expand = (paths: readonly string[]): string[] => {
    const expanded: string[] = []
    for (const path of paths) {
      const stripped = removeTrailingGlobSuffix(path)
      if (getPlatform() === 'linux' && containsGlobChars(stripped)) {
        expanded.push(...expandGlobPattern(path))
      } else {
        expanded.push(stripped)
      }
    }
    return expanded
  }
  const credentialDenyReadPaths = (runtimeConfig.credentials?.files ?? [])
    .filter(file => file.mode === 'deny')
    .map(file => file.path)
  const readConfig: FsReadRestrictionConfig = {
    denyOnly: expand([
      ...new Set([
        ...runtimeConfig.filesystem.denyRead,
        ...credentialDenyReadPaths,
      ]),
    ]),
    allowWithinDeny: expand(runtimeConfig.filesystem.allowRead ?? []),
  }
  return { readConfig, writeConfig }
}

async function wrapLaunchCommand(
  options: LaunchAuthorityOptions,
  runtimeConfig: SandboxRuntimeConfig,
  context: HostNetworkManagerContext | undefined,
  token: string | undefined,
  launchMitmCA: MitmCA | undefined,
  credentialRestrictions: CredentialRestrictionConfig,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const { readConfig, writeConfig } = launchFilesystemConfig(runtimeConfig)
  if (launchMitmCA !== undefined && readConfig !== undefined) {
    ;(readConfig.allowWithinDeny ??= []).push(launchMitmCA.certPath)
  }
  let wrapped: string
  if (getPlatform() === 'macos') {
    wrapped = wrapCommandWithSandboxMacOS({
      command: options.command,
      needsNetworkRestriction: true,
      httpProxyPort: context?.httpProxyPort,
      socksProxyPort: context?.socksProxyPort,
      proxyAuthToken: token,
      caCertPath: launchMitmCA?.certPath,
      readConfig,
      writeConfig,
      unsetEnvVars: credentialRestrictions.unsetEnvVars,
      setEnvVars: credentialRestrictions.setEnvVars,
      allowUnixSockets: runtimeConfig.network.allowUnixSockets,
      allowAllUnixSockets: runtimeConfig.network.allowAllUnixSockets,
      allowLocalBinding: false,
      allowMachLookup: runtimeConfig.network.allowMachLookup,
      ignoreViolations: runtimeConfig.ignoreViolations,
      allowPty: runtimeConfig.allowPty,
      allowGitConfig: runtimeConfig.filesystem.allowGitConfig ?? false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: runtimeConfig.allowAppleEvents ?? false,
      binShell: options.binShell,
    })
  } else if (getPlatform() === 'linux') {
    const bridge = context?.linuxBridge
    if (token !== undefined && bridge === undefined) {
      throw new Error('launch Linux bridge is unavailable')
    }
    wrapped = await wrapCommandWithSandboxLinux({
      command: options.command,
      needsNetworkRestriction: true,
      httpSocketPath: bridge.httpSocketPath,
      socksSocketPath: bridge.socksSocketPath,
      httpProxyPort: context?.httpProxyPort,
      socksProxyPort: context?.socksProxyPort,
      proxyAuthToken: token,
      caCertPath: launchMitmCA?.certPath,
      readConfig,
      writeConfig,
      unsetEnvVars: credentialRestrictions.unsetEnvVars,
      setEnvVars: credentialRestrictions.setEnvVars,
      enableWeakerNestedSandbox: false,
      allowAllUnixSockets: runtimeConfig.network.allowAllUnixSockets,
      binShell: options.binShell,
      ripgrepConfig: runtimeConfig.ripgrep ?? { command: 'rg' },
      mandatoryDenySearchDepth:
        runtimeConfig.mandatoryDenySearchDepth ?? 3,
      allowGitConfig: runtimeConfig.filesystem.allowGitConfig ?? false,
      seccompConfig: runtimeConfig.seccomp,
      bwrapPath: runtimeConfig.bwrapPath,
      socatPath: runtimeConfig.socatPath,
      abortSignal: options.abortSignal,
    })
  } else {
    throw new Error('per-launch proxy authority is unavailable')
  }
  return {
    argv: [options.binShell ?? '/bin/bash', '-c', wrapped],
    env: process.env,
  }
}

function supportsLaunchAuthority(): boolean {
  const platform = getPlatform()
  return platform === 'macos' || platform === 'linux'
}

function launchAuthorityCapacityAvailable(): boolean {
  return launchAuthorityRegistry?.capacityAvailable() ?? false
}

function initializeLaunchAuthority(endpointRegistryPath: string): void {
  if (launchAuthorityRegistry !== undefined) {
    throw new Error('per-launch proxy authority is already initialized')
  }
  const generationId = randomBytes(32).toString('hex')
  const registry = new EndpointLeaseRegistry(endpointRegistryPath, {
    generationId,
  })
  registry.claimGeneration()
  try {
    registry.recoverPriorGenerations()
  } catch (error) {
    try {
      registry.releaseGeneration()
    } catch {
      // Initialization remains failed closed; the exact owner marker can be
      // recovered after process exit if corrupt durable state blocks release.
    }
    throw error
  }
  launchAuthorityRegistry = registry
  launchAuthorityRegistryPath = endpointRegistryPath
  launchAuthorityGenerationId = generationId
  launchAuthorityAccepting = true
  launchAuthorityEpoch += 1
}

function prepareLaunchAuthority(
  runtimeConfig: SandboxRuntimeConfig,
  options: LaunchAuthorityOptions,
): Promise<PreparedLaunchAuthority> {
  const expectedEpoch = launchAuthorityEpoch
  const operation = launchLifecycleTail.then(() =>
    prepareLaunchAuthorityUnserialized(runtimeConfig, options, expectedEpoch),
  )
  launchLifecycleTail = operation.then(
    () => undefined,
    () => undefined,
  )
  return operation
}

// ============================================================================
// Public Module Functions (will be exported via namespace)
// ============================================================================

async function initialize(
  runtimeConfig: SandboxRuntimeConfig,
  sandboxAskCallback?: SandboxAskCallback,
  enableLogMonitor = false,
): Promise<void> {
  // Return if already initializing
  if (initializationPromise) {
    await initializationPromise
    return
  }

  const requestedResolver = runtimeConfig.network.resolveDestination
  if (requestedResolver !== undefined) {
    if (runtimeConfig.network.inheritProxyEnv !== false) {
      throw new Error(
        'network.inheritProxyEnv must be false when network.resolveDestination is configured',
      )
    }
    assertDestinationGuardRoutesCompatible(runtimeConfig.network)
  }

  // Store config and capture initialization-scoped resolver authority.
  config = runtimeConfig
  destinationResolver = requestedResolver

  // Resolve parent/upstream proxy from config or HTTP_PROXY env before we
  // start our own listeners (which will later shadow those vars in the child).
  parentProxy = resolveParentProxy(
    runtimeConfig.network.parentProxy,
    runtimeConfig.network.inheritProxyEnv !== false,
  )
  if (parentProxy) {
    logForDebugging(
      `Parent proxy configured: http=${redactUrl(parentProxy.httpUrl)} ` +
        `https=${redactUrl(parentProxy.httpsUrl)}`,
    )
  }

  // Load TLS-termination CA if configured. Throws on unreadable/non-PEM —
  // tlsTerminate is explicit opt-in, so a bad config is a hard error.
  if (runtimeConfig.network.tlsTerminate && runtimeConfig.network.mitmProxy) {
    throw new Error(
      'network.tlsTerminate and network.mitmProxy are mutually exclusive',
    )
  }
  mitmCA = runtimeConfig.network.tlsTerminate
    ? createMitmCA(runtimeConfig.network.tlsTerminate)
    : undefined

  // Check dependencies
  const deps = checkDependencies()
  if (deps.errors.length > 0) {
    throw new Error(
      `Sandbox dependencies not available: ${deps.errors.join(', ')}`,
    )
  }

  // Start log monitor for macOS if enabled
  if (enableLogMonitor && getPlatform() === 'macos') {
    logMonitorShutdown = startMacOSSandboxLogMonitor(
      sandboxViolationStore.addViolation.bind(sandboxViolationStore),
      config.ignoreViolations,
    )
    logForDebugging('Started macOS sandbox log monitor')
  }

  // Register cleanup handlers first time
  registerCleanup()

  // Initialize network infrastructure
  initializationPromise = (async () => {
    try {
      // On Windows the WFP loopback permit covers a fixed port
      // range, so the proxies must bind inside it. Other platforms
      // bake the actual ephemeral port into the sandbox profile, so
      // they keep using port 0.
      const portRange: readonly [number, number] | undefined =
        getPlatform() === 'windows'
          ? (config.windows?.proxyPortRange ?? DEFAULT_WINDOWS_PROXY_PORT_RANGE)
          : undefined

      // The auth token is only set when this process owns the proxy; an
      // external proxy (config.network.httpProxyPort) handles its own auth,
      // and embedding our token in its URL would be wrong.
      proxyAuthToken =
        config.network.httpProxyPort !== undefined
          ? undefined
          : randomBytes(16).toString('hex')
      let httpProxyPort: number
      if (config.network.httpProxyPort !== undefined) {
        // Use external HTTP proxy (don't start a server)
        httpProxyPort = config.network.httpProxyPort
        logForDebugging(`Using external HTTP proxy on port ${httpProxyPort}`)
      } else {
        // Start local HTTP proxy
        httpProxyPort = await startHttpProxyServer(
          sandboxAskCallback,
          portRange,
          new Set(),
        )
      }

      let socksProxyPort: number
      if (config.network.socksProxyPort !== undefined) {
        // Use external SOCKS proxy (don't start a server)
        socksProxyPort = config.network.socksProxyPort
        logForDebugging(`Using external SOCKS proxy on port ${socksProxyPort}`)
      } else {
        // Start local SOCKS proxy. Skip the port the HTTP proxy
        // already took.
        socksProxyPort = await startSocksProxyServer(
          sandboxAskCallback,
          portRange,
          new Set([httpProxyPort]),
        )
      }

      // Initialize platform-specific infrastructure
      let linuxBridge: LinuxNetworkBridgeContext | undefined
      if (getPlatform() === 'linux') {
        linuxBridge = await initializeLinuxNetworkBridge(
          httpProxyPort,
          socksProxyPort,
          config.socatPath,
        )
      }

      const context: HostNetworkManagerContext = {
        httpProxyPort,
        socksProxyPort,
        linuxBridge,
      }
      managerContext = context
      logForDebugging('Network infrastructure initialized')
      return context
    } catch (error) {
      // Clear state on error so initialization can be retried
      initializationPromise = undefined
      managerContext = undefined
      reset().catch(e => {
        logForDebugging(`Cleanup failed in initializationPromise ${e}`, {
          level: 'error',
        })
      })
      throw error
    }
  })()

  await initializationPromise
}

function isSupportedPlatform(): boolean {
  const platform = getPlatform()
  if (platform === 'linux') {
    // WSL1 doesn't support bubblewrap
    return getWslVersion() !== '1'
  }
  return platform === 'macos' || platform === 'windows'
}

/**
 * Resolve the Windows group reference from config. Used by both the
 * dependency check and `wrapWithSandbox` so they agree.
 */
function getWindowsGroupRef(): WindowsGroupRef {
  return {
    groupName: config?.windows?.groupName ?? DEFAULT_WINDOWS_GROUP_NAME,
    groupSid: config?.windows?.groupSid,
  }
}

function isSandboxingEnabled(): boolean {
  // Sandboxing is enabled if config has been set (via initialize())
  return config !== undefined
}

/**
 * Check sandbox dependencies for the current platform
 * @param ripgrepConfig - Ripgrep command to check. If not provided, uses config from initialization or defaults to 'rg'
 * @returns { warnings, errors } - errors mean sandbox cannot run, warnings mean degraded functionality
 */
function checkDependencies(ripgrepConfig?: {
  command: string
  args?: string[]
}): SandboxDependencyCheck {
  if (!isSupportedPlatform()) {
    return { errors: ['Unsupported platform'], warnings: [] }
  }

  const errors: string[] = []
  const warnings: string[] = []

  const platform = getPlatform()
  if (platform === 'linux') {
    // ripgrep is Linux-only: it's used by linuxGetMandatoryDenyPaths() to
    // expand glob deny-patterns to concrete paths for bwrap. macOS seatbelt
    // profiles take regex patterns directly, so rg is never invoked there.
    const rgToCheck = ripgrepConfig ?? config?.ripgrep ?? { command: 'rg' }
    if (whichSync(rgToCheck.command) === null) {
      errors.push(`ripgrep (${rgToCheck.command}) not found`)
    }

    const linuxDeps = checkLinuxDependencies({
      seccompConfig: config?.seccomp,
      bwrapPath: config?.bwrapPath,
      socatPath: config?.socatPath,
    })
    errors.push(...linuxDeps.errors)
    warnings.push(...linuxDeps.warnings)
  } else if (platform === 'windows') {
    const winDeps = checkWindowsDependencies(
      getWindowsGroupRef(),
      config?.windows?.wfpSublayerGuid,
    )
    errors.push(...winDeps.errors)
    warnings.push(...winDeps.warnings)
  }

  return { errors, warnings }
}

/**
 * Build the read-deny / env-unset / env-set maps implied by the
 * `credentials` config.
 *
 * Only explicitly declared sources are restricted: `mode: 'deny'` file
 * entries join the read-deny set, `mode: 'deny'` env vars are unset, and
 * `mode: 'mask'` env vars are set to a per-session sentinel registered in
 * {@link sentinelRegistry}. A masked var with no value in the host
 * environment is skipped — there is nothing to protect, and emitting an
 * unset var would change tool behaviour (presence checks would pass where
 * they didn't before).
 */
function getCredentialRestrictions(
  credentials: CredentialsConfig | undefined,
  allowedDomains: readonly string[] | undefined,
): CredentialRestrictionConfig {
  return getCredentialRestrictionsForConfig(
    credentials,
    allowedDomains,
    sentinelRegistry,
  )
}

function getCredentialRestrictionsForConfig(
  credentials: CredentialsConfig | undefined,
  allowedDomains: readonly string[] | undefined,
  launchSentinelRegistry: SentinelRegistry,
): CredentialRestrictionConfig {
  if (!credentials) {
    return { denyReadPaths: [], unsetEnvVars: [], setEnvVars: {} }
  }

  const files = credentials.files ?? []
  const denyReadPaths = files.filter(f => f.mode === 'deny').map(f => f.path)

  const unsetEnvVars: string[] = []
  const setEnvVars: Record<string, string> = {}
  for (const v of credentials.envVars ?? []) {
    if (v.mode === 'deny') {
      unsetEnvVars.push(v.name)
    } else if (v.mode === 'mask') {
      const real = process.env[v.name]
      if (real === undefined) continue
      // Effective injectHosts: per-entry narrows; if unset, default to
      // every reachable host (network.allowedDomains). injectHosts is an
      // *optional narrowing*, not a required allowlist. Trade-off: a
      // masked credential with no injectHosts is injectable at every host
      // the sandbox can reach — narrow it explicitly when the credential
      // should only go to a subset.
      const injectHosts = v.injectHosts ?? allowedDomains ?? []
      setEnvVars[v.name] = launchSentinelRegistry.register(
        v.name,
        real,
        injectHosts,
      )
    }
  }

  return {
    denyReadPaths: [...new Set(denyReadPaths)],
    unsetEnvVars: [...new Set(unsetEnvVars)],
    setEnvVars,
  }
}

function getFsReadConfig(): FsReadRestrictionConfig {
  if (!config || config.filesystem.disabled) {
    return { denyOnly: [], allowWithinDeny: [] }
  }

  // Credential deny paths are unioned with the caller's denyRead — never
  // replacing it — so explicit filesystem restrictions always survive.
  const rawDenyRead = [
    ...new Set([
      ...config.filesystem.denyRead,
      ...getCredentialRestrictions(
        config.credentials,
        config.network.allowedDomains,
      ).denyReadPaths,
    ]),
  ]

  const denyPaths: string[] = []
  for (const p of rawDenyRead) {
    const stripped = removeTrailingGlobSuffix(p)
    if (getPlatform() === 'linux' && containsGlobChars(stripped)) {
      // Expand glob to concrete paths on Linux (bubblewrap doesn't support globs)
      const expanded = expandGlobPattern(p)
      logForDebugging(
        `[Sandbox] Expanded glob pattern "${p}" to ${expanded.length} paths on Linux`,
      )
      denyPaths.push(...expanded)
    } else {
      denyPaths.push(stripped)
    }
  }

  // Process allowRead paths (re-allow within denied regions)
  const allowPaths: string[] = []
  for (const p of config.filesystem.allowRead ?? []) {
    const stripped = removeTrailingGlobSuffix(p)
    if (getPlatform() === 'linux' && containsGlobChars(stripped)) {
      const expanded = expandGlobPattern(p)
      logForDebugging(
        `[Sandbox] Expanded allowRead glob pattern "${p}" to ${expanded.length} paths on Linux`,
      )
      allowPaths.push(...expanded)
    } else {
      allowPaths.push(stripped)
    }
  }

  return {
    denyOnly: denyPaths,
    allowWithinDeny: allowPaths,
  }
}

function getFsWriteConfig(): FsWriteRestrictionConfig {
  if (!config) {
    return { allowOnly: getDefaultWritePaths(), denyWithinAllow: [] }
  }

  if (config.filesystem.disabled) {
    return { allowOnly: ['/'], denyWithinAllow: [] }
  }

  // Filter out glob patterns on Linux/WSL for allowWrite (bubblewrap doesn't support globs)
  const allowPaths = config.filesystem.allowWrite
    .map(path => removeTrailingGlobSuffix(path))
    .filter(path => {
      if (getPlatform() === 'linux' && containsGlobChars(path)) {
        logForDebugging(`Skipping glob pattern on Linux/WSL: ${path}`)
        return false
      }
      return true
    })

  // Filter out glob patterns on Linux/WSL for denyWrite (bubblewrap doesn't support globs)
  const denyPaths = config.filesystem.denyWrite
    .map(path => removeTrailingGlobSuffix(path))
    .filter(path => {
      if (getPlatform() === 'linux' && containsGlobChars(path)) {
        logForDebugging(`Skipping glob pattern on Linux/WSL: ${path}`)
        return false
      }
      return true
    })

  // Build allowOnly list: default paths + configured allow paths
  const allowOnly = [...getDefaultWritePaths(), ...allowPaths]

  return {
    allowOnly,
    denyWithinAllow: denyPaths,
  }
}

function getNetworkRestrictionConfig(): NetworkRestrictionConfig {
  if (!config) {
    return {}
  }

  // Preserve an explicitly-empty allowlist: consumers need to distinguish
  // "no network restriction configured" (absent) from "allowlist configured
  // with zero entries" (block-all / ask-only). Stripping the empty array
  // made a host app's restriction-status UI report an airgapped config as
  // unrestricted. deniedHosts keeps the strip — an empty denylist and an
  // absent one are semantically identical.
  const allowedHosts = config.network.allowedDomains
  const deniedHosts = config.network.deniedDomains

  return {
    allowedHosts,
    ...(deniedHosts.length > 0 && { deniedHosts }),
  }
}

function getAllowUnixSockets(): string[] | undefined {
  return config?.network?.allowUnixSockets
}

function getAllowAllUnixSockets(): boolean | undefined {
  return config?.network?.allowAllUnixSockets
}

function getAllowLocalBinding(): boolean | undefined {
  return config?.network?.allowLocalBinding
}

function getAllowMachLookup(): string[] | undefined {
  return config?.network?.allowMachLookup
}

function getIgnoreViolations(): Record<string, string[]> | undefined {
  return config?.ignoreViolations
}

function getEnableWeakerNestedSandbox(): boolean | undefined {
  return config?.enableWeakerNestedSandbox
}

function getEnableWeakerNetworkIsolation(): boolean | undefined {
  return config?.enableWeakerNetworkIsolation
}

function getAllowAppleEvents(): boolean | undefined {
  return config?.allowAppleEvents
}

function getRipgrepConfig(): { command: string; args?: string[] } {
  return config?.ripgrep ?? { command: 'rg' }
}

function getMandatoryDenySearchDepth(): number {
  return config?.mandatoryDenySearchDepth ?? 3
}

function getAllowGitConfig(): boolean {
  return config?.filesystem?.allowGitConfig ?? false
}

function getSeccompConfig(): SeccompConfig | undefined {
  return config?.seccomp
}

function getProxyAuthToken(): string | undefined {
  return proxyAuthToken
}

function getProxyPort(): number | undefined {
  return managerContext?.httpProxyPort
}

function getSocksProxyPort(): number | undefined {
  return managerContext?.socksProxyPort
}

function getLinuxHttpSocketPath(): string | undefined {
  return managerContext?.linuxBridge?.httpSocketPath
}

function getLinuxSocksSocketPath(): string | undefined {
  return managerContext?.linuxBridge?.socksSocketPath
}

/**
 * Wait for network initialization to complete if already in progress
 * Returns true if initialized successfully, false otherwise
 */
async function waitForNetworkInitialization(): Promise<boolean> {
  if (!config) {
    return false
  }
  if (initializationPromise) {
    try {
      await initializationPromise
      return true
    } catch {
      return false
    }
  }
  return managerContext !== undefined
}

async function wrapWithSandbox(
  command: string,
  binShell?: string,
  customConfig?: Partial<SandboxRuntimeConfig>,
  abortSignal?: AbortSignal,
): Promise<string> {
  const platform = getPlatform()

  // filesystem.disabled bypasses ALL filesystem rule generation. Both
  // platform wrappers treat readConfig/writeConfig === undefined as "no
  // filesystem restrictions" (seatbelt emits `(allow file-write*)`; bwrap
  // skips the `--ro-bind / /` root and all path binds).
  //
  // Precedence: when a caller passes a per-call filesystem override at all,
  // its `disabled` (defaulting to false) wins outright. A global
  // disabled=true must not silently discard a per-call tightening that
  // omits the new key.
  const fsDisabled =
    customConfig?.filesystem !== undefined
      ? (customConfig.filesystem.disabled ?? false)
      : (config?.filesystem.disabled ?? false)

  // Credential env handling is independent of filesystem policy: unsetEnvVars /
  // setEnvVars must be applied even when fsDisabled (the credential file
  // deny-reads are dropped, but env scrubbing still happens).
  const credentialRestrictions = getCredentialRestrictions(
    customConfig?.credentials ?? config?.credentials,
    customConfig?.network?.allowedDomains ?? config?.network?.allowedDomains,
  )

  // Get configs - use custom if provided, otherwise fall back to main config
  // If neither exists, defaults to empty arrays (most restrictive)
  // Always include default system write paths (like /dev/null, /tmp/claude)
  //
  // Strip trailing /** and filter remaining globs on Linux (bwrap needs
  // real paths, not globs; macOS subpath matching is also recursive so
  // stripping is harmless there).
  let writeConfig: FsWriteRestrictionConfig | undefined
  let readConfig: FsReadRestrictionConfig | undefined
  if (!fsDisabled) {
    const stripWriteGlobs = (paths: string[]): string[] =>
      paths
        .map(p => removeTrailingGlobSuffix(p))
        .filter(p => {
          if (getPlatform() === 'linux' && containsGlobChars(p)) {
            logForDebugging(
              `[Sandbox] Skipping glob write pattern on Linux: ${p}`,
            )
            return false
          }
          return true
        })
    const userAllowWrite = stripWriteGlobs(
      customConfig?.filesystem?.allowWrite ??
        config?.filesystem.allowWrite ??
        [],
    )
    writeConfig = {
      allowOnly: [...getDefaultWritePaths(), ...userAllowWrite],
      denyWithinAllow: stripWriteGlobs(
        customConfig?.filesystem?.denyWrite ??
          config?.filesystem.denyWrite ??
          [],
      ),
    }

    // Credential deny paths are unioned with the caller's denyRead — never
    // replacing it — so explicit filesystem restrictions always survive.
    const rawDenyRead = [
      ...new Set([
        ...(customConfig?.filesystem?.denyRead ??
          config?.filesystem.denyRead ??
          []),
        ...credentialRestrictions.denyReadPaths,
      ]),
    ]
    const expandedDenyRead: string[] = []
    for (const p of rawDenyRead) {
      const stripped = removeTrailingGlobSuffix(p)
      if (getPlatform() === 'linux' && containsGlobChars(stripped)) {
        expandedDenyRead.push(...expandGlobPattern(p))
      } else {
        expandedDenyRead.push(stripped)
      }
    }
    const rawAllowRead =
      customConfig?.filesystem?.allowRead ?? config?.filesystem.allowRead ?? []
    const expandedAllowRead: string[] = []
    for (const p of rawAllowRead) {
      const stripped = removeTrailingGlobSuffix(p)
      if (getPlatform() === 'linux' && containsGlobChars(stripped)) {
        expandedAllowRead.push(...expandGlobPattern(p))
      } else {
        expandedAllowRead.push(stripped)
      }
    }
    // The TLS-termination CA cert must be readable by the child so the trust
    // env vars (NODE_EXTRA_CA_CERTS etc.) resolve, even if its path falls
    // under a user-configured denyRead.
    if (mitmCA) {
      expandedAllowRead.push(mitmCA.certPath)
    }
    readConfig = {
      denyOnly: expandedDenyRead,
      allowWithinDeny: expandedAllowRead,
    }
  }

  // Check if network config is specified - this determines if we need network restrictions
  // Network restriction is needed when:
  // 1. customConfig has network.allowedDomains defined (even if empty array = block all)
  // 2. OR config has network.allowedDomains defined (even if empty array = block all)
  // An empty allowedDomains array means "no domains allowed" = block all network access
  const hasNetworkConfig =
    customConfig?.network?.allowedDomains !== undefined ||
    config?.network?.allowedDomains !== undefined

  // Network RESTRICTION is needed whenever network config is specified
  // This includes empty allowedDomains which means "block all network"
  const needsNetworkRestriction = hasNetworkConfig

  // Network PROXY is needed whenever network config is specified
  // Even with empty allowedDomains, we route through proxy so that:
  // 1. updateConfig() can enable network access for already-running processes
  // 2. The proxy blocks all requests when allowlist is empty
  const needsNetworkProxy = hasNetworkConfig

  // Wait for network initialization only if proxy is actually needed
  if (needsNetworkProxy) {
    await waitForNetworkInitialization()
  }

  // Check custom config to allow pseudo-terminal (can be applied dynamically)
  const allowPty = customConfig?.allowPty ?? config?.allowPty

  switch (platform) {
    case 'macos':
      // macOS sandbox profile supports glob patterns directly, no ripgrep needed
      return wrapCommandWithSandboxMacOS({
        command,
        needsNetworkRestriction,
        // Only pass proxy ports if proxy is running (when there are domains to filter)
        httpProxyPort: needsNetworkProxy ? getProxyPort() : undefined,
        socksProxyPort: needsNetworkProxy ? getSocksProxyPort() : undefined,
        proxyAuthToken: needsNetworkProxy ? proxyAuthToken : undefined,
        caCertPath: mitmCA?.certPath,
        readConfig,
        writeConfig,
        unsetEnvVars: credentialRestrictions.unsetEnvVars,
        setEnvVars: credentialRestrictions.setEnvVars,
        allowUnixSockets: getAllowUnixSockets(),
        allowAllUnixSockets: getAllowAllUnixSockets(),
        allowLocalBinding: getAllowLocalBinding(),
        allowMachLookup: getAllowMachLookup(),
        ignoreViolations: getIgnoreViolations(),
        allowPty,
        allowGitConfig: getAllowGitConfig(),
        enableWeakerNetworkIsolation: getEnableWeakerNetworkIsolation(),
        allowAppleEvents: getAllowAppleEvents(),
        binShell,
      })

    case 'linux':
      return wrapCommandWithSandboxLinux({
        command,
        needsNetworkRestriction,
        // Only pass socket paths if proxy is running (when there are domains to filter)
        httpSocketPath: needsNetworkProxy
          ? getLinuxHttpSocketPath()
          : undefined,
        socksSocketPath: needsNetworkProxy
          ? getLinuxSocksSocketPath()
          : undefined,
        httpProxyPort: needsNetworkProxy
          ? managerContext?.httpProxyPort
          : undefined,
        socksProxyPort: needsNetworkProxy
          ? managerContext?.socksProxyPort
          : undefined,
        proxyAuthToken: needsNetworkProxy ? proxyAuthToken : undefined,
        caCertPath: mitmCA?.certPath,
        readConfig,
        writeConfig,
        unsetEnvVars: credentialRestrictions.unsetEnvVars,
        setEnvVars: credentialRestrictions.setEnvVars,
        enableWeakerNestedSandbox: getEnableWeakerNestedSandbox(),
        allowAllUnixSockets: getAllowAllUnixSockets(),
        binShell,
        ripgrepConfig: getRipgrepConfig(),
        mandatoryDenySearchDepth: getMandatoryDenySearchDepth(),
        allowGitConfig: getAllowGitConfig(),
        seccompConfig: getSeccompConfig(),
        bwrapPath: config?.bwrapPath,
        socatPath: config?.socatPath,
        abortSignal,
      })

    case 'windows':
      // Windows wraps to an argv array, not a shell string. Forcing
      // callers through wrapWithSandboxArgv() means they spawn with
      // {shell:false}, which is the security boundary that keeps the
      // user's command bytes off the HOST shell.
      throw new Error(
        'wrapWithSandbox() returns a shell string and is not supported ' +
          'on Windows. Use SandboxManager.wrapWithSandboxArgv() and ' +
          'spawn the result with {shell: false}.',
      )

    default:
      // Unsupported platform - this should not happen since isSandboxingEnabled() checks platform support
      throw new Error(
        `Sandbox configuration is not supported on platform: ${platform}`,
      )
  }
}

/**
 * Wrap `command` for the sandbox and return a spawn descriptor:
 * `{ argv, env }`, suitable for
 * `spawn(argv[0], argv.slice(1), {shell: false, env})`.
 *
 * On Windows this is the ONLY supported wrap method (see
 * {@link wrapWithSandbox}); `env` carries the full proxy set that the
 * sandboxed child inherits (`srt-win exec` forwards its environment
 * verbatim — see {@link wrapCommandWithSandboxWindows}). On
 * macOS/Linux `argv` is `[binShell, '-c', <wrapWithSandbox result>]`
 * (proxy env is baked into that command) and `env` is the unchanged
 * `process.env`, so callers can spawn uniformly across platforms.
 */
async function wrapWithSandboxArgv(
  command: string,
  binShell?: string,
  customConfig?: Partial<SandboxRuntimeConfig>,
  abortSignal?: AbortSignal,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  const platform = getPlatform()

  if (platform === 'windows') {
    const hasNetworkConfig =
      customConfig?.network?.allowedDomains !== undefined ||
      config?.network?.allowedDomains !== undefined
    if (hasNetworkConfig) {
      await waitForNetworkInitialization()
    }
    return wrapCommandWithSandboxWindows({
      command,
      group: getWindowsGroupRef(),
      sublayerGuid: config?.windows?.wfpSublayerGuid,
      httpProxyPort: hasNetworkConfig ? getProxyPort() : undefined,
      socksProxyPort: hasNetworkConfig ? getSocksProxyPort() : undefined,
      proxyAuthToken: hasNetworkConfig ? proxyAuthToken : undefined,
      binShell: parseWindowsBinShell(binShell),
    })
  }

  // macOS/Linux: delegate to the existing string wrapper, then put
  // the result behind `<shell> -c` so the caller's argv-spawn works.
  const wrapped = await wrapWithSandbox(
    command,
    binShell,
    customConfig,
    abortSignal,
  )
  const shell = binShell ?? '/bin/bash'
  return { argv: [shell, '-c', wrapped], env: process.env }
}

/**
 * Get the current sandbox configuration
 * @returns The current configuration, or undefined if not initialized
 */
function getConfig(): SandboxRuntimeConfig | undefined {
  return config
}

/**
 * Update the sandbox configuration in place.
 *
 * **Network/allowlist changes are a live swap**: the running
 * http/socks proxies read `config.network.allowedDomains` /
 * `deniedDomains` per-request (via `filterNetworkRequest`), so
 * reassigning `config` here takes effect on the next connection
 * with no proxy rebind and no port change — on every platform,
 * including Windows. This is what lets a host enable/deny domains
 * for already-running sandboxed children.
 *
 * Filesystem changes (denyRead/denyWrite) are NOT applied live:
 * macOS bakes them into the seatbelt profile at wrap time, and
 * Windows will need an explicit re-stamp. To change FS
 * restrictions, reset() then initialize() with the new config.
 *
 * @param newConfig - The new configuration to use
 */
function updateConfig(newConfig: SandboxRuntimeConfig): void {
  if (destinationResolver !== undefined) {
    assertDestinationGuardRoutesCompatible(newConfig.network)
  }
  // Deep clone the config to avoid mutations. structuredClone cannot clone
  // functions, so pull filterRequest out, clone the rest, and put it back —
  // a function reference is immutable in the sense that matters here.
  const {
    filterRequest,
    resolveDestination: _ignoredResolver,
    inheritProxyEnv: _ignoredProxyEnvAuthority,
    ...rest
  } = newConfig.network
  config = structuredClone({ ...newConfig, network: rest })
  config.network.filterRequest = filterRequest
  config.network.resolveDestination = destinationResolver
  if (destinationResolver !== undefined) config.network.inheritProxyEnv = false
  // Re-resolve parent proxy so hot-reload picks up changes. Note: the proxy
  // servers capture `parentProxy` by value at creation, so changes here take
  // effect only on re-initialize. This keeps the state consistent for the
  // next initialize() call.
  parentProxy =
    destinationResolver === undefined
      ? resolveParentProxy(
          newConfig.network.parentProxy,
          newConfig.network.inheritProxyEnv !== false,
        )
      : undefined
  logForDebugging('Sandbox configuration updated')
}

/**
 * Lightweight cleanup to call after each sandboxed command completes.
 *
 * On Linux, bwrap creates empty files on the host filesystem as mount points
 * when protecting non-existent deny paths (e.g. ~/.bashrc, ~/.gitconfig).
 * These persist after bwrap exits. This function removes them.
 *
 * Safe to call on any platform — it's a no-op on macOS.
 * Also called automatically by reset() and on process exit as safety nets.
 */
function cleanupAfterCommand(): void {
  cleanupBwrapMountPoints()
}

/**
 * Forcibly close an http.Server, including any in-flight requests.
 *
 * Plain `server.close()` waits for every active request to finish.
 * The proxy may be mid-upstream-request when reset() runs (e.g. a test's
 * curl was killed by --max-time while the proxy was still dialing the
 * real example.com / api.github.com), and `dialDirect()` allows up to
 * 30s before giving up. Combined with a socat fork that hasn't yet seen
 * its unix-socket EOF, that leaves a fully-open inbound connection and
 * `server.close()` never calls back. `closeAllConnections()` (Node 18.2+,
 * also implemented in Bun) tears down ordinary HTTP sockets, while the
 * explicit accepted-socket registry also covers CONNECT-upgraded tunnels.
 */
export interface ForceCloseHttpServer {
  close(callback: (error?: Error) => void): unknown
  closeAllConnections?(): void
}

export function forceCloseHttpServer(server: ForceCloseHttpServer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let closeCallbackReturned = false
    let orderingComplete = false
    let pendingTrackedDrains = 0
    const settle = () => {
      if (
        closeCallbackReturned &&
        orderingComplete &&
        pendingTrackedDrains === 0
      ) {
        resolve()
      }
    }
    const close = () =>
      server.close(error => {
        if (error && error.message !== 'Server is not running.') {
          logForDebugging(`Error closing HTTP proxy server: ${error.message}`, {
            level: 'error',
          })
          reject(error)
          return
        }
        closeCallbackReturned = true
        settle()
      })
    const closeAllConnections = () => server.closeAllConnections?.()
    const destroyTrackedConnections = () => {
      pendingTrackedDrains += 1
      void destroyTrackedHttpProxyConnections(
        server as ReturnType<typeof createHttpProxyServer>,
      ).then(
        () => {
          pendingTrackedDrains -= 1
          settle()
        },
        reject,
      )
    }

    try {
      if (typeof (globalThis as { Bun?: unknown }).Bun === 'object') {
        // Bun detaches the underlying handle in close(), so force-close its
        // established connections first or close() can wait indefinitely.
        closeAllConnections()
        destroyTrackedConnections()
        close()
        // A connection can arrive after the pre-close drain but before close()
        // detaches the listener. Drain that final fixed set as well.
        destroyTrackedConnections()
      } else {
        // Node can accept a new connection between closeAllConnections() and
        // close(). Stop acceptance first, then force-close the fixed set.
        close()
        closeAllConnections()
        destroyTrackedConnections()
      }
      orderingComplete = true
      settle()
    } catch (error) {
      reject(error)
    }
  })
}

async function resetUnserialized(): Promise<void> {
  const launchCloseResults = await Promise.allSettled(
    [...activeLaunchAuthorities].map(authority =>
      closeLaunchAuthorityUnserialized(authority),
    ),
  )
  let launchCleanupFailed = launchCloseResults.some(result => {
    if (result.status === 'fulfilled') return false
    logForDebugging(`Error closing launch authority: ${String(result.reason)}`, {
      level: 'error',
    })
    return true
  })
  // Abort guarded resolution/dial work before closing proxy listeners. Lease
  // release is idempotent, so later socket close events cannot revive state.
  resetDestinationGuardConnections()

  // Clean up any leftover bwrap mount points. Force past the
  // active-sandbox counter — reset() means the session is over.
  cleanupBwrapMountPoints({ force: true })

  // Stop log monitor
  if (logMonitorShutdown) {
    logMonitorShutdown()
    logMonitorShutdown = undefined
  }

  if (managerContext?.linuxBridge) {
    const {
      httpSocketPath,
      socksSocketPath,
      httpBridgeProcess,
      socksBridgeProcess,
    } = managerContext.linuxBridge

    // Kill both bridges and wait for them to exit
    await Promise.all([
      stopLinuxBridgeProcess(httpBridgeProcess, 'HTTP'),
      stopLinuxBridgeProcess(socksBridgeProcess, 'SOCKS'),
    ])

    // Clean up sockets
    if (httpSocketPath) {
      try {
        fs.rmSync(httpSocketPath, { force: true })
        logForDebugging('Cleaned up HTTP socket')
      } catch (err) {
        logForDebugging(`HTTP socket cleanup error: ${err}`, {
          level: 'error',
        })
      }
    }

    if (socksSocketPath) {
      try {
        fs.rmSync(socksSocketPath, { force: true })
        logForDebugging('Cleaned up SOCKS socket')
      } catch (err) {
        logForDebugging(`SOCKS socket cleanup error: ${err}`, {
          level: 'error',
        })
      }
    }
  }

  // Close servers in parallel (only if they exist, i.e., were started by us)
  const closePromises: Promise<void>[] = []

  if (mitmCA) {
    closePromises.push(disposeMitmCA(mitmCA))
  }

  if (httpProxyServer) {
    closePromises.push(forceCloseHttpServer(httpProxyServer))
  }

  if (socksProxyServer) {
    const socksClose = socksProxyServer.close().catch((error: Error) => {
      logForDebugging(`Error closing SOCKS proxy server: ${error.message}`, {
        level: 'error',
      })
    })
    closePromises.push(socksClose)
  }

  // Wait for all servers to close
  await Promise.all(closePromises)

  // Clear references
  httpProxyServer = undefined
  proxyAuthToken = undefined
  socksProxyServer = undefined
  managerContext = undefined
  initializationPromise = undefined
  parentProxy = undefined
  mitmCA = undefined
  config = undefined
  destinationResolver = undefined
  sentinelRegistry.clear()
  if (launchAuthorityRegistry !== undefined) {
    try {
      if (!launchAuthorityRegistry.releaseGeneration()) {
        launchCleanupFailed = true
      } else {
        launchAuthorityRegistry = undefined
        launchAuthorityRegistryPath = undefined
        launchAuthorityGenerationId = undefined
      }
    } catch (error) {
      launchCleanupFailed = true
      logForDebugging(`Error releasing launch authority generation: ${String(error)}`, {
        level: 'error',
      })
    }
  }
  if (launchCleanupFailed) {
    throw new Error('one or more launch authorities failed to close')
  }
}

function reset(): Promise<void> {
  if (launchResetPromise !== undefined) return launchResetPromise
  launchAuthorityAccepting = false
  launchAuthorityEpoch += 1
  const operation = launchLifecycleTail.then(() => resetUnserialized())
  launchResetPromise = operation
  for (const authority of activeLaunchAuthorities) {
    authority.cleanupPromise ??= operation
  }
  launchLifecycleTail = operation.then(
    () => undefined,
    () => undefined,
  )
  void operation.then(
    () => {
      if (launchResetPromise === operation) launchResetPromise = undefined
    },
    () => {
      if (launchResetPromise === operation) launchResetPromise = undefined
    },
  )
  return operation
}

function getSandboxViolationStore() {
  return sandboxViolationStore
}

function annotateStderrWithSandboxFailures(
  command: string,
  stderr: string,
): string {
  if (!config) {
    return stderr
  }

  const violations = sandboxViolationStore.getViolationsForCommand(command)
  if (violations.length === 0) {
    return stderr
  }

  let annotated = stderr
  annotated += EOL + '<sandbox_violations>' + EOL
  for (const violation of violations) {
    annotated += violation.line + EOL
  }
  annotated += '</sandbox_violations>'

  return annotated
}

/**
 * Returns glob patterns from Edit/Read permission rules that are not
 * fully supported on Linux. Returns empty array on macOS or when
 * sandboxing is disabled.
 *
 * Patterns ending with /** are excluded since they work as subpaths.
 */
function getLinuxGlobPatternWarnings(): string[] {
  // Only warn on Linux/WSL (bubblewrap doesn't support globs)
  // macOS supports glob patterns via regex conversion
  if (getPlatform() !== 'linux' || !config || config.filesystem.disabled) {
    return []
  }

  const globPatterns: string[] = []

  // Check filesystem paths for glob patterns
  // Note: denyRead is excluded because globs are now expanded to concrete paths on Linux
  const allPaths = [
    ...config.filesystem.allowWrite,
    ...config.filesystem.denyWrite,
  ]

  for (const path of allPaths) {
    // Strip trailing /** since that's just a subpath (directory and everything under it)
    const pathWithoutTrailingStar = removeTrailingGlobSuffix(path)

    // Only warn if there are still glob characters after removing trailing /**
    if (containsGlobChars(pathWithoutTrailingStar)) {
      globPatterns.push(path)
    }
  }

  return globPatterns
}

// ============================================================================
// Public API Interface
// ============================================================================

/**
 * Interface for the sandbox manager API
 */
export interface ISandboxManager {
  initialize(
    runtimeConfig: SandboxRuntimeConfig,
    sandboxAskCallback?: SandboxAskCallback,
    enableLogMonitor?: boolean,
  ): Promise<void>
  isSupportedPlatform(): boolean
  isSandboxingEnabled(): boolean
  checkDependencies(ripgrepConfig?: {
    command: string
    args?: string[]
  }): SandboxDependencyCheck
  getFsReadConfig(): FsReadRestrictionConfig
  getFsWriteConfig(): FsWriteRestrictionConfig
  getNetworkRestrictionConfig(): NetworkRestrictionConfig
  getAllowUnixSockets(): string[] | undefined
  getAllowLocalBinding(): boolean | undefined
  getAllowMachLookup(): string[] | undefined
  getIgnoreViolations(): Record<string, string[]> | undefined
  getEnableWeakerNestedSandbox(): boolean | undefined
  getProxyPort(): number | undefined
  getProxyAuthToken(): string | undefined
  getSocksProxyPort(): number | undefined
  getLinuxHttpSocketPath(): string | undefined
  getLinuxSocksSocketPath(): string | undefined
  waitForNetworkInitialization(): Promise<boolean>
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>
  getSandboxViolationStore(): SandboxViolationStore
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  getLinuxGlobPatternWarnings(): string[]
  getConfig(): SandboxRuntimeConfig | undefined
  getMitmCA(): MitmCA | undefined
  getSentinelRegistry(): SentinelRegistry
  updateConfig(newConfig: SandboxRuntimeConfig): void
  supportsLaunchAuthority(): boolean
  launchAuthorityCapacityAvailable(): boolean
  initializeLaunchAuthority(endpointRegistryPath: string): void
  prepareLaunchAuthority(
    runtimeConfig: SandboxRuntimeConfig,
    options: LaunchAuthorityOptions,
  ): Promise<PreparedLaunchAuthority>
  cleanupAfterCommand(): void
  reset(): Promise<void>
}

// ============================================================================
// Export as Namespace with Interface
// ============================================================================

/**
 * Global sandbox manager that handles both network and filesystem restrictions
 * for this session. This runs outside of the sandbox, on the host machine.
 */
export const SandboxManager: ISandboxManager = {
  initialize,
  isSupportedPlatform,
  isSandboxingEnabled,
  checkDependencies,
  getFsReadConfig,
  getFsWriteConfig,
  getNetworkRestrictionConfig,
  getAllowUnixSockets,
  getAllowLocalBinding,
  getAllowMachLookup,
  getIgnoreViolations,
  getEnableWeakerNestedSandbox,
  getProxyPort,
  getProxyAuthToken,
  getSocksProxyPort,
  getLinuxHttpSocketPath,
  getLinuxSocksSocketPath,
  waitForNetworkInitialization,
  wrapWithSandbox,
  wrapWithSandboxArgv,
  cleanupAfterCommand,
  reset,
  getMitmCA: () => mitmCA,
  getSentinelRegistry: () => sentinelRegistry,
  getSandboxViolationStore,
  annotateStderrWithSandboxFailures,
  getLinuxGlobPatternWarnings,
  getConfig,
  updateConfig,
  supportsLaunchAuthority,
  launchAuthorityCapacityAvailable,
  initializeLaunchAuthority,
  prepareLaunchAuthority,
} as const
