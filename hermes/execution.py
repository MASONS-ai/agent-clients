"""An in-Host view of the resident journal; never a second Services receiver."""
from __future__ import annotations

import asyncio
from contextvars import copy_context
from concurrent.futures import Future
import logging
import threading

from .communication import Communication
from .host import Host
from .state import Refusal, State
from .vault import Vault

log = logging.getLogger("masons.hermes")


class Execution:
    def __init__(self, ctx, home, build):
        self.ready = Future()
        self.loop = self.task = self.client = None
        self.stop_requested = threading.Event()
        self.thread = threading.Thread(target=copy_context().run, args=(self.run, ctx, home, build),
                                       name=build.PLATFORM + ":execution", daemon=True)
        ctx.on_unload(self.stop)
        self.thread.start()

    def run(self, ctx, home, build):
        from plugins.plugin_storage import plugin_data_dir, plugin_db
        async def serve():
            store = None
            try:
                self.loop, self.task = asyncio.get_running_loop(), asyncio.current_task()
                store = State(plugin_data_dir(build.PLATFORM), profile=home, channel=build.CHANNEL,
                    connection=plugin_db(build.PLATFORM, "communication.sqlite3"), vault=Vault(home, build.SECRET_PREFIX))
                self.client = Communication(ctx, Host(ctx, home), store, build, self.loop, resident=False)
                self.ready.set_result(self.client)
                if not self.stop_requested.is_set():
                    await self.client.run_execution()
            except asyncio.CancelledError:
                pass
            except Exception as error:
                if not self.ready.done():
                    self.ready.set_exception(error)
                log.exception("MASONS execution view failed")
            finally:
                if self.client:
                    self.client.host.disposed = True
                    await self.client.close()
                if store:
                    store.close()
        asyncio.run(serve())

    def get(self):
        try:
            client = self.ready.result(timeout=5)
        except TimeoutError:
            raise Refusal("native_execution_context_unavailable") from None
        if client.closed or client.host.disposed or self.stop_requested.is_set():
            raise Refusal("native_execution_context_unavailable")
        return client

    def stop(self):
        self.stop_requested.set()
        if self.client:
            self.client.host.disposed = True
        if self.loop and self.task and not self.loop.is_closed():
            self.loop.call_soon_threadsafe(self.task.cancel)
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=7)
