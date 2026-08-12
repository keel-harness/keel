import { EndpointLeaseRegistry } from '../../src/sandbox/endpoint-lease-registry.js'

const [registryPath, generationId, endpoint] = process.argv.slice(2)
if (registryPath === undefined || generationId === undefined || endpoint === undefined) {
  throw new Error('endpoint lease child arguments are required')
}

try {
  const registry = new EndpointLeaseRegistry(registryPath, { generationId })
  registry.claimGeneration()
  registry.recoverPriorGenerations()
  const match = /^(tcp:127\.0\.0\.1:)(\d+)$/u.exec(endpoint)
  if (match === null) throw new Error('endpoint lease child requires one TCP endpoint')
  const peerEndpoint = `${match[1]}${String(Number(match[2]) + 1)}`
  const lease = registry.reserve([endpoint, peerEndpoint])
  process.send?.({ kind: 'ready', lease })
  process.on('message', message => {
    if (message !== 'release') return
    const released = registry.releaseClean(lease)
    const ownerReleased = registry.releaseGeneration()
    process.send?.({ kind: 'released', released, ownerReleased })
    process.disconnect?.()
  })
} catch (error) {
  process.send?.({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  process.disconnect?.()
}
