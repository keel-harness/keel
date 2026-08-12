import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { basename, dirname, isAbsolute, join } from 'node:path'

const REGISTRY_VERSION = 2 as const
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024
const MAX_ENDPOINT_LENGTH = 1024
const MAX_LEGACY_ENDPOINTS = 65_536
const GENERATION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const LOCK_WAIT_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 5
const PORT_MIN = 40_000
const PORT_MAX = 65_535
const PORT_COUNT = PORT_MAX - PORT_MIN + 1
const PORT_BITMAP_BYTES = PORT_COUNT / 8
const MAX_ACTIVE_LEASES = PORT_COUNT / 2
const TCP_ENDPOINT_PATTERN = /^tcp:127\.0\.0\.1:(\d{5})$/u

interface DurableActiveLease {
  readonly generationId: string
  readonly ports: readonly [number, number]
}

interface DurableRegistry {
  readonly version: typeof REGISTRY_VERSION
  retiredPortBitmap: string
  readonly active: Record<string, DurableActiveLease>
  readonly legacyExcludedEndpoints: string[]
}

interface FileOwner {
  readonly pid: number
  readonly generationId: string
  readonly nonce: string
}

export interface EndpointLease {
  readonly leaseId: string
  readonly generationId: string
  readonly ports: readonly [number, number]
}

export interface EndpointLeaseRegistryOptions {
  readonly generationId: string
  readonly createLeaseId?: () => string
  readonly pid?: number
}

export class EndpointLeaseCapacityError extends Error {
  readonly code = 'SRT_LAUNCH_AUTHORITY_CAPACITY' as const

  constructor() {
    super('endpoint lease registry capacity exhausted')
    this.name = 'EndpointLeaseCapacityError'
  }
}

function invalidRegistry(): never {
  throw new Error('invalid endpoint lease registry')
}

function assertOwnerOnlyDirectory(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new Error('endpoint lease registry requires an existing owner-only directory')
  }
  const currentUid = process.getuid?.()
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (currentUid !== undefined && stat.uid !== currentUid)
  ) {
    throw new Error('endpoint lease registry requires an owner-only directory')
  }
}

function assertOwnerOnlyRegularFile(path: string): void {
  const stat = lstatSync(path)
  const currentUid = process.getuid?.()
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (currentUid !== undefined && stat.uid !== currentUid) ||
    stat.size > MAX_REGISTRY_BYTES
  ) {
    invalidRegistry()
  }
}

function validateEndpoint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ENDPOINT_LENGTH &&
    !/\p{Cc}/u.test(value)
  )
}

function portFromEndpoint(endpoint: string): number | undefined {
  const match = TCP_ENDPOINT_PATTERN.exec(endpoint)
  if (match === null) return undefined
  const port = Number(match[1])
  return port >= PORT_MIN && port <= PORT_MAX ? port : undefined
}

function endpointFromPort(port: number): string {
  return `tcp:127.0.0.1:${String(port)}`
}

function decodeBitmap(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==)?$/u.test(value)) {
    return invalidRegistry()
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== PORT_BITMAP_BYTES || decoded.toString('base64') !== value) {
    return invalidRegistry()
  }
  return decoded
}

function emptyBitmap(): Buffer {
  return Buffer.alloc(PORT_BITMAP_BYTES)
}

