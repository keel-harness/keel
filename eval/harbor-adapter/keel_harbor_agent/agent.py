"""The Harbor ``BaseInstalledAgent`` that runs keel against Terminal-Bench tasks.

Register it with Harbor:

    harbor run --dataset terminal-bench/terminal-bench-2-1 \\
        --agent-import-path keel_harbor_agent.agent:KeelAgent \\
        -m anthropic/claude-sonnet-4-6

Harbor installs the agent into each task's Docker container (``install``), then invokes it per task
(``run``). keel's full headless transcript is tee'd to ``/logs/agent/keel.txt`` and synced back to the
host; the TB-2 task's own verifier decides resolved/unresolved (keel's exit code is liveness-only —
QR-7). The keel binary is an owner-built ``bun --compile`` glibc-linux evaluation artifact. Its
local URL and expected digest are supplied via ``KEEL_BINARY_URL`` + ``KEEL_BINARY_SHA256``; the
adapter authenticates the bytes before installation or execution.

All command construction is delegated to the pure, Harbor-free builders in ``commands`` so the exact
shell keel runs is unit-tested in isolation (``tests/test_commands.py``).
"""

from __future__ import annotations

import os

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from . import commands

# Env var carrying the URL of the glibc-linux keel binary to install into the container.
KEEL_BINARY_URL_ENV = "KEEL_BINARY_URL"
KEEL_BINARY_SHA256_ENV = "KEEL_BINARY_SHA256"
# Optional env var: a recording path for an OFFLINE replay run (no model spend). Unset in real runs.
KEEL_REPLAY_ENV = "KEEL_REPLAY"


class KeelAgent(BaseInstalledAgent):
    """Runs the keel coding agent headlessly inside a Terminal-Bench container."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        commands.validate_agent_extra_env(self._extra_env)

    @staticmethod
    def name() -> str:
        return commands.AGENT_NAME

    def get_version_command(self) -> str | None:
        return commands.version_command()

    def _interactive_console_env(self) -> dict[str, str]:
        env = commands.interactive_console_env_from_getter(self._get_env)
        commands.validate_interactive_console_env(env)
        return env

    async def install(self, environment: BaseEnvironment) -> None:
        console_env = self._interactive_console_env()
        binary_url = self._get_env(KEEL_BINARY_URL_ENV)
        if not binary_url:
            raise ValueError(
                f"{KEEL_BINARY_URL_ENV} must point at an owner-built glibc-linux evaluation binary"
            )
        binary_sha256 = self._get_env(KEEL_BINARY_SHA256_ENV)
        if not binary_sha256:
            raise ValueError(
                f"{KEEL_BINARY_SHA256_ENV} must be the binary's 64-character lowercase SHA-256"
            )
        install_command = commands.install_binary_command(binary_url, binary_sha256)

        # Fail closed early on a musl/Alpine base — the glibc-linked binary cannot run there (QR-3).
        await self.exec_as_root(environment, command=commands.glibc_preflight_command())
        # keel's runtime system deps (ripgrep + bash) — the bun-compiled binary does not bundle them.
        await self.exec_as_root(
            environment,
            command=commands.system_deps_command(
                include_interactive_console=commands.interactive_console_requested(console_env)
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # Verify the expected owner-recorded digest before replacing or executing the binary.
        await self.exec_as_root(environment, command=install_command)

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("model name is required (pass -m provider/model to harbor run)")

        # KEEL_PROVIDER/KEEL_MODEL select the provider+model; the provider's API key is passed through
        # from the orchestrator's env (Harbor injects it). Only the matching provider key is forwarded.
        env: dict[str, str] = dict(commands.keel_model_env(self.model_name))
        provider, _ = commands.split_model_name(self.model_name)
        key_var = commands.provider_key_env_var(provider)
        key_val = os.environ.get(key_var)
        if key_val:
            env[key_var] = key_val
        # openai-compatible provider also needs the endpoint URL.
        base_url = os.environ.get("KEEL_BASE_URL")
        if base_url:
            env["KEEL_BASE_URL"] = base_url
        env.update(commands.eval_direct_exec_env_from_getter(self._get_env))
        env.update(self._interactive_console_env())

        # An OFFLINE replay path for cheap end-to-end adapter validation (no model spend). Real
        # benchmark runs leave KEEL_REPLAY unset and hit the live model.
        replay = self._get_env(KEEL_REPLAY_ENV) or None

        await self.exec_as_agent(
            environment,
            command=commands.run_command(instruction, replay=replay),
            env=env,
        )
