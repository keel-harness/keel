"""Pure, dependency-free command builders for the keel Harbor agent.

This module has **no Harbor import** on purpose: the exact shell that keel runs inside a Terminal-Bench
container is the security-sensitive surface (it executes against the benchmark task with the API key in
its env), so it is constructed here in small pure functions that are hermetically unit-testable in any
Python >=3.12 — no Harbor, no Docker, no network. `agent.py` composes these into Harbor's
``BaseInstalledAgent`` lifecycle.

Mirrors keel's runtime env contract (kernel ``cli/runtime.ts``):
  - provider/model are selected via ``KEEL_PROVIDER`` / ``KEEL_MODEL``;
  - the API key is read by the provider SDK from its own env var (e.g. ``ANTHROPIC_API_KEY``).
Keep this map in sync with ``PROVIDER_KEY_ENV`` in kernel ``cli/runtime.ts``.
"""

from __future__ import annotations

from collections.abc import Callable
import re
import shlex

# Agent name registered with Harbor:
#   harbor run --dataset terminal-bench/terminal-bench-2-1 --agent-import-path keel_harbor_agent.agent:KeelAgent -m anthropic/claude-sonnet-4-6
AGENT_NAME = "keel"

# Where the container writes keel's headless transcript. Harbor syncs ``/logs`` back to the host, so
# teeing here means the run output survives even if the task times out mid-run.
DEFAULT_LOG_PATH = "/logs/agent/keel.txt"

# Default install location for the keel binary inside the container (on PATH).
DEFAULT_BINARY_DEST = "/usr/local/bin/keel"

# Core system packages keel needs at RUNTIME that the ``bun --compile`` binary does NOT bundle (QR-3):
#   - ripgrep : the ``search`` tool shells out to the system ``rg`` on the standalone binary build
#               (the bundled ``@vscode/ripgrep`` is only present on the npx/dev path).
#   - bash    : the ``bash`` tool needs a real bash for the marker-protocol completion detection.
RUNTIME_PACKAGES: tuple[str, ...] = ("ripgrep", "bash")

# Runtime packages needed only when the reviewed interactive-console product path is explicitly enabled:
#   - tmux       : the system-tmux broker holds and reads the live console pane.
#   - bubblewrap : Linux SRT sandbox wrapping for the long-lived console target process.
#   - socat      : SRT's Linux network proxy bridge dependency.
# Keep these conditional: installing console-only packages for ordinary runs would expand the container
# tool surface without a warden-owned console target/grant to use it.
INTERACTIVE_CONSOLE_RUNTIME_PACKAGES: tuple[str, ...] = ("tmux", "bubblewrap", "socat")

# System packages needed at INSTALL time to FETCH + verify the keel binary. TB-2 task images do NOT
# guarantee these — observed missing on the stock terminal-bench-2 images (initial bounded Harbor probe: `curl: command not
# found`, install exit 127), so the adapter installs them itself rather than assuming the base provides
# them:
#   - curl            : ``install_binary_command`` downloads the binary with ``curl -fsSL``.
#   - ca-certificates : lets curl verify TLS for an HTTPS binary URL.
#   - coreutils       : supplies ``sha256sum`` and same-directory ``mv`` for verified atomic install.
FETCH_PACKAGES: tuple[str, ...] = ("curl", "ca-certificates", "coreutils")

# provider -> the env var its SDK reads the API key from. Mirrors ``PROVIDER_KEY_ENV`` in keel
# (kernel ``cli/runtime.ts``); the adapter passes ONLY the matching key into the container.
PROVIDER_KEY_ENV: dict[str, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GOOGLE_GENERATIVE_AI_API_KEY",
    "openai-compatible": "OPENAI_API_KEY",
}

INTERACTIVE_CONSOLE_ENV: tuple[str, ...] = (
    "HOME",
    "KEEL_HOME",
    "KEEL_WARDEN_SANDBOX",
    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG",
    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64",
    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64",
    "KEEL_RUN_SESSION_ID",
)

