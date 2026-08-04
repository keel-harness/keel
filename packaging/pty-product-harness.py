#!/usr/bin/env python3
"""Reusable real-PTY support for installed-package smoke tests.

This module is deliberately self-contained inside the publishable packaging tree. It launches
only caller-supplied local Keel executables and a repository-owned loopback fixture; it never
contacts a paid provider.
"""

from __future__ import annotations

import codecs
import errno
import fcntl
import hashlib
import os
import pty
import re
import select
import signal
import socket
import struct
import subprocess
import termios
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
FIXTURE_PATH = HERE / "pty-loopback-fixture.mjs"
MAX_CONTROL_SEQUENCE_CHARS = 4096
MAX_TERMINAL_BYTES = 8 * 1024 * 1024
MAX_OBSERVATION_TAIL_CHARS = 2_000
FRAME_BOUNDARY = "\x00"
SAFE_ENVIRONMENT_KEYS = ("LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER")
IDLE_COMPOSER_PATTERNS = (r"input · type a task", r"›\s*$")
_CONTROL_STRING_ESC = frozenset(("]", "P", "X", "^", "_"))
_CONTROL_STRING_C1 = frozenset(("\x90", "\x98", "\x9d", "\x9e", "\x9f"))
_REDRAW_CSI_FINALS = frozenset("ABCDEFGHJK`adef")
_BIDI_CONTROLS = frozenset(
    (
        "\u061c",
        "\u200e",
        "\u200f",
        "\u202a",
        "\u202b",
        "\u202c",
        "\u202d",
        "\u202e",
        "\u2066",
        "\u2067",
        "\u2068",
        "\u2069",
    )
)
_SECRET_PATTERNS = (
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{12,}\b")),
    ("openai-key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("google-key", re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b")),
    ("bearer-token", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}")),
)
_SENSITIVE_ASSIGNMENT = re.compile(
    r"(?i)\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*"
    r"(?!\[redacted:)[^\s]{8,}"
)
_GOVERNED_STATUS = re.compile(
    r"^protection:[^\r\n]*\bsandbox on\b[^\r\n]*\bpolicy "
    r"(?!starting\b|unavailable\b|none\b|off\b)[^\r\n]+",
    re.IGNORECASE | re.MULTILINE,
)
_COMPACT_GOVERNED_STATUS = re.compile(
    r"^protection:[ \t]*governed\b[^\r\n]*\bsbx:on\b[^\r\n]*\bpolicy:"
    r"(?!starting\b|unavailable\b|none\b|off\b)[^·\r\n]+",
    re.IGNORECASE | re.MULTILINE,
)
_INTERACTIVE_GOVERNED_STATUS = re.compile(
    rf"(?:{_GOVERNED_STATUS.pattern})|(?:{_COMPACT_GOVERNED_STATUS.pattern})",
    re.IGNORECASE | re.MULTILINE,
)
_FIRST_PAINT_MARKER = "keel · starting"
_INPUT_PROBE = "/keel-latency-probe"


def _decode_terminal(raw: bytes | bytearray, *, allow_incomplete: bool) -> tuple[str, bool]:
    decoder = codecs.getincrementaldecoder("utf-8")(errors="surrogateescape")
    decoded = decoder.decode(bytes(raw), final=not allow_incomplete)
    utf8_complete = len(decoder.getstate()[0]) == 0
    normalized: list[str] = []
    for character in decoded:
        code = ord(character)
        if 0xDC80 <= code <= 0xDC9F:
            normalized.append(chr(code - 0xDC00))
        elif 0xDC80 <= code <= 0xDCFF:
            normalized.append("\ufffd")
        else:
            normalized.append(character)
    return "".join(normalized), utf8_complete


