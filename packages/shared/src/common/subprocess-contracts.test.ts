import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PROXY_CONFIG_ENV,
  CREDENTIAL_PROXY_PROJECT_CONFIG_PATH,
  INTERACTIVE_CONSOLE_CAPABILITY,
  INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX,
  LIFECYCLE_MANIFEST_CONFIG_ENV,
} from "./subprocess-contracts.js";

describe("kernel↔warden subprocess wiring constants", () => {
  it("pins the env-var / path / capability contract strings", () => {
    expect(CREDENTIAL_PROXY_CONFIG_ENV).toBe("KEEL_WARDEN_CREDENTIAL_PROXY_RULES");
    expect(CREDENTIAL_PROXY_PROJECT_CONFIG_PATH).toBe(".keel/credential-proxy.json");
    expect(LIFECYCLE_MANIFEST_CONFIG_ENV).toBe("KEEL_WARDEN_LIFECYCLE_MANIFEST");
    expect(INTERACTIVE_CONSOLE_CAPABILITY).toBe("interactive-console:v1");
    expect(INTERACTIVE_CONSOLE_TARGET_CAPABILITY_PREFIX).toBe("interactive-console-target:");
  });
});
