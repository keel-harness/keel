#!/usr/bin/env node
import { INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV } from "@keel/shared";
import { INTERNAL_MCP_DISCOVERY_ENV, runMcpDiscoveryFromEnv, runWardenFromEnv } from "./bin.js";
import { runEgressAddressExceptionAdminFromEnv } from "./egress-address-exception-admin.js";
import {
  INTERNAL_GIT_CREDENTIAL_DOCTOR_ENV,
  runGitCredentialDoctorFromEnv,
} from "./git-credential-doctor.js";

const hiddenMcpDiscovery = process.env[INTERNAL_MCP_DISCOVERY_ENV] === "1";
const hiddenEgressAdmin = process.env[INTERNAL_EGRESS_EXCEPTION_ADMIN_ENV] === "1";
const hiddenGitCredentialDoctor = process.env[INTERNAL_GIT_CREDENTIAL_DOCTOR_ENV] === "1";
const runner = hiddenEgressAdmin
  ? runEgressAddressExceptionAdminFromEnv
  : hiddenGitCredentialDoctor
    ? runGitCredentialDoctorFromEnv
    : hiddenMcpDiscovery
      ? runMcpDiscoveryFromEnv
      : runWardenFromEnv;

void runner()
  .then(() => {
    // Hidden MCP discovery is a one-shot subprocess. The vendored SRT manager intentionally keeps
    // session-scoped proxy handles alive for the normal Warden, so successful discovery must exit
    // explicitly after its single JSON result has flushed. The Kernel owns process-group cleanup.
    if (hiddenMcpDiscovery || hiddenEgressAdmin || hiddenGitCredentialDoctor) process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`keel-warden failed to start: ${message}`);
    process.exit(1);
  });
