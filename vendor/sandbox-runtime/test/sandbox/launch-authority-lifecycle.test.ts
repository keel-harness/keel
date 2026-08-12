import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as platform from '../../src/utils/platform.js'
import {
  LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS,
  SandboxManager,
  settleLaunchAuthorityDrain,
} from '../../src/sandbox/sandbox-manager.js'
import type { SandboxRuntimeConfig } from '../../src/sandbox/sandbox-config.js'
import {
  cleanupBwrapMountPoints,
  cleanupBwrapMountPointsOnProcessExit,
  wrapCommandWithSandboxLinux,
} from '../../src/sandbox/linux-sandbox-utils.js'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await SandboxManager.reset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('launch authority cleanup deadline', () => {
  it('does not register competing process-owned teardown handlers during initialization', async () => {
    vi.spyOn(platform, 'getPlatform').mockReturnValue('linux')
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-listener-registration-')),
    )
    roots.push(root)
    const fakeSocat = join(root, 'socat')
    writeFileSync(
      fakeSocat,
      `#!/usr/bin/env node
const fs = require('node:fs')
const address = process.argv[2]?.match(/^UNIX-LISTEN:([^,]+)/)?.[1]
if (!address) process.exit(64)
fs.writeFileSync(address, '')
setInterval(() => {}, 1000)
`,
      { mode: 0o700 },
    )
    const before = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    }
    await SandboxManager.initialize({
      network: {
        httpProxyPort: 41_001,
        socksProxyPort: 41_002,
        inheritProxyEnv: false,
      },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      bwrapPath: '/usr/bin/true',
      socatPath: fakeSocat,
      ripgrep: { command: '/usr/bin/true' },
      enableWeakerNestedSandbox: true,
    })

    expect(process.listenerCount('exit')).toBe(before.exit)
    expect(process.listenerCount('SIGINT')).toBe(before.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
  })

  it('preserves Linux deny-mount sources on exit while a launch may remain active', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-exit-preserve-')),
    )
    chmodSync(root, 0o700)
    roots.push(root)
    const deniedPath = join(root, 'credential-helper')

    await wrapCommandWithSandboxLinux({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { allowOnly: [root], denyWithinAllow: [deniedPath] },
      binShell: '/bin/sh',
      bwrapPath: '/usr/bin/true',
      enableWeakerNestedSandbox: true,
      allowAllUnixSockets: true,
    })
    writeFileSync(deniedPath, '')

    cleanupBwrapMountPointsOnProcessExit()
    expect(existsSync(deniedPath)).toBe(true)
    cleanupBwrapMountPoints()
    expect(existsSync(deniedPath)).toBe(false)
  })

  it('balances failed Linux wrapping through the safe mountpoint cleanup path', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-failed-wrap-')),
    )
    chmodSync(root, 0o700)
    roots.push(root)
    const deniedPath = join(root, 'credential-helper')

    await expect(
      wrapCommandWithSandboxLinux({
        command: 'true',
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig: { allowOnly: [root], denyWithinAllow: [deniedPath] },
        binShell: 'keel-definitely-missing-shell',
        bwrapPath: '/usr/bin/true',
        enableWeakerNestedSandbox: true,
        allowAllUnixSockets: true,
      }),
    ).rejects.toThrow(/not found in PATH/)

    await wrapCommandWithSandboxLinux({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { allowOnly: [root], denyWithinAllow: [deniedPath] },
      binShell: '/bin/sh',
      bwrapPath: '/usr/bin/true',
      enableWeakerNestedSandbox: true,
      allowAllUnixSockets: true,
    })
    writeFileSync(deniedPath, '')
    cleanupBwrapMountPoints()
    expect(existsSync(deniedPath)).toBe(false)
  })

  it('removes generated nested-deny bind sources after a successful Linux launch settles', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-nested-deny-cleanup-')),
    )
    chmodSync(root, 0o700)
    roots.push(root)
    const scratch = join(root, 'tmp')
    mkdirSync(scratch, { mode: 0o700 })
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = scratch
    try {
      await wrapCommandWithSandboxLinux({
        command: 'true',
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig: {
          allowOnly: [root],
          denyWithinAllow: [join(root, 'missing', 'credential-helper')],
        },
        binShell: '/bin/sh',
        bwrapPath: '/usr/bin/true',
        enableWeakerNestedSandbox: true,
        allowAllUnixSockets: true,
      })

      expect(readdirSync(scratch)).toHaveLength(1)
      cleanupBwrapMountPoints()
      expect(readdirSync(scratch)).toHaveLength(0)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
    }
  })

  it('removes generated nested-deny bind sources when Linux wrapping fails', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-nested-deny-failure-')),
    )
    chmodSync(root, 0o700)
    roots.push(root)
    const scratch = join(root, 'tmp')
    mkdirSync(scratch, { mode: 0o700 })
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = scratch
    try {
      await expect(
        wrapCommandWithSandboxLinux({
          command: 'true',
          needsNetworkRestriction: false,
          readConfig: undefined,
          writeConfig: {
            allowOnly: [root],
            denyWithinAllow: [join(root, 'missing', 'credential-helper')],
          },
          binShell: 'keel-definitely-missing-shell',
          bwrapPath: '/usr/bin/true',
          enableWeakerNestedSandbox: true,
          allowAllUnixSockets: true,
        }),
      ).rejects.toThrow(/not found in PATH/)

      expect(readdirSync(scratch)).toHaveLength(0)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
    }
  })

  it('forgets a failed Linux wrap path before a legitimate empty file appears there', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-failed-wrap-stale-path-')),
    )
    chmodSync(root, 0o700)
    roots.push(root)
    const deniedPath = join(root, 'credential-helper')

    await expect(
      wrapCommandWithSandboxLinux({
        command: 'true',
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig: { allowOnly: [root], denyWithinAllow: [deniedPath] },
        binShell: 'keel-definitely-missing-shell',
        bwrapPath: '/usr/bin/true',
        enableWeakerNestedSandbox: true,
        allowAllUnixSockets: true,
      }),
    ).rejects.toThrow(/not found in PATH/)

    writeFileSync(deniedPath, '')
    cleanupBwrapMountPoints()
    expect(existsSync(deniedPath)).toBe(true)
  })

  it('does not let a concurrent failed wrap transfer path ownership to a live launch', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'keel-linux-concurrent-failed-wrap-')),
    )
    chmodSync(root, 0o700)
    roots.push(root)
    const liveDeniedPath = join(root, 'live-credential-helper')
    const failedDeniedPath = join(root, 'failed-credential-helper')

    await wrapCommandWithSandboxLinux({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: {
        allowOnly: [root],
        denyWithinAllow: [liveDeniedPath],
      },
      binShell: '/bin/sh',
      bwrapPath: '/usr/bin/true',
      enableWeakerNestedSandbox: true,
      allowAllUnixSockets: true,
    })
    await expect(
      wrapCommandWithSandboxLinux({
        command: 'true',
        needsNetworkRestriction: false,
        readConfig: undefined,
        writeConfig: {
          allowOnly: [root],
          denyWithinAllow: [failedDeniedPath],
        },
        binShell: 'keel-definitely-missing-shell',
        bwrapPath: '/usr/bin/true',
        enableWeakerNestedSandbox: true,
        allowAllUnixSockets: true,
      }),
    ).rejects.toThrow(/not found in PATH/)

    writeFileSync(liveDeniedPath, '')
    writeFileSync(failedDeniedPath, '')
    cleanupBwrapMountPoints()

    expect(existsSync(liveDeniedPath)).toBe(false)
    expect(existsSync(failedDeniedPath)).toBe(true)
  })

  it('fails closed at the absolute two-second bound when any drain never settles', async () => {
    vi.useFakeTimers()
    const neverSettles = new Promise<void>(() => undefined)
    const result = settleLaunchAuthorityDrain([
      Promise.resolve(),
      neverSettles,
    ])
    let settled = false
    void result.finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(LAUNCH_AUTHORITY_DRAIN_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBe(false)
  })

  it('wraps Linux endpointless deny-all without dereferencing bridge authority', async () => {
    vi.spyOn(platform, 'getPlatform').mockReturnValue('linux')
    const root = mkdtempSync(join(tmpdir(), 'keel-linux-endpointless-'))
    chmodSync(root, 0o700)
    roots.push(root)
    const registryPath = join(root, 'endpoint-leases.json')
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: [],
        deniedDomains: ['*'],
        strictAllowlist: true,
        inheritProxyEnv: false,
        resolveDestination: async () => [],
      },
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
      bwrapPath: '/usr/bin/true',
      ripgrep: { command: '/usr/bin/true' },
    }
    const manager = SandboxManager as typeof SandboxManager & {
      initializeLaunchAuthority(endpointRegistryPath: string): void
      prepareLaunchAuthority(
        runtimeConfig: SandboxRuntimeConfig,
        options: {
          command: string
          binShell?: string
          endpointRegistryPath: string
        },
      ): Promise<{
        argv: string[]
        revoke(): Promise<void>
        release(): Promise<void>
        cleanup(): Promise<void>
      }>
    }
    manager.initializeLaunchAuthority(registryPath)

    const launch = await manager.prepareLaunchAuthority(config, {
      command: 'true',
      binShell: '/bin/bash',
      endpointRegistryPath: registryPath,
    })
    try {
      const rendered = launch.argv.join(' ')
      expect(rendered).toContain('--unshare-net')
      expect(rendered).not.toContain('keel-http-')
      expect(rendered).not.toContain('keel-socks-')
    } finally {
      await launch.revoke()
      await launch.cleanup()
      await launch.release()
    }
  })

  it('releases only the failed Linux wrap count when reset races preparation', async () => {
    vi.spyOn(platform, 'getPlatform').mockReturnValue('linux')
    const root = mkdtempSync(join(tmpdir(), 'keel-linux-prepare-reset-'))
    chmodSync(root, 0o700)
    roots.push(root)
    const registryPath = join(root, 'endpoint-leases.json')
    const deniedPath = join(root, 'missing-secret')
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: [],
        deniedDomains: ['*'],
        strictAllowlist: true,
        inheritProxyEnv: false,
        resolveDestination: async () => [],
      },
      filesystem: {
        denyRead: [deniedPath],
        allowRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      bwrapPath: '/usr/bin/true',
      ripgrep: { command: '/usr/bin/true' },
    }
    const manager = SandboxManager as typeof SandboxManager & {
      initializeLaunchAuthority(endpointRegistryPath: string): void
      prepareLaunchAuthority(
        runtimeConfig: SandboxRuntimeConfig,
        options: { command: string; binShell?: string; endpointRegistryPath: string },
      ): Promise<unknown>
    }
    manager.initializeLaunchAuthority(registryPath)

    const preparing = manager.prepareLaunchAuthority(config, {
      command: 'true',
      binShell: '/bin/bash',
      endpointRegistryPath: registryPath,
    })
    const resetting = manager.reset()

    await expect(preparing).rejects.toThrow(/stopped/u)
    await expect(resetting).resolves.toBeUndefined()
    expect(existsSync(deniedPath)).toBe(false)
  })

  it('reports only a completely fulfilled drain as clean', async () => {
    await expect(
      settleLaunchAuthorityDrain([Promise.resolve(), Promise.resolve()]),
    ).resolves.toBe(true)
    await expect(
      settleLaunchAuthorityDrain([
        Promise.resolve(),
        Promise.reject(new Error('bridge close failed')),
      ]),
    ).resolves.toBe(false)
  })
})
