#!/usr/bin/env python3
"""Persist installed-carrier workspace trust through Keel's real human PTY prompt."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
from types import ModuleType


REPO_ROOT = Path(__file__).resolve().parents[1]
LIFECYCLE_PATH = REPO_ROOT / "packaging" / "pty-product-harness.py"


def load_lifecycle() -> ModuleType:
    name = "keel_mcp_review_trust_pty_harness"
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


def existing_directory(value: str, label: str) -> Path:
    directory = Path(value).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError(f"{label} must resolve to a directory")
    return directory


def assert_persisted_trust(home: Path, workspace: Path) -> None:
    trust_path = home / "trust.json"
    payload = json.loads(trust_path.read_text(encoding="utf-8"))
    if payload.get("version") != 1:
        raise RuntimeError("workspace trust store version drifted")
    entry = payload.get("workspaces", {}).get(str(workspace))
    if not isinstance(entry, dict) or entry.get("decision") != "trusted":
        raise RuntimeError("real PTY trust prompt did not persist the trusted workspace decision")
    if stat.S_IMODE(trust_path.stat().st_mode) != 0o600:
        raise RuntimeError("workspace trust store must be mode 0600")


def persist_workspace_trust(
    lifecycle: ModuleType, launcher: Path, workspace: Path, home: Path
) -> None:
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment = lifecycle.isolated_product_environment(
        home,
        "http://127.0.0.1:9/v1",
        "installed-mcp-review-trust-smoke",
        max_wall_seconds=30,
    )
    environment.pop("KEEL_TRUST", None)
    environment["KEEL_WARDEN_SANDBOX"] = "srt"
    session = lifecycle.DirectSession([str(launcher)], workspace, environment)
    try:
        session.read_until((r"Trust this workspace\?", r"\[y\] trust"), 15)
        session.send_immediately(b"y\r")
        session.read_until((r"workspace trusted", r"input · type a task", r"›\s*$"), 30)
        exit_code = lifecycle.public_exit(session)
        if exit_code != 0:
            raise RuntimeError(f"installed Keel trust session exited {exit_code}, expected 0")
        assert_persisted_trust(home, workspace)
    finally:
        session.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("launcher")
    parser.add_argument("workspace")
    parser.add_argument("keel_home")
    args = parser.parse_args()
    persist_workspace_trust(
        load_lifecycle(),
        installed_launcher(args.launcher),
        existing_directory(args.workspace, "workspace"),
        Path(args.keel_home).resolve(),
    )
    print("installed npx workspace trust prompt passed")


if __name__ == "__main__":
    main()
