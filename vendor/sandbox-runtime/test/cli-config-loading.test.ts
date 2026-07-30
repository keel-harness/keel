import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadConfig, loadConfigFromString } from '../src/utils/config-loader.js'

describe('loadConfig', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'))
    configPath = path.join(tmpDir, 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should return null when file does not exist', () => {
    const result = loadConfig('/nonexistent/path/config.json')
    expect(result).toBeNull()
  })

  it('should return null for empty file', () => {
    fs.writeFileSync(configPath, '')
    const result = loadConfig(configPath)
    expect(result).toBeNull()
  })

  it('should return null for whitespace-only file', () => {
    fs.writeFileSync(configPath, '   \n\t  ')
    const result = loadConfig(configPath)
    expect(result).toBeNull()
  })

  it('should return null and log error for invalid JSON', () => {
    fs.writeFileSync(configPath, '{ invalid json }')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = loadConfig(configPath)

    expect(result).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid JSON'),
    )
    consoleSpy.mockRestore()
  })

  it('should return null and log Zod errors for invalid schema', () => {
    // Valid JSON but missing required fields
    fs.writeFileSync(configPath, JSON.stringify({ network: {} }))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = loadConfig(configPath)

    expect(result).toBeNull()
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid configuration'),
    )
    consoleSpy.mockRestore()
  })

  it('should return valid config for valid file', () => {
    const validConfig = {
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }
    fs.writeFileSync(configPath, JSON.stringify(validConfig))

    const result = loadConfig(configPath)

    expect(result).not.toBeNull()
    expect(result?.network.allowedDomains).toContain('example.com')
  })
})

describe('loadConfigFromString', () => {
  it('should return null for empty string', () => {
    const result = loadConfigFromString('')
    expect(result).toBeNull()
  })

  it('should return null for whitespace-only string', () => {
    const result = loadConfigFromString('   \n\t  ')
    expect(result).toBeNull()
  })

  it('should return null for invalid JSON', () => {
    const result = loadConfigFromString('{ invalid json }')
    expect(result).toBeNull()
  })

  it('should return null for valid JSON with invalid schema', () => {
    // Valid JSON but missing required fields
    const result = loadConfigFromString(JSON.stringify({ network: {} }))
    expect(result).toBeNull()
  })

  it('should return valid config for valid JSON', () => {
    const validConfig = {
      network: { allowedDomains: ['example.com'], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }
    const result = loadConfigFromString(JSON.stringify(validConfig))

    expect(result).not.toBeNull()
    expect(result?.network.allowedDomains).toContain('example.com')
  })
})
