"""Credentials use Hermes' supported profile secret lifecycle, not the journal."""
from __future__ import annotations

from contextvars import copy_context
import json
from pathlib import Path

from .state import Refusal, encoded


class Vault:
    def __init__(self, home, prefix):
        self.home, self.prefix = Path(home).resolve(), prefix
        self.context = copy_context()

    def scoped(self, operation):
        def run():
            from hermes_constants import get_hermes_home
            if Path(get_hermes_home()).resolve() != self.home or not self.home.is_dir():
                raise Refusal("secret_profile_changed")
            from agent.secret_scope import build_profile_secret_scope, reset_secret_scope, set_secret_scope
            token = set_secret_scope(build_profile_secret_scope(self.home), profile_home=str(self.home))
            try:
                return operation()
            finally:
                reset_secret_scope(token)
        return self.context.copy().run(run)

    def name(self, key):
        return self.prefix + ("RUNTIME" if key == "credential" else "HANDOFF")

    def get(self, key, default=None):
        def read():
            from hermes_cli.config import get_env_value_prefer_dotenv
            raw = get_env_value_prefer_dotenv(self.name(key))
            if not raw:
                return default
            try:
                value = json.loads(raw)
            except (TypeError, ValueError):
                raise Refusal("secret_value_unreadable") from None
            return default if value is None else value
        return self.scoped(read)

    def put(self, key, value):
        def write():
            from hermes_cli.config import save_env_value_secure
            result = save_env_value_secure(self.name(key), encoded(value))
            if not result.get("success"):
                raise Refusal("secret_write_unconfirmed")
        return self.scoped(write)
