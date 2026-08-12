import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EndpointLeaseRegistry } from '../../src/sandbox/endpoint-lease-registry.js'

const roots: string[] = []
const children: ChildProcess[] = []

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keel-srt-endpoint-registry-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function leaseChild(
  registryPath: string,
  generationId: string,
  endpoint: string,
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      join(import.meta.dirname, 'endpoint-lease-child.ts'),
      registryPath,
      generationId,
      endpoint,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  )
  children.push(child)
  return child
}

async function childMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  const [message] = (await once(child, 'message')) as [unknown]
  if (typeof message !== 'object' || message === null) {
    throw new Error('endpoint lease child returned an invalid message')
  }
  return message as Record<string, unknown>
}

describe('per-launch endpoint lease registry', () => {
  it('persists an active lease before use and converts crash residue to a permanent tombstone', () => {
    const path = join(privateRoot(), 'leases.json')
    const first = new EndpointLeaseRegistry(path, {
      generationId: 'generation-a',
      pid: 2_147_483_647,
    })
    first.claimGeneration()
    first.recoverPriorGenerations()
    const lease = first.reserve(['tcp:127.0.0.1:61001', 'tcp:127.0.0.1:61002'])

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 2,
      active: {
        [lease.leaseId]: {
          generationId: 'generation-a',
          ports: [61001, 61002],
        },
      },
    })

    const second = new EndpointLeaseRegistry(path, { generationId: 'generation-b' })
    second.claimGeneration()
    second.recoverPriorGenerations()
    expect(second.excludedEndpoints()).toEqual(
      new Set(['tcp:127.0.0.1:61001', 'tcp:127.0.0.1:61002']),
    )
    expect(JSON.parse(readFileSync(path, 'utf8')).active).toEqual({})
    expect(second.releaseGeneration()).toBe(true)
  })

  it('keeps a concurrent live Warden active and excluded until its own cleanup', () => {
    const path = join(privateRoot(), 'leases.json')
    const first = new EndpointLeaseRegistry(path, { generationId: 'generation-live-a' })
    first.claimGeneration()
    first.recoverPriorGenerations()
    const lease = first.reserve(['tcp:127.0.0.1:61004', 'tcp:127.0.0.1:61005'])

    const second = new EndpointLeaseRegistry(path, { generationId: 'generation-live-b' })
    second.claimGeneration()
    second.recoverPriorGenerations()
    expect(JSON.parse(readFileSync(path, 'utf8')).active[lease.leaseId]).toMatchObject({
      generationId: 'generation-live-a',
      ports: [61004, 61005],
    })
    expect(second.excludedEndpoints()).toEqual(
      new Set(['tcp:127.0.0.1:61004', 'tcp:127.0.0.1:61005']),
    )
    expect(first.releaseClean(lease)).toBe(true)
    expect(first.releaseGeneration()).toBe(true)
    expect(second.releaseGeneration()).toBe(true)
  })

  it('serializes two real Warden processes without losing or reusing a reservation', async () => {
    const path = join(privateRoot(), 'leases.json')
    const endpoint = 'tcp:127.0.0.1:61005'
    const first = leaseChild(path, 'process-generation-a', endpoint)
    const second = leaseChild(path, 'process-generation-b', endpoint)
    const outcomes = await Promise.all([childMessage(first), childMessage(second)])

    expect(outcomes.filter(message => message.kind === 'ready')).toHaveLength(1)
    expect(outcomes.filter(message => message.kind === 'error')).toEqual([
      expect.objectContaining({ message: 'endpoint is already reserved' }),
    ])
    const winner = outcomes[0]!.kind === 'ready' ? first : second
    winner.send('release')
    await expect(childMessage(winner)).resolves.toMatchObject({
      kind: 'released',
      released: true,
      ownerReleased: true,
    })
  })

  it('waits through a bounded live critical section longer than the former retry window', async () => {
    const path = join(privateRoot(), 'leases.json')
    writeFileSync(
      `${path}.lock`,
      `${JSON.stringify({
        pid: process.pid,
        generationId: 'lock-holder',
        nonce: 'a'.repeat(48),
      })}\n`,
      { mode: 0o600 },
    )
    const child = leaseChild(
      path,
      'process-generation-waiter',
      'tcp:127.0.0.1:61010',
    )
    const started = performance.now()
    const release = setTimeout(() => unlinkSync(`${path}.lock`), 250)
    try {
      await expect(childMessage(child)).resolves.toMatchObject({ kind: 'ready' })
      expect(performance.now() - started).toBeGreaterThanOrEqual(200)
      child.send('release')
      await expect(childMessage(child)).resolves.toMatchObject({
        kind: 'released',
        released: true,
        ownerReleased: true,
      })
    } finally {
      clearTimeout(release)
    }
  })

  it('keeps a live process active, then tombstones its residue only after SIGKILL', async () => {
    const path = join(privateRoot(), 'leases.json')
    const endpoint = 'tcp:127.0.0.1:61006'
    const child = leaseChild(path, 'process-generation-crash', endpoint)
    await expect(childMessage(child)).resolves.toMatchObject({ kind: 'ready' })

    const live = new EndpointLeaseRegistry(path, {
      generationId: 'process-generation-observer',
    })
    live.claimGeneration()
    live.recoverPriorGenerations()
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')).active)).toHaveLength(1)
    expect(live.releaseGeneration()).toBe(true)

    child.kill('SIGKILL')
    await once(child, 'close')
    const restart = new EndpointLeaseRegistry(path, {
      generationId: 'process-generation-restart',
    })
    restart.claimGeneration()
    restart.recoverPriorGenerations()
    expect(restart.excludedEndpoints()).toContain(endpoint)
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')).active)).toEqual([])
    expect(restart.releaseGeneration()).toBe(true)
  })

  it('deletes only its exact active lease after structurally clean completion', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, { generationId: 'generation-clean' })
    registry.claimGeneration()
    registry.recoverPriorGenerations()
    const lease = registry.reserve(['tcp:127.0.0.1:61002', 'tcp:127.0.0.1:61003'])

    expect(registry.releaseClean(lease)).toBe(true)
    expect(registry.excludedEndpoints()).toEqual(new Set())
    expect(registry.releaseClean(lease)).toBe(false)
    expect(registry.releaseGeneration()).toBe(true)
  })

  it('does not let stale cleanup erase a newer tombstone or colliding authority', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, { generationId: 'generation-race' })
    registry.claimGeneration()
    registry.recoverPriorGenerations()
    const lease = registry.reserve(['tcp:127.0.0.1:61003', 'tcp:127.0.0.1:61004'])

    expect(registry.retire(lease)).toBe(true)
    expect(registry.retire(lease)).toBe(true)
    expect(registry.releaseClean(lease)).toBe(false)
    expect(() =>
      registry.reserve(['tcp:127.0.0.1:61003', 'tcp:127.0.0.1:61005']),
    ).toThrow(/already reserved/u)
    expect(registry.excludedEndpoints()).toEqual(
      new Set(['tcp:127.0.0.1:61003', 'tcp:127.0.0.1:61004']),
    )
    expect(registry.releaseGeneration()).toBe(true)
  })

  it('rejects an unbounded endpoint set before changing durable state', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, {
      generationId: 'generation-bounded',
    })
    registry.claimGeneration()
    registry.recoverPriorGenerations()

    expect(() =>
      registry.reserve(['tcp:127.0.0.1:62000']),
    ).toThrow(/invalid endpoint lease endpoints/u)
    expect(registry.excludedEndpoints()).toEqual(new Set())
    expect(registry.releaseGeneration()).toBe(true)
  })

  it('migrates every V1 exclusion without making a retired endpoint reusable', () => {
    const path = join(privateRoot(), 'leases.json')
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        entries: {
          legacy: {
            generationId: 'dead-generation',
            state: 'tombstone',
            endpoints: [
              'tcp:127.0.0.1:62001',
              'tcp:127.0.0.1:62002',
              'unix:/private/legacy-bridge.sock',
            ],
          },
        },
      })}\n`,
      { mode: 0o600 },
    )
    const registry = new EndpointLeaseRegistry(path, { generationId: 'migration-generation' })
    registry.claimGeneration()
    registry.recoverPriorGenerations()

    expect(registry.excludedEndpoints()).toEqual(
      new Set([
        'tcp:127.0.0.1:62001',
        'tcp:127.0.0.1:62002',
        'unix:/private/legacy-bridge.sock',
      ]),
    )
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 2,
      active: {},
      legacyExcludedEndpoints: ['unix:/private/legacy-bridge.sock'],
    })
    expect(() =>
      registry.reserve(['tcp:127.0.0.1:62001', 'tcp:127.0.0.1:62003']),
    ).toThrow(/already reserved/u)
  })

  it('keeps the maximum active port-pair state below its fixed byte cap', () => {
    const path = join(privateRoot(), 'leases.json')
    const generationId = 'g'.repeat(128)
    const active = Object.fromEntries(
      Array.from({ length: 12_768 }, (_value, index) => [
        `${'a'.repeat(43)}${String(index).padStart(5, '0')}`,
        {
          generationId,
          ports: [40_000 + index * 2, 40_001 + index * 2],
        },
      ]),
    )
    const serialized = `${JSON.stringify({
      version: 2,
      retiredPortBitmap: Buffer.alloc(3_192).toString('base64'),
      active,
      legacyExcludedEndpoints: [],
    })}\n`
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(4 * 1024 * 1024)
    writeFileSync(path, serialized, { mode: 0o600 })
    const registry = new EndpointLeaseRegistry(path, { generationId })
    registry.claimGeneration()
    registry.recoverPriorGenerations()

    expect(registry.excludedEndpoints().size).toBe(25_536)
    expect(() =>
      registry.reserve(['tcp:127.0.0.1:40000', 'tcp:127.0.0.1:40001']),
    ).toThrow(/already reserved/u)
  })

  it('fails closed for unsafe authority roots and malformed durable state', () => {
    expect(
      () =>
        new EndpointLeaseRegistry('leases.json', {
          generationId: 'generation-relative',
        }),
    ).toThrow(/absolute/u)

    const unsafeRoot = privateRoot()
    chmodSync(unsafeRoot, 0o755)
    expect(
      () =>
        new EndpointLeaseRegistry(join(unsafeRoot, 'leases.json'), {
          generationId: 'generation-unsafe',
        }),
    ).toThrow(/owner-only/u)

    const corruptRoot = privateRoot()
    const corruptPath = join(corruptRoot, 'leases.json')
    writeFileSync(corruptPath, '{"version":2,"active":[]}', { mode: 0o600 })
    const corrupt = new EndpointLeaseRegistry(corruptPath, {
      generationId: 'generation-corrupt',
    })
    corrupt.claimGeneration()
    expect(() => corrupt.recoverPriorGenerations()).toThrow(/invalid endpoint lease registry/u)
    expect(() => corrupt.releaseGeneration()).toThrow(/invalid endpoint lease registry/u)
  })
})