ALLOWED_WARDEN_AGENT_ENV: frozenset[str] = frozenset(INTERACTIVE_CONSOLE_ENV)
SESSION_ID_RE = re.compile(r"^ses_[0-9A-HJKMNP-TV-Z]{26}$")
EVAL_DIRECT_EXEC_ENV = "KEEL_EVAL_DIRECT_EXEC"
EVAL_DIRECT_EXEC_ACK = "i-understand-this-disables-the-warden-eval-only"


def split_model_name(model_name: str) -> tuple[str, str]:
    """Split Harbor's ``provider/model`` (e.g. ``anthropic/claude-sonnet-4-6``) into its parts.

    keel selects the provider+model from ``KEEL_PROVIDER``/``KEEL_MODEL``, so the adapter must pass a
    fully-qualified ``provider/model``. A bare model with no provider is rejected (keel never silently
    guesses a provider).
    """
    if "/" not in model_name:
        raise ValueError(
            f"model name must be 'provider/model' (e.g. anthropic/claude-sonnet-4-6); got {model_name!r}"
        )
    provider, model = model_name.split("/", 1)
    if not provider or not model:
        raise ValueError(f"model name must be 'provider/model'; got {model_name!r}")
    return provider, model


def keel_model_env(model_name: str) -> dict[str, str]:
    """The ``KEEL_PROVIDER``/``KEEL_MODEL`` env keel reads to pick the provider+model (pure)."""
    provider, model = split_model_name(model_name)
    return {"KEEL_PROVIDER": provider, "KEEL_MODEL": model}


def interactive_console_env(source: dict[str, str | None]) -> dict[str, str]:
    """Reviewed interactive-console product env allowed into the benchmark container.

    The config itself is parent-supplied product configuration, not model output. Unknown env vars are
    intentionally dropped so this helper cannot become a broad host-env pass-through.
    """
    env: dict[str, str] = {}
    for name in INTERACTIVE_CONSOLE_ENV:
        value = source.get(name)
        if value:
            env[name] = value
    return env


def interactive_console_env_from_getter(get_env: Callable[[str], str | None]) -> dict[str, str]:
    """Collect reviewed console env through Harbor's agent-env lookup seam.

    Harbor ``--ae`` values are not reliably present in ``os.environ`` during every agent lifecycle
    phase. ``BaseInstalledAgent._get_env`` is the stable accessor: it checks extra agent env first and
    falls back to process env.
    """
    return interactive_console_env({name: get_env(name) for name in INTERACTIVE_CONSOLE_ENV})


def eval_direct_exec_env(source: dict[str, str | None]) -> dict[str, str]:
    """Eval-only runtime acknowledgment for bin-eval direct execution.

    This is deliberately a single exact-ack env var, not a broad ``KEEL_EVAL_*`` pass-through. Release
    binaries ignore it; bin-eval still requires its compile-time build gate before honoring it.
    """
    value = source.get(EVAL_DIRECT_EXEC_ENV)
    if not value:
        return {}
    if value != EVAL_DIRECT_EXEC_ACK:
        raise ValueError("KEEL_EVAL_DIRECT_EXEC must be the exact eval-only acknowledgment")
    return {EVAL_DIRECT_EXEC_ENV: value}


def eval_direct_exec_env_from_getter(get_env: Callable[[str], str | None]) -> dict[str, str]:
    """Collect the eval-direct acknowledgment through Harbor's agent-env lookup seam."""
    return eval_direct_exec_env({EVAL_DIRECT_EXEC_ENV: get_env(EVAL_DIRECT_EXEC_ENV)})


def interactive_console_requested(source: dict[str, str | None]) -> bool:
    """Return true only when parent-supplied console product config is present.

    ``KEEL_WARDEN_SANDBOX=srt`` alone is not enough: it can request the default one-shot sandbox without
    enabling the long-lived console broker, and should not install extra console-only packages.
    """
    return bool(
        source.get("KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG")
        or source.get("KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64")
    )


