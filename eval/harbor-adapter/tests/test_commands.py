"""Hermetic unit tests for the keel Harbor agent's pure command builders.

No Harbor, no Docker, no network — runnable with plain ``python3 -m unittest`` on any Python >=3.12.
This is the Phase-A "adapter offline validation" of the command-construction path: the exact shell keel
runs in a benchmark container is asserted in isolation, so the security-sensitive surface is reviewed
and pinned without spending a cent.
"""

import hashlib
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# Import the harbor-free builders directly (no Harbor needed).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from keel_harbor_agent import commands as c  # noqa: E402


class TestRunCommand(unittest.TestCase):
    def test_basic_run_is_headless_trusted_and_teed(self) -> None:
        cmd = c.run_command("fix the bug")
        # keel is invoked headless with the prompt as a single quoted argv element.
        self.assertIn("keel run -p 'fix the bug'", cmd)
        self.assertIn("--trust", cmd)
        # Never blocks on stdin; full transcript captured to the default log path.
        self.assertIn("</dev/null", cmd)
        self.assertIn(f"tee {shlex.quote(c.DEFAULT_LOG_PATH)}", cmd)
        # No live run should ever carry a replay flag.
        self.assertNotIn("--replay", cmd)

    def test_replay_is_quoted_and_present_when_requested(self) -> None:
        cmd = c.run_command("do x", replay="/rec/smoke.json")
        self.assertIn("--replay /rec/smoke.json", cmd)
        self.assertIn("--trust", cmd)

    def test_trust_can_be_disabled(self) -> None:
        cmd = c.run_command("do x", trust=False)
        self.assertNotIn("--trust", cmd)

    def test_instruction_is_shell_quoted_no_injection(self) -> None:
        # A hostile instruction must not break out of the single argv element.
        evil = "x'; rm -rf / #"
        cmd = c.run_command(evil)
        self.assertIn(shlex.quote(evil), cmd)
        # The dangerous substring only ever appears INSIDE the quoted token, never bare.
        self.assertNotIn("; rm -rf / #\n", cmd)
        # shlex round-trips the whole command into tokens with the instruction intact.
        self.assertIn(evil, shlex.split(cmd.split("</dev/null")[0]))

    def test_custom_log_path_is_quoted(self) -> None:
        cmd = c.run_command("t", log_path="/logs/agent/run 1.txt")
        self.assertIn(shlex.quote("/logs/agent/run 1.txt"), cmd)

    def test_run_forces_zero_exit_so_keel_exit_never_scores(self) -> None:
        # QR-7: keel's exit code is liveness-only — the TB-2 verifier scores the task, never `$?`. keel
        # exits non-zero on a perfectly normal stop (e.g. exhausting the KEEL_MAX_TOKENS budget cap), so
        # the run command MUST end in a forced 0 exit; otherwise Harbor's `exec_as_agent` (under
        # `set -o pipefail`) raises NonZeroAgentExitCodeError and errors the trial before the verifier
        # ever runs. Regression for the initial bounded Harbor probe finding (budget-stop → errored trial instead of a scored one).
        cmd = c.run_command("do the task")
        self.assertTrue(cmd.rstrip().endswith("exit 0"), f"run command must force exit 0; got: {cmd!r}")
        # The transcript is still captured (the liveness signal lives in the tee'd log, not in $?).
        self.assertIn("tee ", cmd)


