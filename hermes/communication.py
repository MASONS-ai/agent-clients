"""Resident Services custody and independently scoped native tool operations."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import logging
import threading
import time
from urllib.parse import quote

from .gateway import Gateway
from .naming import Names
from .typing import Typing
from .identity import native_continuation, native_current, native_end, native_root
from .portrayal import fingerprint, pieces_for, public_outcome
from .presentation import carriers
from .services import DECLARATION, Services, parse_message, record, text
from .state import Refusal, encoded, subject_key

log = logging.getLogger("masons.hermes")
NOTICE = 'MASONS has pending communication. Call {tool} with at="message" to check this conversation\'s inbox.'


class Communication:
    def __init__(self, ctx, host, state, build, loop, *, services=Services, gateway=None, resident=True):
        self.ctx, self.host, self.state, self.build, self.loop = ctx, host, state, build, loop
        self.services = services
        self.resident = resident
        self.gateway = gateway or Gateway(host.home)
        self.registration_gate = threading.Lock()
        self.closed = False
        self.stream = None
        self.stream_credential = None
        self.reconnect = threading.Event()
        self.tasks = set()
        self.credential_ended = False
        self.next_activation = {}
        self.owner = None
        self.names, self.typing = Names(self), Typing(self)
        if resident:
            for held in state.rows("SELECT root FROM sessions"):
                state.restart_parts(held["root"])

    def problem(self, error, *, operation="communication"):
        code = error.code if isinstance(error, Refusal) else type(error).__name__
        report = log.debug if code == "registration_pending" else log.warning
        report("MASONS %s: %s", operation, code)

    def credential(self):
        if self.closed:
            raise Refusal("client_stopped")
        value = self.state.get("credential")
        if not value:
            raise Refusal("link_required")
        return value

    def client_facts(self):
        sha = getattr(self.gateway, "code_sha", None)
        return {"plugin_version": self.build.VERSION,
                **({"host_version": "git:" + sha} if isinstance(sha, str) and len(sha) == 40 and all(c in "0123456789abcdef" for c in sha) else {})}

    def check_credential(self, digest):
        if fingerprint(self.credential()) != digest:
            raise Refusal("credential_changed")

    @asynccontextmanager
    async def connection(self, credential=None):
        credential = credential or self.credential()
        digest = fingerprint(credential)
        api = self.services(self.build.API, credential, assert_current=lambda: self.check_credential(digest))
        try:
            yield api
        finally:
            await api.close()

    def bound(self, held):
        self.check_credential(held["credential"])
        current = self.state.session(held["root"])
        if not current or current["state"] != "active" or current["nonce"] != held["nonce"] or current["credential"] != held["credential"]:
            raise Refusal("registration_changed")

    def invocation(self, caller, held):
        self.host.validate(caller)
        self.bound(held)
        ordinary = self.state.get("ordinary/" + held["root"]) or {}
        if self.state.get("ended/" + held["root"]):
            raise Refusal("native_session_ended")
        if ordinary.get("native"):
            self.check_native(held, caller.physical)
        if ordinary.get("continuation"):
            if native_root(self.host.home, caller.physical) != caller.root:
                raise Refusal("native_identity_changed")
            native_continuation(self.host.home, held["root"], ordinary["continuation"])

    def check_native(self, held, physical=None):
        saved = (self.state.get("ordinary/" + held["root"]) or {}).get("native")
        if not saved:
            return
        physical = physical or self.state.get("active_physical/" + held["root"])
        current = native_current(self.host.home, physical, held["route"])
        facts = self.host.route(current, platform=held["platform"])
        if (facts.get("birth") != saved["birth"] or list(facts["peer"]) != saved["peer"]
                or facts["route"] != saved["route"] or facts["platform"] != saved["platform"]):
            raise Refusal("native_identity_changed")
        if native_end(self.host.home, current, expected_root=held["root"], expected_birth=saved["birth"]):
            raise Refusal("native_session_ended")

    def remember(self, root, physical, route):
        with self.state.transaction():
            self.state.put("physical/" + physical, root)
            self.state.put("active_physical/" + root, physical)
            # A fresh actual invocation proves a native boundary on a reused route.
            for old in self.state.rows("SELECT root FROM sessions WHERE route=? AND root!=? AND state='active'", (route, root)):
                self.state.put("ended/" + old["root"], "native_boundary")

    def party_line(self, event):
        from .tools import COMMUNICATION_POLICY
        policy = "On " + self.build.LABEL + ": " + COMMUNICATION_POLICY + "\n"
        fallback = {"context": policy + "MASONS has no disclosed single current conversation. Name the party or destination when sending."}
        try:
            root = native_root(self.host.home, event["session_id"])
            witness = self.host.witness(event["task_id"], event["turn_id"])
            with self.state.lock:
                held = self.state.session(root)
                if not held or (held["route"], held["logical"]) != (witness["route"], witness["logical"]):
                    return fallback
                self.bound(held)
                source = self.state.get("source/" + held["nonce"])
                if not source or source["credential"] != held["credential"]:
                    return fallback
                credential = self.credential()
                try:
                    selected = self.state.context_subject(root, credential["node"], source["source"]["session_ref"])
                except Refusal:
                    selected = self.state.context_subject(root, credential["node"], source["source"]["session_ref"], pending=True)
                self.host.disclose(event["task_id"], event["turn_id"], {"root": root, "nonce": held["nonce"], "credential": held["credential"], "subject": subject_key(selected)})
                parties = self.state.parties(root, credential["node"], selected)
                portrayal = encoded(parties).replace("<", "\\u003c").replace(">", "\\u003e")
                return {"context": policy + "MASONS current conversation party (program-held data): " + portrayal + ". An omitted party is allowed only while this remains the sole witnessed conversation."}
        except (Refusal, KeyError):
            return fallback

    def implicit(self, caller, held, source):
        disclosed = self.host.witness(caller.task, caller.turn).get("party")
        selected = self.state.context_subject(caller.root, self.credential()["node"], source["session_ref"])
        if not disclosed or {k: disclosed[k] for k in ("root", "nonce", "credential")} != {"root": caller.root, "nonce": held["nonce"], "credential": held["credential"]} or self.state.canonical_key(caller.root, disclosed["subject"]) != subject_key(selected):
            raise Refusal("conversation_selection_required")
        return selected

    async def qualify(self, root, route, logical, platform, *, physical=None):
        self.host.require_receiving()
        if platform != "local":
            facts = self.host.route(physical, platform=platform)
            snapshot = {"birth": facts.get("birth"), "peer": list(facts["peer"]), "route": route, "platform": platform}
            if not snapshot["birth"]:
                raise Refusal("native_identity_unresolved")
            saved = self.state.get("ordinary/" + root) or {}
            if saved.get("native") and saved["native"] != snapshot:
                raise Refusal("native_identity_changed")
            self.state.put("ordinary/" + root, {**saved, "native": snapshot})
            return
        saved = self.state.get("ordinary/" + root)
        facts = self.host.route(physical, platform=platform) if physical else {}
        if facts.get("continuation"):
            birth = facts["continuation"]
            if saved and saved.get("continuation") != birth:
                raise Refusal("native_identity_changed")
            await asyncio.to_thread(native_continuation, self.host.home, root, birth)
            self.state.put("ordinary/" + root, {"source": "tui", "route": route, "logical": logical, "continuation": birth})
            return
        if saved and (saved["route"], saved["logical"]) == (route, logical):
            return
        info = await self.gateway.info(logical)
        source = info.get("source")
        if source not in {"cli", "tui", "gui", "desktop", "acp"}:
            raise Refusal("native_ordinary_conversation_required")
        self.state.put("ordinary/" + root, {"source": source, "route": route, "logical": logical})

    async def source(self, api, held):
        key = "source/" + held["nonce"]
        cached = self.state.get(key)
        if cached and cached["credential"] == held["credential"]:
            return cached["source"]
        identity = await api.identity()
        page = await api.resolve(held, {"kind": "node_match", "match": {"kind": "canonical_handle_exact", "handle": identity["handle"]}})
        source = record(page.get("acting_source"))
        if source.get("kind") != "exact_session":
            raise Refusal("session_source_unconfirmed")
        source = {"kind": "exact_session", "session_ref": text(source.get("session_ref"))}
        self.state.put(key, {"credential": held["credential"], "source": source})
        self.state.reconcile_receipts(held, node=api.credential["node"], self_ref=source["session_ref"])
        self.reconnect.set()
        return source

    @staticmethod
    def realizes(response, declaration=DECLARATION):
        if "runtime_capabilities" not in response:
            return True  # The registration response's documented absence semantics.
        capabilities = response["runtime_capabilities"]
        return (isinstance(capabilities, list) and all(isinstance(c, str) for c in capabilities)
                and set(declaration["runtime_capabilities"]).issubset(capabilities))

    def declaration(self, held):
        naming, base = self.names.registration(held)
        if naming is None and held.get("request"):
            naming = "session_name_apply_v1" in json.loads(held["request"])["body"].get("runtime_capabilities", [])
        return {**DECLARATION, "runtime_capabilities": [*DECLARATION["runtime_capabilities"],
                *(["session_name_apply_v1"] if naming else [])]}, base

    def refresh_needed(self, held):
        if not held["request"]: return False
        intent = json.loads(held["request"])["body"]
        declaration, _ = self.declaration(held)
        return any(intent.get(key) != value for key, value in declaration.items())

    def archive_names(self, held):
        with self.state.transaction() as db:
            for row in self.state.rows("SELECT * FROM controls WHERE root=? AND nonce=? AND credential=? AND acked=0",
                                       (held["root"], held["nonce"], held["credential"])):
                if json.loads(row["body"])["type"] == "session_name_changed":
                    self.state.put("unresolved_name_control/" + row["id"], row)
                    db.execute("DELETE FROM controls WHERE id=?", (row["id"],))

    async def refresh_registration(self, api, held):
        key = "declaration_refresh/" + held["nonce"]
        saved = self.state.get(key)
        await self.qualify_saved(held)
        if not saved:
            try:
                await self.owned(api, held, declaration=False)
            except Refusal as error:
                if error.code in {"registration_retired", "registration_expired"}:
                    self.state.put(key, {"request": json.loads(held["request"]), "response": json.loads(held["response"]),
                        "stage": "retired", "verdict": {"error": error.code, "http_status": error.status}})
                raise
            self.bound(held)
            saved = {"request": json.loads(held["request"]), "response": json.loads(held["response"]), "stage": "retiring"}
            self.state.put(key, saved)
        self.state.fence(held["root"], "retiring", expected=held)
        self.typing.reconcile()
        try:
            await api.retire({**held, "state": "active"})
        except Refusal as error:
            if error.code == "registration_superseded":
                self.state.fence(held["root"], expected=held)
                raise
            if error.code not in {"registration_retired", "registration_expired"}:
                raise
        self.check_credential(held["credential"])
        await self.qualify_saved(held)
        self.archive_names(held)
        with self.state.transaction():
            live = self.state.session(held["root"])
            if (live["nonce"], live["credential"], live["state"]) != (held["nonce"], held["credential"], "retiring"):
                raise Refusal("registration_changed")
            self.state.put(key, {**saved, "stage": "retired"})
            self.state.fence(held["root"], "recovering", expected=held)
        return self.state.enroll(held["root"], held["route"], held["logical"], held["credential"], platform=held["platform"], resume=True)

    async def qualify_saved(self, held):
        self.host.require_receiving()
        physical = self.state.get("active_physical/" + held["root"])
        if not physical or self.state.get("ended/" + held["root"]):
            raise Refusal("native_identity_unresolved")
        if held["platform"] != "local":
            physical = await asyncio.to_thread(native_current, self.host.home, physical, held["route"])
        root = await asyncio.to_thread(native_root, self.host.home, physical)
        if root != held["root"]:
            raise Refusal("native_identity_changed")
        if await self.ended(held, physical):
            raise Refusal("native_session_ended")
        route = await asyncio.to_thread(self.host.route, physical, platform=held["platform"])
        if (route["route"], route["logical"], route["platform"]) != (held["route"], held["logical"], held["platform"]):
            raise Refusal("native_route_changed")
        await self.qualify(root, held["route"], held["logical"], held["platform"], physical=physical)

    async def ended(self, held, physical):
        ordinary = self.state.get("ordinary/" + held["root"]) or {}
        options = {"expected_root": held["root"]}
        if ordinary.get("continuation"):
            options["expected_birth"] = ordinary["continuation"]
        elif ordinary.get("native"):
            options["expected_birth"] = ordinary["native"]["birth"]
        return await asyncio.to_thread(native_end, self.host.home, physical, **options)

    async def execution_binding(self, api, caller):
        if caller is None:
            raise Refusal("canonical_gateway_receiver_required")
        self.host.validate(caller)
        await self.qualify(caller.root, caller.route, caller.logical, caller.platform, physical=caller.physical)
        if not (self.state.get("ordinary/" + caller.root) or {}).get("continuation"):
            raise Refusal("native_execution_context_unavailable")
        digest = fingerprint(api.credential)
        def authorize():
            self.host.validate(caller)
            self.check_credential(digest)
        self.state.propose(caller.root, caller.route, caller.logical, digest, caller.physical, authorize=authorize)
        deadline = time.monotonic() + 3
        while True:
            self.host.validate(caller)
            self.check_credential(digest)
            held = self.state.session(caller.root)
            if held and held["state"] == "active":
                self.invocation(caller, held)
                await self.owned(api, held)
                await self.source(api, held)
                return held
            if held and (held["state"] not in {"pending", "recovering", "retired", "credential_ended"}
                         or held["state"] == "credential_ended" and held["credential"] == digest
                         or self.state.get("ended/" + caller.root)):
                raise Refusal("registration_unavailable")
            if time.monotonic() >= deadline:
                raise Refusal("canonical_gateway_receiver_required")
            await asyncio.sleep(0.05)

    async def ensure(self, api, *, caller=None, held=None):
        if not self.resident:
            return await self.execution_binding(api, caller)
        if not self.registration_gate.acquire(blocking=False):
            raise Refusal("registration_pending")
        try:
            digest = fingerprint(api.credential)
            if caller:
                self.host.require_receiving()
                self.host.validate(caller)
                if self.state.get("ended/" + caller.root):
                    raise Refusal("native_session_ended")
                ordinary = self.state.get("ordinary/" + caller.root)
                if caller.platform == "local" and (not ordinary or (ordinary["route"], ordinary["logical"]) != (caller.route, caller.logical)):
                    raise Refusal("native_conversation_qualification_pending")
                held = self.state.enroll(caller.root, caller.route, caller.logical, digest, platform=caller.platform, resume=True)
                self.remember(caller.root, caller.physical, caller.route)
            self.check_credential(digest)
            if held and held["credential"] == digest and held["state"] == "retiring" and self.state.get("declaration_refresh/" + held["nonce"]):
                held = await self.refresh_registration(api, held)
            if held is None or held["credential"] != digest or held["state"] in {"fenced", "retired", "retiring", "credential_ended"}:
                raise Refusal("registration_unavailable")
            if held["state"] == "recovering" or not held["request"] and not held["response"]:
                await self.qualify_saved(held)
            if held["state"] == "recovering":
                held = self.state.enroll(held["root"], held["route"], held["logical"], digest, platform=held["platform"], resume=True)
            if held["response"] and held["state"] == "active":
                declaration, _ = self.declaration(held)
                intent = json.loads(held["request"])["body"] if held["request"] else declaration
                if any(intent.get(key) != value for key, value in declaration.items()):
                    held = await self.refresh_registration(api, held)
                else:
                    if (self.state.get("ordinary/" + held["root"]) or {}).get("native"):
                        await self.qualify_saved(held)
                    await self.owned(api, held)
                    await self.source(api, held)
                    return held
            if held["request"]:
                intent = json.loads(held["request"])
            else:
                roster = record(await api.request("runtime-endpoints?as=" + quote(api.credential["node"], safe=""), method="GET"))
                if not isinstance(roster.get("endpoints"), list) or any(not isinstance(r, dict) for r in roster["endpoints"]):
                    raise Refusal("registration_roster_unreadable")
                if any(r.get("runtime_kind") == "hermes" and r.get("runtime_session_id") == held["root"] and not r.get("retired_at") and not r.get("superseded_by_endpoint_id") for r in roster["endpoints"]):
                    self.state.fence(held["root"], expected=held)
                    raise Refusal("registration_existing_owner")
                if not api.server_time:
                    raise Refusal("registration_server_time_unconfirmed")
                declaration, base = self.declaration(held)
                intent = {"started_at": api.server_time, "body": {
                    "as": api.credential["node"], "runtime_kind": "hermes", "runtime_session_id": held["root"],
                    "endpoint_nonce": held["nonce"], "display_label": "Hermes", "share_with_peer": [],
                    "client": self.client_facts(), **declaration,
                    **({"host_session_name": base} if base else {})}}
                self.state.registration(held["root"], request=intent)
            try:
                response = await api.ensure(intent["body"], started_at=intent["started_at"])
            except Refusal as error:
                if getattr(error, "registration", None):
                    self.state.registration(held["root"], response=error.registration, activate=False)
                    held = self.state.session(held["root"])
                    self.bind_controls(held)
                with self.state.transaction():
                    if getattr(error, "registration_verdict", None):
                        self.state.put("expired_registration/" + held["nonce"], {"request": intent, "verdict": error.registration_verdict})
                    self.registration_lost(held, error)
                raise
            self.check_credential(digest)
            if (self.state.get("ordinary/" + held["root"]) or {}).get("native"):
                await self.qualify_saved(held)
            current = self.state.session(held["root"])
            if current["nonce"] != held["nonce"] or current["state"] != "pending":
                raise Refusal("registration_changed")
            declaration = {key: intent["body"][key] for key in DECLARATION}
            self.state.registration(held["root"], response=response, activate=self.realizes(response, declaration))
            if not self.realizes(response, declaration):
                raise Refusal("required_session_capability_missing")
            held = self.state.session(held["root"])
            self.bind_controls(held)
            self.bound(held)
            await self.source(api, held)
            return held
        finally:
            self.registration_gate.release()

    def schedule(self, coroutine):
        if self.closed or self.loop.is_closed():
            coroutine.close()
            return
        def start():
            if self.closed:
                coroutine.close()
                return
            async def work():
                try:
                    await coroutine
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.problem(error)
            task = asyncio.create_task(work())
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        self.loop.call_soon_threadsafe(start)

    async def discover(self, stamp):
        root = await asyncio.to_thread(native_root, self.host.home, stamp["physical"])
        await self.qualify(root, stamp["route"], stamp["logical"], stamp["platform"], physical=stamp["physical"])
        with self.state.lock:
            if not self.state.get("active_physical/" + root):
                self.remember(root, stamp["physical"], stamp["route"])
        if self.state.get("ended/" + root):
            return
        if not self.resident:
            digest = fingerprint(self.credential())
            self.state.propose(root, stamp["route"], stamp["logical"], digest, stamp["physical"], authorize=lambda: self.check_credential(digest))
            return
        async with self.connection() as api:
            held = self.state.enroll(root, stamp["route"], stamp["logical"], fingerprint(api.credential), platform=stamp["platform"], resume=True)
            await self.ensure(api, held=held)

    def pre_request(self, event):
        stamp = self.host.observation(event)
        # Freeze only public carrier identity/order/length/digest, never the whole prompt.
        working = carriers(event.get("conversation_history"))
        effective = carriers(event.get("request_messages"))
        root = native_root(self.host.home, stamp["physical"])
        witness = self.host.witness(stamp["task"], stamp["turn"])
        route = self.host.route(stamp["physical"], platform=witness["platform"])
        if route != {key: witness.get(key) for key in route}:
            raise Refusal("native_route_changed")
        with self.state.lock:
            self.remember(root, stamp["physical"], route["route"])
        def authorize():
            held = self.state.session(root)
            if held: self.bound(held)
            if held and (self.state.get("ordinary/" + root) or {}).get("native"):
                self.bound(held)
                self.check_native(held, stamp["physical"])
            if held and route.get("continuation"):
                self.bound(held)
                saved = self.state.get("ordinary/" + root) or {}
                if saved.get("continuation") != route["continuation"]:
                    raise Refusal("native_identity_changed")
                native_continuation(self.host.home, root, saved["continuation"])
        self.state.observe_context(root, working, effective, tool_name=self.build.PREFIX + "look", authorize=authorize)
        held = self.state.session(root)
        if held and held["state"] == "active":
            authorize()
            source = self.state.get("source/" + held["nonce"])
            conversations = (self.state.composing(root, stamp["task"], stamp["turn"], working, effective,
                tool_name=self.build.PREFIX + "look", node=self.credential()["node"], self_ref=source["source"]["session_ref"])
                if source and source["credential"] == held["credential"] else set())
            self.typing.begin(held, event, conversations)

    async def dispatch(self, name, args, event):
        caller = await self.host.caller(event)
        if not isinstance(args, dict):
            raise Refusal("tool_arguments_unreadable")
        from .tools import arguments, Tools, upgrade
        if name not in {"receive", "read"}:
            arguments(name, args)
        if name == "link" or name == "status" or name == "look" and args["at"] in {"link", "me"}:
            from .owner import link_record, request_link, status
            if name == "look" and args["at"] == "link":
                return link_record(self.state)
            if self.owner is None:
                return await request_link(self, caller) if name == "link" else await status(self, caller.root, caller=caller)
            return await self.owner.invoke("link" if name == "link" else "status", caller)
        if name == "upgrade":
            return await upgrade(self.build)
        if name == "profile" and args["operation"] == "view":
            async with self.connection() as api:
                held = self.state.session(caller.root) if args["target"]["kind"] == "session" else None
                if args["target"]["kind"] == "session" and held is None:
                    raise Refusal("registration_unavailable")
                operation = Tools(self, api, held, caller)
                result = await operation.profile(args, caller=caller)
            operation.guard()
            return result
        async with self.connection() as api:
            held = await self.ensure(api, caller=caller)
            self.host.validate(caller)
            self.bound(held)
            if name == "receive" or name == "look" and args["at"] == "message":
                if args and args != {"at": "message"}:
                    raise Refusal("receive_has_no_target_arguments")
                message = self.state.next_message(caller.root, node=api.credential["node"])
                if message is None:
                    self.tell_set_aside(held, api.credential["node"])
                    return {"messages": [], "set_aside": len(self.state.rows("SELECT id FROM inbox WHERE root=? AND node=? AND set_aside=1 AND presented=0", (caller.root, api.credential["node"])))}
                frame = json.loads(message["frame"])
                if frame["subject"]["self_participant_ref"] != (await self.source(api, held))["session_ref"]:
                    raise Refusal("message_source_changed")
                repeat = bool(self.state.rows("SELECT id FROM handoffs WHERE message=? LIMIT 1", (message["id"],)))
                pieces = pieces_for(frame, repeat=repeat)
                def authorize():
                    self.invocation(caller, held)
                return self.state.handoff(message["id"], caller, pieces, authorize=authorize)
            from .operations import Operation
            operation = Operation(self, api, held, caller) if name == "read" else Tools(self, api, held, caller)
            return await getattr(operation, name)(args, caller=caller)

    def tell_set_aside(self, held, node):
        rows = self.state.rows("SELECT id FROM inbox WHERE root=? AND node=? AND set_aside=1 AND presented=0 AND notice_told=0", (held["root"], node))
        if not rows:
            return
        async def tell():
            self.bound(held)
            handle = await self.ctx.apost_message("Some MASONS messages remain unconfirmed after interrupted context handover and have been set aside. Other communication can continue.")
            if getattr(handle, "ok", False) is True:
                with self.state.lock:
                    for row in rows:
                        self.state.db.execute("UPDATE inbox SET notice_told=1 WHERE id=? AND root=? AND node=?", (row["id"], held["root"], node))
        self.schedule(tell())

    async def retire(self, held, api):
        if held["state"] in {"retired", "credential_ended"}:
            return
        # Local fencing precedes network retirement; unknown deletion is retried.
        self.state.fence(held["root"], "retiring", expected=held)
        self.typing.reconcile()
        try:
            if not held["response"] and held["request"]:
                intent = json.loads(held["request"])
                response = await api.ensure(intent["body"], started_at=intent["started_at"])
                held = {**held, "response": encoded(response)}
            if held["response"]:
                await api.retire({**held, "state": "active"})
        except Refusal as error:
            if error.status in {401, 403}:
                self.state.unconfirmed_retirement(held, api.credential["node"])
                self.state.fence(held["root"], "credential_ended", expected=held)
                return
            if error.code not in {"registration_retired", "registration_superseded", "registration_expired"}:
                raise
        self.state.fence(held["root"], "retired", expected=held)
        self.archive_names(held)

    async def frame(self, raw):
        if not isinstance(raw, dict) or raw.get("type") not in {"message", "force_unregister", "registration_retired", "session_name_changed", "typing"}:
            return
        credential = self.credential()
        digest = fingerprint(credential)
        matches = [r for r in self.state.rows("SELECT * FROM sessions WHERE credential=?", (digest,))
                   if r["response"] and json.loads(r["response"])["endpoint_id"] == raw.get("endpoint_id")]
        held = matches[0] if len(matches) == 1 else None
        if raw["type"] == "typing":
            if held and held["state"] == "active": self.typing.receive(held, raw)
            return
        if raw["type"] != "message":
            if type(raw.get("version")) is not int or raw["version"] != 1:
                raise Refusal("control_version_unknown")
            key = text(raw.get("idempotency_key"))
            raw = {"type": raw["type"], "version": 1, "endpoint_id": text(raw.get("endpoint_id")), "idempotency_key": key,
                   **({"reason": text(raw.get("reason"))} if raw["type"] == "force_unregister" else {})}
            with self.state.transaction() as db:
                previous = db.execute("SELECT body,credential FROM controls WHERE id=?", (key,)).fetchone()
                if previous and (previous["body"] != encoded(raw) or previous["credential"] != digest):
                    raise Refusal("control_replay_conflict")
                db.execute("INSERT OR IGNORE INTO controls(id,body,credential,root,nonce) VALUES(?,?,?,?,?)",
                           (key, encoded(raw), digest, held["root"] if held else None, held["nonce"] if held else None))
                if held and not previous and raw["type"] != "session_name_changed":
                    self.state.fence(held["root"], "fenced" if raw["type"] == "force_unregister" else "recovering", expected=held,
                                     from_state=None if raw["type"] == "force_unregister" else "active")
            self.typing.reconcile()
            return
        if held is None or held["state"] != "active": return
        cached = self.state.get("source/" + held["nonce"])
        if not cached or cached["credential"] != digest: return
        frame = parse_message(raw)
        if frame["recipient"] != {"runtime_session_id": held["root"]} or frame["subject"]["self_participant_ref"] != cached["source"]["session_ref"]:
            raise Refusal("message_wrong_session")
        self.state.retain(frame, held["root"], held["nonce"], node=credential["node"])
        self.typing.message(held, frame["subject"]["conversation_ref"])

    async def activate(self, held, api):
        self.bound(held)
        await self.owned(api, held)
        if (self.state.get("ordinary/" + held["root"]) or {}).get("native"):
            await self.qualify_saved(held)
        physical = self.state.get("active_physical/" + held["root"])
        if physical:
            try:
                ended = await self.ended(held, physical)
            except Refusal as error:
                if error.code != "native_lifecycle_unresolved":
                    raise
                self.problem(error)
                ended = None  # A content-free wake grants no identity or body authority.
            if ended:
                self.state.put("ended/" + held["root"], ended)
                raise Refusal("native_session_ended")
        if held["platform"] == "local":
            ordinary = self.state.get("ordinary/" + held["root"]) or {}
            if ordinary.get("continuation"):
                def authorize():
                    self.host.profile()
                    self.host.require_injection(self.build.PLATFORM)
                    self.bound(held)
                    if self.state.get("ended/" + held["root"]):
                        raise Refusal("native_session_ended")
                self.gateway.continuations.start(held["root"], ordinary["continuation"],
                    NOTICE.format(tool=self.build.PREFIX + "look"), authorize, self.problem)
                return True
            await self.gateway.info(held["logical"])
        self.bound(held)
        # Native permission/FIFO remains authoritative; True is scheduling, never presentation.
        if self.ctx.inject_message(NOTICE.format(tool=self.build.PREFIX + "look"), session_key=held["route"]) is not True:
            raise Refusal("native_activation_refused")
        return True

    async def replay(self, api, held, row):
        body = json.loads(row["body"])
        if body["acting_source"] != await self.source(api, held) or row["node"] != api.credential["node"]:
            raise Refusal("standing_send_source_changed")
        for attempt in range(2):
            self.bound(held)
            try:
                result = await api.send(held, row["id"], body)
                break
            except Refusal as error:
                if self.registration_lost(held, error):
                    raise
                if error.status == 409 and error.code == "conflicting_replay" and attempt == 0:
                    continue
                if error.status is not None and 400 <= error.status < 500 and error.status not in {408, 429}:
                    result = {"request_refusal": error.code, "http_status": error.status}
                    break
                raise
        self.state.send_result(row["id"], result)
        return result

    def registration_lost(self, held, error):
        if error.code in {"registration_retired", "registration_expired"}:
            if held["state"] in {"active", "pending"}:
                self.state.fence(held["root"], "recovering", expected=held, from_state=held["state"])
            return True
        if error.code in {"registration_superseded", "registration_inactive", "registration_intent_not_current"}:
            self.state.fence(held["root"], expected=held)
            return True
        return False

    def bind_controls(self, held):
        endpoint = json.loads(held["response"])["endpoint_id"]
        with self.state.lock:
            for row in self.state.rows("SELECT * FROM controls WHERE credential=? AND root IS NULL AND applied=0", (held["credential"],)):
                raw = json.loads(row["body"])
                if raw["endpoint_id"] == endpoint:
                    self.state.db.execute("UPDATE controls SET root=?,nonce=? WHERE id=?", (held["root"], held["nonce"], row["id"]))
                    if raw["type"] != "session_name_changed":
                        self.state.fence(held["root"], "fenced" if raw["type"] == "force_unregister" else "recovering", expected=held,
                                         from_state=None if raw["type"] == "force_unregister" else "active")

    async def owned(self, api, held, *, declaration=True):
        try:
            return await api.owned(held) if declaration else await api.owned(held, declaration=False)
        except Refusal as error:
            self.registration_lost(held, error)
            raise

    async def controls(self, api, digest):
        for row in self.state.rows("SELECT * FROM controls WHERE credential=? AND acked=0", (digest,)):
            try:
                if not row["applied"]:
                    held = self.state.session(row["root"]) if row["root"] else None
                    raw = json.loads(row["body"])
                    if held is None:
                        matches = [s for s in self.state.rows("SELECT * FROM sessions WHERE credential=?", (digest,))
                                   if s["response"] and json.loads(s["response"])["endpoint_id"] == raw["endpoint_id"]]
                        if len(matches) == 1:
                            held = matches[0]
                            row.update(root=held["root"], nonce=held["nonce"])
                            with self.state.lock:
                                self.state.db.execute("UPDATE controls SET root=?,nonce=? WHERE id=?", (row["root"], row["nonce"], row["id"]))
                            if raw["type"] != "session_name_changed":
                                self.state.fence(held["root"], "fenced" if raw["type"] == "force_unregister" else "recovering", expected=held,
                                                 from_state=None if raw["type"] == "force_unregister" else "active")
                            held = self.state.session(held["root"])
                        else:
                            if self.state.rows("SELECT root FROM sessions WHERE credential=? AND state IN ('pending','retiring') AND request IS NOT NULL AND response IS NULL", (digest,)):
                                continue
                    if raw["type"] == "session_name_changed":
                        if held and held["nonce"] == row["nonce"] and held["state"] == "active":
                            await self.names.maintain(api, held)
                            current = self.state.rows("SELECT applied FROM controls WHERE id=?", (row["id"],))
                            if not current or not current[0]["applied"]: continue
                            await api.control_ack(row["id"])
                            with self.state.lock:
                                self.check_credential(digest)
                                self.state.db.execute("UPDATE controls SET acked=1 WHERE id=?", (row["id"],))
                            continue
                        elif held and held["nonce"] == row["nonce"] and held["state"] in {"pending", "recovering", "retiring"}:
                            continue
                        else:
                            self.state.put("unresolved_name_control/" + row["id"], row)
                            with self.state.lock: self.state.db.execute("DELETE FROM controls WHERE id=?", (row["id"],))
                            continue
                    if held and held["nonce"] != row["nonce"] and held["state"] in {"pending", "recovering", "retiring"}:
                        continue
                    if held and held["nonce"] == row["nonce"]:
                        if raw["type"] == "force_unregister":
                            if held["state"] not in {"retired", "credential_ended"}:
                                self.state.fence(held["root"], expected=held)
                                try:
                                    await api.retire({**held, "state": "active"})
                                except Refusal as error:
                                    if error.code not in {"registration_retired", "registration_superseded", "registration_expired"}:
                                        raise
                        elif held["state"] in {"active", "pending", "recovering", "retiring"}:
                            continue
                    with self.state.lock:
                        self.check_credential(digest)
                        self.state.db.execute("UPDATE controls SET applied=1 WHERE id=?", (row["id"],))
                await api.control_ack(row["id"])
                with self.state.lock:
                    self.check_credential(digest)
                    self.state.db.execute("UPDATE controls SET acked=1 WHERE id=?", (row["id"],))
            except Exception as error:
                self.problem(error)

    async def maintain(self):
        async with self.connection() as api:
            digest = fingerprint(api.credential)
            for row in self.state.rows("SELECT key,value FROM meta WHERE key LIKE 'admission/%'"):
                stamp = json.loads(row["value"])
                if stamp["credential"] != digest:
                    continue
                try:
                    if self.state.get("ended/" + stamp["root"]):
                        continue
                    platform = stamp.get("platform", "local")
                    physical = stamp["physical"]
                    if platform != "local":
                        physical = await asyncio.to_thread(native_current, self.host.home, physical, stamp["route"])
                    elif stamp.get("birth") and stamp["birth"]["source"] == "tui":
                        physical = (await asyncio.to_thread(native_continuation, self.host.home, stamp["root"], stamp["birth"]))["physical"]
                    root = await asyncio.to_thread(native_root, self.host.home, physical)
                    route = await asyncio.to_thread(self.host.route, physical, platform=platform)
                    if root != stamp["root"] or (route["route"], route["logical"]) != (stamp["route"], stamp["logical"]):
                        raise Refusal("native_identity_changed")
                    if stamp.get("birth") and (route.get("birth") != stamp["birth"] or list(route["peer"]) != stamp["peer"]):
                        raise Refusal("native_identity_changed")
                    if await asyncio.to_thread(native_end, self.host.home, physical, expected_root=root, expected_birth=stamp.get("birth")):
                        raise Refusal("native_session_ended")
                    await self.qualify(root, stamp["route"], stamp["logical"], platform, physical=physical)
                    held = self.state.enroll(root, stamp["route"], stamp["logical"], digest, platform=platform, resume=True)
                    self.remember(root, physical, stamp["route"])
                    await self.ensure(api, held=held)
                    if not stamp.get("link_candidate"):
                        with self.state.lock:
                            self.state.db.execute("DELETE FROM meta WHERE key=? AND value=?", (row["key"], row["value"]))
                except Exception as error:
                    self.problem(error)
            for held in self.state.rows("SELECT * FROM sessions WHERE credential=? AND state IN ('pending','recovering')", (digest,)):
                try: await self.ensure(api, held=held)
                except Refusal as error: self.problem(error)
            await self.controls(api, digest)
            for receipt in self.state.pending_receipts():
                held = self.state.session(receipt["root"])
                if held["credential"] != digest or held["nonce"] != receipt["nonce"]: continue
                try:
                    self.bound(held)
                    await self.owned(api, held)
                    await api.receipt(held, receipt)
                    self.state.receipt_result(receipt, True)
                except Exception as error:
                    self.state.receipt_result(receipt, False)
                    self.problem(error)
            for held in self.state.rows("SELECT * FROM sessions WHERE credential=? AND state='retiring'", (digest,)):
                try:
                    if self.state.get("declaration_refresh/" + held["nonce"]): await self.ensure(api, held=held)
                    else: await self.retire(held, api)
                except Exception as error: self.problem(error)
            for held in self.state.rows("SELECT * FROM sessions WHERE credential=? AND state='active'", (digest,)):
                try:
                    if self.refresh_needed(held): held = await self.ensure(api, held=held)
                    await self.names.maintain(api, held)
                except Exception as error:
                    self.problem(error)
                    continue
                cached = self.state.get("source/" + held["nonce"])
                if not cached or cached["credential"] != digest:
                    try:
                        await self.owned(api, held)
                        await self.source(api, held)
                    except Exception as error:
                        self.problem(error)
                ended = self.state.get("ended/" + held["root"])
                if not ended:
                    physical = self.state.get("active_physical/" + held["root"])
                    try:
                        if not physical:
                            raise Refusal("native_identity_unresolved")
                        ended = await self.ended(held, physical)
                        if ended:
                            self.state.put("ended/" + held["root"], ended)
                    except Refusal as error:
                        self.problem(error)
                if not ended and self.state.next_message(held["root"], node=api.credential["node"]) and time.monotonic() >= self.next_activation.get(held["root"], 0):
                    self.next_activation[held["root"]] = time.monotonic() + 30
                    try: await self.activate(held, api)
                    except Exception as error: self.problem(error)
                for row in self.state.rows("SELECT * FROM outbox WHERE root=? AND node=? AND state='pending'", (held["root"], api.credential["node"])):
                    try: await self.replay(api, held, row)
                    except Exception as error: self.problem(error)
                if ended and not self.state.rows("SELECT id FROM outbox WHERE root=? AND node=? AND state='pending'", (held["root"], api.credential["node"])):
                    try: await self.retire(held, api)
                    except Exception as error: self.problem(error)
            self.state.expire_presentations()

    async def watch(self, credential):
        digest = fingerprint(credential)
        api = self.services(self.build.API, credential, assert_current=lambda: self.check_credential(digest))
        try:
            while not self.closed:
                try: await api.stream(self.frame, on_connected=lambda: self.reconcile_active(api))
                except asyncio.CancelledError: raise
                except Exception as error:
                    self.problem(error)
                    if isinstance(error, Refusal) and error.status in {401, 403}:
                        self.credential_ended = True
                        return
                await asyncio.sleep(1)
        finally:
            await api.close()

    async def reconcile_active(self, api):
        digest = fingerprint(api.credential)
        for held in self.state.rows("SELECT * FROM sessions WHERE credential=? AND state='active'", (digest,)):
            try:
                self.bound(held)
                if self.refresh_needed(held): held = await self.ensure(api, held=held)
                else: await self.owned(api, held)
                await self.source(api, held)
            except Refusal as error:
                self.problem(error)
                if error.code not in {"registration_retired", "registration_expired", "registration_superseded", "registration_inactive", "registration_changed", "registration_pending"}:
                    raise

    async def run(self):
        if not self.resident:
            raise Refusal("canonical_gateway_receiver_required")
        try:
            while not self.closed:
                try:
                    credential = self.state.get("credential")
                    digest = fingerprint(credential) if credential else None
                    if digest != self.stream_credential or self.reconnect.is_set() or self.stream and self.stream.done() and not self.credential_ended:
                        self.reconnect.clear()
                        if self.stream:
                            self.stream.cancel()
                            await asyncio.gather(self.stream, return_exceptions=True)
                        self.stream = asyncio.create_task(self.watch(credential)) if credential else None
                        self.stream_credential = digest
                        self.credential_ended = False
                    if self.owner:
                        try: await self.owner.poll()
                        except Exception as error: self.problem(error)
                    self.typing.reconcile()
                    if credential and not self.credential_ended: await self.maintain()
                except asyncio.CancelledError: raise
                except Exception as error: self.problem(error)
                await asyncio.sleep(1)
        finally:
            await self.close()

    async def run_execution(self):
        if self.resident:
            raise Refusal("native_execution_context_unavailable")
        try:
            while not self.closed:
                try:
                    credential = self.state.get("credential")
                    if credential:
                        digest = fingerprint(credential)
                        for held in self.state.rows("SELECT * FROM sessions WHERE platform='local' AND state='active' AND credential=?", (digest,)):
                            if not self.state.next_message(held["root"], node=credential["node"]) or time.monotonic() < self.next_activation.get(held["root"], 0):
                                continue
                            ordinary = self.state.get("ordinary/" + held["root"]) or {}
                            if not ordinary.get("continuation") or self.state.get("ended/" + held["root"]):
                                continue
                            current = await asyncio.to_thread(native_continuation, self.host.home, held["root"], ordinary["continuation"])
                            self.host.profile()
                            self.bound(held)
                            if self.ctx.inject_message(NOTICE.format(tool=self.build.PREFIX + "look"), session_key=current["physical"]) is True:
                                self.next_activation[held["root"]] = time.monotonic() + 30
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.problem(error)
                await asyncio.sleep(1)
        finally:
            await self.close()

    async def close(self):
        self.closed = True
        typing_tasks = [token["task"] for token in self.typing.requests.values() if token.get("task")]
        self.typing.close()
        await asyncio.gather(*typing_tasks, return_exceptions=True)
        if self.stream:
            self.stream.cancel()
            await asyncio.gather(self.stream, return_exceptions=True)
        for task in tuple(self.tasks): task.cancel()
        await asyncio.gather(*tuple(self.tasks), return_exceptions=True)
        await self.gateway.close()
