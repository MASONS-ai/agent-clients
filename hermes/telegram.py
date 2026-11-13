"""Owner commands on the Host's documented native Telegram extension point."""
from __future__ import annotations

import asyncio
from contextvars import copy_context
import logging
from pathlib import Path
import re
import secrets
import threading
import time

from .state import Refusal, encoded
from .host import Host

log = logging.getLogger("masons.hermes")


def wire(ctx, application, adapter, current, build):
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    from telegram.ext import ApplicationHandlerStop, CallbackQueryHandler, CommandHandler
    from gateway.config import load_gateway_config
    from gateway.platforms.base import build_session_key
    from hermes_constants import get_hermes_home, profile_name_for_home

    home, context, loop = Path(get_hermes_home()).resolve(), copy_context(), asyncio.get_running_loop()
    ended, pending, stop_lock = threading.Event(), {}, threading.Lock()
    prefix = build.PLATFORM + ":"

    def actor(update):
        if ended.is_set():
            raise Refusal("owner_native_handler_ended")
        user, chat, message = update.effective_user, update.effective_chat, update.effective_message
        if (user is None or user.is_bot or chat is None or chat.type != "private" or message is None
                or str(user.id) != str(chat.id)):
            raise Refusal("owner_explicit_native_admin_required")
        source = adapter.build_source(chat_id=str(chat.id), chat_type="dm", user_id=str(user.id),
            thread_id=str(message.message_thread_id) if message.message_thread_id else None)
        routed, own = getattr(source, "profile", None), profile_name_for_home(home)
        if getattr(source, "profile_route_rejected", False) or routed and routed != own:
            raise Refusal("owner_profile_route_unavailable")
        client = current()
        authority = client.host.telegram_owner(source)
        config = load_gateway_config()
        route = build_session_key(source, group_sessions_per_user=config.group_sessions_per_user,
            thread_sessions_per_user=config.thread_sessions_per_user, profile=routed)
        return client, authority, route

    def native_session(client, route):
        try:
            return client.owner.session_for_route(route)
        except Refusal:
            return None

    async def command(update, sdk):
        text = update.effective_message.text or ""
        raw = text.split(maxsplit=1)[1] if len(text.split(maxsplit=1)) == 2 else ""
        if raw.strip() == "compatibility":
            await update.effective_message.reply_text(encoded(Host.compatibility(ctx)))
            return
        client, authority, route = actor(update)
        if not client.owner.commands.acquire(blocking=False):
            raise Refusal("owner_action_in_progress")
        try:
            proposal = client.owner.prepare(raw)
            native = native_session(client, route)
            if proposal["action"] == "status":
                def authorize():
                    if actor(update) != (client, authority, route) or native_session(client, route) != native:
                        raise Refusal("owner_context_changed")
                result = await client.owner.status(native[0] if native else None,
                    unavailable=None if native else "native_identity_unresolved", authorize=authorize)
                authorize()
                await update.effective_message.reply_text(encoded(result))
                return
            nonce = secrets.token_urlsafe(18)
            held = {"client": client, "authority": authority, "route": route, "bot": sdk.bot.id,
                    "proposal": proposal, "native": native, "expires": time.monotonic() + 120, "message": None}
            pending.clear()
            pending[nonce] = held
            markup = InlineKeyboardMarkup([[InlineKeyboardButton("Confirm", callback_data=prefix + nonce + ":yes"),
                                            InlineKeyboardButton("Cancel", callback_data=prefix + nonce + ":no")]])
            reply = await update.effective_message.reply_text(proposal["question"], reply_markup=markup)
            held["message"] = reply.message_id
        finally:
            client.owner.commands.release()

    async def callback(update, sdk):
        client, authority, route = actor(update)
        query = update.callback_query
        data = query.data if query else None
        match = re.fullmatch(re.escape(prefix) + r"([A-Za-z0-9_-]+):(yes|no)", data or "")
        held = pending.get(match[1]) if match else None
        if (not held or held["client"] is not client or held["authority"] != authority or held["route"] != route
                or held["bot"] != sdk.bot.id or held["message"] != update.effective_message.message_id
                or held["expires"] <= time.monotonic()):
            raise Refusal("owner_confirmation_unavailable")
        if not client.owner.commands.acquire(blocking=False):
            raise Refusal("owner_action_in_progress")
        try:
            pending.pop(match[1])
            await query.answer()
            if match[2] == "no":
                result = {"status": "cancelled"}
            else:
                def authorize():
                    if actor(update) != (client, authority, route):
                        raise Refusal("owner_context_changed")
                authorize()
                native = native_session(client, route)
                old = held["native"]
                reclaim = native if old and native and (old[0], old[1], old[2], old[4]) == (native[0], native[1], native[2], native[4]) else None
                result = await client.owner.confirm(held["proposal"], reclaim, authorize=authorize)
            await query.edit_message_text(encoded(result))
        finally:
            client.owner.commands.release()

    async def run(fn, update, sdk):
        try:
            if ended.is_set():
                raise Refusal("owner_native_handler_ended")
            task = context.copy().run(lambda: ctx.spawn_task(fn(update, sdk), name=build.PLATFORM + ":owner"))
            await task
        except Refusal as error:
            if update.callback_query:
                await update.callback_query.answer(error.code, show_alert=True)
            else:
                await update.effective_message.reply_text(encoded({"error": error.code}))
        except Exception:
            log.exception("MASONS native owner action failed")
            if update.effective_message:
                await update.effective_message.reply_text(encoded({"error": "operation_unconfirmed"}))
        raise ApplicationHandlerStop

    async def on_command(update, sdk):
        await run(command, update, sdk)

    async def on_callback(update, sdk):
        await run(callback, update, sdk)

    handlers = [CommandHandler(build.PLATFORM.replace("-", "_"), on_command),
                CallbackQueryHandler(on_callback, pattern="^" + re.escape(prefix))]
    for handler in handlers:
        application.add_handler(handler)

    def stop():
        with stop_lock:
            if ended.is_set():
                return
            ended.set()
        def remove():
            for handler in handlers:
                application.remove_handler(handler)
        if loop.is_closed():
            return
        try:
            same_loop = asyncio.get_running_loop() is loop
        except RuntimeError:
            same_loop = False
        if same_loop:
            remove()
        else:
            loop.call_soon_threadsafe(remove)
    ctx.on_unload(stop)
    return stop
