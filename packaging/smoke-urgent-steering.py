#!/usr/bin/env python3
"""Prove installed-npx urgent steering settlement through a real PTY and loopback provider."""

from __future__ import annotations

import argparse
import errno
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType
from typing import Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
LIFECYCLE_PATH = REPO_ROOT / "packaging" / "pty-product-harness.py"
SCENARIOS = (
    ("now", "KSTR0001"),
    ("before-next-edit", "KSTR0002"),
    ("stop-after-current", "KSTR0003"),
)
EXPECTED_RUN_STATUSES = ("aborted", "model-stop", "model-stop")
TARGET_BEFORE = "before\n"


def load_lifecycle() -> ModuleType:
    name = "keel_installed_pty_product_harness"
    spec = importlib.util.spec_from_file_location(name, LIFECYCLE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load PTY lifecycle helper: {LIFECYCLE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def installed_launcher(value: str) -> Path:
    launcher = Path(value).resolve(strict=True)
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise ValueError("installed npx launcher must resolve to an executable file")
    if launcher.name != "keel.mjs" or launcher.parent.name != "bin":
        raise ValueError("installed npx launcher must resolve to keel-harness/bin/keel.mjs")
    return launcher


def release_fifo(path: Path, payload: bytes, timeout: float = 8.0) -> None:
    deadline = time.monotonic() + timeout
    while True:
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            break
        except OSError as error:
            if error.errno != errno.ENXIO or time.monotonic() >= deadline:
                raise RuntimeError("the installed read tool never opened the PTY smoke FIFO") from error
            time.sleep(0.02)
    try:
        written = os.write(descriptor, payload)
        if written != len(payload):
            raise RuntimeError("short write while releasing the PTY smoke FIFO")
    finally:
        os.close(descriptor)


def read_session_records(home: Path) -> tuple[Path, list[dict[str, object]]]:
    ledgers = sorted((home / "sessions").glob("ses_*.jsonl"))
    if len(ledgers) != 1:
        raise RuntimeError(f"expected one isolated session ledger, found {len(ledgers)}")
    records: list[dict[str, object]] = []
    for number, line in enumerate(ledgers[0].read_text(encoding="utf-8").splitlines(), start=1):
        value = json.loads(line)
        if not isinstance(value, dict):
            raise RuntimeError(f"session ledger line {number} is not an object")
        records.append(value)
    return ledgers[0], records


def assert_ledger(records: Sequence[dict[str, object]], nonce: str) -> dict[str, object]:
    statuses = tuple(
        str(record.get("reason")) for record in records if record.get("type") == "run_status"
    )
    if statuses != EXPECTED_RUN_STATUSES:
        raise RuntimeError(f"unexpected run-status ordering: {statuses!r}")

    tool_results = [record for record in records if record.get("type") == "tool_result"]
    if len(tool_results) != 1 or tool_results[0].get("name") != "read":
        raise RuntimeError("the durable ledger must contain exactly the completed read result")
    if tool_results[0].get("toolCallId") != f"{nonce}-read-1":
        raise RuntimeError("the durable read result has the wrong occurrence identity")
    if f"{nonce}-READ-COMPLETE" not in str(tool_results[0].get("output", "")):
        raise RuntimeError("the current read tool did not complete with the fixture payload")
    if any(record.get("name") == "edit" for record in tool_results):
        raise RuntimeError("the prevented edit acquired a durable tool result")

    assistant_calls = [
        call
        for record in records
        if record.get("type") == "assistant" and isinstance(record.get("toolCalls"), list)
        for call in record["toolCalls"]
        if isinstance(call, dict)
    ]
    if not any(
        call.get("id") == f"{nonce}-edit-1" and call.get("name") == "edit"
        for call in assistant_calls
    ):
        raise RuntimeError("the fixture did not durably propose the edit occurrence")

    user_content = [
        str(record.get("content", "")) for record in records if record.get("type") == "user"
    ]
    if sum(f"{nonce}-URGENT-APPLIED" in content for content in user_content) != 1:
        raise RuntimeError("the urgent instruction was not applied exactly once")
    if sum(f"{nonce}-ORDINARY" in content for content in user_content) != 1:
        raise RuntimeError("the ordinary follow-up did not start exactly one later turn")

    return {
        "runStatuses": list(statuses),
        "toolResults": [str(record.get("name")) for record in tool_results],
        "urgentUserEvents": sum(
            f"{nonce}-URGENT-APPLIED" in content for content in user_content
        ),
        "ordinaryUserEvents": sum(f"{nonce}-ORDINARY" in content for content in user_content),
    }


def assert_idle_frame(frame: str, expected_answer: str | None = None) -> None:
    if expected_answer is not None and expected_answer not in frame:
        raise RuntimeError(f"final PTY frame omitted {expected_answer}")
    if re.search(r"(?m)^running[ \t]*·", frame) or "follow-up to queue" in frame:
        raise RuntimeError("final PTY frame retained stale running/queue footer copy")
    if "input · type a task" not in frame:
        raise RuntimeError("final PTY frame did not return to the idle composer")


def close_scenario_resources(
    session: object | None, fixture: object | None
) -> tuple[dict[str, object], list[BaseException]]:
    """Attempt both cleanups independently so one failure cannot strand the other process group."""
    errors: list[BaseException] = []
    fixture_cleanup: dict[str, object] = {}
    if session is not None:
        try:
            session.close()
        except BaseException as error:
            errors.append(error)
    if fixture is not None:
        try:
            result = fixture.close()
            if not isinstance(result, dict):
                raise RuntimeError("fixture cleanup returned a non-object result")
            fixture_cleanup = result
        except BaseException as error:
            errors.append(error)
    return fixture_cleanup, errors


def run_scenario(
    lifecycle: ModuleType, launcher: Path, control: str, nonce: str, root: Path
) -> dict[str, object]:
    scenario_root = root / control
    workspace = scenario_root / "workspace"
    home = scenario_root / "home"
    fixture_root = scenario_root / "fixture"
    for path in (scenario_root, workspace, home, fixture_root):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = workspace / "target.txt"
    target.write_text(TARGET_BEFORE, encoding="utf-8")
    fifo = workspace / "gate.pipe"
    os.mkfifo(fifo, 0o600)

    fixture = None
    session = None
    fixture_cleanup: dict[str, object] = {}
    transcript_sha256 = ""
    clean_product_exit = False
    ledger: dict[str, object] | None = None
    ledger_sha256 = ""
    scenario_error: BaseException | None = None
    cleanup_errors: list[BaseException] = []
    try:
        fixture = lifecycle.FixtureServer(fixture_root)
        model = f"urgent-{control}-{nonce}"
        environment = lifecycle.isolated_product_environment(
            home, fixture.base_url, model, max_wall_seconds=60
        )
        session = lifecycle.DirectSession([str(launcher), "--trust"], workspace, environment)
        lifecycle.wait_for_idle(session, 30)

        lifecycle.submit(session, f"{nonce} inspect gate.pipe then update target.txt")
        active = session.read_until((r"tool checking read", r"running[ \t]*·"), 30)
        if "checking read execution" not in active or target.read_text(encoding="utf-8") != TARGET_BEFORE:
            raise RuntimeError("the current read was not active before urgent input")

        lifecycle.submit(
            session, f"/{control} {nonce}-URGENT-APPLIED keep target.txt unchanged"
        )
        release_fifo(fifo, f"{nonce}-READ-COMPLETE\n".encode("utf-8"))

        session.read_until((re.escape(f"{nonce}-REDRIVE-DONE"),), 30)
        first_idle = lifecycle.wait_for_idle(session, 30)
        assert_idle_frame(first_idle)
        if target.read_text(encoding="utf-8") != TARGET_BEFORE:
            raise RuntimeError("the urgent steering boundary did not preserve target.txt")

        lifecycle.submit(session, f"{nonce}-ORDINARY continue with a normal turn")
        session.read_until((re.escape(f"{nonce}-ORDINARY-DONE"),), 30)
        second_idle = lifecycle.wait_for_idle(session, 30)
        assert_idle_frame(second_idle)

        exit_code = lifecycle.public_exit(session)
        lifecycle.wait_for_process_exit(session.process, 12)
        clean_product_exit = exit_code == 0 and not lifecycle.INTERACTIONS.process_group_exists(
            session.process.pid
        )
        if not clean_product_exit:
            raise RuntimeError(f"installed Keel did not exit cleanly: {exit_code}")

        transcript = session.sanitized_transcript()
        transcript_sha256 = hashlib.sha256(transcript.encode("utf-8")).hexdigest()
        ledger_path, records = read_session_records(home)
        ledger = assert_ledger(records, nonce)
        ledger_sha256 = hashlib.sha256(ledger_path.read_bytes()).hexdigest()
    except BaseException as error:
        scenario_error = error
    finally:
        fixture_cleanup, cleanup_errors = close_scenario_resources(session, fixture)

    failures = ([scenario_error] if scenario_error is not None else []) + cleanup_errors
    if len(failures) == 1:
        raise failures[0]
    if failures:
        detail = "; ".join(f"{type(error).__name__}: {error}" for error in failures)
        raise RuntimeError(f"scenario and cleanup failures: {detail}") from failures[0]
    if ledger is None:
        raise RuntimeError("scenario completed without ledger evidence")

    if fixture_cleanup.get("requestCount") != 4:
        raise RuntimeError(f"fixture request count was not exactly four: {fixture_cleanup!r}")
    if fixture_cleanup.get("survivedAfter") is not False or fixture_cleanup.get("forcedKill") is True:
        raise RuntimeError(f"fixture did not stop cleanly: {fixture_cleanup!r}")

    return {
        "control": f"/{control}",
        "status": "PASS",
        "targetUnchanged": target.read_text(encoding="utf-8") == TARGET_BEFORE,
        "cleanProductExit": clean_product_exit,
        "fixtureRequests": fixture_cleanup["requestCount"],
        "fixtureSurvived": fixture_cleanup["survivedAfter"],
        "transcriptSha256": transcript_sha256,
        "ledgerSha256": ledger_sha256,
        **ledger,
    }


def run_smoke(launcher: Path) -> dict[str, object]:
    lifecycle = load_lifecycle()
    with tempfile.TemporaryDirectory(prefix="keel-npx-urgent-steering-") as directory:
        root = Path(directory).resolve()
        scenarios = [
            run_scenario(lifecycle, launcher, control, nonce, root)
            for control, nonce in SCENARIOS
        ]
    return {
        "status": "PASS",
        "carrier": str(launcher),
        "provider": "loopback-openai-compatible",
        "paidProviderRequests": 0,
        "scenarios": scenarios,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("launcher", help="freshly installed node_modules/.bin/keel")
    args = parser.parse_args()
    print(json.dumps(run_smoke(installed_launcher(args.launcher)), sort_keys=True))


if __name__ == "__main__":
    main()
