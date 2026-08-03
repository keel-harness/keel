#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import ModuleType


HARNESS = Path(__file__).with_name("pty-product-harness.py")


def load_harness() -> ModuleType:
    spec = importlib.util.spec_from_file_location("keel_pty_product_harness_test", HARNESS)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load PTY harness: {HARNESS}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LaunchObservationHistoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = load_harness()

    def test_governed_row_survives_same_read_incremental_redraw(self) -> None:
        raw = (
            b"keel \xc2\xb7 starting\x1b[2J\n"
            b"protection: starting \xc2\xb7 input waits\n"
            b"\x1b[2J\nprotection: governed \xc2\xb7 sbx:on \xc2\xb7 net:on "
            b"\xc2\xb7 policy:Guided \xc2\xb7 audit:on\n"
            b"\x1b[1A\ninput \xc2\xb7 type a task or /help\n\xe2\x80\xba  \n"
            b"\xe2\x80\xba /keel-latency-probe\n\x1b[1A\n\xe2\x80\xba  \n"
        )

        history, complete = self.harness._visible_terminal_history(
            raw, allow_incomplete=False
        )
        current, current_complete = self.harness._visible_terminal_frame(
            raw, allow_incomplete=False
        )

        self.assertTrue(complete)
        self.assertTrue(current_complete)
        self.assertNotIn("keel \u00b7 starting", current)
        self.assertNotIn("protection: governed", current)
        self.assertNotIn("/keel-latency-probe", current)
        self.assertIn("keel \u00b7 starting", history)
        self.assertTrue(self.harness._ready_for_input_probe(history))
        self.assertTrue(self.harness._probe_is_application_rendered(history))

    def test_latest_unavailable_row_cannot_reuse_older_governed_history(self) -> None:
        raw = (
            b"protection: governed \xc2\xb7 sbx:on \xc2\xb7 net:on "
            b"\xc2\xb7 policy:Guided \xc2\xb7 audit:on\n"
            b"\x1b[1A\nprotection: unavailable \xc2\xb7 warden stopped\n"
            b"\x1b[1A\n\xe2\x80\xba  \n"
        )

        history, complete = self.harness._visible_terminal_history(
            raw, allow_incomplete=False
        )

        self.assertTrue(complete)
        self.assertFalse(self.harness._ready_for_input_probe(history))


if __name__ == "__main__":
    unittest.main()
