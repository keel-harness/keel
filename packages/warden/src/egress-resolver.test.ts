import { describe, expect, it, vi } from "vitest";

import {
  EGRESS_ADDRESS_GUARD_LIMITS,
  EgressAddressGuardError,
  createBoundedEgressAddressResolver,
  type EgressResolverAuditRecord,
  type EgressResolverLookup,
} from "./egress-resolver.js";

function publicAnswer(address = "8.8.8.8") {
  return { address, family: address.includes(":") ? (6 as const) : (4 as const) };
}

function immediateLookup(
  answers: readonly { readonly address: string; readonly family: 4 | 6 }[],
): EgressResolverLookup {
  return (_hostname, options, callback) => {
    expect(options).toEqual({ all: true, verbatim: true });
    callback(null, [...answers]);
  };
}

function fixture(
  overrides: Partial<Parameters<typeof createBoundedEgressAddressResolver>[0]> = {},
) {
  const records: EgressResolverAuditRecord[] = [];
  const onQuarantine = vi.fn();
  const resolver = createBoundedEgressAddressResolver({
    lookup: immediateLookup([publicAnswer()]),
    audit: { append: (record) => records.push(record) },
    onQuarantine,
    ...overrides,
  });
  return { resolver, records, onQuarantine };
}

describe("bounded Warden egress resolver", () => {
  it("rejects malformed exception-policy revisions at construction", () => {
    expect(() => fixture({ exceptionPolicyRevision: "mutable revision" })).toThrow(
      "invalid egress exception policy revision",
    );
  });

  it("uses the OS lookup contract once per connection and returns the normalized complete set", async () => {
    const lookup = vi.fn<EgressResolverLookup>((hostname, options, callback) => {
      expect(hostname).toBe("public.example");
      expect(options).toEqual({ all: true, verbatim: true });
      callback(null, [publicAnswer("8.8.8.8"), publicAnswer("2001:4860:4860:0:0:0:0:8888")]);
    });
    const { resolver, records } = fixture({ lookup });

    await expect(
      resolver.resolveDestination("public.example", 443, new AbortController().signal),
    ).resolves.toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    await expect(
      resolver.resolveDestination("public.example", 443, new AbortController().signal),
    ).resolves.toHaveLength(2);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(records).toEqual([]);
  });

  it("re-resolves every connection and denies a public-to-loopback DNS rebinding answer", async () => {
    let call = 0;
    const lookup = vi.fn<EgressResolverLookup>((_hostname, _options, callback) => {
      call += 1;
      callback(null, call === 1 ? [publicAnswer()] : [{ address: "127.0.0.1", family: 4 }]);
    });
    const { resolver, records } = fixture({ lookup });

    await expect(
      resolver.resolveDestination("rebind.example", 443, new AbortController().signal),
    ).resolves.toEqual([publicAnswer()]);
    await expect(
      resolver.resolveDestination("rebind.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "hard-deny" });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(records).toEqual([
      expect.objectContaining({
        kind: "denial",
        host: "rebind.example",
        reason: "hard-deny",
        answerCount: 1,
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("127.0.0.1");
  });

  it("classifies an IP literal without DNS and still denies hard and restricted space", async () => {
    const lookup = vi.fn<EgressResolverLookup>();
    const { resolver, records } = fixture({ lookup });

    await expect(
      resolver.resolveDestination("8.8.8.8", 443, new AbortController().signal),
    ).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
    await expect(
      resolver.resolveDestination("127.0.0.1", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "hard-deny" });
    await expect(
      resolver.resolveDestination("10.0.0.1", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "restricted-address-not-excepted" });
    expect(lookup).not.toHaveBeenCalled();
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("127.0.0.1");
    expect(JSON.stringify(records)).not.toContain("10.0.0.1");
  });

  it("denies metadata names before DNS", async () => {
    const lookup = vi.fn<EgressResolverLookup>();
    const { resolver, records } = fixture({ lookup });
    await expect(
      resolver.resolveDestination(
        "service.metadata.google.internal",
        80,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "hard-deny-name" });
    expect(lookup).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      kind: "denial",
      host: "service.metadata.google.internal",
      reason: "hard-deny-name",
      addressClass: "hard-deny",
      answerCount: 0,
    });
  });

  it.each([
    [[publicAnswer(), { address: "127.0.0.1", family: 4 as const }], "hard-deny", "hard-deny"],
    [
      [{ address: "10.0.0.1", family: 4 as const }, publicAnswer()],
      "restricted-address-not-excepted",
      "restricted",
    ],
    [
      [publicAnswer(), { address: "10.0.0.1", family: 4 as const }],
      "restricted-address-not-excepted",
      "restricted",
    ],
  ])(
    "denies the entire mixed answer set independent of order",
    async (answers, code, addressClass) => {
      const { resolver, records } = fixture({ lookup: immediateLookup(answers) });
      await expect(
        resolver.resolveDestination("mixed.example", 443, new AbortController().signal),
      ).rejects.toMatchObject({ code });
      expect(records).toEqual([
        expect.objectContaining({
          kind: "denial",
          host: "mixed.example",
          port: 443,
          reason: code,
          addressClass,
          answerCount: 2,
          exceptionPolicyRevision: "none",
        }),
      ]);
    },
  );

  it("permits restricted answers only when every answer has narrow exception authority", async () => {
    const allowsRestrictedAddress = vi.fn(
      ({ address }: { readonly address: string }) => address === "10.20.1.1",
    );
    const { resolver, records } = fixture({
      lookup: immediateLookup([
        { address: "10.20.1.1", family: 4 },
        { address: "10.20.1.2", family: 4 },
      ]),
      allowsRestrictedAddress,
      exceptionPolicyRevision: "sha256:fixture",
    });

    await expect(
      resolver.resolveDestination("registry.corp.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "restricted-address-not-excepted" });
    expect(allowsRestrictedAddress).toHaveBeenCalledTimes(2);
    expect(records[0]).toMatchObject({
      answerCount: 2,
      exceptionPolicyRevision: "sha256:fixture",
    });
    expect(JSON.stringify(records)).not.toContain("10.20.1.2");
  });

  it("returns restricted answers only when every answer is excepted", async () => {
    const allowsRestrictedAddress = vi.fn(() => true);
    const { resolver, records } = fixture({
      lookup: immediateLookup([
        { address: "10.20.1.1", family: 4 },
        { address: "10.20.1.2", family: 4 },
      ]),
      allowsRestrictedAddress,
      exceptionPolicyRevision: "sha256:fixture",
    });

    await expect(
      resolver.resolveDestination("registry.corp.example", 443, new AbortController().signal),
    ).resolves.toEqual([
      { address: "10.20.1.1", family: 4 },
      { address: "10.20.1.2", family: 4 },
    ]);
    expect(allowsRestrictedAddress).toHaveBeenCalledTimes(2);
    expect(records).toEqual([]);
  });

  it("fails closed when restricted-address exception authority throws", async () => {
    const { resolver, records } = fixture({
      lookup: immediateLookup([{ address: "10.20.1.1", family: 4 }]),
      allowsRestrictedAddress: () => {
        throw new Error("private authority diagnostic");
      },
      exceptionPolicyRevision: "sha256:fixture",
    });

    await expect(
      resolver.resolveDestination("registry.corp.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "exception-authority-failure" });
    expect(records).toEqual([
      expect.objectContaining({
        reason: "exception-authority-failure",
        addressClass: "restricted",
        exceptionPolicyRevision: "sha256:fixture",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private authority diagnostic");
  });

  it("never consults exception authority for a hard-denied address", async () => {
    const allowsRestrictedAddress = vi.fn(() => true);
    const { resolver } = fixture({
      lookup: immediateLookup([{ address: "127.0.0.1", family: 4 }]),
      allowsRestrictedAddress,
    });
    await expect(
      resolver.resolveDestination("granted.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "hard-deny" });
    expect(allowsRestrictedAddress).not.toHaveBeenCalled();
  });

  it.each([
    [[], "empty-answer-set"],
    [
      Array.from({ length: EGRESS_ADDRESS_GUARD_LIMITS.maxAnswers + 1 }, (_, index) => ({
        address: `8.8.8.${String(index)}`,
        family: 4 as const,
      })),
      "answer-limit",
    ],
    [[publicAnswer(), publicAnswer()], "duplicate-answer"],
    [[{ address: "8.8.8.8", family: 6 as const }], "family-mismatch"],
    [[{ address: "fe80::1%lo0", family: 6 as const }], "malformed-answer"],
  ])("fails closed for defective resolver answers: %s", async (answers, code) => {
    const { resolver } = fixture({ lookup: immediateLookup(answers) });
    await expect(
      resolver.resolveDestination("defective.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code });
  });

  it.each([[null], ["8.8.8.8"], [{ family: 4 }], [{ address: "8.8.8.8", family: 5 }]])(
    "fails closed for malformed raw resolver answer shape %j",
    async (raw) => {
      const { resolver } = fixture({
        lookup: (_hostname, _options, callback) =>
          callback(null, [raw] as unknown as readonly { address: string; family: 4 | 6 }[]),
      });
      await expect(
        resolver.resolveDestination("malformed.example", 443, new AbortController().signal),
      ).rejects.toMatchObject({ code: "malformed-answer" });
    },
  );

  it.each([
    ["", 443, "invalid-host"],
    ["*", 443, "invalid-host"],
    ["valid.example", 0, "valid.example"],
    ["valid.example", 65_536, "valid.example"],
    ["valid.example", 443.5, "valid.example"],
  ])("rejects malformed destination request %j:%s before DNS", async (hostname, port, host) => {
    const lookup = vi.fn<EgressResolverLookup>();
    const { resolver, records } = fixture({ lookup });
    await expect(
      resolver.resolveDestination(hostname, port, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(lookup).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      kind: "denial",
      host,
      port,
      reason: "invalid-request",
    });
  });

  it("rejects a pre-aborted request without DNS or audit growth", async () => {
    const lookup = vi.fn<EgressResolverLookup>();
    const controller = new AbortController();
    controller.abort();
    const { resolver, records } = fixture({ lookup });

    await expect(
      resolver.resolveDestination("public.example", 443, controller.signal),
    ).rejects.toMatchObject({
      code: "resolver-aborted",
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("bounds concurrent lookup work and rejects beyond the fixed waiting queue", async () => {
    const callbacks: Parameters<EgressResolverLookup>[2][] = [];
    const lookup = vi.fn<EgressResolverLookup>((_hostname, _options, callback) => {
      callbacks.push(callback);
    });
    const { resolver } = fixture({ lookup });
    const pending = Array.from(
      {
        length:
          EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups +
          EGRESS_ADDRESS_GUARD_LIMITS.maxQueuedLookups,
      },
      (_, index) =>
        resolver.resolveDestination(
          `queued-${String(index)}.example`,
          443,
          new AbortController().signal,
        ),
    );
    expect(lookup).toHaveBeenCalledTimes(EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups);
    expect(resolver.snapshot()).toMatchObject({
      activeLookups: EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups,
      queuedLookups: EGRESS_ADDRESS_GUARD_LIMITS.maxQueuedLookups,
    });

    await expect(
      resolver.resolveDestination("queue-full.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "resolver-queue-full" });

    const shutdown = resolver.shutdown();
    for (const callback of callbacks) callback(null, [publicAnswer()]);
    await expect(shutdown).resolves.toMatchObject({ drained: true, activeLookups: 0 });
    const settled = await Promise.allSettled(pending);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
  });

  it("starts queued work only after a real active callback releases its slot", async () => {
    const callbacks: Parameters<EgressResolverLookup>[2][] = [];
    const lookup = vi.fn<EgressResolverLookup>((_hostname, _options, callback) => {
      callbacks.push(callback);
    });
    const { resolver } = fixture({ lookup });
    const active = Array.from(
      { length: EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups },
      (_, index) =>
        resolver.resolveDestination(
          `active-${String(index)}.example`,
          443,
          new AbortController().signal,
        ),
    );
    const queued = resolver.resolveDestination("queued.example", 443, new AbortController().signal);
    expect(lookup).toHaveBeenCalledTimes(EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups);

    callbacks[0]!(null, [publicAnswer()]);
    await expect(active[0]).resolves.toEqual([publicAnswer()]);
    expect(lookup).toHaveBeenCalledTimes(EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups + 1);
    callbacks.at(-1)!(null, [publicAnswer("1.1.1.1")]);
    await expect(queued).resolves.toEqual([publicAnswer("1.1.1.1")]);

    for (const callback of callbacks.slice(1, -1)) callback(null, [publicAnswer()]);
    await expect(Promise.all(active.slice(1))).resolves.toHaveLength(
      EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups - 1,
    );
    expect(resolver.snapshot()).toMatchObject({ activeLookups: 0, queuedLookups: 0 });
  });

  it("ignores duplicate callbacks from a defective resolver", async () => {
    const { resolver } = fixture({
      lookup: (_hostname, _options, callback) => {
        callback(null, [publicAnswer()]);
        callback(new Error("late private diagnostic"), []);
      },
    });
    await expect(
      resolver.resolveDestination("duplicate-callback.example", 443, new AbortController().signal),
    ).resolves.toEqual([publicAnswer()]);
    expect(resolver.snapshot()).toMatchObject({ activeLookups: 0, queuedLookups: 0 });
  });

  it("converts a synchronous resolver throw into a stable audited failure", async () => {
    const { resolver, records } = fixture({
      lookup: () => {
        throw new Error("resolver secret 10.20.30.40");
      },
    });
    await expect(
      resolver.resolveDestination("throw.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "resolver-failure" });
    expect(records[0]).toMatchObject({ reason: "resolver-failure", addressClass: "unknown" });
    expect(JSON.stringify(records)).not.toContain("10.20.30.40");
  });

  it("times out callers but retains the uncancellable lookup slot until its real callback", async () => {
    vi.useFakeTimers();
    try {
      let callback: Parameters<EgressResolverLookup>[2] | undefined;
      const { resolver } = fixture({
        lookup: (_hostname, _options, value) => {
          callback = value;
        },
      });
      const request = resolver.resolveDestination(
        "late.example",
        443,
        new AbortController().signal,
      );
      const rejection = expect(request).rejects.toMatchObject({ code: "resolver-timeout" });
      await vi.advanceTimersByTimeAsync(EGRESS_ADDRESS_GUARD_LIMITS.requestDeadlineMs);
      await rejection;
      expect(resolver.snapshot()).toMatchObject({ activeLookups: 1, queuedLookups: 0 });

      callback?.(null, [publicAnswer()]);
      expect(resolver.snapshot()).toMatchObject({ activeLookups: 0, queuedLookups: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes an aborted queued request without consuming an underlying slot", async () => {
    const callbacks: Parameters<EgressResolverLookup>[2][] = [];
    const { resolver } = fixture({
      lookup: (_hostname, _options, callback) => callbacks.push(callback),
    });
    const active = Array.from(
      { length: EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups },
      (_, i) =>
        resolver.resolveDestination(
          `active-${String(i)}.example`,
          443,
          new AbortController().signal,
        ),
    );
    const queuedAbort = new AbortController();
    const queued = resolver.resolveDestination("abort.example", 443, queuedAbort.signal);
    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ code: "resolver-aborted" });
    expect(resolver.snapshot().queuedLookups).toBe(0);

    const shutdown = resolver.shutdown();
    for (const callback of callbacks) callback(null, [publicAnswer()]);
    await shutdown;
    await Promise.allSettled(active);
  });

  it("suppresses raw resolver diagnostics and exact denied addresses", async () => {
    const { resolver, records } = fixture({
      lookup: (_hostname, _options, callback) => {
        callback(new Error("EAI_AGAIN at 10.20.30.40 with secret-token"), []);
      },
    });
    let caught: unknown;
    try {
      await resolver.resolveDestination("failure.example", 443, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EgressAddressGuardError);
    expect(String(caught).length).toBeLessThanOrEqual(
      EGRESS_ADDRESS_GUARD_LIMITS.maxDiagnosticLength,
    );
    expect(String(caught)).not.toContain("EAI_AGAIN");
    expect(String(caught)).not.toContain("10.20.30.40");
    expect(JSON.stringify(records)).not.toContain("secret-token");
  });

  it("converts hostile resolver answer access into a stable audited denial", async () => {
    const hostileDiagnostic = "hostile answer getter exposed 10.20.30.40 secret-token";
    const hostileAnswers = new Proxy([publicAnswer()], {
      get(_target, property) {
        if (property === "length") throw new Error(hostileDiagnostic);
        return undefined;
      },
    });
    const { resolver, records } = fixture({
      lookup: (_hostname, _options, callback) => callback(null, hostileAnswers),
    });

    let caught: unknown;
    try {
      await resolver.resolveDestination("hostile.example", 443, new AbortController().signal);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "EgressAddressGuardError",
      code: "malformed-answer",
      message: "egress address guard denied the connection",
    });
    expect(String(caught)).not.toContain(hostileDiagnostic);
    expect(records).toEqual([
      expect.objectContaining({
        kind: "denial",
        host: "hostile.example",
        reason: "malformed-answer",
        addressClass: "unknown",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("10.20.30.40");
    expect(JSON.stringify(records)).not.toContain("secret-token");
  });

  it("quarantines once after the bounded denial burst and prevents retry audit growth", async () => {
    const { resolver, records, onQuarantine } = fixture();
    for (let index = 0; index < EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit; index += 1) {
      await expect(
        resolver.resolveDestination("127.0.0.1", 443, new AbortController().signal),
      ).rejects.toBeInstanceOf(EgressAddressGuardError);
    }
    expect(resolver.snapshot().state).toBe("quarantined");
    expect(records.filter((record) => record.kind === "denial")).toHaveLength(
      EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit,
    );
    expect(records.filter((record) => record.kind === "quarantine")).toHaveLength(1);
    expect(onQuarantine).toHaveBeenCalledTimes(1);

    const boundedCount = records.length;
    for (let index = 0; index < 20; index += 1) {
      await expect(
        resolver.resolveDestination("8.8.8.8", 443, new AbortController().signal),
      ).rejects.toMatchObject({ code: "guard-quarantined" });
    }
    expect(records).toHaveLength(boundedCount);
    expect(onQuarantine).toHaveBeenCalledTimes(1);
  });

  it("prunes old denials before applying the fixed burst window", async () => {
    let timestamp = 1_000;
    const { resolver, onQuarantine } = fixture({ now: () => timestamp });
    for (let index = 0; index < EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit - 1; index += 1) {
      await expect(
        resolver.resolveDestination("127.0.0.1", 443, new AbortController().signal),
      ).rejects.toMatchObject({ code: "hard-deny" });
    }
    timestamp += EGRESS_ADDRESS_GUARD_LIMITS.denialWindowMs + 1;
    await expect(
      resolver.resolveDestination("127.0.0.1", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "hard-deny" });
    expect(resolver.snapshot().state).toBe("active");
    expect(onQuarantine).not.toHaveBeenCalled();
  });

  it("keeps quarantine terminal when the teardown callback throws", async () => {
    const resolver = createBoundedEgressAddressResolver({
      lookup: immediateLookup([publicAnswer()]),
      audit: { append: vi.fn() },
      onQuarantine: () => {
        throw new Error("teardown diagnostic");
      },
    });
    for (let index = 0; index < EGRESS_ADDRESS_GUARD_LIMITS.denialBurstLimit; index += 1) {
      await expect(
        resolver.resolveDestination("127.0.0.1", 443, new AbortController().signal),
      ).rejects.toBeInstanceOf(EgressAddressGuardError);
    }
    expect(resolver.snapshot().state).toBe("quarantined");
  });

  it("fails into terminal quarantine when authoritative audit append fails", async () => {
    const onQuarantine = vi.fn();
    const resolver = createBoundedEgressAddressResolver({
      lookup: immediateLookup([{ address: "127.0.0.1", family: 4 }]),
      audit: {
        append: vi.fn(() => {
          throw new Error("disk details must not escape");
        }),
      },
      onQuarantine,
    });
    await expect(
      resolver.resolveDestination("audit-failure.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "audit-failure" });
    expect(resolver.snapshot().state).toBe("quarantined");
    expect(onQuarantine).toHaveBeenCalledTimes(1);
    await expect(
      resolver.resolveDestination("8.8.8.8", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "guard-quarantined" });
  });

  it("shutdown rejects queued and active callers, waits for callbacks, and prevents new work", async () => {
    const callbacks: Parameters<EgressResolverLookup>[2][] = [];
    const { resolver } = fixture({
      lookup: (_hostname, _options, callback) => callbacks.push(callback),
    });
    const requests = Array.from(
      { length: EGRESS_ADDRESS_GUARD_LIMITS.maxConcurrentLookups + 1 },
      (_, index) =>
        resolver.resolveDestination(
          `shutdown-${String(index)}.example`,
          443,
          new AbortController().signal,
        ),
    );
    const shutdown = resolver.shutdown();
    await expect(
      resolver.resolveDestination("new.example", 443, new AbortController().signal),
    ).rejects.toMatchObject({ code: "guard-shutdown" });
    expect(resolver.snapshot()).toMatchObject({ state: "shutdown", queuedLookups: 0 });
    for (const callback of callbacks) callback(null, [publicAnswer()]);
    await expect(shutdown).resolves.toEqual({ drained: true, activeLookups: 0 });
    const settled = await Promise.allSettled(requests);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
  });

  it("shutdown is immediately drained and idempotent when no work exists", async () => {
    const { resolver } = fixture();
    const first = resolver.shutdown();
    const second = resolver.shutdown();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ drained: true, activeLookups: 0 });
    expect(resolver.snapshot().state).toBe("shutdown");
  });

  it("bounds shutdown waiting when an underlying lookup never returns", async () => {
    vi.useFakeTimers();
    try {
      let callback: Parameters<EgressResolverLookup>[2] | undefined;
      const { resolver } = fixture({
        lookup: (_hostname, _options, value) => {
          callback = value;
        },
      });
      const request = resolver.resolveDestination(
        "hung.example",
        443,
        new AbortController().signal,
      );
      const shutdown = resolver.shutdown();
      await expect(request).rejects.toMatchObject({ code: "guard-shutdown" });
      await vi.advanceTimersByTimeAsync(EGRESS_ADDRESS_GUARD_LIMITS.shutdownTimeoutMs);
      await expect(shutdown).resolves.toEqual({ drained: false, activeLookups: 1 });
      expect(resolver.shutdown()).toBe(shutdown);

      callback?.(null, [publicAnswer()]);
      expect(resolver.snapshot()).toMatchObject({ state: "shutdown", activeLookups: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