class TestInstallCommands(unittest.TestCase):
    BINARY_SHA256 = "a" * 64

    def test_system_deps_installs_ripgrep_and_bash_and_fails_closed_off_apt(self) -> None:
        cmd = c.system_deps_command()
        self.assertIn("ripgrep", cmd)
        self.assertIn("bash", cmd)
        self.assertNotIn("tmux", cmd)
        self.assertNotIn("bubblewrap", cmd)
        self.assertNotIn("socat", cmd)
        self.assertIn("apt-get install -y", cmd)
        # Fails closed (non-zero exit) on a non-apt (e.g. musl/Alpine) base — QR-3.
        self.assertIn("exit 1", cmd)

    def test_system_deps_installs_console_runtime_deps_only_for_reviewed_interactive_console_config(
        self,
    ) -> None:
        self.assertFalse(c.interactive_console_requested({}))
        self.assertFalse(c.interactive_console_requested({"KEEL_WARDEN_SANDBOX": "srt"}))
        self.assertFalse(
            c.interactive_console_requested(
                {"KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0="}
            )
        )
        self.assertTrue(
            c.interactive_console_requested(
                {"KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJiYWNrZW5kIjp7fX0="}
            )
        )
        self.assertTrue(
            c.interactive_console_requested({"KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG": "{}"})
        )

        cmd = c.system_deps_command(include_interactive_console=True)
        self.assertIn("ripgrep", cmd)
        self.assertIn("bash", cmd)
        self.assertIn("tmux", cmd)
        self.assertIn("bubblewrap", cmd)
        self.assertIn("socat", cmd)

    def test_system_deps_includes_fetch_tools_for_binary_install(self) -> None:
        # TB-2 task images do NOT guarantee curl/ca-certificates/coreutils. The installer downloads and
        # hash-verifies the binary before atomically replacing the destination, so all must be explicit.
        # Regression for the initial bounded Harbor probe finding: the stock terminal-bench-2 image lacked curl → install exit 127.
        cmd = c.system_deps_command()
        self.assertIn("curl", cmd)
        self.assertIn("ca-certificates", cmd)
        self.assertIn("coreutils", cmd)

    def test_glibc_preflight_detects_musl_and_fails_closed(self) -> None:
        cmd = c.glibc_preflight_command()
        self.assertIn("/etc/alpine-release", cmd)  # Alpine detection
        self.assertIn("musl", cmd)  # musl ldd detection
        self.assertIn("exit 1", cmd)  # fails closed
        self.assertIn("glibc", cmd)  # the message names the requirement

    def test_install_binary_downloads_hash_checks_and_atomically_installs(self) -> None:
        cmd = c.install_binary_command(
            "https://example.invalid/keel-linux-x64", self.BINARY_SHA256
        )
        self.assertIn(shlex.quote("https://example.invalid/keel-linux-x64"), cmd)
        self.assertIn("curl -fsSL", cmd)  # fail on HTTP error, never write an error page to the binary
        self.assertIn("mktemp", cmd)
        self.assertIn("sha256sum -c -", cmd)
        self.assertIn(self.BINARY_SHA256, cmd)
        self.assertIn('chmod 0755 "$TMP"', cmd)
        self.assertIn("mv -f --", cmd)
        self.assertIn("trap", cmd)
        self.assertIn('"$TMP" --version', cmd)
        self.assertLess(cmd.index('"$TMP" --version'), cmd.index("mv -f --"))
        self.assertTrue(cmd.rstrip().endswith("--version"))
        self.assertIn("set -euo pipefail", cmd)

    @unittest.skipUnless(
        shutil.which("bash") and shutil.which("sha256sum"),
        "requires bash and sha256sum",
    )
    def test_install_binary_wrong_hash_cannot_replace_or_execute_destination(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            source = tmp / "downloaded-keel"
            source.write_text(
                "#!/usr/bin/env bash\n"
                "if [[ ${1:-} == --version ]]; then\n"
                "  printf executed >> \"$EXECUTION_MARKER\"\n"
                "  echo 'keel 0.0.0-test'\n"
                "  exit 0\n"
                "fi\n"
                "exit 64\n",
                encoding="utf-8",
            )
            source.chmod(0o755)
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            dest = tmp / "keel"
            dest.write_text("existing-destination\n", encoding="utf-8")
            fake_bin = tmp / "fake-bin"
            fake_bin.mkdir()
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                "out=''\n"
                "while (($#)); do\n"
                "  case \"$1\" in\n"
                "    -o) out=$2; shift 2 ;;\n"
                "    --) shift; break ;;\n"
                "    *) shift ;;\n"
                "  esac\n"
                "done\n"
                "cp -- \"$FAKE_BINARY_SOURCE\" \"$out\"\n",
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            execution_marker = tmp / "execution-marker"
            env = {
                **os.environ,
                "EXECUTION_MARKER": str(execution_marker),
                "FAKE_BINARY_SOURCE": str(source),
                "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}",
            }

            denied = subprocess.run(
                [
                    "bash",
                    "-c",
                    c.install_binary_command(
                        "https://example.invalid/keel", "0" * 64, dest=str(dest)
                    ),
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(denied.returncode, 0)
            self.assertEqual(dest.read_text(encoding="utf-8"), "existing-destination\n")
            self.assertFalse(execution_marker.exists())
            self.assertEqual(list(tmp.glob("keel.tmp.*")), [])

            allowed = subprocess.run(
                ["bash", "-c", c.install_binary_command("https://example.invalid/keel", expected, dest=str(dest))],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            self.assertEqual(dest.read_bytes(), source.read_bytes())
            self.assertEqual(execution_marker.read_text(encoding="utf-8"), "executedexecuted")
            self.assertEqual(list(tmp.glob("keel.tmp.*")), [])

    def test_install_binary_url_is_quoted_no_injection(self) -> None:
        evil = "https://x/$(touch pwned)"
        cmd = c.install_binary_command(evil, self.BINARY_SHA256)
        self.assertIn(shlex.quote(evil), cmd)

    def test_install_binary_uses_end_of_options_guard_for_a_dash_url(self) -> None:
        # `--` before the URL means a dash-leading URL can't be parsed by curl as a flag.
        cmd = c.install_binary_command("-o/etc/cron.d/evil", self.BINARY_SHA256)
        self.assertRegex(cmd, r"curl -fsSL -o \S+ -- ")
        self.assertIn(shlex.quote("-o/etc/cron.d/evil"), cmd)

    def test_install_binary_rejects_missing_or_malformed_expected_hash(self) -> None:
        for malformed in ("", "a" * 63, "A" * 64, "g" * 64, "a" * 64 + "; touch pwned"):
            with self.subTest(malformed=malformed):
                with self.assertRaisesRegex(ValueError, "expected SHA-256"):
                    c.install_binary_command("https://example.invalid/keel", malformed)

    def test_phase_b_readme_backgrounds_and_cleans_up_the_binary_server(self) -> None:
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf8")
        phase_b = readme.split("## Phase B", 1)[1].split("Container-prep specifics", 1)[0]
        self.assertIn("keel_http_pid=$!", phase_b)
        self.assertIn("trap keel_stop_http_server EXIT INT TERM", phase_b)
        self.assertIn('kill "$keel_http_pid"', phase_b)
        server = "(cd build/bin && exec python3 -m http.server 8077 --bind 0.0.0.0) &"
        self.assertIn(server, phase_b)
        self.assertLess(phase_b.index(server), phase_b.index("harbor run"))

    def test_version_command_targets_the_installed_binary(self) -> None:
        self.assertEqual(c.version_command(), f"{shlex.quote(c.DEFAULT_BINARY_DEST)} --version")


class TestModelEnv(unittest.TestCase):
    def test_split_model_name(self) -> None:
        self.assertEqual(
            c.split_model_name("anthropic/claude-sonnet-4-6"),
            ("anthropic", "claude-sonnet-4-6"),
        )

    def test_split_model_name_rejects_bare_model(self) -> None:
        with self.assertRaises(ValueError):
            c.split_model_name("claude-sonnet-4-6")
        with self.assertRaises(ValueError):
            c.split_model_name("anthropic/")

    def test_keel_model_env(self) -> None:
        self.assertEqual(
            c.keel_model_env("anthropic/claude-sonnet-4-6"),
            {"KEEL_PROVIDER": "anthropic", "KEEL_MODEL": "claude-sonnet-4-6"},
        )

    def test_interactive_console_env_forwards_only_reviewed_product_config_and_grant_knobs(self) -> None:
        self.assertEqual(
            c.interactive_console_env(
                {
                    "KEEL_WARDEN_SANDBOX": "srt",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG": "",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                    "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    "HOME": "/logs/agent",
                    "KEEL_HOME": "/logs/agent/keelhome",
                    "KEEL_WARDEN_POLICY_PATH": "/tmp/should-not-pass",
                    "SECRET_TOKEN": "do-not-pass",
                }
            ),
            {
                "KEEL_WARDEN_SANDBOX": "srt",
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "HOME": "/logs/agent",
                "KEEL_HOME": "/logs/agent/keelhome",
            },
        )

    def test_interactive_console_env_from_getter_honors_agent_extra_env(self) -> None:
        extra_env = {
            "KEEL_WARDEN_SANDBOX": "srt",
            "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJhZ2VudCI6ImVudiJ9",
            "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
            "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "HOME": "/logs/agent",
            "KEEL_HOME": "/logs/agent/keelhome",
            "KEEL_WARDEN_POLICY_PATH": "/tmp/should-not-pass",
        }

        env = c.interactive_console_env_from_getter(extra_env.get)

        self.assertEqual(
            env,
            {
                "KEEL_WARDEN_SANDBOX": "srt",
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJhZ2VudCI6ImVudiJ9",
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "HOME": "/logs/agent",
                "KEEL_HOME": "/logs/agent/keelhome",
            },
        )
        self.assertTrue(c.interactive_console_requested(env))

    def test_eval_direct_exec_env_forwards_only_exact_ack(self) -> None:
        self.assertEqual(
            c.eval_direct_exec_env(
                {
                    "KEEL_EVAL_DIRECT_EXEC": c.EVAL_DIRECT_EXEC_ACK,
                    "KEEL_EVAL_OTHER": "do-not-pass",
                    "SECRET_TOKEN": "do-not-pass",
                }
            ),
            {"KEEL_EVAL_DIRECT_EXEC": c.EVAL_DIRECT_EXEC_ACK},
        )
        self.assertEqual(c.eval_direct_exec_env({}), {})
        self.assertEqual(c.eval_direct_exec_env({"KEEL_EVAL_DIRECT_EXEC": ""}), {})
        with self.assertRaisesRegex(ValueError, "KEEL_EVAL_DIRECT_EXEC must be the exact"):
            c.eval_direct_exec_env({"KEEL_EVAL_DIRECT_EXEC": "1"})

    def test_eval_direct_exec_env_from_getter_honors_agent_extra_env(self) -> None:
        extra_env = {
            "KEEL_EVAL_DIRECT_EXEC": c.EVAL_DIRECT_EXEC_ACK,
            "KEEL_EVAL_OTHER": "do-not-pass",
        }

        self.assertEqual(
            c.eval_direct_exec_env_from_getter(extra_env.get),
            {"KEEL_EVAL_DIRECT_EXEC": c.EVAL_DIRECT_EXEC_ACK},
        )

    def test_validate_agent_extra_env_rejects_unreviewed_warden_knobs(self) -> None:
        c.validate_agent_extra_env(
            {
                "KEEL_BINARY_URL": "http://host.docker.internal:8077/keel-linux-x64",
                "KEEL_HOME": "/logs/agent/keelhome",
                "KEEL_WARDEN_SANDBOX": "srt",
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "HOME": "/logs/agent",
                "KEEL_HOME": "/logs/agent/keelhome",
            }
        )

        with self.assertRaisesRegex(
            ValueError,
            "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires KEEL_RUN_SESSION_ID",
        ):
            c.validate_agent_extra_env(
                {
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                    "HOME": "/logs/agent",
                    "KEEL_HOME": "/logs/agent/keelhome",
                }
            )

        with self.assertRaisesRegex(ValueError, "KEEL_RUN_SESSION_ID must be ses_<ULID>"):
            c.validate_agent_extra_env(
                {
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                    "KEEL_RUN_SESSION_ID": "not-a-session",
                    "HOME": "/logs/agent",
                    "KEEL_HOME": "/logs/agent/keelhome",
                }
            )

        with self.assertRaisesRegex(ValueError, "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires HOME"):
            c.validate_agent_extra_env(
                {
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                    "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    "KEEL_HOME": "/logs/agent/keelhome",
                }
            )

        with self.assertRaisesRegex(
            ValueError, "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires KEEL_HOME"
        ):
            c.validate_agent_extra_env(
                {
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_CONFIG_B64": "eyJrIjoiYiJ9",
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                    "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    "HOME": "/logs/agent",
                }
            )

        with self.assertRaisesRegex(
            ValueError,
            "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64 requires interactive console product config",
        ):
            c.validate_agent_extra_env(
                {
                    "KEEL_WARDEN_INTERACTIVE_CONSOLE_GRANT_B64": "eyJncmFudCI6dHJ1ZX0=",
                    "KEEL_RUN_SESSION_ID": "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    "HOME": "/logs/agent",
                    "KEEL_HOME": "/logs/agent/keelhome",
                }
            )

        with self.assertRaisesRegex(
            ValueError, "unsupported keel Harbor agent env: KEEL_INTERNAL_WARDEN_STDIO"
        ):
            c.validate_agent_extra_env({"KEEL_INTERNAL_WARDEN_STDIO": "1"})

        with self.assertRaisesRegex(
            ValueError, "unsupported keel Harbor agent env: KEEL_WARDEN_POLICY_PATH"
        ):
            c.validate_agent_extra_env({"KEEL_WARDEN_POLICY_PATH": "/tmp/policy.json"})

        with self.assertRaisesRegex(
            ValueError, "unsupported keel Harbor agent env: KEEL_WARDEN_POLICY_PATH"
        ):
            c.validate_agent_extra_env({"KEEL_WARDEN_POLICY_PATH": ""})

        with self.assertRaisesRegex(ValueError, "KEEL_WARDEN_SANDBOX must be srt"):
            c.validate_agent_extra_env({"KEEL_WARDEN_SANDBOX": "none"})

        with self.assertRaisesRegex(ValueError, "KEEL_WARDEN_SANDBOX must be srt"):
            c.validate_agent_extra_env({"KEEL_WARDEN_SANDBOX": ""})

        with self.assertRaisesRegex(ValueError, "KEEL_EVAL_DIRECT_EXEC must be the exact"):
            c.validate_agent_extra_env({"KEEL_EVAL_DIRECT_EXEC": "1"})

        with self.assertRaisesRegex(
            ValueError, "unsupported keel Harbor agent env: KEEL_EVAL_EXTRA_ROOTS"
        ):
            c.validate_agent_extra_env({"KEEL_EVAL_EXTRA_ROOTS": "/app:/tmp"})

        with self.assertRaisesRegex(
            ValueError, "unsupported keel Harbor agent env: KEEL_EVAL_BASH_MAX_TIMEOUT_MS"
        ):
            c.validate_agent_extra_env({"KEEL_EVAL_BASH_MAX_TIMEOUT_MS": "10800000"})

    def test_provider_key_env_var_matches_keel(self) -> None:
        self.assertEqual(c.provider_key_env_var("anthropic"), "ANTHROPIC_API_KEY")
        self.assertEqual(c.provider_key_env_var("openai"), "OPENAI_API_KEY")
        self.assertEqual(c.provider_key_env_var("google"), "GOOGLE_GENERATIVE_AI_API_KEY")

    def test_provider_key_env_var_rejects_unknown(self) -> None:
        with self.assertRaises(ValueError):
            c.provider_key_env_var("mistral")


if __name__ == "__main__":
    unittest.main()
