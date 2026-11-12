"""Public plugin registration and one gateway-owned supervisor per profile."""
from __future__ import annotations

import asyncio
import importlib.util
import logging
from pathlib import Path
import threading

from . import _build as build
from .communication import Communication
from .host import Host, INVOCATION, Scope
from .owner import Owner
from .state import Refusal, State, encoded
from .vault import Vault
from .tools import SCHEMAS, DESCRIPTIONS

log = logging.getLogger("masons.hermes")


def register(ctx):
    from gateway.config import Platform
    from gateway.platforms.base import BasePlatformAdapter, SendResult
    from hermes_constants import get_hermes_home
    from plugins.plugin_storage import plugin_data_dir, plugin_db

    instances = []
    disposed = False
    telegram_stop = None
    views = {}
    view_lock = threading.Lock()

    def current(event=None):
        home = Path(get_hermes_home()).resolve()
        active = [c for c in instances if c.host.home == home and not c.closed and not c.host.disposed]
        if disposed or len(active) > 1:
            raise Refusal("canonical_gateway_receiver_required")
        if active:
            return active[0]
        with view_lock:
            if home not in views:
                if event is None or not event.get("task_id") or not event.get("turn_id"):
                    raise Refusal("canonical_gateway_receiver_required")
                host = Host(ctx, home)
                host.begin(event)
                facts = host.witness(event["task_id"], event["turn_id"])
                if not facts.get("continuation"):
                    raise Refusal("canonical_gateway_receiver_required")
                from .execution import Execution
                views[home] = Execution(ctx, home, build)
            return views[home].get()

    def tool(name):
        async def handler(args, **event):
            try:
                result = await current().dispatch(name, args, event)
                return result if isinstance(result, str) else encoded(result)
            except Refusal as error:
                return encoded({"error": error.code, "retry": False})
            except Exception:
                log.exception("MASONS tool failed")
                return encoded({"error": "operation_unconfirmed", "retry": False})
        return handler

    def execution(*, tool_name, args, next_call, session_id="", task_id="", turn_id="", tool_call_id="", api_request_id="", **event):
        if tool_name not in {build.PREFIX + n for n in SCHEMAS}:
            return next_call(args)
        scope = Scope(session_id, task_id, turn_id, tool_call_id, api_request_id)
        token = INVOCATION.set(scope)
        try:
            return next_call(args)
        finally:
            scope.ended.set()
            INVOCATION.reset(token)

    ctx.register_middleware("tool_execution", execution)

    def command(raw, **event):
        try:
            if raw.strip() == "compatibility":
                return encoded(Host.compatibility(ctx))
            if not callable(getattr(ctx, "session_surface", None)):
                raise Refusal("native_owner_controls_unavailable")
            client = current()
            if client.owner is None:
                raise Refusal("native_owner_controls_unavailable")
            return encoded(client.owner.command(raw, **event))
        except Refusal as error:
            return encoded({"error": error.code, **({"detail": "Use this profile's configured Telegram administrator DM for status, Link, cancel or unlink. Session messaging continues in the original conversation."}
                            if error.code == "native_owner_controls_unavailable" else {})})
        except Exception:
            log.exception("MASONS owner command failed")
            return encoded({"error": "operation_unconfirmed"})

    def observe(name):
        def callback(**event):
            try:
                client = current(event if name == "begin" else None)
                if name == "begin":
                    client.host.begin(event)
                    if client.state.get("credential"):
                        witness = client.host.witness(event.get("task_id"), event.get("turn_id"))
                        client.schedule(client.discover({**witness, "physical": event["session_id"]}))
                        return client.party_line(event)
                elif name == "end":
                    client.typing.finish(event, turn=True)
                    client.host.end(event)
                elif name == "request_end":
                    client.typing.finish(event)
                elif name == "interrupt":
                    client.host.interrupt(event.get("session_key"), event.get("parent_session_id"))
                elif name == "proof":
                    client.pre_request(event)
                elif name == "lifecycle":
                    # Normal UI shutdown/disconnect is deliberately not retirement.
                    if event.get("reason") in {"deleted", "reset", "session_reset"}:
                        root = client.state.get("physical/" + (event.get("old_session_id") or event.get("session_id", "")))
                        if root:
                            client.state.put("ended/" + root, event["reason"])
                            client.typing.reconcile()
            except Refusal as error:
                if name == "begin":
                    log.warning("MASONS native turn admission refused: %s", error.code)
                return
            except Exception:
                log.exception("MASONS observation failed")
        return callback

    class Adapter(BasePlatformAdapter):
        def __init__(self, config):
            super().__init__(config, Platform(build.PLATFORM))
            self.client = self.task = self.store = None

        async def connect(self, *, is_reconnect=False):
            if disposed:
                return False
            if self.client and not self.client.closed:
                return True
            home = Path(get_hermes_home()).resolve()
            if any(not c.closed and c.host.home == home for c in instances):
                raise Refusal("duplicate_profile_receiver")
            directory = plugin_data_dir(build.PLATFORM)
            self.store = State(directory, profile=home, channel=build.CHANNEL,
                               connection=plugin_db(build.PLATFORM, "communication.sqlite3"),
                               vault=Vault(home, build.SECRET_PREFIX))
            client = Communication(ctx, Host(ctx, home), self.store, build, asyncio.get_running_loop())
            client.owner = Owner(client)
            self.client = client
            instances.append(client)
            async def service():
                try:
                    await client.run()
                finally:
                    client.host.disposed = True
                    self._mark_disconnected()
                    if client in instances:
                        instances.remove(client)
                    if self.store:
                        self.store.close()
                        self.store = None
            self.task = ctx.spawn_task(service(), name=build.PLATFORM + ":service")
            self._mark_connected()
            # Attach authentication is attempted after startup has published the gateway.
            def stop():
                client.host.disposed = True
                if not client.loop.is_closed():
                    client.loop.call_soon_threadsafe(self.task.cancel)
            ctx.on_unload(stop)
            return True

        async def disconnect(self):
            self._mark_disconnected()
            if self.client is None:
                return
            self.client.host.disposed = True
            if self.task:
                self.task.cancel()
                await asyncio.gather(self.task, return_exceptions=True)
            await self.client.close()
            if self.client in instances:
                instances.remove(self.client)
            if self.store:
                self.store.close()
                self.store = None

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            return SendResult(success=False, error="Use the MASONS send tool in its native Session.")

        async def get_chat_info(self, chat_id):
            raise Refusal("masons_is_not_a_shadow_chat")

    def unload():
        nonlocal disposed
        disposed = True
        for client in instances:
            client.host.disposed = True

    ctx.on_unload(unload)
    ctx.register_platform(build.PLATFORM, build.LABEL, Adapter,
        check_fn=lambda: all(importlib.util.find_spec(m) is not None for m in ("aiohttp", "cryptography")),
        validate_config=lambda config: True, required_env=[],
        install_hint="Enable this plugin's gateway platform and injection permission, then restart the canonical gateway.")
    def telegram(application, adapter):
        nonlocal telegram_stop
        from .telegram import wire
        if telegram_stop:
            telegram_stop()
        telegram_stop = wire(ctx, application, adapter, current, build)

    if callable(getattr(ctx, "register_platform_handler", None)):
        ctx.register_platform_handler("telegram", telegram)
    for name, schema in SCHEMAS.items():
        description = "On " + build.LABEL + ": " + DESCRIPTIONS[name]
        ctx.register_tool(build.PREFIX + name, build.PLATFORM,
            {"name": build.PREFIX + name, "description": description, "parameters": schema},
            tool(name), is_async=True, description=description)
    ctx.register_command(build.PLATFORM, command, description=build.LABEL + " status, link [@handle], unlink, cancel, compatibility", args_hint="status | link [@handle] | unlink | cancel | compatibility")
    for hook, name in (("pre_llm_call", "begin"), ("post_llm_call", "end"), ("pre_api_request", "proof"), ("post_api_request", "request_end"), ("api_request_error", "request_end"), ("on_session_end", "end"), ("agent_loop_stopped", "interrupt"), ("on_session_finalize", "lifecycle"), ("on_session_reset", "lifecycle")):
        ctx.register_hook(hook, observe(name))
