#!/usr/bin/env python3
"""Boot the installed npx renderer through the publishable real-PTY harness."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import tempfile
from pathlib import Path
from types import ModuleType


REPO_ROOT = Path(__file__).resolve().parents[1]
OBSERVER_PATH = REPO_ROOT / "packaging" / "pty-product-harness.py"


def load_observer() -> ModuleType:
    spec = importlib.util.spec_from_file_location("keel_npx_production_renderer_smoke", OBSERVER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load packaged-product observer: {OBSERVER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def installed_launcher(value: str) -> Path:
    launcher = Path(value).resolve(strict=True)
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        raise ValueError("installed npx launcher must resolve to an executable file")
    if launcher.name != "keel.mjs" or launcher.parent.name != "bin":
        raise ValueError("installed npx launcher must resolve to keel-harness/bin/keel.mjs")
    return launcher


def run_smoke(launcher: Path) -> dict[str, object]:
    observer = load_observer()
    with tempfile.TemporaryDirectory(prefix="keel-npx-production-renderer-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        home = root / "home"
        workspace.mkdir(mode=0o700)
        home.mkdir(mode=0o700)
        sample = observer.run_launch_sample(
            [str(launcher), "--trust"],
            workspace,
            home,
            "http://127.0.0.1:9/v1",
            timeout=20.0,
        )
    if not isinstance(sample, dict):
        raise RuntimeError("packaged-product observer returned a non-object result")
    return sample


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("launcher", help="freshly installed node_modules/.bin/keel")
    args = parser.parse_args()
    sample = run_smoke(installed_launcher(args.launcher))
    print(json.dumps(sample, sort_keys=True))
    if sample.get("status") != "PASS":
        reason = sample.get("reason", "unknown failure")
        tail = sample.get("observationTail", "")
        raise RuntimeError(f"installed npx renderer smoke failed: {reason}; tail={tail!r}")


if __name__ == "__main__":
    main()
