#!/usr/bin/env node
import { INTERNAL_MCP_DISCOVERY_ENV, runMcpDiscoveryFromEnv, runWardenFromEnv } from "./bin.js";

const hiddenMcpDiscovery = process.env[INTERNAL_MCP_DISCOVERY_ENV] === "1";
const runner = hiddenMcpDiscovery ? runMcpDiscoveryFromEnv : runWardenFromEnv;

void runner()
  .then(() => {
    // Hidden MCP discovery is a one-shot subprocess. The vendored SRT manager intentionally keeps
    // session-scoped proxy handles alive for the normal Warden, so successful discovery must exit
    // explicitly after its single JSON result has flushed. The Kernel owns process-group cleanup.
    if (hiddenMcpDiscovery) process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`keel-warden failed to start: ${message}`);
    process.exit(1);
  });