function bitmapHas(bitmap: Buffer, port: number): boolean {
  const index = port - PORT_MIN
  return (bitmap[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0
}

function bitmapSet(bitmap: Buffer, port: number): void {
  const index = port - PORT_MIN
  bitmap[Math.floor(index / 8)]! |= 1 << (index % 8)
}

function parseV1Registry(record: Record<string, unknown>): DurableRegistry {
  if (
    typeof record.entries !== 'object' ||
    record.entries === null ||
    Array.isArray(record.entries)
  ) {
    return invalidRegistry()
  }
  const entries = record.entries as Record<string, unknown>
  if (Object.keys(entries).length > 65_536) return invalidRegistry()
  const bitmap = emptyBitmap()
  const legacy = new Set<string>()
  for (const [leaseId, rawEntry] of Object.entries(entries)) {
    if (
      !GENERATION_PATTERN.test(leaseId) ||
      typeof rawEntry !== 'object' ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    ) {
      return invalidRegistry()
    }
    const entry = rawEntry as Record<string, unknown>
    if (
      typeof entry.generationId !== 'string' ||
      !GENERATION_PATTERN.test(entry.generationId) ||
      (entry.state !== 'active' && entry.state !== 'tombstone') ||
      !Array.isArray(entry.endpoints) ||
      entry.endpoints.length === 0 ||
      entry.endpoints.length > 8 ||
      entry.endpoints.some(endpoint => !validateEndpoint(endpoint))
    ) {
      return invalidRegistry()
    }
    for (const endpoint of entry.endpoints as string[]) {
      const port = portFromEndpoint(endpoint)
      if (port === undefined) legacy.add(endpoint)
      else bitmapSet(bitmap, port)
    }
  }
  if (legacy.size > MAX_LEGACY_ENDPOINTS) return invalidRegistry()
  return {
    version: REGISTRY_VERSION,
    retiredPortBitmap: bitmap.toString('base64'),
    active: {},
    legacyExcludedEndpoints: [...legacy].sort(),
  }
}

function parseRegistry(raw: string): DurableRegistry {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return invalidRegistry()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalidRegistry()
  }
  const record = parsed as Record<string, unknown>
  if (record.version === 1) return parseV1Registry(record)
  if (
    record.version !== REGISTRY_VERSION ||
    typeof record.active !== 'object' ||
    record.active === null ||
    Array.isArray(record.active) ||
    !Array.isArray(record.legacyExcludedEndpoints)
  ) {
    return invalidRegistry()
  }
  const bitmap = decodeBitmap(record.retiredPortBitmap)
  const rawActive = record.active as Record<string, unknown>
  const activeKeys = Object.keys(rawActive)
  if (activeKeys.length > MAX_ACTIVE_LEASES) return invalidRegistry()
  const active: Record<string, DurableActiveLease> = {}
  const activePorts = new Set<number>()
  for (const leaseId of activeKeys) {
    const rawEntry = rawActive[leaseId]
    if (
      !GENERATION_PATTERN.test(leaseId) ||
      typeof rawEntry !== 'object' ||
      rawEntry === null ||
      Array.isArray(rawEntry)
    ) {
      return invalidRegistry()
    }
    const entry = rawEntry as Record<string, unknown>
    if (
      typeof entry.generationId !== 'string' ||
      !GENERATION_PATTERN.test(entry.generationId) ||
      !Array.isArray(entry.ports) ||
      entry.ports.length !== 2 ||
      entry.ports.some(
        port => !Number.isInteger(port) || (port as number) < PORT_MIN || (port as number) > PORT_MAX,
      ) ||
      entry.ports[0] === entry.ports[1]
    ) {
      return invalidRegistry()
    }
    const ports = entry.ports as [number, number]
    if (
      ports.some(port => activePorts.has(port) || bitmapHas(bitmap, port))
    ) {
      return invalidRegistry()
    }
    for (const port of ports) activePorts.add(port)
    active[leaseId] = { generationId: entry.generationId, ports: [...ports] }
  }
  const legacy = record.legacyExcludedEndpoints
  if (
    legacy.length > MAX_LEGACY_ENDPOINTS ||
    legacy.some(endpoint => !validateEndpoint(endpoint) || portFromEndpoint(endpoint) !== undefined) ||
    new Set(legacy).size !== legacy.length
  ) {
    return invalidRegistry()
  }
  return {
    version: REGISTRY_VERSION,
    retiredPortBitmap: bitmap.toString('base64'),
    active,
    legacyExcludedEndpoints: [...legacy] as string[],
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parseFileOwner(path: string): FileOwner {
  assertOwnerOnlyRegularFile(path)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('endpoint lease registry owner is unavailable')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('endpoint lease registry owner is unavailable')
  }
  const owner = value as Record<string, unknown>
  if (
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.generationId !== 'string' ||
    !GENERATION_PATTERN.test(owner.generationId) ||
    typeof owner.nonce !== 'string' ||
    !/^[0-9a-f]{48}$/u.test(owner.nonce)
  ) {
    throw new Error('endpoint lease registry owner is unavailable')
  }
  return {
    pid: owner.pid,
    generationId: owner.generationId,
    nonce: owner.nonce,
  }
}

function ownersMatch(left: FileOwner, right: FileOwner): boolean {
  return (
    left.pid === right.pid &&
    left.generationId === right.generationId &&
    left.nonce === right.nonce
  )
}

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))
function boundedLockWait(): void {
  Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_MS)
}

