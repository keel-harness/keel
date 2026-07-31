import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { z } from "zod";
import {
  JsonRpcErrorResponse,
  JsonRpcSuccessResponse,
  PROTOCOL_VERSION,
  WARDEN_METHODS,
  type WardenMethodNameT,
} from "@keel/shared";
import { mergeAndRestoreHostNodeEnv } from "../tools/child-env.js";

type MethodParams<M extends WardenMethodNameT> = z.infer<(typeof WARDEN_METHODS)[M]["params"]>;
type MethodResult<M extends WardenMethodNameT> = z.infer<(typeof WARDEN_METHODS)[M]["result"]>;
type HelloResult = MethodResult<"warden.hello">;

export const DEFAULT_WARDEN_RESPONSE_MAX_LINE_BYTES = 1_048_576;
export const DEFAULT_WARDEN_STDERR_MAX_BYTES = 65_536;
/** Grace after SIGTERM before the kernel force-kills a wedged warden (P1-19). Kept strictly GREATER
 *  than the warden's own teardown budget (`WARDEN_TEARDOWN_BUDGET_MS` = 2s, which caps its reap wait
 *  on both the SIGTERM and EOF paths) so a warden legitimately using its full budget exits cleanly —
 *  flushing the final checkpoint and unlinking its audit lock — BEFORE this SIGKILL lands, instead of
 *  racing it. Still bounded, so a truly wedged warden that ignores SIGTERM can never hang teardown. */
export const DEFAULT_WARDEN_TERMINATE_GRACE_MS = 4_000;

export interface WardenCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface PendingCall<M extends WardenMethodNameT = WardenMethodNameT> {
  method: M;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve(value: MethodResult<M>): void;
  reject(reason: WardenClientError): void;
}

export class WardenClientError extends Error {
  readonly code: string;
  readonly rpcCode?: number;
  readonly details?: unknown;
  /** False only when the client can prove no request bytes were submitted to the warden. */
  readonly requestSent?: boolean;

  constructor(
    code: string,
    message: string,
    options: { rpcCode?: number; details?: unknown; requestSent?: boolean } = {},
  ) {
    super(message);
    this.name = "WardenClientError";
    this.code = code;
    if (options.rpcCode !== undefined) this.rpcCode = options.rpcCode;
    if (options.details !== undefined) this.details = options.details;
    if (options.requestSent !== undefined) this.requestSent = options.requestSent;
  }
}

export interface AttachWardenClientOptions {
  requestTimeoutMs?: number;
  responseMaxLineBytes?: number;
  stderrMaxBytes?: number;
  /** Grace after SIGTERM before escalating to SIGKILL on terminate (default
   *  {@link DEFAULT_WARDEN_TERMINATE_GRACE_MS}). Injectable for deterministic tests. */
  terminateGraceMs?: number;
}

export interface StartWardenClientOptions extends AttachWardenClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  kernelVersion: string;
  protocolVersion?: string;
}

export type StartedWardenClient = WardenProcessClient & { readonly hello: HelloResult };

function extractId(raw: unknown): string | number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as Record<string, unknown>)["id"];
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isInteger(id)) return id;
  return null;
}

function errorFromRpc(error: z.infer<typeof JsonRpcErrorResponse>["error"]): WardenClientError {
  const wireCode =
    error.data !== undefined && typeof error.data.code === "string" ? error.data.code : "RPC_ERROR";
  return new WardenClientError(wireCode, error.message, {
    rpcCode: error.code,
    details: error.data,
  });
}