def sanitize_terminal(
    raw: bytes | bytearray, *, mark_redraws: bool, allow_incomplete: bool
) -> tuple[str, bool]:
    if len(raw) > MAX_TERMINAL_BYTES:
        raise RuntimeError(f"terminal output exceeds {MAX_TERMINAL_BYTES} bytes")

    text, utf8_complete = _decode_terminal(raw, allow_incomplete=allow_incomplete)
    output: list[str] = []
    cursor = 0

    def incomplete(kind: str) -> tuple[str, bool]:
        if allow_incomplete:
            return "".join(output), False
        raise RuntimeError(f"unterminated terminal control {kind}")

    def append_redraw_boundary() -> None:
        if mark_redraws and (not output or output[-1] != FRAME_BOUNDARY):
            output.append(FRAME_BOUNDARY)

    while cursor < len(text):
        character = text[cursor]
        code = ord(character)

        if character in _BIDI_CONTROLS:
            cursor += 1
            continue

        if character == "\x1b":
            start = cursor
            if cursor + 1 >= len(text):
                return incomplete("escape sequence")
            introducer = text[cursor + 1]
            if introducer in _CONTROL_STRING_ESC:
                allow_bel = introducer == "]"
                cursor += 2
                while cursor < len(text):
                    if cursor - start + 1 > MAX_CONTROL_SEQUENCE_CHARS:
                        raise RuntimeError("terminal control sequence exceeds bounded limit")
                    if text[cursor] == "\x9c":
                        cursor += 1
                        break
                    if text[cursor] == "\x1b" and cursor + 1 < len(text) and text[cursor + 1] == "\\":
                        cursor += 2
                        break
                    if allow_bel and text[cursor] == "\x07":
                        cursor += 1
                        break
                    cursor += 1
                else:
                    return incomplete("string")
                continue
            if introducer == "[":
                cursor += 2
                while cursor < len(text):
                    if cursor - start + 1 > MAX_CONTROL_SEQUENCE_CHARS:
                        raise RuntimeError("terminal control sequence exceeds bounded limit")
                    code = ord(text[cursor])
                    if 0x40 <= code <= 0x7E:
                        if text[cursor] in _REDRAW_CSI_FINALS:
                            append_redraw_boundary()
                        cursor += 1
                        break
                    if not 0x20 <= code <= 0x3F:
                        raise RuntimeError("malformed terminal control CSI sequence")
                    cursor += 1
                else:
                    return incomplete("CSI sequence")
                continue

            cursor += 1
            while cursor < len(text) and 0x20 <= ord(text[cursor]) <= 0x2F:
                if cursor - start + 1 > MAX_CONTROL_SEQUENCE_CHARS:
                    raise RuntimeError("terminal control sequence exceeds bounded limit")
                cursor += 1
            if cursor >= len(text):
                return incomplete("escape sequence")
            if not 0x30 <= ord(text[cursor]) <= 0x7E:
                raise RuntimeError("malformed terminal control escape sequence")
            cursor += 1
            continue

        if character in _CONTROL_STRING_C1:
            start = cursor
            allow_bel = character == "\x9d"
            cursor += 1
            while cursor < len(text):
                if cursor - start + 1 > MAX_CONTROL_SEQUENCE_CHARS:
                    raise RuntimeError("terminal control sequence exceeds bounded limit")
                if text[cursor] == "\x9c":
                    cursor += 1
                    break
                if text[cursor] == "\x1b" and cursor + 1 < len(text) and text[cursor + 1] == "\\":
                    cursor += 2
                    break
                if allow_bel and text[cursor] == "\x07":
                    cursor += 1
                    break
                cursor += 1
            else:
                return incomplete("string")
            continue

        if character == "\x9b":
            start = cursor
            cursor += 1
            while cursor < len(text):
                if cursor - start + 1 > MAX_CONTROL_SEQUENCE_CHARS:
                    raise RuntimeError("terminal control sequence exceeds bounded limit")
                code = ord(text[cursor])
                if 0x40 <= code <= 0x7E:
                    if text[cursor] in _REDRAW_CSI_FINALS:
                        append_redraw_boundary()
                    cursor += 1
                    break
                if not 0x20 <= code <= 0x3F:
                    raise RuntimeError("malformed terminal control CSI sequence")
                cursor += 1
            else:
                return incomplete("CSI sequence")
            continue

        if character == "\r":
            # A PTY with ONLCR may expand an application's CRLF into CR CR LF. Consume the whole
            # carriage-return run once so that completed line ending remains part of the current
            # frame; a run not followed by LF is still an incremental redraw boundary.
            while cursor < len(text) and text[cursor] == "\r":
                cursor += 1
            if cursor >= len(text) or text[cursor] != "\n":
                append_redraw_boundary()
            continue

        if code < 0x20 or 0x7F <= code <= 0x9F:
            if character in ("\n", "\t"):
                output.append(character)
            cursor += 1
            continue

        output.append(character)
        cursor += 1

    return "".join(output), utf8_complete