def validate_interactive_console_env(source: dict[str, str | None]) -> None:
    """Fail closed when collected console env is internally inconsistent."""
    grant = source.get("KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64")
    session_id = source.get("KEEL_RUN_SESSION_ID")
    if grant:
        if not (
            source.get("KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG")
            or source.get("KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64")
        ):
            raise ValueError(
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires interactive console product config"
            )
        if not session_id:
            raise ValueError("KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires KEEL_RUN_SESSION_ID")
        if not source.get("HOME"):
            raise ValueError("KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires HOME")
        if not source.get("KEEL_HOME"):
            raise ValueError("KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires KEEL_HOME")
    if session_id and not SESSION_ID_RE.match(session_id):
        raise ValueError("KEEL_RUN_SESSION_ID must be ses_<ULID>")


def validate_agent_extra_env(source: dict[str, str | None]) -> None:
    """Fail closed on agent-env keys that would alter keel's warden boundary.

    Harbor merges all ``--ae`` values into every container exec. The adapter therefore rejects
    unreviewed warden/internal knobs up front instead of relying on per-command env construction to
    drop them.
    """
    if "KEEL_WARDEN_SANDBOX" in source and source["KEEL_WARDEN_SANDBOX"] != "srt":
        raise ValueError("KEEL_WARDEN_SANDBOX must be srt when set for the keel Harbor agent")
    eval_direct_exec_env(source)
    validate_interactive_console_env(source)
    unsupported = sorted(
        name
        for name in source
        if (
            (name.startswith("KEEL_WARDEN_") and name not in ALLOWED_WARDEN_AGENT_ENV)
            or (name.startswith("KEEL_EVAL_") and name != EVAL_DIRECT_EXEC_ENV)
            or name.startswith("KEEL_INTERNAL_")
        )
    )
    if unsupported:
        joined = ", ".join(unsupported)
        raise ValueError(f"unsupported keel Harbor agent env: {joined}")


def provider_key_env_var(provider: str) -> str:
    """The API-key env var keel's SDK reads for ``provider`` (raises on an unknown provider)."""
    try:
        return PROVIDER_KEY_ENV[provider]
    except KeyError:
        raise ValueError(
            f"unknown provider {provider!r} (expected one of {', '.join(sorted(PROVIDER_KEY_ENV))})"
        ) from None


def glibc_preflight_command() -> str:
    """Fail closed early if the container base is musl/Alpine (QR-3).

    The ``bun --compile`` keel binary is **glibc-linked** and will not run on musl. Detect Alpine
    (``/etc/alpine-release``) or a musl ``ldd`` and exit non-zero with a clear, actionable message
    BEFORE we waste time installing packages + a binary that cannot execute. A glibc/Debian-family base
    is the documented floor (see CONTAINER.md).
    """
    return (
        "if [ -f /etc/alpine-release ] || "
        "(command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then "
        "echo 'keel-adapter: musl/Alpine base detected — the bun-compiled keel binary is glibc-linked "
        "and will not run here. Use a glibc/Debian-family base image (QR-3 / CONTAINER.md).' >&2; "
        "exit 1; fi"
    )


def system_deps_command(*, include_interactive_console: bool = False) -> str:
    """Root command installing keel's runtime system deps (``ripgrep`` + ``bash``).

    glibc/Debian-family only: the ``bun --compile`` binary is glibc-linked, so the base image must NOT
    be musl/Alpine (QR-3). If ``apt-get`` is absent we fail closed with a clear message rather than
    silently producing a broken container.
    """
    runtime_packages = RUNTIME_PACKAGES + (
        INTERACTIVE_CONSOLE_RUNTIME_PACKAGES if include_interactive_console else ()
    )
    pkgs = " ".join(runtime_packages + FETCH_PACKAGES)
    return (
        "if command -v apt-get >/dev/null 2>&1; then "
        f"apt-get update && apt-get install -y {pkgs}; "
        "else "
        "echo 'keel-adapter: apt-get not found — keel requires a glibc/Debian-family base image "
        "(the bun-compiled binary is glibc-linked; QR-3)' >&2; exit 1; "
        "fi"
    )


