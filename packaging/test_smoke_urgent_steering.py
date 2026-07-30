import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("smoke-urgent-steering.py")
SPEC = importlib.util.spec_from_file_location("keel_smoke_urgent_steering_tested", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load smoke harness: {SCRIPT}")
SMOKE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SMOKE
SPEC.loader.exec_module(SMOKE)


def valid_records(nonce="KSTR0001"):
    return [
        {"type": "session_meta"},
        {
            "type": "assistant",
            "toolCalls": [{"id": f"{nonce}-read-1", "name": "read"}],
        },
        {
            "type": "tool_result",
            "toolCallId": f"{nonce}-read-1",
            "name": "read",
            "output": f"{nonce}-READ-COMPLETE\n",
        },
        {
            "type": "assistant",
            "toolCalls": [{"id": f"{nonce}-edit-1", "name": "edit"}],
        },
        {"type": "run_status", "reason": "aborted"},
        {"type": "user", "content": f"{nonce}-URGENT-APPLIED keep unchanged"},
        {"type": "run_status", "reason": "model-stop"},
        {"type": "user", "content": f"{nonce}-ORDINARY continue"},
        {"type": "run_status", "reason": "model-stop"},
    ]


class UrgentSteeringSmokeOracleTests(unittest.TestCase):
    def test_loads_publishable_pty_support_without_an_internal_docs_tree(self):
        lifecycle = SMOKE.load_lifecycle()
        self.assertEqual(lifecycle.FIXTURE_PATH.name, "pty-loopback-fixture.mjs")
        self.assertTrue(lifecycle.FIXTURE_PATH.is_file())
        self.assertTrue(callable(lifecycle.run_launch_sample))
        self.assertTrue(callable(lifecycle.wait_for_idle))

    def test_accepts_exact_terminal_ledger_contract(self):
        result = SMOKE.assert_ledger(valid_records(), "KSTR0001")
        self.assertEqual(result["runStatuses"], ["aborted", "model-stop", "model-stop"])
        self.assertEqual(result["toolResults"], ["read"])

    def test_rejects_a_durable_result_for_the_prevented_edit(self):
        records = valid_records()
        records.insert(
            4,
            {
                "type": "tool_result",
                "toolCallId": "KSTR0001-edit-1",
                "name": "edit",
                "output": "edited",
            },
        )
        with self.assertRaisesRegex(RuntimeError, "exactly the completed read"):
            SMOKE.assert_ledger(records, "KSTR0001")

    def test_idle_oracle_rejects_the_original_false_running_footer(self):
        SMOKE.assert_idle_frame(
            "KSTR0001-REDRIVE-DONE\ninput · type a task or /help",
            "KSTR0001-REDRIVE-DONE",
        )
        with self.assertRaisesRegex(RuntimeError, "stale running/queue"):
            SMOKE.assert_idle_frame(
                "KSTR0001-REDRIVE-DONE\nrunning · type a follow-up to queue",
                "KSTR0001-REDRIVE-DONE",
            )

    def test_fixture_cleanup_runs_even_when_product_cleanup_raises(self):
        calls = []

        class FailingSession:
            def close(self):
                calls.append("session")
                raise PermissionError("product cleanup denied")

        class Fixture:
            def close(self):
                calls.append("fixture")
                return {"survivedAfter": False, "requestCount": 0}

        cleanup, errors = SMOKE.close_scenario_resources(FailingSession(), Fixture())
        self.assertEqual(calls, ["session", "fixture"])
        self.assertEqual(cleanup, {"survivedAfter": False, "requestCount": 0})
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], PermissionError)

    def test_both_cleanup_failures_are_preserved(self):
        class FailingSession:
            def close(self):
                raise PermissionError("product cleanup denied")

        class FailingFixture:
            def close(self):
                raise RuntimeError("fixture cleanup denied")

        cleanup, errors = SMOKE.close_scenario_resources(FailingSession(), FailingFixture())
        self.assertEqual(cleanup, {})
        self.assertEqual(
            [(type(error).__name__, str(error)) for error in errors],
            [
                ("PermissionError", "product cleanup denied"),
                ("RuntimeError", "fixture cleanup denied"),
            ],
        )


if __name__ == "__main__":
    unittest.main()
