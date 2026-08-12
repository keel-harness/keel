import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { stopLinuxBridgeProcess } from '../../src/sandbox/linux-sandbox-utils.js'

describe('Linux bridge process-group cleanup', () => {
  it.skipIf(process.platform === 'win32')(
    'waits for and force-reaps a forked descendant that ignores SIGTERM',
    async () => {
      const parent = spawn(
        process.execPath,
        [
          '-e',
          [
            "const { spawn } = require('node:child_process')",
            "const child = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\", () => {}); process.stdout.write(\\\"ready\\\"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] })",
            "child.stdout.once('data', () => process.stdout.write(String(child.pid) + '\\n'))",
            "process.on('SIGTERM', () => process.exit(0))",
            'setInterval(() => {}, 1000)',
          ].join(';'),
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'inherit'] },
      )
      if (parent.pid === undefined || parent.stdout === null) {
        throw new Error('process-group fixture did not start')
      }
      const groupId = parent.pid
      try {
        await once(parent.stdout, 'data')
        const startedAt = Date.now()
        await stopLinuxBridgeProcess(parent, 'test')

        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400)
        expect(() => process.kill(-groupId, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        )
      } finally {
        try {
          process.kill(-groupId, 'SIGKILL')
        } catch {
          // The expected path already reaped the entire process group.
        }
      }
    },
    5_000,
  )
})
