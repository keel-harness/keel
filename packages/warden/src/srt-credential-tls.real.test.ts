/**
 * Real ADR-0066 credential-TLS acceptance.
 *
 * This suite is opt-in with the same fail-closed gate as the other real SRT probes. The upstream
 * fixture uses a committed test-only CA supplied through NODE_EXTRA_CA_CERTS when Vitest starts;
 * neither curl nor the SRT proxy disables certificate verification. The direct localhost profile is
 * test-fixture plumbing only. Public hostname authority rejects localhost in the Slice 1A corpus.
 */
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { createVendoredSrtSandboxComponents } from "./srt-runtime-loader.js";
import { isRealSandboxRequired, resolveRealSandboxGate } from "./real-sandbox-gate.js";
import type { SandboxCredentialProxyConfig, SandboxPort, SandboxProfile } from "./sandbox.js";
import type { SrtSandboxLaunchPreparer } from "./srt-sandbox.js";

const required = isRealSandboxRequired(process.env);
const suite = required ? describe : describe.skip;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDir = join(repoRoot, "vendor", "sandbox-runtime", "test", "fixtures", "tls-terminate");
const fixtureCaCert = join(fixtureDir, "ca.crt");
const fixtureServerKey = join(fixtureDir, "server.key");

interface RequestObservation {
  readonly authorization?: string;
  readonly host?: string;
  readonly url?: string;
}

interface HttpsFixture {
  readonly port: number;
  readonly requests: RequestObservation[];
  readonly serverNames: string[];
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP fixture address"));
        return;
      }
      resolveListen((address as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else reject(error);
    });
  });
}

async function startHttpsFixture(certificateHostname: string): Promise<HttpsFixture> {
  const certPath = join(
    fixtureDir,
    certificateHostname === "localhost" ? "localhost.crt" : "wrong-host.crt",
  );
  const cert = readFileSync(certPath, "utf8");
  const key = readFileSync(fixtureServerKey, "utf8");
  const secureContext = createSecureContext({ cert, key });
  const requests: RequestObservation[] = [];
  const serverNames: string[] = [];
  const server = createHttpsServer(
    {
      cert,
      key,
      SNICallback: (serverName, callback) => {
        serverNames.push(serverName);
        callback(null, secureContext);
      },
    },
    (request, response) => {
      requests.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
        ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
        ...(request.url === undefined ? {} : { url: request.url }),
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("fixture-ok");
    },
  );
  const port = await listen(server);
  return { port, requests, serverNames, close: () => closeServer(server) };
}

function profileForLocalFixture(): SandboxProfile {
  return {
    filesystem: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
    network: { allowedDomains: ["localhost"], deniedDomains: [], strictAllowlist: true },
  };
}

function curlInvocation(url: string, headers: readonly string[] = []) {
  const argv = [
    "curl",
    "-sS",
    "--noproxy",
    "",
    "--max-time",
    "10",
    ...headers.flatMap((header) => ["--header", header]),
    "--write-out",
    "\nSTATUS:%{http_code}",
    url,
  ];
  return { command: "curl", argv };
}

