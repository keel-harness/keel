import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    from keel_harbor_agent.agent import KeelAgent
except ModuleNotFoundError:  # pragma: no cover - plain command-builder environments skip this.
    KeelAgent = None  # type: ignore[assignment]


class FakeEnvironment:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def exec(
        self,
        *,
        command: str,
        user: str | int | None = None,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
        timeout_sec: int | None = None,
    ):
        self.calls.append(
            {
                "command": command,
                "user": user,
                "env": env,
                "cwd": cwd,
                "timeout_sec": timeout_sec,
            }
        )
        return SimpleNamespace(return_code=0, stdout="keel 0.0.0\n", stderr="")


@unittest.skipIf(KeelAgent is None, "Harbor is not installed")
class TestKeelAgentLifecycle(unittest.IsolatedAsyncioTestCase):
    BINARY_SHA256 = "a" * 64

    async def test_install_uses_agent_extra_env_for_reviewed_console_packages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = KeelAgent(
                logs_dir=Path(tmp),
                extra_env={
                    "KEEL_BINARY_URL": "http://host.docker.internal:8077/keel-linux-x64",
                    "KEEL_BINARY_SHA256": self.BINARY_SHA256,
                    "KEEL_WARDEN_SANDBOX": "srt",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                },
            )
            environment = FakeEnvironment()

            await agent.install(environment)  # type: ignore[union-attr]

        install_commands = [str(call["command"]) for call in environment.calls]
        self.assertTrue(
            any("apt-get install -y ripgrep bash tmux bubblewrap socat" in cmd for cmd in install_commands),
            install_commands,
        )
        self.assertTrue(
            any("sha256sum -c -" in cmd and self.BINARY_SHA256 in cmd for cmd in install_commands),
            install_commands,
        )

    async def test_install_validates_console_env_collected_from_process_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = KeelAgent(
                logs_dir=Path(tmp),
                extra_env={
                    "KEEL_BINARY_URL": "http://host.docker.internal:8077/keel-linux-x64",
                    "KEEL_BINARY_SHA256": self.BINARY_SHA256,
                },
            )
            environment = FakeEnvironment()

            with patch.dict(
                "os.environ",
                {
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                },
                clear=True,
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires KEEL_RUN_SESSION_ID",
                ):
                    await agent.install(environment)  # type: ignore[union-attr]

        self.assertEqual(environment.calls, [])

    async def test_install_requires_expected_binary_hash_before_container_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = KeelAgent(
                logs_dir=Path(tmp),
                extra_env={"KEEL_BINARY_URL": "http://host.docker.internal:8077/keel-linux-x64"},
            )
            environment = FakeEnvironment()

            with self.assertRaisesRegex(ValueError, "KEEL_BINARY_SHA256 must be"):
                await agent.install(environment)  # type: ignore[union-attr]

        self.assertEqual(environment.calls, [])

    async def test_constructor_rejects_unreviewed_warden_agent_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(
                ValueError, "unsupported keel Harbor agent env: KEEL_WARDEN_POLICY_PATH"
            ):
                KeelAgent(  # type: ignore[operator]
                    logs_dir=Path(tmp),
                    extra_env={"KEEL_WARDEN_POLICY_PATH": "/tmp/policy.json"},
                )


if __name__ == "__main__":
    unittest.main()
