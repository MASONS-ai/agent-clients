"""Native owner decisions and recoverable encrypted browser Link."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import shlex
import threading
import time
from urllib.parse import quote, urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .portrayal import fingerprint
from .services import record, text
from .state import Refusal, encoded


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def unb64(value):
    value = text(value)
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def decrypt(private_key, envelope):
    key = serialization.load_pem_private_key(private_key.encode(), password=None)
    secret = key.decrypt(unb64(envelope["wrapped_key"]), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    if len(secret) != 32:
        raise Refusal("handoff_key_unreadable")
    return record(json.loads(AESGCM(secret).decrypt(unb64(envelope["iv"]), unb64(envelope["ciphertext"]), None)))


def link_record(state):
    candidate, credential = state.get("candidate"), state.get("credential")
    status = ("expired" if candidate["expires"] <= time.time() and candidate["state"] in {"starting", "pending", "expired"}
              else "awaiting") if candidate else "complete" if credential else "none"
    return {"state": status, "credentials_present": bool(credential),
            **({"linked_as": credential["handle"]} if credential else {})}


def link_candidate(candidate):
    return hashlib.sha256(candidate["private_key"].encode()).hexdigest()


def pending_admissions(state, candidate):
    identity = link_candidate(candidate)
    return [(row["key"], json.loads(row["value"])) for row in state.rows("SELECT key,value FROM meta WHERE key LIKE 'admission/%'")
            if json.loads(row["value"]).get("link_candidate") == identity]


def release_admissions(state, candidate):
    for key, stamp in pending_admissions(state, candidate):
        release_admission(state, key, stamp)


def release_admission(state, key, stamp):
    current = state.get("credential")
    if not current or stamp["credential"] != fingerprint(current):
        state.db.execute("DELETE FROM meta WHERE key=?", (key,))
    else:
        stamp.pop("link_candidate")
        state.put(key, stamp)


def claim_link(client, expected, previous, reclaim=None, authorize=None):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    candidate = {"state": "starting", "expected": expected,
        "previous": previous, "expires": time.time() + 600,
        "private_key": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}
    admission = None
    if reclaim:
        facts = client.host.route(reclaim[3], platform=reclaim[4])
        if facts.get("birth"):
            admission = {"root": reclaim[0], "route": reclaim[1], "logical": reclaim[2],
                "physical": reclaim[3], "platform": reclaim[4], "birth": facts["birth"], "peer": list(facts["peer"])}
    # The journal lock serializes profile secret writes; it cannot roll them back.
    with client.state.transaction():
        client.host.profile()
        if authorize: authorize()
        credential = client.state.get("credential")
        if (fingerprint(credential) if credential else None) != previous: raise Refusal("owner_binding_changed")
        current = client.state.get("candidate")
        if current and not (current["state"] in {"starting", "pending", "expired"} and current["expires"] <= time.time() and not current.get("committing")):
            if current["previous"] != previous or expected is not None and current["expected"] != expected:
                raise Refusal("link_candidate_retained")
            candidate = current
        else:
            if current:
                release_admissions(client.state, current)
            client.state.put("candidate", candidate)
        if admission:
            key = "admission/" + admission["root"]
            existing = client.state.get(key)
            if existing and existing.get("link_candidate") == link_candidate(candidate) and any(existing.get(k) != admission[k] for k in ("birth", "peer", "route", "logical", "platform")):
                raise Refusal("native_identity_changed")
            client.state.put(key, {**admission, "credential": previous, "link_candidate": link_candidate(candidate)})
            client.state.put("physical/" + admission["physical"], admission["root"])
            if not client.state.get("active_physical/" + admission["root"]):
                client.state.put("active_physical/" + admission["root"], admission["physical"])
        return candidate


async def request_link(client, caller):
    client.host.tool_owner(caller)
    credential = client.state.get("credential")
    candidate = claim_link(client, None, fingerprint(credential) if credential else None,
        (caller.root, caller.route, caller.logical, caller.physical, caller.platform), lambda: client.host.tool_owner(caller))
    for _ in range(100):
        client.host.tool_owner(caller)
        current = client.state.get("candidate")
        if not current or current["private_key"] != candidate["private_key"]:
            raise Refusal("owner_candidate_changed")
        if current.get("url"):
            if current["expires"] <= time.time() or current["state"] == "expired":
                return {"status": "expired", "detail": "Ask Link again to open a new browser handoff."}
            return {"status": current["state"], "url": current["url"]}
        await asyncio.sleep(0.1)
    return {"status": "starting", "detail": "Link is retained. The canonical gateway has not returned its browser URL yet. Ask Link again; do not create another chat or upgrade Hermes."}


class Owner:
    def __init__(self, client):
        self.client = client
        self.ctx, self.host, self.state, self.build = client.ctx, client.host, client.state, client.build
        self.commands = threading.Lock()
        self.operations = asyncio.Lock()

    async def invoke(self, action, caller):
        async def act():
            def authorize():
                self.host.tool_owner(caller)
            if action == "link":
                authorize()
                current = self.state.get("credential")
                result = await self.change("link", None, fingerprint(current) if current else None,
                    None, (caller.root, caller.route, caller.logical, caller.physical, caller.platform), authorize=authorize)
                authorize()
                return result
            return await self.status(caller.root, caller=caller)
        if asyncio.get_running_loop() is self.client.loop:
            return await act()
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(act(), self.client.loop))

    def link_record(self):
        return link_record(self.state)

    def save_candidate(self, candidate):
        with self.state.transaction():
            current = self.state.get("candidate")
            if not current or current["private_key"] != candidate["private_key"]:
                raise Refusal("owner_candidate_changed")
            self.binding(candidate["previous"])
            self.state.put("candidate", candidate)
            if candidate["state"] == "expired":
                release_admissions(self.state, candidate)

    def run(self, coroutine):
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.client.loop:
            coroutine.close()
            raise Refusal("owner_command_executor_required")
        future = asyncio.run_coroutine_threadsafe(coroutine, self.client.loop)
        try:
            return future.result(timeout=45)
        except TimeoutError:
            future.cancel()
            raise Refusal("owner_operation_unconfirmed") from None

    def binding(self, expected):
        value = self.state.get("credential")
        if (fingerprint(value) if value else None) != expected:
            raise Refusal("owner_binding_changed")

    def prepare(self, raw):
        words = shlex.split(raw)
        if not words or words == ["status"]:
            return {"action": "status"}
        action = words[0]
        if action not in {"link", "unlink", "cancel"} or len(words) > (2 if action == "link" else 1):
            raise Refusal("owner_command_usage")
        current, candidate = self.state.get("credential"), self.state.get("candidate")
        expected = words[1].lstrip("@").lower() if len(words) == 2 else None
        question = (f"Link this Hermes profile to {'@' + expected if expected else 'a Node selected in your browser'} on {self.build.LABEL}?" if action == "link"
                    else "Unlink this Hermes profile?" if action == "unlink" else "Cancel the pending browser Link?")
        return {"action": action, "expected": expected, "previous": fingerprint(current) if current else None,
                "candidate_key": candidate.get("private_key") if candidate else None, "question": question}

    def session_for_route(self, route):
        from .identity import native_current
        matches = []
        for held in self.state.rows("SELECT * FROM sessions WHERE route=?", (route,)):
            physical = self.state.get("active_physical/" + held["root"])
            if not physical or self.state.get("ended/" + held["root"]):
                continue
            try:
                current = native_current(self.host.home, physical, route)
                native = self.host.owner_session({"session_id": current, "session_key": route, "platform": held["platform"]})
                if native[0] == held["root"]:
                    matches.append(native)
            except Refusal:
                continue
        if len(matches) != 1:
            raise Refusal("native_identity_unresolved")
        return matches[0]

    async def confirm(self, proposal, reclaim=None, *, authorize=None):
        return await self.change(proposal["action"], proposal["expected"], proposal["previous"], proposal["candidate_key"], reclaim, authorize=authorize)

    def command(self, raw, **event):
        if not self.commands.acquire(blocking=False):
            raise Refusal("owner_action_in_progress")
        try:
            native = self.host.owner_context(event)
            proposal = self.prepare(raw)
            if proposal["action"] == "status":
                try:
                    root = self.host.owner_session(event)[0]
                    unavailable = None
                except Refusal as error:
                    root, unavailable = None, error.code
                return self.run(self.status(root, unavailable=unavailable))
            reclaim = None
            if proposal["action"] == "link":
                try:
                    reclaim = self.host.owner_session(event)
                except Refusal:
                    pass
            if not callable(getattr(self.ctx, "ask_choice", None)):
                raise Refusal("owner_confirmation_unavailable")
            answer = self.ctx.ask_choice(proposal["question"], [{"value": "confirm", "label": "Confirm"}, {"value": "cancel", "label": "Cancel"}])
            if answer != "confirm":
                return {"status": "cancelled"}
            if self.host.owner_context(event) != native:
                raise Refusal("owner_context_changed")
            if reclaim:
                try:
                    if self.host.owner_session(event) != reclaim:
                        reclaim = None
                except Refusal:
                    reclaim = None
            return self.run(self.confirm(proposal, reclaim))
        finally:
            self.commands.release()

    async def status(self, root=None, *, unavailable=None, caller=None):
        return await status(self.client, root, unavailable=unavailable, caller=caller)

    async def change(self, action, expected, previous, candidate_key, reclaim, *, authorize=None):
        async with self.operations:
            self.host.profile()
            if self.client.closed:
                raise Refusal("client_stopped")
            if authorize:
                authorize()
            self.binding(previous)
            if not self.client.registration_gate.acquire(blocking=False):
                raise Refusal("registration_pending")
            try:
                if reclaim:
                    with self.state.lock:
                        self.state.put("physical/" + reclaim[3], reclaim[0])
                        if not self.state.get("active_physical/" + reclaim[0]):
                            self.state.put("active_physical/" + reclaim[0], reclaim[3])
                if action == "link":
                    return await self.begin(expected, previous, reclaim=reclaim)
                current = self.state.get("candidate")
                if (current.get("private_key") if current else None) != candidate_key:
                    raise Refusal("owner_candidate_changed")
                await self.cancel(expected=candidate_key)
                if action == "cancel":
                    return self.cleanup_outcome("cancelled")
                credential = self.state.get("credential")
                if credential:
                    await self.retire_current(credential)
                with self.state.transaction():
                    self.binding(previous)
                    if self.state.get("candidate"):
                        raise Refusal("owner_candidate_changed")
                    self.state.put("credential", None)
                self.client.reconnect.set()
                return self.cleanup_outcome("unlinked")
            finally:
                self.client.registration_gate.release()

    async def begin(self, expected, previous, *, reclaim=None):
        candidate = claim_link(self.client, expected, previous, reclaim)
        if candidate["state"] != "starting":
            return {"status": candidate["state"], **({"url": candidate["url"]} if candidate.get("url") else {})}
        return await self.start(candidate)

    async def start(self, candidate):
        key = serialization.load_pem_private_key(candidate["private_key"].encode(), password=None)
        current = self.state.get("credential")
        api = self.client.services(self.build.API, current or {})
        try:
            request = {"cli_pubkey": b64(key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)), "session_topology": "multi_session"}
            try:
                reply = record(await api.request("cli-handoff/init", request, auth=bool(current)))
            except Refusal as error:
                if error.status != 401:
                    raise
                reply = record(await api.request("cli-handoff/init", request, auth=False))
            url = text(reply.get("owner_choice_url"))
            parsed, allowed = urlsplit(url), urlsplit(self.build.WEB)
            if parsed.scheme != "https" or parsed.netloc != allowed.netloc or not parsed.path or parsed.fragment or parsed.username or parsed.password:
                raise Refusal("owner_choice_url_untrusted")
            candidate.update(state="pending", session=text(reply.get("session_id")), url=url)
            if candidate["expires"] <= time.time():
                candidate["state"] = "expired"
            self.save_candidate(candidate)
            if candidate["state"] == "expired":
                return {"status": "expired"}
            return {"status": "pending", "url": url}
        finally:
            await api.close()

    async def poll(self):
        async with self.operations:
            with self.state.transaction():
                candidate = self.state.get("candidate")
                retained = link_candidate(candidate) if candidate and candidate["state"] != "expired" else None
                for row in self.state.rows("SELECT key,value FROM meta WHERE key LIKE 'admission/%'"):
                    stamp = json.loads(row["value"])
                    if stamp.get("link_candidate") and stamp["link_candidate"] != retained:
                        release_admission(self.state, row["key"], stamp)
            if not candidate or candidate["state"] == "expired":
                return
            # A crash after secret replacement is recovered from the retained candidate.
            current = self.state.get("credential")
            committed = candidate.get("committing") and current == candidate.get("credential")
            if not committed:
                self.binding(candidate["previous"])
            if candidate["expires"] <= time.time() and candidate["state"] in {"starting", "pending"}:
                candidate["state"] = "expired"
                self.save_candidate(candidate)
                return
            if not self.client.registration_gate.acquire(blocking=False):
                return
            api = None
            try:
                if candidate["state"] == "starting":
                    await self.start(candidate)
                    return
                if candidate["state"] == "pending":
                    api = self.client.services(self.build.API, {})
                    reply = record(await api.request("cli-handoff/" + quote(candidate["session"], safe="") + "/poll", method="GET", auth=False))
                    if reply.get("status") == "pending":
                        return
                    if reply.get("status") != "completed":
                        raise Refusal("link_poll_unconfirmed")
                    candidate.update(state="received", envelope=record(reply.get("payload")))
                    self.save_candidate(candidate)
                    await api.close()
                    api = None
                if candidate["state"] == "received":
                    payload = decrypt(candidate["private_key"], candidate["envelope"])
                    agent = record(payload.get("agent"))
                    credential = {"token": text(payload.get("token")), "node": text(agent.get("agentId")), "handle": text(agent.get("handle"))}
                    if not credential["token"].startswith("masons_rt_v1_"):
                        raise Refusal("link_grant_unreadable")
                    api = self.client.services(self.build.API, credential)
                    identity = await api.identity()
                    if identity["handle"] != credential["handle"] or candidate["expected"] is not None and identity["handle"] != candidate["expected"]:
                        raise Refusal("link_wrong_node_retained")
                    candidate.update(state="qualified", credential=credential)
                    self.save_candidate(candidate)
                    await api.close()
                    api = None
                if current and not committed:
                    if "resume" not in candidate:
                        candidate["same_node"] = current["node"] == candidate["credential"]["node"]
                        candidate["resume"] = self.state.rows("SELECT root,route,logical,platform,state FROM sessions WHERE credential=?", (fingerprint(current),))
                        self.save_candidate(candidate)
                    await self.retire_current(current)
                with self.state.transaction() as db:
                    if (self.state.get("candidate") or {}).get("private_key") != candidate["private_key"]:
                        raise Refusal("owner_candidate_changed")
                    if not committed:
                        self.binding(candidate["previous"])
                    unknown = self.state.rows("SELECT root FROM sessions WHERE credential=? AND state='credential_ended'", (candidate["previous"],))
                    if not committed and not unknown and self.state.rows("SELECT id FROM controls WHERE credential=? AND acked=0", (candidate["previous"],)):
                        raise Refusal("old_control_ack_pending")
                    digest = fingerprint(candidate["credential"])
                    same_node = candidate.get("same_node", False)
                    admissions = pending_admissions(self.state, candidate)
                    if not candidate.get("committing"):
                        candidate["reclaim_roots"] = sorted({stamp["root"] for _, stamp in admissions})
                    reclaim_roots = set(candidate["reclaim_roots"])
                    candidate["committing"] = True
                    self.state.put("candidate", candidate)
                    self.state.put("credential", candidate["credential"])
                    forced = {row["root"] for row in self.state.rows("SELECT root,body FROM controls WHERE credential=?", (candidate["previous"],)) if json.loads(row["body"])["type"] == "force_unregister"}
                    db.execute("UPDATE sessions SET state='retired' WHERE credential!=?", (digest,))
                    for held in candidate.get("resume", []):
                        if self.state.get("ended/" + held["root"]):
                            continue
                        if same_node and (held["state"] == "fenced" or held["root"] in forced) and held["root"] not in reclaim_roots:
                            db.execute("UPDATE sessions SET state='fenced' WHERE root=?", (held["root"],))
                        elif held["state"] in {"active", "pending", "recovering"} or held["root"] in reclaim_roots:
                            db.execute("UPDATE sessions SET credential=?,request=NULL,response=NULL,state='recovering' WHERE root=?", (digest, held["root"]))
                    for key, stamp in admissions:
                        stamp.pop("link_candidate")
                        self.state.put(key, {**stamp, "credential": digest})
                with self.state.transaction():
                    current_candidate = self.state.get("candidate")
                    if (not current_candidate or current_candidate["private_key"] != candidate["private_key"]
                            or self.state.get("credential") != candidate["credential"]):
                        raise Refusal("owner_candidate_changed")
                    self.state.put("candidate", None)
                self.client.reconnect.set()
            finally:
                if api:
                    await api.close()
                self.client.registration_gate.release()

    async def retire_current(self, credential):
        async with self.client.connection(credential) as api:
            for held in self.state.rows("SELECT * FROM sessions WHERE credential=? AND state IN ('active','pending','retiring','fenced','recovering')", (fingerprint(credential),)):
                await self.client.retire(held, api)
            await self.client.controls(api, fingerprint(credential))

    def cleanup_outcome(self, status):
        unknown = self.state.rows("SELECT key FROM meta WHERE key LIKE 'unconfirmed_retirement/%' LIMIT 1")
        return {"status": status, **({"remote_retirement": "unconfirmed"} if unknown else {})}

    async def cancel(self, *, expected):
        with self.state.transaction():
            candidate = self.state.get("candidate")
            if (candidate.get("private_key") if candidate else None) != expected:
                raise Refusal("owner_candidate_changed")
            if candidate and candidate.get("committing"):
                raise Refusal("link_commit_pending")
            if candidate:
                release_admissions(self.state, candidate)
            self.state.put("candidate", None)


async def status(client, root=None, *, unavailable=None, caller=None):
    credential = client.state.get("credential")
    result = {"Link": {"state": "link_lost" if credential and client.credential_ended else "linked" if credential else "setup_pending" if client.state.get("candidate") else "not_linked"},
              "Identity": None, "Presence": None, "Client": None, "loaded_plugin_version": client.build.VERSION}
    if credential:
        async with client.connection() as api:
            try:
                result["Identity"] = await api.identity()
            except Exception as error:
                client.problem(error)
                result.setdefault("unavailable", {})["Identity"] = getattr(error, "code", "services_unavailable")
                if getattr(error, "status", None) in {401, 403}:
                    result["Link"]["state"] = "link_lost"
            held = client.state.session(root) if root else None
            if held and held["state"] == "active":
                def current():
                    if caller:
                        client.invocation(caller, held)
                    else:
                        client.bound(held)
                try:
                    current()
                    row = await api.owned(held)
                    current()
                    result["Presence"], result["Client"] = row.get("presence"), row.get("client")
                except Exception as error:
                    client.problem(error)
                    result.setdefault("unavailable", {}).update(Presence=getattr(error, "code", "services_unavailable"), Client=getattr(error, "code", "services_unavailable"))
                try:
                    current()
                    identity = await api.session_identity(held)
                    current()
                    result["Identity"] = {**(result["Identity"] or {}), **identity}
                    naming = client.state.get("native_name_status/" + held["root"])
                    if naming: result["SessionName"] = naming
                except Exception as error:
                    client.problem(error)
                    result.setdefault("unavailable", {})["SessionIdentity"] = getattr(error, "code", "services_unavailable")
            elif unavailable:
                result.setdefault("unavailable", {}).update(Presence=unavailable, Client=unavailable)
            else:
                result["Link"]["receiver"] = "not_registered"
    result["Link"].update(set_aside=len(client.state.rows("SELECT id FROM inbox WHERE set_aside=1 AND presented=0")),
                           unconfirmed_registration_cleanup=len(client.state.rows("SELECT key FROM meta WHERE key LIKE 'unconfirmed_retirement/%'")))
    return result
