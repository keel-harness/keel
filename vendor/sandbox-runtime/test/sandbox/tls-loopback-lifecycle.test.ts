import { EventEmitter } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  inner: undefined as FakeInnerServer | undefined,
  loopback: undefined as PassThrough | undefined,
}));

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  return {
    ...actual,
    createServer: () => {
      if (transport.inner === undefined) throw new Error("missing fake inner server");
      return transport.inner;
    },
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: () => {
      if (transport.loopback === undefined) throw new Error("missing fake loopback");
      return transport.loopback;
    },
  };
});

vi.mock("../../src/sandbox/mitm-leaf.js", () => ({
  mintLeafCert: () => ({ certPem: "test-cert", keyPem: "test-key" }),
  secureContextFor: () => ({}),
}));

const { terminateAndForward } = await import("../../src/sandbox/tls-terminate-proxy.js");

class FakeInnerServer extends EventEmitter {
  closeCalls = 0;

  close(): this {
    this.closeCalls += 1;
    return this;
  }

  listen(_path: string, callback: () => void): this {
    callback();
    return this;
  }

  unref(): this {
    return this;
  }
}

class HeldWriteDuplex extends Duplex {
  readonly chunks: Buffer[] = [];
  private pendingWrite: (() => void) | undefined;

  _read(): void {}

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.pendingWrite = callback;
  }

  releaseWrite(): void {
    const callback = this.pendingWrite;
    this.pendingWrite = undefined;
    callback?.();
  }
}

function startProxy(client: Duplex, loopback: PassThrough): FakeInnerServer {
  const inner = new FakeInnerServer();
  transport.inner = inner;
  transport.loopback = loopback;
  terminateAndForward(
    {} as Parameters<typeof terminateAndForward>[0],
    undefined,
    undefined,
    client,
    Buffer.alloc(0),
    {
      hostname: "denied.example",
      port: 443,
      signal: new AbortController().signal,
    },
  );
  loopback.emit("connect");
  return inner;
}

describe("TLS loopback lifecycle", () => {
  it("lets a complete response flush after the loopback closes normally", async () => {
    const client = new HeldWriteDuplex();
    const loopback = new PassThrough();
    const response = Buffer.from(
      "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 11\r\n\r\nBad Gateway",
    );

    const inner = startProxy(client, loopback);

    const loopbackClosed = new Promise<void>((resolve) => loopback.once("close", resolve));
    const clientFinished = new Promise<void>((resolve) => client.once("finish", resolve));
    loopback.end(response);
    await loopbackClosed;

    expect(client.destroyed).toBe(false);
    expect(client.writableFinished).toBe(false);
    expect(Buffer.concat(client.chunks)).toEqual(response);

    client.releaseWrite();
    await clientFinished;
    expect(client.writableFinished).toBe(true);

    // The readable side deliberately remains open. Per-connection server
    // resources must not wait for a cooperative peer FIN.
    expect(inner.closeCalls).toBe(1);
    const clientClosed = new Promise<void>((resolve) => client.once("close", resolve));
    client.destroy();
    await clientClosed;
    expect(inner.closeCalls).toBe(1);
  });

  it("destroys the client when the loopback fails", async () => {
    const client = new PassThrough();
    const loopback = new PassThrough();
    const clientClosed = new Promise<void>((resolve) => client.once("close", resolve));

    const inner = startProxy(client, loopback);
    loopback.destroy(new Error("loopback failed"));
    await clientClosed;

    expect(client.destroyed).toBe(true);
    expect(inner.closeCalls).toBe(1);
  });
});