def current_frame(text: str) -> str:
    return text.rsplit(FRAME_BOUNDARY, 1)[-1]


def project_visible(raw: bytes | bytearray, *, allow_incomplete: bool = False) -> str:
    projected, _ = sanitize_terminal(raw, mark_redraws=True, allow_incomplete=allow_incomplete)
    return projected


def redact_sensitive(text: str) -> str:
    redacted = text
    for label, pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(f"[redacted:{label}]", redacted)
    return _SENSITIVE_ASSIGNMENT.sub("[redacted:sensitive-assignment]", redacted)


def assert_artifact_safe(text: str) -> None:
    for label, pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            raise RuntimeError(f"refusing to retain terminal output containing {label}")
    if _SENSITIVE_ASSIGNMENT.search(text):
        raise RuntimeError("refusing to retain terminal output containing a sensitive assignment")


def _visible_terminal_frame(
    raw: bytes | bytearray, *, allow_incomplete: bool = False
) -> tuple[str, bool]:
    projected, complete = _visible_terminal_history(raw, allow_incomplete=allow_incomplete)
    return (current_frame(projected) if complete else ""), complete


def _visible_terminal_history(
    raw: bytes | bytearray, *, allow_incomplete: bool = False
) -> tuple[str, bool]:
    """Return bounded sanitized render history without discarding incremental redraw fragments."""
    return sanitize_terminal(raw, mark_redraws=True, allow_incomplete=allow_incomplete)


def _safe_observation_tail(raw: bytes | bytearray) -> str:
    projected, _ = sanitize_terminal(raw, mark_redraws=True, allow_incomplete=True)
    retained = current_frame(projected)[-MAX_OBSERVATION_TAIL_CHARS:]
    assert_artifact_safe(retained)
    return retained


def _ready_for_input_probe(text: str) -> bool:
    protection_lines = list(re.finditer(r"(?m)^protection:[^\r\n]*$", text, re.IGNORECASE))
    if not protection_lines:
        return False
    latest = protection_lines[-1].group(0)
    return _GOVERNED_STATUS.search(latest) is not None or _COMPACT_GOVERNED_STATUS.search(latest) is not None


def _probe_is_application_rendered(text: str) -> bool:
    return re.search(rf"(?m)^›[ \t]*{re.escape(_INPUT_PROBE)}[ \t]*$", text) is not None


def _read_pty_chunk(master: int) -> bytes:
    try:
        return os.read(master, 65_536)
    except OSError as error:
        if error.errno == errno.EIO:
            return b""
        raise


def process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_for_process_group_exit(
    process_group: int, timeout: float, process: subprocess.Popen[bytes] | None = None
) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        if process is not None:
            process.poll()
        if not process_group_exists(process_group):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.02)


def stop_process_group(
    process: subprocess.Popen[bytes], grace_seconds: float = 2.0, wait_timeout: float = 2.0
) -> dict[str, object]:
    graceful = True
    forced_signal: str | None = None
    group_signal_denied = False
    process.poll()
    if process_group_exists(process.pid):
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            group_signal_denied = True
            process.terminate()
        if not _wait_for_process_group_exit(process.pid, grace_seconds, process):
            graceful = False
            forced_signal = "SIGKILL"
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                group_signal_denied = True
                process.kill()
    try:
        process.wait(timeout=wait_timeout)
    except subprocess.TimeoutExpired:
        graceful = False
        forced_signal = "SIGKILL"
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=wait_timeout)
    survived = process_group_exists(process.pid)
    if survived:
        raise RuntimeError(f"process group {process.pid} survived forced cleanup")
    return {
        "graceful": graceful,
        "forcedSignal": forced_signal,
        "groupSignalDenied": group_signal_denied,
        "survived": False,
    }