export class EndpointLeaseRegistry {
  readonly #path: string
  readonly #lockPath: string
  readonly #ownerDirectory: string
  readonly #ownerPath: string
  readonly #generationId: string
  readonly #createLeaseId: () => string
  readonly #pid: number
  #generationOwner: FileOwner | undefined

  constructor(path: string, options: EndpointLeaseRegistryOptions) {
    if (!GENERATION_PATTERN.test(options.generationId)) {
      throw new Error('invalid endpoint lease generation')
    }
    if (!isAbsolute(path) || basename(path).length === 0) {
      throw new Error('endpoint lease registry path must be absolute')
    }
    assertOwnerOnlyDirectory(dirname(path))
    this.#path = path
    this.#lockPath = `${path}.lock`
    this.#ownerDirectory = `${path}.generations`
    this.#ownerPath = join(this.#ownerDirectory, `${options.generationId}.owner`)
    this.#generationId = options.generationId
    this.#createLeaseId =
      options.createLeaseId ?? (() => randomBytes(24).toString('hex'))
    this.#pid = options.pid ?? process.pid
  }

  claimGeneration(): void {
    if (this.#generationOwner !== undefined) {
      throw new Error('endpoint lease registry generation is already claimed')
    }
    try {
      mkdirSync(this.#ownerDirectory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    assertOwnerOnlyDirectory(this.#ownerDirectory)
    const owner: FileOwner = {
      pid: this.#pid,
      generationId: this.#generationId,
      nonce: randomBytes(24).toString('hex'),
    }
    this.#claimOwner(owner)
    this.#generationOwner = owner
  }

  releaseGeneration(): boolean {
    const owner = this.#generationOwner
    if (owner === undefined) return false
    const hasActiveLease = this.#withLock(() =>
      Object.values(this.#read().active).some(
        entry => entry.generationId === this.#generationId,
      ),
    )
    if (hasActiveLease) return false
    let current: FileOwner
    try {
      current = parseFileOwner(this.#ownerPath)
    } catch {
      return false
    }
    if (!ownersMatch(current, owner)) return false
    try {
      unlinkSync(this.#ownerPath)
    } catch {
      return false
    }
    this.#generationOwner = undefined
    return true
  }

  recoverPriorGenerations(): void {
    this.#assertGenerationClaimed()
    this.#mutate(registry => {
      const bitmap = decodeBitmap(registry.retiredPortBitmap)
      for (const [leaseId, entry] of Object.entries(registry.active)) {
        if (
          entry.generationId !== this.#generationId &&
          !this.#generationIsAlive(entry.generationId)
        ) {
          for (const port of entry.ports) bitmapSet(bitmap, port)
          delete registry.active[leaseId]
        }
      }
      registry.retiredPortBitmap = bitmap.toString('base64')
      return undefined
    })
  }

  reserve(endpoints: readonly string[]): EndpointLease {
    this.#assertGenerationClaimed()
    const ports = this.#validateEndpointPair(endpoints)
    return this.#mutate(registry => {
      this.#assertAvailable(registry, ports)
      const leaseId = this.#createLeaseId()
      if (!GENERATION_PATTERN.test(leaseId) || registry.active[leaseId] !== undefined) {
        throw new Error('invalid endpoint lease identity')
      }
      registry.active[leaseId] = {
        generationId: this.#generationId,
        ports,
      }
      return { leaseId, generationId: this.#generationId, ports }
    })
  }

