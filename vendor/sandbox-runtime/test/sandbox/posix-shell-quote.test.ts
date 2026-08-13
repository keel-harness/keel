import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { quotePosixShellArgs } from '../../src/sandbox/posix-shell-quote.js'

describe('POSIX shell quoting', () => {
  it('preserves literal exclamation marks through a rendered command-string argument', () => {
    const expected = [
      'plain',
      'literal!bang',
      'literal!==comparison',
      'literal\\!backslash-bang',
      "quote'value!bang",
      '',
    ]
    const observer = [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      '--',
      ...expected,
    ]
    const renderedObserver = quotePosixShellArgs(observer)
    const renderedOuter = quotePosixShellArgs(['/bin/sh', '-c', renderedObserver])

    const child = spawnSync('/bin/sh', ['-c', renderedOuter], { encoding: 'utf8' })

    expect(child.status, child.stderr).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual(expected)
  })
})
