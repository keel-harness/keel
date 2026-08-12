import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const lease = first.reserve(['tcp:127.0.0.1:61001', 'unix:/private/bridge-a.sock'])

    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      entries: {
        [lease.leaseId]: {
          generationId: 'generation-a',
          state: 'active',
          endpoints: ['tcp:127.0.0.1:61001', 'unix:/private/bridge-a.sock'],
        },
      },
    })

    const second = new EndpointLeaseRegistry(path, { generationId: 'generation-b' })
    second.claimGeneration()
    second.recoverPriorGenerations()
    expect(second.excludedEndpoints()).toEqual(
      new Set(['tcp:127.0.0.1:61001', 'unix:/private/bridge-a.sock']),
    )
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[lease.leaseId].state).toBe(
      'tombstone',
    )
    expect(second.releaseGeneration()).toBe(true)
  })

  it('keeps a concurrent live Warden active and excluded until its own cleanup', () => {
    const path = join(privateRoot(), 'leases.json')
    const first = new EndpointLeaseRegistry(path, { generationId: 'generation-live-a' })
    first.claimGeneration()
    first.recoverPriorGenerations()
    const lease = first.reserve(['tcp:127.0.0.1:61004'])

    const second = new EndpointLeaseRegistry(path, { generationId: 'generation-live-b' })
    second.claimGeneration()
    second.recoverPriorGenerations()
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[lease.leaseId]).toMatchObject({
      generationId: 'generation-live-a',
      state: 'active',
    })
    expect(second.excludedEndpoints()).toEqual(new Set(['tcp:127.0.0.1:61004']))
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
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')).entries)).toEqual([
      expect.objectContaining({ state: 'active' }),
    ])
    expect(live.releaseGeneration()).toBe(true)

    child.kill('SIGKILL')
    await once(child, 'close')
    const restart = new EndpointLeaseRegistry(path, {
      generationId: 'process-generation-restart',
    })
    restart.claimGeneration()
    restart.recoverPriorGenerations()
    expect(restart.excludedEndpoints()).toContain(endpoint)
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')).entries)).toEqual([
      expect.objectContaining({ state: 'tombstone' }),
    ])
    expect(restart.releaseGeneration()).toBe(true)
  })

  it('deletes only its exact active lease after structurally clean completion', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, { generationId: 'generation-clean' })
    registry.claimGeneration()
    registry.recoverPriorGenerations()
    const lease = registry.reserve(['tcp:127.0.0.1:61002'])

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
    const lease = registry.reserve(['tcp:127.0.0.1:61003'])

    expect(registry.retire(lease)).toBe(true)
    expect(registry.retire(lease)).toBe(true)
    expect(registry.releaseClean(lease)).toBe(false)
    expect(() => registry.reserve(['tcp:127.0.0.1:61003'])).toThrow(/already reserved/u)
    expect(registry.excludedEndpoints()).toEqual(new Set(['tcp:127.0.0.1:61003']))
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
      registry.reserve(
        Array.from({ length: 9 }, (_value, index) =>
          `tcp:127.0.0.1:${String(62000 + index)}`,
        ),
      ),
    ).toThrow(/invalid endpoint lease endpoints/u)
    expect(registry.excludedEndpoints()).toEqual(new Set())
    expect(registry.releaseGeneration()).toBe(true)
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
    writeFileSync(corruptPath, '{"version":1,"entries":[]}', { mode: 0o600 })
    const corrupt = new EndpointLeaseRegistry(corruptPath, {
      generationId: 'generation-corrupt',
    })
    corrupt.claimGeneration()
    expect(() => corrupt.recoverPriorGenerations()).toThrow(/invalid endpoint lease registry/u)
    expect(() => corrupt.releaseGeneration()).toThrow(/invalid endpoint lease registry/u)
  })
})