def _startup_environment(home: Path, base_url: str) -> dict[str, str]:
    if re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}/v1", base_url) is None:
        raise ValueError("packaged-product provider URL must be versioned loopback HTTP")
    environment = {key: os.environ[key] for key in SAFE_ENVIRONMENT_KEYS if key in os.environ}
    environment.update(
        {
            "COLUMNS": "80",
            "HOME": str(home),
            "KEEL_HOME": str(home),
            "KEEL_PROVIDER": "openai-compatible",
            "KEEL_MODEL": "installed-product-smoke",
            "KEEL_BASE_URL": base_url,
            "LINES": "24",
            "OPENAI_API_KEY": "local-fixture-placeholder",
            "TERM": "xterm-256color",
        }
    )
    return environment


def _disable_terminal_echo(fd: int) -> None:
    attributes = termios.tcgetattr(fd)
    attributes[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(fd, termios.TCSANOW, attributes)


def _wait_for_visible(
    master: int,
    process: subprocess.Popen[bytes],
    raw: bytearray,
    predicate,
    timeout: float,
    label: str,
) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            chunk = _read_pty_chunk(master)
            if not chunk:
                break
            raw.extend(chunk)
            visible, complete = _visible_terminal_frame(raw, allow_incomplete=True)
            if complete and predicate(visible):
                return visible
        if process.poll() is not None:
            break
    visible, _ = _visible_terminal_frame(raw, allow_incomplete=False)
    if predicate(visible):
        return visible
    raise RuntimeError(f"timed out waiting for {label}")


def _drain_pty(master: int, raw: bytearray, quiet_window: float = 0.02) -> None:
    quiet_deadline = time.monotonic() + max(0.0, quiet_window)
    while True:
        timeout = max(0.0, quiet_deadline - time.monotonic())
        if not select.select([master], [], [], timeout)[0]:
            return
        chunk = _read_pty_chunk(master)
        if not chunk:
            return
        raw.extend(chunk)
        quiet_deadline = time.monotonic() + max(0.0, quiet_window)


def _wait_for_exit_draining(
    master: int, process: subprocess.Popen[bytes], raw: bytearray, timeout: float
) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.02)[0]:
            chunk = _read_pty_chunk(master)
            if chunk:
                raw.extend(chunk)
        return_code = process.poll()
        if return_code is not None and not process_group_exists(process.pid):
            return return_code
    raise RuntimeError("Keel did not exit and reap its process group within the timeout")


def _interactive_exit(
    master: int, process: subprocess.Popen[bytes], raw: bytearray
) -> int:
    _drain_pty(master, raw)
    os.write(master, b"\x03")
    _wait_for_visible(
        master,
        process,
        raw,
        lambda text: re.search(r"(?m)^›[ \t]*$", text) is not None,
        3.0,
        "blank composer after dismissing the input probe",
    )
    _drain_pty(master, raw)
    os.write(master, b"/exit")
    _wait_for_visible(
        master,
        process,
        raw,
        lambda text: "Enter quits" in text
        and re.search(r"(?m)^›[ \t]*/exit[ \t]*$", text) is not None,
        3.0,
        "rendered /exit confirmation",
    )
    os.write(master, b"\r")
    return _wait_for_exit_draining(master, process, raw, 10.0)


