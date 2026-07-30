import { describe, expect, it } from "vitest";
import * as shared from "@keel/shared";
import {
  canonicalMcpToolPinForLaunch as wardenPin,
  encodeTrustedMcpServersEnv as wardenEncode,
  INTERNAL_MCP_DISCOVERY_ENV as wardenInternalDiscovery,
  MCP_DISCOVERY_REQUEST_ENV as wardenDiscoveryRequest,
  MCP_TRUSTED_SERVERS_ENV as wardenTrustedServers,
  parseMcpDiscoveryResult as wardenParse,
} from "./mcp/local-stdio.js";
import {
  CREDENTIAL_PROXY_CONFIG_ENV as wardenProxyEnv,
  CREDENTIAL_PROXY_PROJECT_CONFIG_PATH as wardenProxyPath,
} from "./credential-proxy.js";
import { LIFECYCLE_MANIFEST_CONFIG_ENV as wardenLifecycleEnv } from "./lifecycle.js";
import {
  INTERACTIVE_CONSOLE_CAPABILITY as wardenConsoleCap,
  INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX as wardenConsolePrefix,
} from "./rpc-server.js";

// ADR-0071 P1-10: the pure kernel↔warden contracts live in `@keel/shared`; the warden
// re-exports them so its public surface is unchanged. These guards prove there is a SINGLE
// source of truth — the warden serves `@keel/shared`'s objects, not a private re-declaration.
describe("warden re-exports the shared kernel↔warden contracts (single source of truth)", () => {
  it("re-exports the SAME function objects as @keel/shared (object identity)", () => {
    // Function identity is a true single-source proof: a re-declared copy would be a
    // different reference and fail `toBe`.
    expect(wardenPin).toBe(shared.canonicalMcpToolPinForLaunch);
    expect(wardenEncode).toBe(shared.encodeTrustedMcpServersEnv);
    expect(wardenParse).toBe(shared.parseMcpDiscoveryResult);
  });

  it("re-exports the shared constant values (drift guard)", () => {
    // Primitive strings compare by value, so this catches drift; the lint rule
    // (kernel/warden must import these from @keel/shared) is the structural single-source
    // backstop that value-equality alone cannot provide.
    expect(wardenTrustedServers).toBe(shared.MCP_TRUSTED_SERVERS_ENV);
    expect(wardenInternalDiscovery).toBe(shared.INTERNAL_MCP_DISCOVERY_ENV);
    expect(wardenDiscoveryRequest).toBe(shared.MCP_DISCOVERY_REQUEST_ENV);
    expect(wardenProxyEnv).toBe(shared.CREDENTIAL_PROXY_CONFIG_ENV);
    expect(wardenProxyPath).toBe(shared.CREDENTIAL_PROXY_PROJECT_CONFIG_PATH);
    expect(wardenLifecycleEnv).toBe(shared.LIFECYCLE_MANIFEST_CONFIG_ENV);
    expect(wardenConsoleCap).toBe(shared.INTERACTIVE_CONSOLE_CAPABILITY);
    expect(wardenConsolePrefix).toBe(shared.INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX);
  });
});
