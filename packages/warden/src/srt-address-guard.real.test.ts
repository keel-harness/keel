/**
 * Real Epic 3.22 walking skeleton.
 *
 * A hostname grant is only authority over the name. This probe gives SRT a
 * normally grantable DNS name, then drives a deterministic host-side lookup
 * that returns loopback. The Warden-owned resolver denies that address set,
 * records the decision in the authoritative audit chain, and SRT must turn the
 * rejection into a stable proxy denial before any upstream socket is opened.
 */
import { createServer } from "node:http";
import type { Server } from "node:net";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toChainRecords, verifyChain, type PrincipalT } from "@keel/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SessionAuditLog } from "./audit/session-log.js";
import { readAuditLog } from "./audit/writer.js";
import { isRealSandboxRequired, resolveRealSandboxGate } from "./real-sandbox-gate.js";
import type { SandboxProfile } from "./sandbox.js";
import { createVendoredSrtSandboxComponents } from "./srt-runtime-loader.js";

const required = isRealSandboxRequired(process.env);
const suite = required ? describe : describe.skip;
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXTURE_HOST = "guard-fixture.example";
const PRINCIPAL: PrincipalT = {
  osUser: "epic-3.22-fixture",
  configuredId: null,
  authProvider: "local",
  assurance: "local-os-user",
};

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP fixture address"));
        return;
      }
      resolveListen(address.port);
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

function fixtureProfile(): SandboxProfile {
  return {
    filesystem: { allowRead: [], allowWrite: [], denyRead: [], denyWrite: [] },
    network: { allowedDomains: [FIXTURE_HOST], deniedDomains: [], strictAllowlist: true },
  };
}

suite("real SRT connect-time destination address guard (opt-in)", () => {
  let workRoot: string;

  beforeAll(() => {
    workRoot = realpathSync(mkdtempSync(join(tmpdir(), "keel-address-guard-real-")));
  });

  afterAll(() => {
    if (workRoot !== undefined && existsSync(workRoot)) {
      rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("denies a granted hostname that resolves to loopback before the real listener accepts", async () => {
    let listenerAccepts = 0;
    const listener = createServer((_request, response) => {
      response.end("UNSAFE_REACHED");
    });
    listener.on("connection", () => {
      listenerAccepts += 1;
    });
    const port = await listen(listener);

    // Positive control: the host listener is live. Only accepts after this
    // baseline count belong to the guarded SRT attempt.
    const control = await fetch(`http://127.0.0.1:${String(port)}/control`);
    expect(await control.text()).toBe("UNSAFE_REACHED");
    const baselineAccepts = listenerAccepts;
    expect(baselineAccepts).toBeGreaterThan(0);

    const auditLog = new SessionAuditLog({
      auditDir: join(workRoot, "audit"),
      principal: PRINCIPAL,
    });
    const deterministicLookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    const resolveDestination = vi.fn(
      async (hostname: string, requestedPort: number, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        const answers = await deterministicLookup();
        expect(answers).toEqual([{ address: "127.0.0.1", family: 4 }]);
        auditLog.append({
          eventType: "egress.deny",
          sessionId: SESSION_ID,
          payload: {
            host: hostname,
            port: requestedPort,
            reason: "blocked-address-policy",
            addressClass: "hard-deny",
            answerCount: answers.length,
            exceptionPolicyRevision: "none",
          },
        });
        throw new Error("blocked-address-policy");
      },
    );

    try {
      const components = await createVendoredSrtSandboxComponents({ resolveDestination });
      const status = components.sandbox.status();
      const gate = resolveRealSandboxGate({
        required,
        available: status.available,
        ...(status.reason === undefined ? {} : { unavailableReason: status.reason }),
      });
      if (gate.action === "fail") throw new Error(gate.reason);

      const result = await components.sandbox.execute(
        {
          command: "curl",
          argv: [
            "curl",
            "-sS",
            "--noproxy",
            "",
            "--max-time",
            "10",
            "--output",
            "/dev/null",
            "--write-out",
            "%{http_code}",
            `http://${FIXTURE_HOST}:${String(port)}/guarded`,
          ],
        },
        fixtureProfile(),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("403");
      expect(result.stderr).not.toContain("127.0.0.1");
      expect(listenerAccepts - baselineAccepts).toBe(0);
      expect(resolveDestination).toHaveBeenCalledTimes(1);
      expect(resolveDestination).toHaveBeenCalledWith(FIXTURE_HOST, port, expect.any(AbortSignal));
      expect(deterministicLookup).toHaveBeenCalledTimes(1);

      const records = readAuditLog(auditLog.pathFor(SESSION_ID));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        eventType: "egress.deny",
        sessionId: SESSION_ID,
        payload: {
          host: FIXTURE_HOST,
          port,
          reason: "blocked-address-policy",
          addressClass: "hard-deny",
          answerCount: 1,
          exceptionPolicyRevision: "none",
        },
      });
      expect(JSON.stringify(records)).not.toContain("127.0.0.1");
      expect(verifyChain(toChainRecords(records)).ok).toBe(true);
    } finally {
      auditLog.close();
      await closeServer(listener);
    }
  }, 30_000);
});