def run_launch_sample(
    command: list[str], cwd: Path, home: Path, base_url: str, *, timeout: float
) -> dict[str, object]:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    _disable_terminal_echo(slave)
    started = time.monotonic()
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=_startup_environment(home, base_url),
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    raw = bytearray()
    first_paint: float | None = None
    protection_ready: float | None = None
    probe_sent: float | None = None
    input_acknowledged: float | None = None
    reason: str | None = None
    interactive_exit_ok = False
    cleanup: dict[str, object] = {"graceful": False, "forcedSignal": None, "survived": True}
    try:
        deadline = started + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.02)
            if readable:
                chunk = _read_pty_chunk(master)
                if not chunk:
                    break
                raw.extend(chunk)
                visible, complete = _visible_terminal_history(raw, allow_incomplete=True)
                if not complete:
                    continue
                now = time.monotonic()
                if first_paint is None and _FIRST_PAINT_MARKER in visible:
                    first_paint = now
                if protection_ready is None and _ready_for_input_probe(visible):
                    protection_ready = now
                    probe_sent = time.monotonic()
                    os.write(master, _INPUT_PROBE.encode("utf-8"))
                if probe_sent is not None and _probe_is_application_rendered(visible):
                    input_acknowledged = now
                    break
            if process.poll() is not None:
                break

        if first_paint is None:
            raise RuntimeError("Keel produced no recognizable first paint before timeout or exit")
        if protection_ready is None:
            raise RuntimeError("Keel produced no governed ready state before timeout or exit")
        if probe_sent is None or input_acknowledged is None:
            raise RuntimeError("Keel did not application-render the input probe before timeout or exit")
        exit_code = _interactive_exit(master, process, raw)
        interactive_exit_ok = exit_code == 0
        if not interactive_exit_ok:
            raise RuntimeError(f"clean interactive sample exited {exit_code}, expected 0")
    except Exception as error:
        reason = str(error)
        assert_artifact_safe(reason)
    finally:
        try:
            cleanup = stop_process_group(process)
        except Exception as error:
            cleanup = {
                "graceful": False,
                "forcedSignal": "SIGKILL",
                "survived": True,
                "error": str(error),
            }
            if reason is None:
                reason = str(error)
        os.close(master)

    cleanup_status = "PASS" if not cleanup.get("survived") else "FAIL"
    status = (
        "PASS"
        if reason is None
        and interactive_exit_ok
        and cleanup_status == "PASS"
        and first_paint is not None
        and protection_ready is not None
        and probe_sent is not None
        and input_acknowledged is not None
        else "FAIL"
    )
    payload: dict[str, object] = {
        "status": status,
        "cleanupStatus": cleanup_status,
        "cleanup": cleanup,
        "exitCode": process.returncode,
        "rawBytes": len(raw),
        "rawSha256": hashlib.sha256(bytes(raw)).hexdigest(),
        "observationTail": _safe_observation_tail(raw),
    }
    timings = (
        ("firstPaintMs", first_paint),
        ("protectionReadyMs", protection_ready),
        ("probeSentMs", probe_sent),
        ("inputAcknowledgedMs", input_acknowledged),
    )
    for key, observed in timings:
        if observed is not None:
            payload[key] = round((observed - started) * 1000, 3)
    if probe_sent is not None and input_acknowledged is not None:
        payload["probeToRenderedMs"] = round((input_acknowledged - probe_sent) * 1000, 3)
    if reason is not None:
        payload["reason"] = reason[:1000]
    return payload


def _set_terminal_geometry(fd: int, *, rows: int, columns: int) -> None:
    if rows <= 0 or columns <= 0:
        raise ValueError("terminal geometry must be positive")
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def _acquire_controlling_terminal(fd: int) -> None:
    os.setsid()
    fcntl.ioctl(fd, termios.TIOCSCTTY, 0)


def _match_visible(text: str, patterns: tuple[str | re.Pattern[str], ...]) -> tuple[bool, str]:
    frame = current_frame(text)
    cursor = 0
    for pattern in patterns:
        match = (
            pattern.search(frame, cursor)
            if isinstance(pattern, re.Pattern)
            else re.compile(pattern, re.IGNORECASE | re.MULTILINE).search(frame, cursor)
        )
        if match is None:
            return False, text
        cursor = match.end()
    return True, frame[cursor:]


