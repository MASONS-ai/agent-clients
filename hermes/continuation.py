"""Finite clients of Hermes' documented external stdio process protocol."""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys

from .identity import native_continuation, native_root
from .state import Refusal, encoded


def environment(home):
    from agent.secret_scope import build_profile_secret_scope, get_secret, reset_secret_scope, set_secret_scope
    scope = build_profile_secret_scope(home)
    token = set_secret_scope(scope, profile_home=str(home))
    try:
        return {key: value for key in set(os.environ) | set(scope)
                if not key.startswith(("HERMES_SESSION_", "HERMES_TUI_"))
                and (value := get_secret(key)) is not None}
    finally:
        reset_secret_scope(token)


class Continuations:
    def __init__(self, home):
        self.home = Path(home).resolve()
        self.tasks = {}

    def start(self, root, birth, notice, authorize, problem):
        if root in self.tasks and not self.tasks[root].done():
            return
        async def run():
            try:
                await self.turn(root, birth, notice, authorize)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                problem(error)
            finally:
                self.tasks.pop(root, None)
        self.tasks[root] = asyncio.create_task(run())

    async def close(self):
        tasks = tuple(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def turn(self, root, birth, notice, authorize):
        before = await asyncio.to_thread(native_continuation, self.home, root, birth)
        authorize()
        spec = importlib.util.find_spec("hermes_constants")
        directory = Path(spec.origin).resolve().parent if spec and spec.origin else None
        if directory is None or not (directory / "tui_gateway" / "entry.py").is_file():
            raise Refusal("native_process_entry_unavailable")
        env = environment(self.home)
        env["HERMES_HOME"] = str(self.home)
        env["PYTHONPATH"] = str(directory) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
        process = await asyncio.create_subprocess_exec(sys.executable, "-P", "-m", "tui_gateway.entry",
            cwd=before["cwd"], env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=64 * 1024 * 1024)
        sequence = 0
        async def send(frame):
            process.stdin.write((encoded(frame) + "\n").encode())
            await process.stdin.drain()

        async def read():
            while True:
                line = await process.stdout.readline()
                if not line:
                    raise Refusal("native_process_ended")
                try:
                    frame = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(frame, dict):
                    continue
                if frame.get("method") and frame.get("id") is not None:
                    await send({"jsonrpc": "2.0", "id": frame["id"],
                                "error": {"code": -32601, "message": "No owner input is attached to this finite client."}})
                    continue
                return frame

        async def rpc(method, params):
            nonlocal sequence
            sequence += 1
            rid = sequence
            await send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            while True:
                frame = await read()
                if frame.get("id") != rid or frame.get("method"):
                    continue
                if "error" in frame:
                    code = frame["error"].get("code")
                    raise Refusal("native_session_busy" if code == 4090 else "native_restore_refused")
                if not isinstance(frame.get("result"), dict):
                    raise Refusal("native_restore_unconfirmed")
                return frame["result"]

        try:
            async with asyncio.timeout(120):
                while True:
                    ready = await read()
                    if ready.get("method") == "event" and ready.get("params", {}).get("type") == "gateway.ready":
                        break
                await rpc("client.capabilities", {"server_requests": True})
                authorize()
                await asyncio.to_thread(native_continuation, self.home, root, birth)
                # External-runtime EOF must preserve another writer of this stored TUI.
                resumed = await rpc("session.resume", {"session_id": root, "source": "desktop", "eager_build": True, "inline_images": False})
                after = await asyncio.to_thread(native_continuation, self.home, root, birth)
                if (not isinstance(resumed.get("session_id"), str) or not resumed["session_id"]
                        or resumed.get("resumed") != after["physical"] or resumed.get("session_key") != after["physical"]
                        or await asyncio.to_thread(native_root, self.home, resumed["resumed"]) != root
                        or Path(resumed.get("info", {}).get("cwd", "")).resolve() != Path(after["cwd"]).resolve()):
                    raise Refusal("native_restore_mismatch")
                authorize()
                submitted = await rpc("prompt.submit", {"session_id": resumed["session_id"], "text": notice})
                if submitted.get("status") not in {"streaming", "queued", "steered"}:
                    raise Refusal("native_submission_unconfirmed")
                while True:
                    event = await read()
                    params = event.get("params", {})
                    if (event.get("method") == "event" and params.get("type") == "message.complete"
                            and params.get("session_id") == resumed["session_id"]):
                        break
        finally:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except TimeoutError:
                    process.kill()
                    await process.wait()
