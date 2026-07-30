"""keel Harbor agent — runs the keel coding agent as a Terminal-Bench (Harbor) installed agent.

The pure command builders live in ``keel_harbor_agent.commands`` (Harbor-free, hermetically testable).
The Harbor-coupled agent class lives in ``keel_harbor_agent.agent`` and is imported lazily so that
``commands`` can be unit-tested without Harbor installed.
"""

from . import commands

__all__ = ["commands"]