class DirectSession:
    def __init__(
        self,
        command: list[str],
        cwd: Path,
        environment: dict[str, str],
        *,
        rows: int = 40,
        columns: int = 120,
    ) -> None:
        self.master, slave = pty.openpty()
        _set_terminal_geometry(slave, rows=rows, columns=columns)
        _disable_terminal_echo(slave)
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            preexec_fn=lambda: _acquire_controlling_terminal(slave),
            close_fds=True,
        )
        os.close(slave)
        foreground_group = os.tcgetpgrp(self.master)
        if foreground_group != self.process.pid:
            stop_process_group(self.process)
            os.close(self.master)
            raise RuntimeError("direct PTY child did not acquire foreground terminal ownership")
        self.raw = bytearray()
        self.carry = ""
        self.master_open = True

    def _retain(self, chunk: bytes) -> None:
        if len(self.raw) + len(chunk) > MAX_TERMINAL_BYTES:
            raise RuntimeError(f"terminal output exceeds {MAX_TERMINAL_BYTES} bytes")
        self.raw.extend(chunk)

    def drain_pending_output(self, quiet_window: float = 0.02) -> None:
        self.carry = ""
        drained = bytearray()
        quiet_deadline = time.monotonic() + max(0.0, quiet_window)
        while True:
            timeout = max(0.0, quiet_deadline - time.monotonic())
            if not select.select([self.master], [], [], timeout)[0]:
                break
            chunk = _read_pty_chunk(self.master)
            if not chunk:
                break
            self._retain(chunk)
            drained.extend(chunk)
            quiet_deadline = time.monotonic() + max(0.0, quiet_window)
        if drained:
            project_visible(drained)

    def read_until(
        self, patterns: tuple[str | re.Pattern[str], ...], timeout: float = 12.0
    ) -> str:
        local = bytearray()
        matched, remainder = _match_visible(self.carry, patterns)
        if matched:
            visible = current_frame(self.carry)
            self.carry = remainder
            return visible
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.05)
            if readable:
                chunk = _read_pty_chunk(self.master)
                if not chunk:
                    break
                local.extend(chunk)
                self._retain(chunk)
                projected, complete = sanitize_terminal(
                    local, mark_redraws=True, allow_incomplete=True
                )
                visible = self.carry + projected
                matched, remainder = _match_visible(visible, patterns) if complete else (False, visible)
                if complete and matched:
                    self.carry = remainder
                    return current_frame(visible)
            if self.process.poll() is not None:
                break
        visible = self.carry + project_visible(local)
        raise RuntimeError(f"timed out waiting for {patterns!r}; latest output:\n{visible[-2000:]}")

    def send(self, data: bytes) -> None:
        self.drain_pending_output()
        os.write(self.master, data)

    def send_immediately(self, data: bytes) -> None:
        os.write(self.master, data)

    def wait_for_exit(self, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.05)
            if readable:
                chunk = _read_pty_chunk(self.master)
                if chunk:
                    self._retain(chunk)
            result = self.process.poll()
            if result is not None and not process_group_exists(self.process.pid):
                return result
        raise RuntimeError("Keel did not exit within the PTY shutdown timeout")

    def sanitized_transcript(self) -> str:
        transcript = redact_sensitive(project_visible(self.raw, allow_incomplete=True))
        assert_artifact_safe(transcript)
        return transcript

    def close(self) -> None:
        try:
            stop_process_group(self.process)
        finally:
            if self.master_open:
                os.close(self.master)
                self.master_open = False


def wait_for_process_exit(process: subprocess.Popen[bytes], timeout: float) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = process.poll()
        if result is not None and not process_group_exists(process.pid):
            return result
        time.sleep(0.02)
    raise RuntimeError("Keel process group did not exit within the lifecycle timeout")


