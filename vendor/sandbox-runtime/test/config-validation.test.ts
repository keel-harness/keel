import { describe, test, expect } from 'bun:test'
import { SandboxRuntimeConfigSchema } from '../src/sandbox/sandbox-config.js'

describe('Config Validation', () => {
  test('should validate a valid minimal config', () => {
    const config = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test('should validate a config with valid domains', () => {
    const config = {
      network: {
        allowedDomains: ['example.com', '*.github.com', 'localhost'],
        deniedDomains: ['evil.com'],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test('should reject invalid domain patterns', () => {
    const config = {
      network: {
        allowedDomains: ['not-a-domain'],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test('should reject domain with protocol', () => {
    const config = {
      network: {
        allowedDomains: ['https://example.com'],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test('should reject empty filesystem paths', () => {
    const config = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [''],
        allowWrite: [],
        denyWrite: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test('should validate config with optional fields', () => {
    const config = {
      network: {
        allowedDomains: ['example.com'],
        deniedDomains: [],
        allowUnixSockets: ['/var/run/docker.sock'],
        allowAllUnixSockets: false,
        allowLocalBinding: true,
      },
      filesystem: {
        denyRead: ['/etc/shadow'],
        allowWrite: ['/tmp'],
        denyWrite: ['/etc'],
      },
      ignoreViolations: {
        '*': ['/usr/bin'],
        'git push': ['/usr/bin/nc'],
      },
      enableWeakerNestedSandbox: true,
      enableWeakerNetworkIsolation: false,
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test('should reject missing required fields', () => {
    const config = {
      network: {
        allowedDomains: [],
      },
      filesystem: {
        denyRead: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })

  test('should validate wildcard domains correctly', () => {
    const validWildcards = ['*.example.com', '*.github.io', '*.co.uk']

    const invalidWildcards = [
      '*example.com', // Missing dot after asterisk
      '*.com', // No subdomain
      '*.', // Invalid format
    ]

    for (const domain of validWildcards) {
      const config = {
        network: { allowedDomains: [domain], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      }
      const result = SandboxRuntimeConfigSchema.safeParse(config)
      expect(result.success).toBe(true)
    }

    for (const domain of invalidWildcards) {
      const config = {
        network: { allowedDomains: [domain], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      }
      const result = SandboxRuntimeConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    }
  })

  test('should validate config with enableWeakerNetworkIsolation', () => {
    const config = {
      network: {
        allowedDomains: ['example.com'],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      enableWeakerNetworkIsolation: true,
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enableWeakerNetworkIsolation).toBe(true)
    }
  })

  test('should validate config with allowAppleEvents', () => {
    const config = {
      network: {
        allowedDomains: ['example.com'],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      allowAppleEvents: true,
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.allowAppleEvents).toBe(true)
    }
  })

  test('should validate config with custom ripgrep command', () => {
    const config = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      ripgrep: {
        command: '/usr/local/bin/rg',
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ripgrep?.command).toBe('/usr/local/bin/rg')
    }
  })

  test('should validate config with custom ripgrep command and args', () => {
    const config = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
      ripgrep: {
        command: 'claude',
        args: ['--ripgrep'],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ripgrep?.command).toBe('claude')
      expect(result.data.ripgrep?.args).toEqual(['--ripgrep'])
    }
  })

  test('should accept valid allowMachLookup entries', () => {
    const config = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowMachLookup: [
          '2BUA8C4S2C.com.1password.*',
          'com.apple.CoreSimulator.CoreSimulatorService',
          '*',
        ],
      },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  test.each(['com.*.foo', 'com.example.**'])(
    'should reject allowMachLookup entry with non-trailing wildcard: %s',
    entry => {
      const config = {
        network: {
          allowedDomains: [],
          deniedDomains: [],
          allowMachLookup: [entry],
        },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      }

      const result = SandboxRuntimeConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
    },
  )

  test('should use default ripgrep command when not specified', () => {
    const config = {
      network: {
        allowedDomains: [],
        deniedDomains: [],
      },
      filesystem: {
        denyRead: [],
        allowWrite: [],
        denyWrite: [],
      },
    }

    const result = SandboxRuntimeConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ripgrep).toBeUndefined()
    }
  })

  describe('bwrapPath / socatPath', () => {
    const base = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }

    test('accepts absolute paths', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        bwrapPath: '/usr/local/bin/bwrap',
        socatPath: '/opt/tools/socat',
      })
      expect(result.success).toBe(true)
    })

    test('rejects relative bwrapPath', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        bwrapPath: 'bwrap',
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('must be absolute')
      }
    })

    test('rejects relative socatPath', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        socatPath: './bin/socat',
      })
      expect(result.success).toBe(false)
    })

    test('rejects empty bwrapPath', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        bwrapPath: '',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('credentials', () => {
    const base = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }

    test('is optional — config without it validates and stays undefined', () => {
      const result = SandboxRuntimeConfigSchema.safeParse(base)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.credentials).toBeUndefined()
      }
    })

    test('accepts file and env var entries with deny mode', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {
          files: [
            { path: '~/.netrc', mode: 'deny' },
            { path: '~/.aws', mode: 'deny' },
          ],
          envVars: [
            { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' },
            { name: 'GH_TOKEN', mode: 'deny' },
          ],
        },
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.credentials?.files).toHaveLength(2)
        expect(result.data.credentials?.envVars).toHaveLength(2)
      }
    })

    test('rejects mode "allow" — no longer a valid mode', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {
          files: [{ path: '~/.aws', mode: 'allow' }],
        },
      })
      expect(result.success).toBe(false)
    })

    test('accepts an empty credentials object', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {},
      })
      expect(result.success).toBe(true)
    })

    test('rejects mode "mask" for files with an actionable message', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {
          files: [{ path: '~/.config/gh/hosts.yml', mode: 'mask' }],
        },
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message).join('\n')
        expect(messages).toContain('not supported for files yet')
        expect(messages).toContain('"mask"')
      }
    })

    test('accepts mode "mask" for env vars when tlsTerminate is enabled', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask' }],
        },
      })
      expect(result.success).toBe(true)
    })

    test('rejects mode "mask" for env vars without tlsTerminate', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: { allowedDomains: ['api.github.com'], deniedDomains: [] },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask' }],
        },
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message).join('\n')
        expect(messages).toContain('tlsTerminate')
        expect(messages).toContain('allowPlaintextInject')
      }
    })

    test('allowPlaintextInject permits mask without tlsTerminate', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: { allowedDomains: ['api.github.com'], deniedDomains: [] },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask' }],
          allowPlaintextInject: true,
        },
      })
      expect(result.success).toBe(true)
    })

    test('accepts a masked env var with no injectHosts (defaults to allowedDomains)', () => {
      // No per-entry injectHosts — the credential defaults to
      // network.allowedDomains (injection at every reachable host).
      // injectHosts is an optional narrowing.
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask' }],
        },
      })
      expect(result.success).toBe(true)
    })

    test('rejects a masked env var whose per-entry injectHosts is explicitly empty', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask', injectHosts: [] }],
        },
      })
      // An explicit empty list would mean "mask but never inject", which
      // is self-contradictory.
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map(i => i.message).join('\n')
        expect(messages).toContain('explicitly empty')
        expect(messages).toContain('masked but never injected')
      }
    })

    test('rejects block-level credentials.injectHosts (removed key)', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask' }],
          injectHosts: ['api.github.com'],
        },
      })
      // The block-level default no longer exists; the schema is strict so
      // a stale config fails rather than silently widening the credential
      // to every allowedDomain.
      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find(
          i => i.path.join('.') === 'credentials',
        )
        expect(issue?.message).toContain('injectHosts')
      }
    })

    test('accepts a masked env var with per-entry injectHosts', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['registry.npmjs.org'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'NPM_TOKEN',
              mode: 'mask',
              injectHosts: ['registry.npmjs.org'],
            },
          ],
        },
      })
      expect(result.success).toBe(true)
    })

    test('rejects per-entry injectHosts not reachable via allowedDomains', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'NPM_TOKEN',
              mode: 'mask',
              injectHosts: ['registry.npmjs.org'],
            },
          ],
        },
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find(i =>
          i.path.join('.').startsWith('credentials.envVars.0.injectHosts'),
        )
        expect(issue?.message).toContain('registry.npmjs.org')
        expect(issue?.message).toContain('network.allowedDomains')
      }
    })

    test('rejects overly-broad wildcards in per-entry injectHosts', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: { ...base.network, tlsTerminate: {} },
        credentials: {
          envVars: [{ name: 'GH_TOKEN', mode: 'mask', injectHosts: ['*.com'] }],
        },
      })
      expect(result.success).toBe(false)
    })

    test('injectHosts on a deny-mode entry is accepted (ignored)', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: { allowedDomains: ['api.github.com'], deniedDomains: [] },
        credentials: {
          envVars: [
            { name: 'GH_TOKEN', mode: 'deny', injectHosts: ['api.github.com'] },
          ],
        },
      })
      expect(result.success).toBe(true)
    })

    test('accepts per-entry injectHosts that are a subset of allowedDomains', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com', 'github.com', '*.amazonaws.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'GH_TOKEN',
              mode: 'mask',
              injectHosts: ['api.github.com', '*.amazonaws.com'],
            },
          ],
        },
      })
      expect(result.success).toBe(true)
    })

    test('accepts an exact injectHost covered by a wildcard allowedDomain', () => {
      // The injectHosts ⊆ allowedDomains check is semantic coverage, not
      // literal string membership — api.github.com is reachable via
      // *.github.com, so this must validate.
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['*.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'GH_TOKEN',
              mode: 'mask',
              injectHosts: ['api.github.com'],
            },
          ],
        },
      })
      expect(result.success).toBe(true)
    })

    test('accepts a wildcard injectHost covered by a broader allowed wildcard', () => {
      // Every host under *.api.github.com is also under *.github.com.
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['*.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'GH_TOKEN',
              mode: 'mask',
              injectHosts: ['*.api.github.com'],
            },
          ],
        },
      })
      expect(result.success).toBe(true)
    })

    test('rejects a wildcard injectHost not covered by an exact allowedDomain', () => {
      // *.github.com would inject at gist.github.com, which is not
      // reachable when allowedDomains only contains api.github.com.
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['api.github.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'GH_TOKEN',
              mode: 'mask',
              injectHosts: ['*.github.com'],
            },
          ],
        },
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find(i =>
          i.path.join('.').startsWith('credentials.envVars.0.injectHosts'),
        )
        expect(issue?.message).toContain('*.github.com')
        expect(issue?.message).toContain('not reachable')
      }
    })

    test('rejects an exact injectHost not covered by an unrelated wildcard', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          allowedDomains: ['*.example.com'],
          deniedDomains: [],
          tlsTerminate: {},
        },
        credentials: {
          envVars: [
            {
              name: 'GH_TOKEN',
              mode: 'mask',
              injectHosts: ['api.github.com'],
            },
          ],
        },
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        const issue = result.error.issues.find(i =>
          i.path.join('.').startsWith('credentials.envVars.0.injectHosts'),
        )
        expect(issue?.message).toContain('api.github.com')
        expect(issue?.message).toContain('not reachable')
      }
    })

    test('rejects unknown modes', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {
          files: [{ path: '~/.netrc', mode: 'block' }],
        },
      })
      expect(result.success).toBe(false)
    })

    test('rejects empty file paths', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {
          files: [{ path: '', mode: 'deny' }],
        },
      })
      expect(result.success).toBe(false)
    })

    test.each(['', 'FOO=BAR', 'FOO BAR', '--bind', '-u', '1FOO', 'FOO.BAR'])(
      'rejects invalid env var name: %j',
      name => {
        const result = SandboxRuntimeConfigSchema.safeParse({
          ...base,
          credentials: {
            envVars: [{ name, mode: 'deny' }],
          },
        })
        expect(result.success).toBe(false)
      },
    )

    test.each(['_FOO', 'FOO_BAR2'])('accepts valid env var name: %j', name => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        credentials: {
          envVars: [{ name, mode: 'deny' }],
        },
      })
      expect(result.success).toBe(true)
    })
  })

  describe('network.tlsTerminate', () => {
    const base = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    }

    test('is optional — config without it validates', () => {
      expect(SandboxRuntimeConfigSchema.safeParse(base).success).toBe(true)
    })

    test('accepts caCertPath + caKeyPath', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          ...base.network,
          tlsTerminate: { caCertPath: '/etc/ca.crt', caKeyPath: '/etc/ca.key' },
        },
      })
      expect(result.success).toBe(true)
    })

    test('rejects when caKeyPath is missing', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          ...base.network,
          tlsTerminate: { caCertPath: '/etc/ca.crt' },
        },
      })
      expect(result.success).toBe(false)
    })

    test('rejects empty caCertPath', () => {
      const result = SandboxRuntimeConfigSchema.safeParse({
        ...base,
        network: {
          ...base.network,
          tlsTerminate: { caCertPath: '', caKeyPath: '/etc/ca.key' },
        },
      })
      expect(result.success).toBe(false)
    })
  })
})
