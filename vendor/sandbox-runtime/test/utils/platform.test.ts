import { describe, test, expect } from 'bun:test'
import { getPlatform, getWslVersion } from '../../src/utils/platform.js'

describe('platform utilities', () => {
  describe('getWslVersion', () => {
    test('returns undefined on non-linux platforms', () => {
      if (process.platform === 'linux') {
        // On Linux, it might be WSL or not - skip this test
        return
      }
      expect(getWslVersion()).toBeUndefined()
    })
  })

  describe('getPlatform', () => {
    test('returns macos on darwin', () => {
      if (process.platform === 'darwin') {
        expect(getPlatform()).toBe('macos')
      }
    })

    test('returns windows on win32', () => {
      if (process.platform === 'win32') {
        expect(getPlatform()).toBe('windows')
      }
    })

    test('returns linux on linux', () => {
      if (process.platform === 'linux') {
        expect(getPlatform()).toBe('linux')
      }
    })
  })
})