def isolated_product_environment(
    home: Path, base_url: str, model: str, *, max_wall_seconds: int = 120
) -> dict[str, str]:
    if re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}/v1", base_url) is None:
        raise ValueError("fixture provider URL must be versioned loopback HTTP")
    environment = {key: os.environ[key] for key in SAFE_ENVIRONMENT_KEYS if key in os.environ}
    environment.update(
        {
            "COLUMNS": "120",
            "HOME": str(home),
            "KEEL_BASE_URL": base_url,
            "KEEL_HOME": str(home),
            "KEEL_MAX_WALL_SEC": str(max_wall_seconds),
            "KEEL_MODEL": model,
            "KEEL_PROVIDER": "openai-compatible",
            "KEEL_TRUST": "1",
            "LINES": "40",
            "OPENAI_API_KEY": "local-fixture-placeholder",
            "TERM": "xterm-256color",
        }
    )
    return environment


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fixture_request_count(path: Path) -> int:
    if not path.exists():
        return 0
    rows = path.read_text(encoding="utf-8").splitlines()
    if any(row != "1" for row in rows):
        raise RuntimeError("malformed fixture request log")
    return len(rows)


class FixtureServer:
    def __init__(self, root: Path) -> None:
        self._close_result: dict[str, object] | None = None
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = int(reservation.getsockname()[1])
        self.request_log = root / "requests.log"
        environment = {
            **{key: os.environ[key] for key in SAFE_ENVIRONMENT_KEYS if key in os.environ},
            "KEEL_FIXTURE_REQUEST_LOG": str(self.request_log),
        }
        self.process = subprocess.Popen(
            ["node", str(FIXTURE_PATH), str(self.port)],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    return
            except OSError:
                time.sleep(0.02)
        evidence = self.close()
        raise RuntimeError(
            "fixture server did not become ready: "
            f"{str(evidence.get('stderrTail', ''))[-1000:]}"
        )

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def close(self) -> dict[str, object]:
        if self._close_result is not None:
            return dict(self._close_result)
        alive_before_cleanup = self.process.poll() is None
        forced_kill = False
        if alive_before_cleanup:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            forced_kill = True
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=2)
        stderr = "" if self.process.stderr is None else self.process.stderr.read()
        request_count: int | None = None
        request_log_error: str | None = None
        try:
            request_count = _fixture_request_count(self.request_log)
        except RuntimeError as error:
            request_log_error = str(error)
        self._close_result = {
            "aliveBeforeCleanup": alive_before_cleanup,
            "cleanupInitiated": True,
            "survivedAfter": self.process.poll() is None,
            "forcedKill": forced_kill,
            "exitCode": self.process.returncode,
            "stderrTail": redact_sensitive(stderr[-1000:]),
            "requestCount": request_count,
            "requestLogSha256": (
                _sha256_file(self.request_log)
                if self.request_log.exists()
                else hashlib.sha256(b"").hexdigest()
            ),
            "requestLogError": request_log_error,
        }
        return dict(self._close_result)


def wait_for_idle(session: DirectSession, timeout: float = 30.0) -> str:
    return session.read_until((_INTERACTIVE_GOVERNED_STATUS, *IDLE_COMPOSER_PATTERNS), timeout)


def _composer_echo_pattern(text: str) -> re.Pattern[str]:
    tokens = text.split()
    if not tokens:
        raise ValueError("composer text must contain a non-whitespace character")
    separator = r"(?:[ \t]+|[ \t]*\r?\n[ \t]*)"
    soft_wrap = r"(?:[ \t]*\r?\n[ \t]*)?"
    token_patterns = [
        soft_wrap.join(re.escape(character) for character in token) for token in tokens
    ]
    return re.compile(
        r"^›[ \t]*" + separator.join(token_patterns) + r"[ \t]*(?:\r?\n[ \t]*)?\Z",
        re.MULTILINE,
    )


def submit(session: DirectSession, text: str) -> None:
    session.send(text.encode("utf-8"))
    session.read_until((_composer_echo_pattern(text),), 5)
    session.send_immediately(b"\r")


def public_exit(session: DirectSession) -> int:
    session.send(b"/exit")
    session.read_until((r"Enter quits", r"›\s*/exit"), 5)
    session.send_immediately(b"\r")
    return session.wait_for_exit(12)


class _Interactions:
    process_group_exists = staticmethod(process_group_exists)


INTERACTIONS = _Interactions()