  releaseClean(lease: EndpointLease): boolean {
    this.#assertGenerationClaimed()
    return this.#mutate(registry => {
      const entry = registry.active[lease.leaseId]
      if (!this.#matchesActiveLease(entry, lease)) return false
      delete registry.active[lease.leaseId]
      return true
    })
  }

  retire(lease: EndpointLease): boolean {
    this.#assertGenerationClaimed()
    return this.#mutate(registry => {
      const entry = registry.active[lease.leaseId]
      const bitmap = decodeBitmap(registry.retiredPortBitmap)
      if (entry === undefined) {
        return (
          lease.generationId === this.#generationId &&
          lease.ports.every(port => bitmapHas(bitmap, port))
        )
      }
      if (!this.#matchesActiveLease(entry, lease)) return false
      for (const port of entry.ports) bitmapSet(bitmap, port)
      registry.retiredPortBitmap = bitmap.toString('base64')
      delete registry.active[lease.leaseId]
      return true
    })
  }

  excludedEndpoints(): ReadonlySet<string> {
    this.#assertGenerationClaimed()
    return this.#withLock(() => {
      const registry = this.#read()
      const bitmap = decodeBitmap(registry.retiredPortBitmap)
      const endpoints = new Set(registry.legacyExcludedEndpoints)
      for (let port = PORT_MIN; port <= PORT_MAX; port++) {
        if (bitmapHas(bitmap, port)) endpoints.add(endpointFromPort(port))
      }
      for (const entry of Object.values(registry.active)) {
        for (const port of entry.ports) endpoints.add(endpointFromPort(port))
      }
      return endpoints
    })
  }

  isTcpPortExcluded(port: number): boolean {
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) return false
    this.#assertGenerationClaimed()
    return this.#withLock(() => {
      const registry = this.#read()
      if (bitmapHas(decodeBitmap(registry.retiredPortBitmap), port)) return true
      return Object.values(registry.active).some(entry => entry.ports.includes(port))
    })
  }

  capacityAvailable(): boolean {
    this.#assertGenerationClaimed()
    return this.#withLock(() => {
      const registry = this.#read()
      const bitmap = decodeBitmap(registry.retiredPortBitmap)
      const activePorts = new Set(
        Object.values(registry.active).flatMap(entry => [...entry.ports]),
      )
      let available = 0
      for (let port = PORT_MIN; port <= PORT_MAX && available < 2; port++) {
        if (!bitmapHas(bitmap, port) && !activePorts.has(port)) available += 1
      }
      return available >= 2
    })
  }

  assertCapacityAvailable(): void {
    if (!this.capacityAvailable()) throw new EndpointLeaseCapacityError()
  }

  #validateEndpointPair(endpoints: readonly string[]): readonly [number, number] {
    if (!Array.isArray(endpoints) || endpoints.length !== 2) {
      throw new Error('invalid endpoint lease endpoints')
    }
    const ports = endpoints.map(endpoint =>
      typeof endpoint === 'string' ? portFromEndpoint(endpoint) : undefined,
    )
    if (ports[0] === undefined || ports[1] === undefined || ports[0] === ports[1]) {
      throw new Error('invalid endpoint lease endpoints')
    }
    return [ports[0], ports[1]]
  }

  #assertGenerationClaimed(): void {
    if (this.#generationOwner === undefined) {
      throw new Error('endpoint lease registry generation is not claimed')
    }
  }

  #generationIsAlive(generationId: string): boolean {
    const ownerPath = join(this.#ownerDirectory, `${generationId}.owner`)
    try {
      const owner = parseFileOwner(ownerPath)
      if (owner.generationId !== generationId) {
        throw new Error('endpoint lease registry owner is unavailable')
      }
      return processIsAlive(owner.pid)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  #claimOwner(owner: FileOwner): void {
    const deadline = performance.now() + LOCK_WAIT_TIMEOUT_MS
    while (performance.now() < deadline) {
      try {
        const fd = openSync(
          this.#ownerPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        )
        try {
          writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8')
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      let existing: FileOwner
      try {
        existing = parseFileOwner(this.#ownerPath)
      } catch {
        throw new Error('endpoint lease registry generation owner is unavailable')
      }
      if (processIsAlive(existing.pid)) {
        throw new Error('endpoint lease registry generation owner is unavailable')
      }
      if (!this.#unlinkExactDeadOwner(this.#ownerPath)) boundedLockWait()
    }
    throw new Error('endpoint lease registry generation owner is unavailable')
  }

  #matchesActiveLease(
    entry: DurableActiveLease | undefined,
    lease: EndpointLease,
  ): entry is DurableActiveLease {
    return (
      entry?.generationId === this.#generationId &&
      lease.generationId === this.#generationId &&
      entry.ports[0] === lease.ports[0] &&
      entry.ports[1] === lease.ports[1]
    )
  }

  #assertAvailable(registry: DurableRegistry, ports: readonly [number, number]): void {
    const bitmap = decodeBitmap(registry.retiredPortBitmap)
    if (
      ports.some(
        port =>
          bitmapHas(bitmap, port) ||
          Object.values(registry.active).some(entry => entry.ports.includes(port)),
      )
    ) {
      throw new Error('endpoint is already reserved')
    }
  }

  #mutate<T>(callback: (registry: DurableRegistry) => T): T {
    return this.#withLock(() => {
      const registry = this.#read()
      const result = callback(registry)
      this.#write(registry)
      return result
    })
  }

  #read(): DurableRegistry {
    try {
      assertOwnerOnlyRegularFile(this.#path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          version: REGISTRY_VERSION,
          retiredPortBitmap: emptyBitmap().toString('base64'),
          active: {},
          legacyExcludedEndpoints: [],
        }
      }
      throw error
    }
    return parseRegistry(readFileSync(this.#path, 'utf8'))
  }

  #write(registry: DurableRegistry): void {
    const directory = dirname(this.#path)
    const tempPath = join(
      directory,
      `.${basename(this.#path)}.${this.#generationId}.${randomBytes(12).toString('hex')}.tmp`,
    )
    const serialized = `${JSON.stringify(registry)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REGISTRY_BYTES) {
      throw new Error('endpoint lease registry capacity exhausted')
    }
    let fd: number | undefined
    try {
      fd = openSync(
        tempPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      )
      writeFileSync(fd, serialized, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tempPath, this.#path)
      const dirFd = openSync(directory, constants.O_RDONLY)
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try {
        unlinkSync(tempPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  #withLock<T>(callback: () => T): T {
    const lock = this.#acquireLock()
    try {
      return callback()
    } finally {
      closeSync(lock.fd)
      try {
        const current = parseFileOwner(this.#lockPath)
        if (ownersMatch(current, lock.owner)) unlinkSync(this.#lockPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  #acquireLock(): { fd: number; owner: FileOwner } {
    const owner: FileOwner = {
      pid: this.#pid,
      generationId: this.#generationId,
      nonce: randomBytes(24).toString('hex'),
    }
    const deadline = performance.now() + LOCK_WAIT_TIMEOUT_MS
    while (performance.now() < deadline) {
      try {
        const fd = openSync(
          this.#lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        )
        try {
          writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8')
          fsyncSync(fd)
        } catch (error) {
          closeSync(fd)
          try {
            unlinkSync(this.#lockPath)
          } catch {
            // The incomplete lock stays fail-closed if it cannot be removed.
          }
          throw error
        }
        return { fd, owner }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      let existing: FileOwner
      try {
        existing = parseFileOwner(this.#lockPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error('endpoint lease registry lock is unavailable')
      }
      if (processIsAlive(existing.pid)) {
        boundedLockWait()
        continue
      }
      if (!this.#unlinkExactDeadOwner(this.#lockPath)) boundedLockWait()
    }
    throw new Error('endpoint lease registry lock is unavailable')
  }

  /**
   * Remove a dead owner without a rename-to-canonical rollback. The private
   * hard link pins the exact inode we inspected; the canonical name can be
   * unlinked only while it still names that inode and no competing reclaimer
   * has linked it. A replacement live owner is therefore never overwritten.
   */
  #unlinkExactDeadOwner(path: string): boolean {
    const claimedPath = `${path}.dead.${randomBytes(12).toString('hex')}`
    try {
      try {
        linkSync(path, claimedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
      const claimed = parseFileOwner(claimedPath)
      if (processIsAlive(claimed.pid)) return false
      let canonicalStat
      try {
        canonicalStat = lstatSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
      const claimedStat = lstatSync(claimedPath)
      if (
        canonicalStat.dev !== claimedStat.dev ||
        canonicalStat.ino !== claimedStat.ino ||
        claimedStat.nlink !== 2
      ) {
        return false
      }
      unlinkSync(path)
      return true
    } finally {
      try {
        unlinkSync(claimedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
