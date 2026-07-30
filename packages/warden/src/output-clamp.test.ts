import { describe, expect, it } from "vitest";
import {
  clampSandboxAuditStreams,
  clampSandboxResponseStreams,
  SANDBOX_AUDIT_STREAM_MAX_BYTES,
  SANDBOX_RESPONSE_STREAM_MAX_BYTES,
} from "./output-clamp.js";

// The kernel client rejects any warden response frame over this as fatal and kills the warden
// (packages/kernel/src/warden/client.ts DEFAULT_WARDEN_RESPONSE_MAX_LINE_BYTES). The response clamp
// must keep the serialized stdout+stderr comfortably below it regardless of content.
const KERNEL_FATAL_FRAME_BYTES = 1_048_576;

function serializedBytes(stdout: string, stderr: string): number {
  return Buffer.byteLength(JSON.stringify({ stdout, stderr }), "utf8");
}

describe("clampSandboxResponseStreams", () => {
  it("passes small streams through unchanged", () => {
    const out = clampSandboxResponseStreams("hello", "world");
    expect(out).toEqual({ stdout: "hello", stderr: "world", limited: false });
  });

  it("head+tail truncates a large stdout with an honest marker and keeps head and tail", () => {
    const big = `HEAD_MARKER${"a".repeat(2_000_000)}TAIL_MARKER`;
    const out = clampSandboxResponseStreams(big, "");
    expect(out.stdout).toContain("... [output truncated] ...");
    expect(out.stdout.startsWith("HEAD_MARKER")).toBe(true);
    expect(out.stdout.endsWith("TAIL_MARKER")).toBe(true);
    expect(out.limited).toBe(true);
    expect(Buffer.byteLength(out.stdout, "utf8")).toBeLessThanOrEqual(
      SANDBOX_RESPONSE_STREAM_MAX_BYTES,
    );
  });

  it("keeps the serialized frame well under the kernel's fatal cap for a huge text stream", () => {
    const big = "x".repeat(8 * 1024 * 1024); // the srt per-stream cap
    const out = clampSandboxResponseStreams(big, big);
    expect(serializedBytes(out.stdout, out.stderr)).toBeLessThan(KERNEL_FATAL_FRAME_BYTES);
  });

  it("shrinks streams further when a large envelope is reserved from the frame budget", () => {
    const control = String.fromCharCode(1).repeat(4 * 1024 * 1024);
    const noReserve = clampSandboxResponseStreams(control, control);
    const bigReserve = clampSandboxResponseStreams(control, control, 500 * 1024);
    // Reserving 500 KiB for the envelope leaves less frame for the streams, so they are clamped
    // strictly smaller than with no reservation.
    expect(serializedBytes(bigReserve.stdout, bigReserve.stderr)).toBeLessThan(
      serializedBytes(noReserve.stdout, noReserve.stderr),
    );
  });

  it("keeps a small (marked) stream budget even when the reserved envelope exceeds the frame budget", () => {
    const control = String.fromCharCode(1).repeat(4 * 1024 * 1024);
    // Reserve more than the total frame budget → the stream ceiling floors at the minimum rather than
    // going negative; the streams are truncated to a small marked head+tail, never dropped entirely.
    const out = clampSandboxResponseStreams(control, control, 2 * 1024 * 1024);
    expect(out.stdout).toContain("... [output truncated] ...");
    expect(Buffer.byteLength(out.stdout, "utf8")).toBeGreaterThan(0);
    expect(serializedBytes(out.stdout, out.stderr)).toBeLessThan(64 * 1024);
  });

  it("keeps the frame safe even for all-control-byte output (worst-case JSON escaping)", () => {
    // A 0x01 byte serializes to a 6-char  escape; if the clamp only bounded raw byte length
    // this content would still blow past the frame cap. The frame-safety shrink must fit the frame.
    const control = String.fromCharCode(1).repeat(4 * 1024 * 1024);
    const out = clampSandboxResponseStreams(control, control);
    expect(serializedBytes(out.stdout, out.stderr)).toBeLessThan(KERNEL_FATAL_FRAME_BYTES);
  });
});

describe("clampSandboxAuditStreams", () => {
  it("passes small streams through unchanged", () => {
    const out = clampSandboxAuditStreams("hello", "world");
    expect(out).toEqual({ stdout: "hello", stderr: "world" });
  });

  it("bounds a giant stream to the audit budget with a marker (spike guard)", () => {
    const big = "y".repeat(8 * 1024 * 1024);
    const out = clampSandboxAuditStreams(big, big);
    expect(out.stdout).toContain("... [output truncated] ...");
    expect(Buffer.byteLength(out.stdout, "utf8")).toBeLessThanOrEqual(
      SANDBOX_AUDIT_STREAM_MAX_BYTES,
    );
    expect(Buffer.byteLength(out.stderr, "utf8")).toBeLessThanOrEqual(
      SANDBOX_AUDIT_STREAM_MAX_BYTES,
    );
  });

  it("preserves more fidelity than the model-visible response clamp", () => {
    const big = "z".repeat(8 * 1024 * 1024);
    const audit = clampSandboxAuditStreams(big, "");
    const response = clampSandboxResponseStreams(big, "");
    expect(Buffer.byteLength(audit.stdout, "utf8")).toBeGreaterThan(
      Buffer.byteLength(response.stdout, "utf8"),
    );
  });

  it("redacts a secret straddling the truncation boundary before it can be split (F5)", () => {
    // A high-entropy secret positioned across the head cut (60% of the 1 MiB budget). truncateHeadTail
    // keeps the first ~629 KiB, so 30 chars of the secret land in the kept head and the rest is dropped
    // into the removed middle. That 30-char fragment is below the entropy net's 44-char floor, so the
    // writer's post-truncation whole-record redaction would miss it — the stream must be redacted BEFORE
    // it is truncated.
    const secret = "Zk8Qw3Nx7Lp2Rt9Vb4Hn6Jm1Fd5Gs0Yc8Wa3Ue7Oi2Kq9Xz4Bv6Tl1Pr5Md0";
    const headBytes = Math.floor(SANDBOX_AUDIT_STREAM_MAX_BYTES * 0.6);
    // Realistic output: whitespace-delimited tokens, so the secret is its own token (not fused into a
    // giant low-entropy filler run). The secret starts 30 bytes before the head cut and is followed by
    // a newline, so 30 of its chars land in the kept head and the rest is dropped into the middle.
    const headFiller = `${"x".repeat(headBytes - 31)}\n`; // ends 30 bytes before the head cut
    const tailFiller = `\n${"y ".repeat(512 * 1024)}`; // pushes the secret's tail into the dropped middle
    const stream = `${headFiller}${secret}${tailFiller}`;

    const out = clampSandboxAuditStreams(stream, "");

    expect(out.stdout).not.toContain(secret.slice(0, 30));
    expect(out.stdout).not.toContain(secret);
    expect(out.stdout).toContain("[redacted:high-entropy]");
  });
});