def install_binary_command(
    url: str, expected_sha256: str, *, dest: str = DEFAULT_BINARY_DEST
) -> str:
    """Download, authenticate, atomically install, and execute a glibc-linux evaluation binary.

    ``expected_sha256`` is owner-supplied provenance from the clean local build manifest. It is
    validated before shell construction; the downloaded bytes are checked before they can replace or
    execute ``dest``. The temporary file lives beside ``dest`` so ``mv`` is a same-filesystem atomic
    replacement. ``-fsSL`` rejects HTTP error pages and ``--`` protects a dash-leading URL.
    """
    if re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None:
        raise ValueError("expected SHA-256 must be 64 lowercase hexadecimal characters")
    q_url = shlex.quote(url)
    q_dest = shlex.quote(dest)
    q_temp_template = shlex.quote(f"{dest}.tmp.XXXXXX")
    return (
        "set -euo pipefail; "
        f"TMP=$(mktemp {q_temp_template}); "
        "trap 'rm -f \"$TMP\"' EXIT; "
        f"curl -fsSL -o \"$TMP\" -- {q_url}; "
        f"printf '%s  %s\\n' {expected_sha256} \"$TMP\" | sha256sum -c -; "
        "chmod 0755 \"$TMP\"; "
        '"$TMP" --version; '
        f"mv -f -- \"$TMP\" {q_dest}; "
        "trap - EXIT; "
        f"{q_dest} --version"
    )


def version_command() -> str:
    """Command that prints the installed keel version (Harbor best-effort version detection)."""
    return f"{shlex.quote(DEFAULT_BINARY_DEST)} --version"


def run_command(
    instruction: str,
    *,
    replay: str | None = None,
    trust: bool = True,
    log_path: str = DEFAULT_LOG_PATH,
) -> str:
    """Build the headless ``keel run`` command for one task instruction.

    - ``--trust`` opts the workspace into project-context loading (AGENTS.md/skills, Epic 1.7). There is
      no sandbox in Phase 1, so this governs context loading only, never enforcement.
    - ``--replay <file>`` swaps the live model for a recorded session (offline, no key/network) — used
      ONLY by the no-spend walking skeleton, NEVER in a real benchmark run.

    The instruction is ``shlex``-quoted (keel receives it as a single argv element, never via shell
    interpolation). ``</dev/null`` prevents keel from blocking on interactive stdin; ``2>&1 | tee``
    captures the full transcript to ``log_path``.

    keel's EXIT CODE is liveness-only — task success is scored from the TB-2 grader's verdict, never
    ``$?`` (QR-7). keel exits **non-zero on a perfectly normal stop** (e.g. exhausting the
    ``KEEL_MAX_TOKENS`` budget cap), so the command ends in a forced ``exit 0``: otherwise Harbor's
    ``exec_as_agent`` (which runs under ``set -o pipefail`` and raises ``NonZeroAgentExitCodeError`` on a
    non-zero exit) would error the trial BEFORE the verifier runs, turning every budget-capped run into a
    spurious exception instead of a scored result. The liveness signal lives in the tee'd transcript (its
    final status line says why keel stopped), not in ``$?``.
    """
    parts = ["keel", "run", "-p", shlex.quote(instruction)]
    if replay is not None:
        parts += ["--replay", shlex.quote(replay)]
    if trust:
        parts.append("--trust")
    pipeline = f"{' '.join(parts)} </dev/null 2>&1 | tee {shlex.quote(log_path)}"
    return f"{pipeline}; exit 0"