function expectSecretAbsent(value: unknown, ...secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

suite("real SRT verified-HTTPS credential injection (opt-in)", () => {
  let sandbox: SandboxPort;
  let launchPreparer: SrtSandboxLaunchPreparer;

  beforeAll(async () => {
    const configuredCa = process.env["NODE_EXTRA_CA_CERTS"];
    if (configuredCa === undefined || realpathSync(configuredCa) !== realpathSync(fixtureCaCert)) {
      throw new Error(
        `real credential-TLS tests require NODE_EXTRA_CA_CERTS=${fixtureCaCert} before Node starts`,
      );
    }
    const components = await createVendoredSrtSandboxComponents({
      credentialTlsTermination: true,
    });
    const status = components.sandbox.status();
    const gate = resolveRealSandboxGate({
      required,
      available: status.available,
      ...(status.reason === undefined ? {} : { unavailableReason: status.reason }),
    });
    if (gate.action === "fail") throw new Error(gate.reason);
    if (components.launchPreparer === undefined) {
      throw new Error("real SRT credential-TLS test requires the launch preparer");
    }
    sandbox = components.sandbox;
    launchPreparer = components.launchPreparer;
  }, 30_000);

  it("keeps real credential bytes out of the prepared child argv and environment", async () => {
    const swapSecret = "keel-real-swap-secret-adr0066";
    const placeholderSecret = "keel-real-placeholder-secret-adr0066";
    const placeholder = "keelcred_real_adr0066";
    const credentialProxy: SandboxCredentialProxyConfig = {
      authorizationHeaders: [{ host: "localhost", scheme: "Bearer", secret: swapSecret }],
      authorizationPlaceholders: [
        {
          host: "localhost",
          scheme: "Bearer",
          placeholder,
          secret: placeholderSecret,
        },
      ],
      sandboxEnv: { KEEL_AUTH_PLACEHOLDER: placeholder },
    };
    const launch = await launchPreparer.prepareLaunch(
      curlInvocation("https://localhost:443/"),
      profileForLocalFixture(),
      { credentialProxy },
    );
    try {
      expectSecretAbsent(launch.descriptor, swapSecret, placeholderSecret);
      expect(JSON.stringify(launch.descriptor)).toContain(placeholder);
    } finally {
      launch.cleanup();
    }
  });

  it("injects swap and placeholder credentials only after verified TLS with correct SNI", async () => {
    const fixture = await startHttpsFixture("localhost");
    const swapSecret = "keel-real-swap-secret-adr0066";
    const placeholderSecret = "keel-real-placeholder-secret-adr0066";
    const placeholder = "keelcred_real_adr0066";
    try {
      const swap = await sandbox.execute(
        curlInvocation(`https://localhost:${String(fixture.port)}/swap`),
        profileForLocalFixture(),
        {
          credentialProxy: {
            authorizationHeaders: [{ host: "localhost", scheme: "Bearer", secret: swapSecret }],
          },
        },
      );
      expect(swap.exitCode).toBe(0);
      expect(swap.stdout).toContain("fixture-ok");
      expect(swap.stdout).toContain("STATUS:200");
      expectSecretAbsent(swap, swapSecret);
      expect(fixture.requests).toEqual([
        {
          authorization: `Bearer ${swapSecret}`,
          host: `localhost:${String(fixture.port)}`,
          url: "/swap",
        },
      ]);
      expect(fixture.serverNames).toEqual(["localhost"]);

      fixture.requests.length = 0;
      fixture.serverNames.length = 0;
      const substituted = await sandbox.execute(
        curlInvocation(`https://localhost:${String(fixture.port)}/placeholder`, [
          `Authorization: Bearer ${placeholder}`,
        ]),
        profileForLocalFixture(),
        {
          credentialProxy: {
            authorizationPlaceholders: [
              {
                host: "localhost",
                scheme: "Bearer",
                placeholder,
                secret: placeholderSecret,
              },
            ],
            sandboxEnv: { KEEL_AUTH_PLACEHOLDER: placeholder },
          },
        },
      );
      expect(substituted.exitCode).toBe(0);
      expect(substituted.stdout).toContain("STATUS:200");
      expectSecretAbsent(substituted, placeholderSecret);
      expect(fixture.requests).toEqual([
        {
          authorization: `Bearer ${placeholderSecret}`,
          host: `localhost:${String(fixture.port)}`,
          url: "/placeholder",
        },
      ]);
      expect(fixture.serverNames).toEqual(["localhost"]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("denies wrong-host and unknown placeholders before the upstream receives a request", async () => {
    const fixture = await startHttpsFixture("localhost");
    const placeholder = "keelcred_bound_adr0066";
    const secret = "keel-real-bound-secret-adr0066";
    try {
      for (const attempt of [
        {
          sent: "keelcred_unknown_adr0066",
          configuredHost: "localhost",
        },
        {
          sent: placeholder,
          configuredHost: "other.example.com",
        },
      ]) {
        const result = await sandbox.execute(
          curlInvocation(`https://localhost:${String(fixture.port)}/denied`, [
            `Authorization: Bearer ${attempt.sent}`,
          ]),
          profileForLocalFixture(),
          {
            credentialProxy: {
              authorizationPlaceholders: [
                {
                  host: attempt.configuredHost,
                  scheme: "Bearer",
                  placeholder,
                  secret,
                },
              ],
            },
          },
        );
        expect(`${result.stdout}\n${result.stderr}`).toContain("403");
        expectSecretAbsent(result, secret);
      }
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("uses ordinary hostname verification and refuses a valid chain for the wrong host", async () => {
    const fixture = await startHttpsFixture("wrong-host.example.com");
    try {
      const result = await sandbox.execute(
        curlInvocation(`https://localhost:${String(fixture.port)}/wrong-certificate`),
        profileForLocalFixture(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("STATUS:502");
      expect(fixture.serverNames).toEqual(["localhost"]);
      expect(fixture.requests).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("does not inject real credentials on the plaintext HTTP product path", async () => {
    const observations: RequestObservation[] = [];
    const server = createHttpServer((request, response) => {
      observations.push({
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
      response.end("plaintext-ok");
    });
    const port = await listen(server);
    const swapSecret = "keel-plaintext-swap-secret-adr0066";
    const placeholderSecret = "keel-plaintext-placeholder-secret-adr0066";
    const placeholder = "keelcred_plaintext_adr0066";
    try {
      const swap = await sandbox.execute(
        curlInvocation(`http://localhost:${String(port)}/swap`),
        profileForLocalFixture(),
        {
          credentialProxy: {
            authorizationHeaders: [{ host: "localhost", scheme: "Bearer", secret: swapSecret }],
          },
        },
      );
      expect(swap.exitCode).toBe(0);
      expect(swap.stdout).toContain("STATUS:200");
      expectSecretAbsent(swap, swapSecret);

      const substituted = await sandbox.execute(
        curlInvocation(`http://localhost:${String(port)}/placeholder`, [
          `Authorization: Bearer ${placeholder}`,
        ]),
        profileForLocalFixture(),
        {
          credentialProxy: {
            authorizationPlaceholders: [
              {
                host: "localhost",
                scheme: "Bearer",
                placeholder,
                secret: placeholderSecret,
              },
            ],
          },
        },
      );
      expect(substituted.exitCode).toBe(0);
      expect(substituted.stdout).toContain("STATUS:200");
      expectSecretAbsent(substituted, placeholderSecret);
      expect(observations).toEqual([{}, { authorization: `Bearer ${placeholder}` }]);
    } finally {
      await closeServer(server);
    }
  }, 30_000);
});
