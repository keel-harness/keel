#!/usr/bin/env python3
"""Exercise interactive shutdown controls through Keel's real source-mode PTY product path."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType


REPO_ROOT = Path(__file__).resolve().parents[1]
HARNESS_PATH = REPO_ROOT / "packaging" / "pty-product-harness.py"


def load_harness() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "keel_terminal_lifecycle_product_harness", HARNESS_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load PTY harness: {HARNESS_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def source_command(node: str) -> list[str]:
    return [
        node,
        "--conditions=@keel/source",
        "--import",
        str(REPO_ROOT / "node_modules" / "tsx" / "dist" / "loader.mjs"),
        str(REPO_ROOT / "packages" / "kernel" / "src" / "cli" / "bin.ts"),
        "--trust",
    ]


def run_scenario(harness: ModuleType, node: str, scenario: str) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix=f"keel-terminal-{scenario}-") as directory:
        # macOS exposes its physical temporary root through the /var -> /private/var alias.
        # The product intentionally rejects path aliases for KEEL_HOME authority, so fixtures use
        # the physical path just as production callers must.
        root = Path(directory).resolve()
        workspace = root / "workspace"
        home = root / "keel-home"
        workspace.mkdir(mode=0o700)
        home.mkdir(mode=0o700)
        environment = harness.isolated_product_environment(
            home,
            "http://127.0.0.1:9/v1",
            "terminal-lifecycle-product-probe",
            max_wall_seconds=20,
        )
        session = harness.DirectSession(source_command(node), workspace, environment)
        try:
            # This is the first real Ink composer. It is deliberately independent of Warden
            # readiness so the lifecycle contract remains testable on every supported CI host.
            session.read_until(
                (r"protection: starting", r"input · type a task", r"›\s*$"),
                15,
            )
            time.sleep(0.1)
            leader = session.process.pid
            if scenario == "ctrl-d":
                session.send(b"\x04")
                expected_exit = 0
            elif scenario == "sighup":
                os.kill(leader, signal.SIGHUP)
                expected_exit = 129
            else:
                raise ValueError(f"unsupported lifecycle scenario: {scenario}")
            try:
                # A real terminal continuously consumes final renderer output. Use the session's
                # bounded drain-and-wait path so PTY backpressure cannot manufacture a hung exit.
                exit_code = session.wait_for_exit(5)
            except RuntimeError as error:
                return {
                    "status": "FAIL",
                    "scenario": scenario,
                    "error": str(error),
                    "kernelReturnCode": session.process.poll(),
                    "processGroupReapedBeforeCleanup": not harness.INTERACTIONS.process_group_exists(
                        leader
                    ),
                    "rawTerminalSha256": hashlib.sha256(bytes(session.raw)).hexdigest(),
                }
            reaped = not harness.INTERACTIONS.process_group_exists(leader)
            return {
                "status": "PASS" if exit_code == expected_exit and reaped else "FAIL",
                "scenario": scenario,
                "exitCode": exit_code,
                "expectedExitCode": expected_exit,
                "processGroupReaped": reaped,
                "rawTerminalSha256": hashlib.sha256(bytes(session.raw)).hexdigest(),
            }
        finally:
            session.close()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: terminal-lifecycle-product-probe.py /absolute/path/to/node")
    node = str(Path(sys.argv[1]).resolve(strict=True))
    harness = load_harness()
    results = [
        run_scenario(harness, node, "ctrl-d"),
        run_scenario(harness, node, "sighup"),
    ]
    print(json.dumps(results, sort_keys=True))
    if any(result["status"] != "PASS" for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
