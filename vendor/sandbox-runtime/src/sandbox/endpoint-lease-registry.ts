import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'

const REGISTRY_VERSION = 1 as const
const MAX_REGISTRY_BYTES = 1024 * 1024
const MAX_ENDPOINT_LENGTH = 1024
const MAX_ENDPOINTS_PER_LEASE = 8
const MAX_ENTRIES = 65_536
const GENERATION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const MAX_LOCK_ATTEMPTS = 64
const LOCK_RETRY_MS = 2

type LeaseState = 'active' | 'tombstone'

interface DurableLeaseEntry {
  readonly generationId: string
  readonly state: LeaseState
  readonly endpoints: string[]
}

interface DurableRegistry {
  readonly version: typeof REGISTRY_VERSION
  readonly entries: Record<string, DurableLeaseEntry>
}

interface FileOwner {
  readonly pid: number
  readonly generationId: string
  readonly nonce: string
}

export interface EndpointLease {
  readonly leaseId: string
  readonly generationId: string
}

export interface EndpointLeaseRegistryOptions {
  readonly generationId: string
  readonly createLeaseId?: () => string
  readonly pid?: number
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
  if (
    record.version !== REGISTRY_VERSION ||
    typeof record.entries !== 'object' ||
    record.entries === null ||
    Array.isArray(record.entries)
  ) {
    return invalidRegistry()
  }
  const rawEntries = record.entries as Record<string, unknown>
  const keys = Object.keys(rawEntries)
  if (keys.length > MAX_ENTRIES) return invalidRegistry()
  const entries: Record<string, DurableLeaseEntry> = {}
  for (const leaseId of keys) {
    const rawEntry = rawEntries[leaseId]
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
      entry.endpoints.length > MAX_ENDPOINTS_PER_LEASE ||
      entry.endpoints.some(endpoint => !validateEndpoint(endpoint)) ||
      new Set(entry.endpoints).size !== entry.endpoints.length
    ) {
      return invalidRegistry()
    }
    entries[leaseId] = {
      generationId: entry.generationId,
      state: entry.state,
      endpoints: [...entry.endpoints] as string[],
    }
  }
  return { version: REGISTRY_VERSION, entries }
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
      Object.values(this.#read().entries).some(
        entry =>
          entry.state === 'active' && entry.generationId === this.#generationId,
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
      for (const [leaseId, entry] of Object.entries(registry.entries)) {
        if (
          entry.state === 'active' &&
          entry.generationId !== this.#generationId &&
          !this.#generationIsAlive(entry.generationId)
        ) {
          registry.entries[leaseId] = { ...entry, state: 'tombstone' }
        }
      }
      return undefined
    })
  }

  reserve(endpoints: readonly string[]): EndpointLease {
    this.#assertGenerationClaimed()
    const normalized = this.#validateEndpoints(endpoints)
    return this.#mutate(registry => {
      this.#assertAvailable(registry, normalized)
      const leaseId = this.#createLeaseId()
      if (!GENERATION_PATTERN.test(leaseId) || registry.entries[leaseId] !== undefined) {
        throw new Error('invalid endpoint lease identity')
      }
      registry.entries[leaseId] = {
        generationId: this.#generationId,
        state: 'active',
        endpoints: normalized,
      }
      return { leaseId, generationId: this.#generationId }
    })
  }

  releaseClean(lease: EndpointLease): boolean {
    this.#assertGenerationClaimed()
    return this.#mutate(registry => {
      const entry = registry.entries[lease.leaseId]
      if (!this.#matchesActiveLease(entry, lease)) return false
      delete registry.entries[lease.leaseId]
      return true
    })
  }

  retire(lease: EndpointLease): boolean {
    this.#assertGenerationClaimed()
    return this.#mutate(registry => {
      const entry = registry.entries[lease.leaseId]
      if (
        entry?.state === 'tombstone' &&
        entry.generationId === this.#generationId &&
        lease.generationId === this.#generationId
      ) {
        return true
      }
      if (!this.#matchesActiveLease(entry, lease)) return false
      registry.entries[lease.leaseId] = { ...entry, state: 'tombstone' }
      return true
    })
  }

  excludedEndpoints(): ReadonlySet<string> {
    this.#assertGenerationClaimed()
    return this.#withLock(() => {
      const registry = this.#read()
      return new Set(Object.values(registry.entries).flatMap(entry => entry.endpoints))
    })
  }

  #validateEndpoints(endpoints: readonly string[]): string[] {
    if (
      !Array.isArray(endpoints) ||
      endpoints.length === 0 ||
      endpoints.length > MAX_ENDPOINTS_PER_LEASE ||
      endpoints.some(endpoint => !validateEndpoint(endpoint)) ||
      new Set(endpoints).size !== endpoints.length
    ) {
      throw new Error('invalid endpoint lease endpoints')
    }
    return [...endpoints]
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
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
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
      const claimedPath = `${this.#ownerPath}.dead.${randomBytes(12).toString('hex')}`
      try {
        renameSync(this.#ownerPath, claimedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error('endpoint lease registry generation owner is unavailable')
      }
      const claimed = parseFileOwner(claimedPath)
      if (processIsAlive(claimed.pid)) {
        try {
          renameSync(claimedPath, this.#ownerPath)
        } catch {
          // A concurrent live owner already won the canonical path. The
          // private claimed inode remains harmless and is never consulted.
        }
        throw new Error('endpoint lease registry generation owner is unavailable')
      }
      try {
        unlinkSync(claimedPath)
      } catch {
        // A private dead-owner inode cannot grant authority. Retry the
        // canonical exclusive create and fail closed if contention persists.
      }
    }
    throw new Error('endpoint lease registry generation owner is unavailable')
  }

  #matchesActiveLease(
    entry: DurableLeaseEntry | undefined,
    lease: EndpointLease,
  ): entry is DurableLeaseEntry {
    return (
      entry?.state === 'active' &&
      entry.generationId === this.#generationId &&
      lease.generationId === this.#generationId
    )
  }

  #assertAvailable(
    registry: DurableRegistry,
    endpoints: readonly string[],
    exceptLeaseId?: string,
  ): void {
    const excluded = new Set(
      Object.entries(registry.entries)
        .filter(([leaseId]) => leaseId !== exceptLeaseId)
        .flatMap(([, entry]) => entry.endpoints),
    )
    if (endpoints.some(endpoint => excluded.has(endpoint))) {
      throw new Error('endpoint is already reserved')
    }
  }

  #mutate<T>(callback: (registry: { version: 1; entries: Record<string, DurableLeaseEntry> }) => T): T {
    return this.#withLock(() => {
      const registry = this.#read()
      const result = callback(registry)
      this.#write(registry)
      return result
    })
  }

  #read(): { version: 1; entries: Record<string, DurableLeaseEntry> } {
    try {
      assertOwnerOnlyRegularFile(this.#path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: REGISTRY_VERSION, entries: {} }
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
      fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
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
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
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
      } catch {
        throw new Error('endpoint lease registry lock is unavailable')
      }
      if (processIsAlive(existing.pid)) {
        boundedLockWait()
        continue
      }
      const claimedPath = `${this.#lockPath}.dead.${randomBytes(12).toString('hex')}`
      try {
        renameSync(this.#lockPath, claimedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error('endpoint lease registry lock is unavailable')
      }
      const claimed = parseFileOwner(claimedPath)
      if (processIsAlive(claimed.pid)) {
        try {
          renameSync(claimedPath, this.#lockPath)
        } catch {
          // A canonical contender already exists; never replace it.
        }
        throw new Error('endpoint lease registry lock is unavailable')
      }
      try {
        unlinkSync(claimedPath)
      } catch {
        // The claimed dead inode is outside the authority path.
      }
    }
    throw new Error('endpoint lease registry lock is unavailable')
  }
}