export class WardenProcessClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly requestTimeoutMs: number;
  readonly responseMaxLineBytes: number;
  readonly stderrMaxBytes: number;
  readonly #terminateGraceMs: number;
  hello: HelloResult | undefined;
  #nextId = 1;
  #pending = new Map<string | number, PendingCall>();
  #stdoutBuffer = "";
  #stderr = "";
  #closed = false;

  constructor(child: ChildProcessWithoutNullStreams, options: AttachWardenClientOptions = {}) {
    this.child = child;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.responseMaxLineBytes =
      options.responseMaxLineBytes ?? DEFAULT_WARDEN_RESPONSE_MAX_LINE_BYTES;
    this.stderrMaxBytes = options.stderrMaxBytes ?? DEFAULT_WARDEN_STDERR_MAX_BYTES;
    this.#terminateGraceMs = options.terminateGraceMs ?? DEFAULT_WARDEN_TERMINATE_GRACE_MS;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.#appendStderr(chunk);
    });
    this.child.once("error", (error) => {
      // A child `error` (spawn failure / stdio error) is fatal: mark closed so isClosed() reports
      // death immediately, even before the `close` event lands (P0-3 halt liveness).
      this.#closed = true;
      this.#failAll(new WardenClientError("WARDEN_UNAVAILABLE", error.message));
    });
    this.child.once("close", () => {
      this.#closed = true;
      this.#failAll(
        new WardenClientError(
          "WARDEN_UNAVAILABLE",
          `warden process exited; stderr=${this.#stderr}`,
        ),
      );
    });
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  /** Structural warden liveness for the loop's fail-closed halt (P0-3): true once the warden child
   *  has closed, errored, or been terminated. Distinct from any tool-level failure. */
  isClosed(): boolean {
    return this.#closed || this.child.killed || this.child.exitCode !== null;
  }

  async call<M extends WardenMethodNameT>(
    method: M,
    params: MethodParams<M>,
    options: WardenCallOptions = {},
  ): Promise<MethodResult<M>> {
    const schema = WARDEN_METHODS[method].params;
    const parsedParams = schema.safeParse(params);
    if (!parsedParams.success) {
      throw new WardenClientError("INVALID_PARAMS", `invalid params for ${method}`, {
        details: parsedParams.error.issues,
        requestSent: false,
      });
    }
    if (this.#closed || this.child.killed || this.child.exitCode !== null) {
      throw new WardenClientError("WARDEN_UNAVAILABLE", "warden process is not available", {
        requestSent: false,
      });
    }
    if (options.signal?.aborted === true) {
      throw new WardenClientError("WARDEN_ABORTED", `aborted before sending ${method}`, {
        requestSent: false,
      });
    }

    const id = this.#nextId++;
    const frame = { jsonrpc: "2.0", id, method, params: parsedParams.data };
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const abort = (): void => {
        this.#rejectError(
          id,
          new WardenClientError("WARDEN_ABORTED", `aborted waiting for ${method}`),
        );
        this.#terminate();
      };
      const requestTimeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.#rejectError(
          id,
          new WardenClientError("WARDEN_TIMEOUT", `timed out waiting for ${method}`),
        );
        // `warden.presentation.take` is the sole presentation-only, non-authority-bearing poll in
        // the protocol. Its bounded UI timeout may leave a late response, which is safely ignored by
        // id after the pending entry is removed. Execution/authority-bearing requests retain the
        // existing fail-closed process termination because their outcome may be indeterminate.
        if (method !== "warden.presentation.take") this.#terminate();
      }, requestTimeoutMs);
      const pending: PendingCall<M> = {
        method,
        timer,
        resolve,
        reject,
      };
      if (options.signal !== undefined) {
        options.signal.addEventListener("abort", abort, { once: true });
        pending.signal = options.signal;
        pending.onAbort = abort;
      }
      this.#pending.set(id, pending);
      try {
        this.child.stdin.write(`${JSON.stringify(frame)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#rejectError(
          id,
          new WardenClientError("WARDEN_UNAVAILABLE", message, { requestSent: false }),
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed || this.child.exitCode !== null) return;
    this.#closed = true;
    this.child.stdin.end();
    this.child.kill(); // SIGTERM: ask for a graceful shutdown (reap sandbox child, close audit log)
    await this.#awaitExitWithEscalation();
  }

  /** Wait for the child to exit, escalating SIGTERM→SIGKILL if it does not within the grace window.
   *  A wedged warden that ignores SIGTERM must never hang teardown or linger as a live orphan holding
   *  the audit lock (P1-19). SIGKILL always terminates, so `close`/`exit` always fires. */
  #awaitExitWithEscalation(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) {
        resolve();
        return;
      }
      const escalate = setTimeout(() => {
        if (this.child.exitCode === null) this.child.kill("SIGKILL");
      }, this.#terminateGraceMs);
      escalate.unref();
      this.child.once("close", () => {
        clearTimeout(escalate);
        resolve();
      });
    });
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    for (;;) {
      const idx = this.#stdoutBuffer.indexOf("\n");
      if (idx === -1) break;
      const line = this.#stdoutBuffer.slice(0, idx);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(idx + 1);
      if (Buffer.byteLength(line, "utf8") > this.responseMaxLineBytes) {
        this.#fatalProtocolError(
          new WardenClientError("INVALID_RESPONSE", "warden response frame exceeds maximum size"),
        );
        return;
      }
      this.#handleResponseLine(line);
    }
    if (Buffer.byteLength(this.#stdoutBuffer, "utf8") > this.responseMaxLineBytes) {
      this.#fatalProtocolError(
        new WardenClientError("INVALID_RESPONSE", "warden response frame exceeds maximum size"),
      );
    }
  }

  #appendStderr(chunk: string): void {
    this.#stderr += chunk;
    if (Buffer.byteLength(this.#stderr, "utf8") <= this.stderrMaxBytes) return;
    const truncated = Buffer.from(this.#stderr, "utf8")
      .subarray(-this.stderrMaxBytes)
      .toString("utf8");
    this.#stderr = `[truncated]\n${truncated}`;
  }

  #handleResponseLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#fatalProtocolError(
        new WardenClientError("INVALID_RESPONSE", "warden emitted invalid JSON"),
      );
      return;
    }

    const success = JsonRpcSuccessResponse.safeParse(raw);
    if (success.success) {
      this.#resolveSuccess(success.data.id, success.data.result);
      return;
    }

    const error = JsonRpcErrorResponse.safeParse(raw);
    if (error.success) {
      this.#rejectError(error.data.id, errorFromRpc(error.data.error));
      return;
    }

    const id = extractId(raw);
    const clientError = new WardenClientError(
      "INVALID_RESPONSE",
      "warden emitted an invalid JSON-RPC response",
    );
    if (id === null) {
      this.#fatalProtocolError(clientError);
    } else {
      this.#rejectError(id, clientError);
    }
  }

  #resolveSuccess(id: string | number, result: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    this.#clearPending(pending);
    const schema = WARDEN_METHODS[pending.method].result;
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      pending.reject(
        new WardenClientError("INVALID_RESPONSE", `invalid result for ${pending.method}`, {
          details: parsed.error.issues,
        }),
      );
      return;
    }
    pending.resolve(parsed.data);
  }

  #rejectError(id: string | number | null, error: WardenClientError): void {
    if (id === null) {
      this.#failAll(error);
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    this.#clearPending(pending);
    pending.reject(error);
  }

  #failAll(error: WardenClientError): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      this.#clearPending(pending);
      pending.reject(error);
    }
  }

  #clearPending(pending: PendingCall): void {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }

  #fatalProtocolError(error: WardenClientError): void {
    this.#failAll(error);
    this.#terminate();
  }

  #terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.child.stdin.end();
    if (!this.child.killed && this.child.exitCode === null) {
      this.child.kill(); // SIGTERM
      // Fire-and-forget SIGKILL escalation so a wedged warden after a fatal protocol error can never
      // linger holding the audit lock (P1-19). We don't await here — #terminate is a synchronous
      // fatal-path teardown.
      void this.#awaitExitWithEscalation();
    }
  }
}

export function attachWardenClient(
  child: ChildProcessWithoutNullStreams,
  options: AttachWardenClientOptions = {},
): WardenProcessClient {
  return new WardenProcessClient(child, options);
}

export async function startWardenClient(
  options: StartWardenClientOptions,
): Promise<StartedWardenClient> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    // ADR-0083: restore on the final spawn env. The launcher-owned sentinels are reserved across
    // this merge so a later internal env layer cannot disable or rewrite host restoration.
    env: mergeAndRestoreHostNodeEnv(process.env, options.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = attachWardenClient(child, options);
  try {
    const hello = await client.call("warden.hello", {
      kernelVersion: options.kernelVersion,
      protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    });
    client.hello = hello;
    return client as StartedWardenClient;
  } catch (error) {
    await client.close();
    throw error;
  }
}
