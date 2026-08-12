import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EndpointLeaseRegistry } from '../../src/sandbox/endpoint-lease-registry.js'

const roots: string[] = []

function privateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'keel-srt-endpoint-registry-'))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('per-launch endpoint lease registry', () => {
  it('persists an active lease before use and converts crash residue to a permanent tombstone', () => {
    const path = join(privateRoot(), 'leases.json')
    const first = new EndpointLeaseRegistry(path, { generationId: 'generation-a' })
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
    second.recoverPriorGenerations()
    expect(second.excludedEndpoints()).toEqual(
      new Set(['tcp:127.0.0.1:61001', 'unix:/private/bridge-a.sock']),
    )
    expect(JSON.parse(readFileSync(path, 'utf8')).entries[lease.leaseId].state).toBe(
      'tombstone',
    )
  })

  it('deletes only its exact active lease after structurally clean completion', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, { generationId: 'generation-clean' })
    registry.recoverPriorGenerations()
    const lease = registry.reserve(['tcp:127.0.0.1:61002'])

    expect(registry.releaseClean(lease)).toBe(true)
    expect(registry.excludedEndpoints()).toEqual(new Set())
    expect(registry.releaseClean(lease)).toBe(false)
  })

  it('does not let stale cleanup erase a newer tombstone or colliding authority', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, { generationId: 'generation-race' })
    registry.recoverPriorGenerations()
    const lease = registry.reserve(['tcp:127.0.0.1:61003'])

    expect(registry.retire(lease)).toBe(true)
    expect(registry.releaseClean(lease)).toBe(false)
    expect(() => registry.reserve(['tcp:127.0.0.1:61003'])).toThrow(/already reserved/u)
    expect(registry.excludedEndpoints()).toEqual(new Set(['tcp:127.0.0.1:61003']))
  })

  it('rejects an unbounded endpoint set before changing durable state', () => {
    const path = join(privateRoot(), 'leases.json')
    const registry = new EndpointLeaseRegistry(path, {
      generationId: 'generation-bounded',
    })
    registry.recoverPriorGenerations()

    expect(() =>
      registry.reserve(
        Array.from({ length: 9 }, (_value, index) =>
          `tcp:127.0.0.1:${String(62000 + index)}`,
        ),
      ),
    ).toThrow(/invalid endpoint lease endpoints/u)
    expect(registry.excludedEndpoints()).toEqual(new Set())
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
    expect(() => corrupt.recoverPriorGenerations()).toThrow(/invalid endpoint lease registry/u)
  })
})
