import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const race = vi.hoisted(() => ({
  armedPath: undefined as string | undefined,
  replacement: undefined as string | undefined,
  fired: false,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    linkSync(existingPath: string, newPath: string) {
      actual.linkSync(existingPath, newPath)
      if (race.armedPath === existingPath && race.replacement !== undefined) {
        race.fired = true
        actual.unlinkSync(existingPath)
        actual.writeFileSync(existingPath, race.replacement, {
          encoding: 'utf8',
          mode: 0o600,
        })
      }
    },
  }
})

const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
const { EndpointLeaseRegistry } = await import(
  '../../src/sandbox/endpoint-lease-registry.js'
)

const roots: string[] = []

afterEach(() => {
  race.armedPath = undefined
  race.replacement = undefined
  race.fired = false
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('endpoint lease owner reclamation identity', () => {
  it('does not unlink a newer live owner that replaces the dead inode mid-reclaim', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'keel-srt-owner-aba-'))
    fs.chmodSync(root, 0o700)
    roots.push(root)
    const registryPath = join(root, 'leases.json')
    const ownerDirectory = `${registryPath}.generations`
    fs.mkdirSync(ownerDirectory, { mode: 0o700 })
    const ownerPath = join(ownerDirectory, 'generation-race.owner')
    fs.writeFileSync(
      ownerPath,
      `${JSON.stringify({
        pid: 2_147_483_647,
        generationId: 'generation-race',
        nonce: 'a'.repeat(48),
      })}\n`,
      { mode: 0o600 },
    )
    const liveOwner = `${JSON.stringify({
      pid: process.pid,
      generationId: 'generation-race',
      nonce: 'b'.repeat(48),
    })}\n`
    race.armedPath = ownerPath
    race.replacement = liveOwner

    const registry = new EndpointLeaseRegistry(registryPath, {
      generationId: 'generation-race',
    })

    expect(() => registry.claimGeneration()).toThrow(/owner is unavailable/u)
    expect(race.fired).toBe(true)
    expect(fs.readFileSync(ownerPath, 'utf8')).toBe(liveOwner)
  })
})
