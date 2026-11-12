"""Public native invocation facts; all mutable scope belongs to this client."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
import threading
from types import SimpleNamespace

from .identity import native_root, native_route, native_stop_route
from .state import Refusal

INVOCATION = ContextVar("masons_hermes_invocation", default=None)


@dataclass(frozen=True)
class Scope:
    physical: str
    task: str
    turn: str
    call: str
    request: str
    ended: threading.Event = field(default_factory=threading.Event)

    @property
    def active(self):
        return not self.ended.is_set()


@dataclass(frozen=True)
class Caller:
    root: str
    physical: str
    task: str
    turn: str
    call: str
    route: str
    logical: str
    request: str = ""
    scope: Scope | None = None
    platform: str = "local"


class Host:
    def __init__(self, ctx, home):
        self.ctx, self.home = ctx, Path(home).resolve()
        self.disposed = False
        self.turns = {}
        self.observed = {}
        self.rejected = {}
        self.lock = threading.RLock()

    def profile(self):
        from hermes_constants import get_hermes_home
        if self.disposed or Path(get_hermes_home()).resolve() != self.home:
            raise Refusal("native_profile_unavailable")

    def require_receiving(self):
        if not callable(getattr(self.ctx, "inject_message", None)):
            raise Refusal("native_injection_unavailable")

    def require_injection(self, plugin):
        self.profile()
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly() or {}
        if config.get("plugins", {}).get("entries", {}).get(plugin, {}).get("allow_gateway_injection") is not True:
            raise Refusal("native_injection_permission_required")

    def route(self, physical, *, platform="", sender=""):
        return native_route(self.home, physical, platform=platform, sender=sender)

    def begin(self, event):
        self.profile()
        task, turn, platform = event.get("task_id"), event.get("turn_id"), event.get("platform")
        if not task or not turn or not platform or platform in {"subagent", "review", "cron", "kanban", "api_server", "tool", "oneshot", "webhook", "msgraph_webhook"} or self.ctx.current_cron_execution() is not None:
            return
        with self.lock:
            if (task, turn) in self.rejected:
                raise Refusal(self.rejected[(task, turn)])
            self.observed[(task, turn)] = {key: event.get(key) for key in ("session_id", "platform", "sender_id")}
            self.witness(task, turn)

    def end(self, event):
        with self.lock:
            self.turns.pop((event.get("task_id"), event.get("turn_id")), None)
            self.observed.pop((event.get("task_id"), event.get("turn_id")), None)
            self.rejected.pop((event.get("task_id"), event.get("turn_id")), None)

    def interrupt(self, key, physical=None):
        if not key and not physical:
            return
        with self.lock:
            for identity, observed in tuple(self.observed.items()):
                held = self.turns.get(identity, {})
                route = held.get("route")
                if not held:
                    try:
                        route = native_stop_route(self.home, observed["session_id"])
                    except Refusal:
                        route = None
                if (physical and observed["session_id"] == physical
                        or not physical and key and key in {route, held.get("logical"), observed["session_id"]}
                        or not physical and key and not held and not route):
                    self.turns.pop(identity, None)
                    self.observed.pop(identity, None)
                    if not held and not route:
                        self.rejected[identity] = "native_turn_stop_unresolved"

    def witness(self, task, turn):
        with self.lock:
            value = self.turns.get((task, turn))
            observed = self.observed.get((task, turn))
            if self.disposed or observed is None:
                raise Refusal(self.rejected.get((task, turn), "native_user_turn_missing"))
            if value is None:
                value = self.route(observed["session_id"], platform=observed["platform"], sender=observed["sender_id"] or "")
                self.turns[(task, turn)] = value
            return dict(value)

    def disclose(self, task, turn, party):
        with self.lock:
            self.witness(task, turn)
            self.turns[(task, turn)]["party"] = party

    async def caller(self, event):
        self.profile()
        scope = INVOCATION.get()
        if scope is None or not scope.active or not all((scope.physical, scope.task, scope.turn, scope.call, scope.request)):
            raise Refusal("native_tool_scope_missing")
        if event.get("session_id") != scope.physical or event.get("task_id") != scope.task:
            raise Refusal("native_tool_scope_missing")
        for key, expected in (("session_id", scope.physical), ("task_id", scope.task), ("turn_id", scope.turn),
                              ("tool_call_id", scope.call), ("api_request_id", scope.request)):
            if key in event and event[key] != expected:
                raise Refusal("native_tool_scope_changed")
        held = self.witness(scope.task, scope.turn)
        actual = self.route(scope.physical, platform=held["platform"])
        if actual != {key: held.get(key) for key in actual}:
            raise Refusal("native_route_changed")
        root = await asyncio.to_thread(native_root, self.home, scope.physical)
        caller = Caller(root, scope.physical, scope.task, scope.turn, scope.call,
                        held["route"], held["logical"], scope.request, scope, held["platform"])
        self.validate(caller)
        return caller

    def validate(self, caller):
        self.profile()
        held = self.witness(caller.task, caller.turn)
        if (caller.scope is None or not caller.scope.active
                or (held["route"], held["logical"]) != (caller.route, caller.logical)):
            raise Refusal("native_invocation_ended")
        actual = self.route(caller.physical, platform=held["platform"])
        if actual != {key: held.get(key) for key in actual}:
            raise Refusal("native_route_changed")

    def observation(self, event):
        self.profile()
        physical, task, turn, request = (event.get(k) for k in ("session_id", "task_id", "turn_id", "api_request_id"))
        if not physical or not request:
            raise Refusal("native_observation_missing")
        self.witness(task, turn)
        return {"physical": physical, "task": task, "turn": turn, "request": request}

    def owner_context(self, event):
        self.profile()
        surface = self.ctx.session_surface() if callable(getattr(self.ctx, "session_surface", None)) else ""
        if surface in {"local", "cli", "tui", "desktop"} and event.get("platform") in {"local", "cli", "tui", "desktop"}:
            return surface, ""
        source = event.get("source")
        if surface != "telegram" or event.get("platform") != "telegram" or source is None:
            raise Refusal("owner_authorized_command_required")
        return self.telegram_owner(source)

    def tool_owner(self, caller):
        self.profile()
        self.validate(caller)
        held = self.witness(caller.task, caller.turn)
        if held["platform"] == "local":
            return
        if held["platform"] != "telegram":
            raise Refusal("owner_authorized_channel_required")
        from gateway.config import Platform
        chat, kind, thread, user, profile, transport = held["peer"]
        self.telegram_owner(SimpleNamespace(platform=Platform.TELEGRAM, chat_type=kind,
            user_id=user, chat_id=chat, thread_id=thread, profile=profile), admitted=True, transport=transport)

    def telegram_owner(self, source, *, admitted=False, transport=None):
        self.profile()
        from gateway.config import Platform, load_gateway_config
        from hermes_constants import profile_name_for_home
        gateway = load_gateway_config()
        own = profile_name_for_home(self.home)
        if admitted:
            from agent.secret_scope import is_multiplex_active
            if not transport and (is_multiplex_active() or gateway.multiplex_profiles):
                raise Refusal("owner_transport_unresolved")
            if transport and transport != own:
                from hermes_constants import get_default_hermes_root, reset_hermes_home_override, set_hermes_home_override
                from agent.secret_scope import build_profile_secret_scope, reset_multiplex_context, reset_secret_scope, set_multiplex_context, set_secret_scope
                if not isinstance(transport, str) or Path(transport).name != transport or transport in {".", ".."}:
                    raise Refusal("owner_transport_unresolved")
                root = get_default_hermes_root(home=self.home)
                home = root if transport == "default" else root / "profiles" / transport
                if not home.is_dir() or profile_name_for_home(home) != transport:
                    raise Refusal("owner_transport_unresolved")
                multiplex = set_multiplex_context(True)
                try:
                    token = set_hermes_home_override(home)
                    try:
                        secret = set_secret_scope(build_profile_secret_scope(home), profile_home=str(home))
                        try:
                            gateway = load_gateway_config()
                        finally:
                            reset_secret_scope(secret)
                    finally:
                        reset_hermes_home_override(token)
                finally:
                    reset_multiplex_context(multiplex)
        config = gateway.platforms.get(Platform.TELEGRAM)
        if config is None or config.enabled is not True or not isinstance(config.extra, dict):
            raise Refusal("owner_native_policy_unavailable")
        admins = config.extra.get("allow_admin_from")
        values = admins if isinstance(admins, (list, tuple, set, frozenset)) else (admins.split(",") if isinstance(admins, str) else ([] if admins is None else [admins]))
        if any(isinstance(value, bool) or not isinstance(value, (str, int)) for value in values):
            raise Refusal("owner_native_policy_unavailable")
        admin_ids = {str(value).strip() for value in values if str(value).strip()}
        user = getattr(source, "user_id", None)
        routed = getattr(source, "profile", None)
        if (getattr(source, "platform", None) != Platform.TELEGRAM or getattr(source, "chat_type", None) != "dm"
                or getattr(source, "profile_route_rejected", False) or routed and routed != own
                or not isinstance(user, str) or not user.isdecimal()
                or (user not in admin_ids if admin_ids else not admitted)
                or str(getattr(source, "chat_id", "")) != user or getattr(source, "is_bot", False)):
            raise Refusal("owner_explicit_native_admin_required")
        return "telegram", user, getattr(source, "thread_id", None), str(self.home)

    def owner_session(self, event):
        self.profile()
        physical = event.get("session_id")
        held = self.route(physical, platform=event.get("platform") or "")
        if event.get("session_key") != held["route"]:
            raise Refusal("native_route_changed")
        return native_root(self.home, physical), held["route"], held["logical"], physical, held["platform"]

    @staticmethod
    def compatibility(ctx):
        from hermes_state import SessionDB
        telegram = callable(getattr(ctx, "register_platform_handler", None))
        choice = callable(getattr(ctx, "ask_choice", None))
        return {
            "invocation_route": callable(getattr(SessionDB, "get_session", None)),
            "native_telegram_controls": telegram,
            "local_owner_surface": callable(getattr(ctx, "session_surface", None)),
            "confirmation_interfaces": {"native_choice": choice, "telegram_buttons": telegram,
                                        "browser_link": True},
            "authorization": "not_checked",
            "receiving": "not_proven",
            "keyed_injection": callable(getattr(ctx, "inject_message", None)),
            "conversation_projection": callable(getattr(SessionDB, "conversation_revision", None)),
            "compression_lineage": callable(getattr(SessionDB, "get_compression_lineage", None)),
            "tool_rotation": callable(getattr(SessionDB, "get_tool_rotation_root", None)),
            "note": "These are interface observations, not proof of Session receiving or presentation. No Hermes upgrade was performed.",
        }
