"""Ephemeral native-request composition; neither custody nor a model action."""
from __future__ import annotations

import asyncio
import threading
import time

from .state import Refusal


class Typing:
    def __init__(self, client, *, now=time.monotonic, interval=4, lease=900):
        self.client, self.now, self.interval, self.lease = client, now, interval, lease
        self.lock = threading.RLock()
        self.requests, self.peers = {}, {}
        self.generation = 0

    def current(self, token):
        with self.lock:
            return (self.requests.get(token["key"]) is token and token["active"]
                    and self.now() < token["deadline"])

    def end(self, token):
        with self.lock:
            token["active"] = False
            if self.requests.get(token["key"]) is token:
                self.requests.pop(token["key"])
            task = token.get("task")
        if task and not self.client.loop.is_closed():
            self.client.loop.call_soon_threadsafe(task.cancel)

    def begin(self, held, event, conversations):
        key = (held["root"], event["task_id"], event["turn_id"], event["api_request_id"])
        with self.lock:
            for previous in list(self.requests.values()):
                if previous["key"][:3] == key[:3]: self.end(previous)
            if len(conversations) != 1:
                return
            self.generation += 1
            token = {"key": key, "active": True, "generation": self.generation,
                     "held": dict(held), "physical": event["session_id"],
                     "started_at": event.get("started_at"), "deadline": self.now() + self.lease,
                     "conversation": next(iter(conversations))}
            self.requests[key] = token

        def start():
            if self.current(token) and not self.client.closed:
                token["task"] = asyncio.create_task(self.pulse(token))
            else:
                self.end(token)
        if not self.client.loop.is_closed():
            self.client.loop.call_soon_threadsafe(start)

    def finish(self, event, *, turn=False):
        with self.lock:
            tokens = [token for token in self.requests.values()
                      if token["key"][1:3] == (event.get("task_id"), event.get("turn_id"))
                      and (turn or token["key"][3] == event.get("api_request_id"))
                      and event.get("session_id") in {token["physical"], token["held"]["root"]}
                      and (turn or event.get("started_at") is None or token["started_at"] is None
                           or event["started_at"] == token["started_at"])]
            for token in tokens:
                self.end(token)

    def check(self, token):
        if not self.current(token) or self.client.closed or self.client.credential_ended:
            raise Refusal("typing_request_ended")
        self.client.host.profile()
        self.client.bound(token["held"])
        if self.client.state.get("ended/" + token["held"]["root"]):
            raise Refusal("native_session_ended")

    async def pulse(self, token):
        try:
            while self.current(token):
                lease = asyncio.timeout(max(0, token["deadline"] - self.now()))
                try:
                    async with lease:
                        self.check(token)
                        await self.client.qualify_saved(token["held"])
                        self.check(token)
                        async with self.client.connection() as api:
                            self.check(token)
                            await api.typing(token["held"], token["conversation"])
                except TimeoutError as error:
                    if lease.expired():
                        return
                    self.client.problem(error, operation="typing")
                except asyncio.CancelledError:
                    raise
                except Refusal as error:
                    if error.code in {"typing_request_ended", "native_session_ended", "registration_changed",
                                      "credential_changed", "native_profile_unavailable", "native_identity_changed",
                                      "native_identity_unresolved", "native_route_changed"}:
                        return
                    self.client.problem(error, operation="typing")
                    if error.status is not None and 400 <= error.status < 500 and error.status not in {408, 429}:
                        return
                except Exception as error:
                    self.client.problem(error, operation="typing")
                await asyncio.sleep(min(self.interval, max(0, token["deadline"] - self.now())))
        finally:
            self.end(token)

    def receive(self, held, frame):
        self.client.bound(held)
        conversation = frame.get("conversation_ref")
        if (frame.get("recipient") != {"runtime_session_id": held["root"]}
                or not isinstance(conversation, str) or not 0 < len(conversation) <= 4096):
            raise Refusal("typing_frame_unreadable")
        now = self.now()
        with self.lock:
            self.peers = {key: expiry for key, expiry in self.peers.items() if expiry > now}
            key = (held["root"], held["nonce"], conversation)
            if key in self.peers or len(self.peers) < 256:
                self.peers[key] = now + 6

    def reconcile(self):
        with self.lock:
            for token in list(self.requests.values()):
                try: self.check(token)
                except Refusal: self.end(token)
                except Exception as error:
                    self.client.problem(error, operation="typing")
                    self.end(token)

    def message(self, held, conversation):
        with self.lock:
            self.peers.pop((held["root"], held["nonce"], conversation), None)

    def close(self):
        with self.lock:
            for token in list(self.requests.values()):
                self.end(token)
            self.peers.clear()
