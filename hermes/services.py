"""Hermes-owned implementation of the Services HTTP and push contracts."""
from __future__ import annotations

import base64
import hashlib
import json
import struct
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import aiohttp

from .state import Refusal, encoded

DECLARATION = {
    "execution_surface": "owner_attached",
    "background_exchange_mode": "adapter_managed_turn",
    "runtime_capabilities": ["background_exchange_v1", "runtime-explicit-session-model-v1", "presence_v1", "conversation_typing_v1"],
}
SENDER_MEDIA = "application/vnd.masons.icm-messaging-v2+json"


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise Refusal("services_value_unreadable")
    value.encode("utf-8")
    return value


def record(value):
    if not isinstance(value, dict):
        raise Refusal("services_record_unreadable")
    return value


def content_digest(content):
    digest = hashlib.sha256()
    for value in ("masons/icm/content/v1", content):
        data = value.encode("utf-8")
        digest.update(struct.pack(">I", len(data)))
        digest.update(data)
    return base64.urlsafe_b64encode(digest.digest()).decode().rstrip("=")


def participant(raw):
    raw = record(raw)
    kind, ref = raw.get("kind"), text(raw.get("participant_ref"))
    if kind not in {"node", "session"}:
        raise Refusal("participant_kind_unknown")
    result = {"kind": kind, "participant_ref": ref}
    node_key = "node" if kind == "node" else "parent_node"
    if node_key in raw:
        node = record(raw[node_key])
        identity = {"kind": text(node.get("kind")), "mstpAddress": text(node.get("mstpAddress"))}
        for key in ("handle", "displayName", "avatarUrl"):
            try:
                identity[key] = text(node.get(key))
            except (Refusal, UnicodeError):
                pass
        result[node_key] = identity
    if kind == "session":
        try:
            for key in ("name", "host_label"):
                if key in raw:
                    result[key] = text(raw[key])
        except (Refusal, UnicodeError):
            return {k: v for k, v in result.items() if k not in {"name", "host_label"}} | {"unresolved": True}
        code = raw.get("pick_code")
        if isinstance(code, str) and len(code) == 6 and all(c in "0123456789abcdef" for c in code):
            result["pick_code"] = code
    else:
        for key in ("nickname", "handle", "avatar_url"):
            try:
                result[key] = text(raw.get(key))
            except (Refusal, UnicodeError):
                pass
    return result


def subject(raw, *, allow_waiting=False):
    raw = record(raw)
    waiting = allow_waiting and raw.get("kind") == "waiting"
    if not waiting and (raw.get("kind") != "conversation" or raw.get("conversation_kind") not in {"session_conversation", "node_conversation"}):
        raise Refusal("message_subject_unknown")
    participants = raw.get("participants")
    count = 1 if waiting else 2
    if not isinstance(participants, list) or len(participants) != count:
        raise Refusal("message_participants_unreadable")
    parties = [participant(p) for p in participants]
    self_ref = text(raw.get("self_participant_ref"))
    if len({p["participant_ref"] for p in parties}) != count or sum(p["participant_ref"] == self_ref for p in parties) != 1:
        raise Refusal("message_self_unreadable")
    if waiting:
        return {"kind": "waiting", "message_ref": text(raw.get("message_ref")), "self_participant_ref": self_ref, "participants": parties}
    return {"kind": "conversation", "conversation_kind": raw["conversation_kind"],
            "conversation_ref": text(raw.get("conversation_ref")), "self_participant_ref": self_ref, "participants": parties}


def parse_message(raw):
    raw = record(raw)
    if raw.get("type") != "message" or type(raw.get("version")) is not int or raw["version"] != 1:
        raise Refusal("message_version_unknown")
    message = text(raw.get("message_ref"))
    recipient = record(raw.get("recipient"))
    if ("runtime_session_id" in recipient) == ("node_id" in recipient):
        raise Refusal("message_recipient_unreadable")
    key = "runtime_session_id" if "runtime_session_id" in recipient else "node_id"
    envelope = record(raw.get("envelope"))
    if envelope.get("type") != "masons.remote_message.v1" or envelope.get("message_ref") != message or not isinstance(envelope.get("content"), str):
        raise Refusal("message_envelope_unreadable")
    if len(envelope["content"].encode("utf-8")) > 65536:
        raise Refusal("message_content_too_large")
    digest = content_digest(envelope["content"])
    if digest != raw.get("content_digest"):
        raise Refusal("message_digest_mismatch")
    whole_subject, speaker = subject(raw.get("subject")), participant(raw.get("speaker"))
    if speaker["participant_ref"] == whole_subject["self_participant_ref"] or not any(p["participant_ref"] == speaker["participant_ref"] and p["kind"] == speaker["kind"] for p in whole_subject["participants"]):
        raise Refusal("message_speaker_mismatch")
    result = {"type": "message", "version": 1, "message_ref": message,
            "endpoint_id": text(raw.get("endpoint_id")), "recipient": {key: text(recipient[key])},
            "content_type": text(raw.get("content_type")), "content_digest": digest,
            "envelope": {"type": "masons.remote_message.v1", "message_ref": message,
                         "content": envelope["content"]},
            "subject": whole_subject, "speaker": speaker}
    try:
        result["envelope"]["sent_at"] = text(envelope.get("sent_at"))
    except (Refusal, UnicodeError):
        pass
    seat = raw.get("seat")
    if isinstance(seat, dict) and isinstance(seat.get("chosen_by"), dict):
        try:
            seated_at = text(seat.get("seated_at"))
            datetime.fromisoformat(seated_at.replace("Z", "+00:00"))
            chooser = seat["chosen_by"]
            if chooser.get("kind") in {"owner", "self"}:
                result["seat"] = {"seated_at": seated_at, "chosen_by": {"kind": chooser["kind"]}}
            elif chooser.get("kind") == "session":
                try:
                    chosen = {k: text(chooser[k]) for k in ("name", "host_label") if k in chooser}
                    if not chosen or chooser.get("unresolved") is True:
                        raise Refusal("seat_chooser_unresolved")
                    result["seat"] = {"seated_at": seated_at, "chosen_by": {"kind": "session", **chosen}}
                except (Refusal, UnicodeError):
                    result["seat"] = {"seated_at": seated_at, "chosen_by": {"kind": "session", "unresolved": True}}
        except (Refusal, UnicodeError, ValueError):
            pass
    return result


def public_party(value):
    return {key: value[key] for key in ("kind", "nickname", "name", "host_label", "handle", "pick_code", "unresolved", "node", "parent_node") if key in value}


def instant(value):
    value = text(value)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
            raise ValueError()
    except ValueError:
        raise Refusal("services_time_unreadable") from None
    return value


def send_outcome(raw):
    raw = record(raw)
    common = {"projection_etag": text(raw.get("projection_etag")), "outcome_at": instant(raw.get("outcome_at"))}
    if raw.get("attempt_ref"):
        outcome = raw.get("outcome")
        if outcome not in {"refused", "dispatch_pending", "acceptance_unconfirmed"}:
            raise Refusal("sending_outcome_unknown")
        result = {**common, "attempt_ref": text(raw["attempt_ref"]), "outcome": outcome}
        if outcome == "refused":
            if raw.get("refusal_code") != "remote_definitive_refusal" or instant(raw.get("local_outcome_recorded_at")) != common["outcome_at"]:
                raise Refusal("sending_refusal_unreadable")
            result.update(refusal_code=raw["refusal_code"], remote_refusal_decided_at=instant(raw.get("remote_refusal_decided_at")), local_outcome_recorded_at=raw["local_outcome_recorded_at"])
        return result
    if raw.get("placement") != "placed":
        raise Refusal("message_placement_unknown")
    if raw.get("progress") not in {"accepted", "delivered", "presented"}:
        raise Refusal("message_progress_unknown")
    return {**common, "message_ref": text(raw.get("message_ref")), "subject": subject(raw.get("subject"), allow_waiting=True), "placement": "placed", "progress": raw["progress"]}


def traversal(raw, *, previous=None, count, choices=None):
    raw = record(raw)
    text(raw.get("traversal_ref"))
    expiry = instant(raw.get("expires_at"))
    if (type(raw.get("page")) is not int or raw["page"] < 1 or raw.get("page_bound") != 12
            or type(raw.get("complete")) is not bool
            or raw["complete"] == ("continuation" in raw)
            or any(type(raw.get(k)) is not int or not 0 <= raw[k] <= 12 for k in ("entry_count", "choice_count"))
            or raw["entry_count"] != count or raw["choice_count"] != (count if choices is None else choices)
            or datetime.fromisoformat(expiry.replace("Z", "+00:00")) <= datetime.now(timezone.utc)):
        raise Refusal("target_traversal_unreadable")
    if "continuation" in raw:
        text(raw["continuation"])
    if previous is None:
        valid = raw["page"] == 1
    else:
        valid = (raw["page"] == previous["page"] + 1
                 and raw["traversal_ref"] == previous["traversal_ref"]
                 and expiry == previous["expires_at"])
    if not valid:
        raise Refusal("target_traversal_changed")
    return raw


def history_entry(raw, selected):
    raw = record(raw)
    for key in ("history_entry_ref", "etag", "speaker_participant_ref", "content_type"):
        text(raw.get(key))
    speaker = participant(raw.get("speaker"))
    refs = {p["participant_ref"] for p in selected["participants"]}
    direction = record(raw.get("direction"))
    from_ref, to_ref = direction.get("from_participant_ref"), direction.get("to_participant_ref")
    perspective = raw.get("direction_perspective")
    if (speaker["participant_ref"] != raw["speaker_participant_ref"] or from_ref != speaker["participant_ref"]
            or from_ref not in refs or to_ref is not None and (to_ref not in refs or to_ref == from_ref)
            or perspective not in {"sent", "received"}
            or (perspective == "sent") != (from_ref == selected["self_participant_ref"])):
        raise Refusal("history_direction_mismatch")
    content = raw.get("content")
    if not isinstance(content, str):
        raise Refusal("history_content_unreadable")
    content.encode("utf-8")
    result = {"content": content, "content_type": raw["content_type"], "speaker": public_party(speaker), "direction_perspective": perspective}
    try:
        result["at"] = instant(raw.get("sent_at"))
    except (Refusal, UnicodeError):
        pass
    if perspective == "sent":
        try:
            delivery = record(raw.get("delivery"))
            if delivery.get("placement") != "placed" or delivery.get("progress") not in {"accepted", "delivered", "presented"}:
                raise Refusal("history_delivery_unreadable")
            result["delivery"] = {"placement": "placed", "progress": text(delivery.get("progress")), "outcome_at": instant(delivery.get("outcome_at"))}
        except (Refusal, UnicodeError):
            pass
    return result


class Services:
    def __init__(self, api, credential, *, assert_current=lambda: None):
        self.api, self.credential, self.assert_current = api.rstrip("/"), credential, assert_current
        self.http = None
        self.server_time = None

    async def open(self):
        if self.http is None:
            self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))

    async def close(self):
        if self.http is not None:
            await self.http.close()
            self.http = None

    async def request(self, path, body=None, *, method="POST", headers=None, auth=True, expected=None, business_errors=None, response_meta=None):
        self.assert_current()
        self.server_time = None
        await self.open()
        merged = {"Accept": "application/json", "Content-Type": "application/json", **(headers or {})}
        if auth:
            merged["Authorization"] = "Bearer " + self.credential["token"]
        async with self.http.request(method, self.api + "/v1/" + path, json=body, headers=merged, allow_redirects=False) as response:
            if response_meta is not None:
                response_meta["status"] = response.status
            if response.headers.get("Date"):
                try:
                    self.server_time = parsedate_to_datetime(response.headers["Date"]).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                except (TypeError, ValueError, OverflowError):
                    raise Refusal("services_response_time_unreadable") from None
            chunks, size = [], 0
            async for chunk in response.content.iter_chunked(65536):
                size += len(chunk)
                if size > 4 * 1024 * 1024:
                    raise Refusal("services_response_too_large")
                chunks.append(chunk)
            self.assert_current()
            data = b"".join(chunks)
            try:
                value = json.loads(data) if data else None
            except (ValueError, UnicodeError):
                raise Refusal("services_response_unreadable", response.status) from None
            if response.status >= 300:
                code = value.get("error") if isinstance(value, dict) else None
                if business_errors and isinstance(code, str) and code in business_errors.get(response.status, set()):
                    return value
                raise Refusal(code if isinstance(code, str) and code.replace("_", "").isalnum() else "services_request_refused", response.status)
            if expected is not None and response.status != expected:
                raise Refusal("services_status_unconfirmed", response.status)
            return value

    async def identity(self):
        identity = record(await self.request("me/identity", method="GET"))
        principal = record(await self.request("whoami", method="GET"))
        node = record(identity.get("node"))
        if principal.get("subjectType") != "agent-runtime" or principal.get("carrier") != "runtime-api-key" or principal.get("subjectId") != self.credential["node"]:
            raise Refusal("link_principal_mismatch")
        return {"handle": text(node.get("handle")), "address": text(node.get("mstpAddress"))}

    async def session_identity(self, session):
        value = record(await self.request("runtime/session-identity", {"type": "runtime_session_identity", "version": 1, **self.endpoint(session)}))
        topology = value.get("topology")
        if topology not in {"single_session", "multi_session"}:
            raise Refusal("session_identity_unreadable")
        raw = record(value.get("self"))
        own = {k: text(raw[k]) for k in ("name", "host_label") if k in raw}
        if "node" in raw:
            node = record(raw["node"])
            own["node"] = {"handle": text(node.get("handle")),
                           **({"display_name": text(node["display_name"])} if "display_name" in node else {})}
        result = {"self": own, "topology": topology}
        if "siblings" in value:
            siblings = value["siblings"]
            if topology != "multi_session" or not isinstance(siblings, list):
                raise Refusal("session_identity_unreadable")
            result["siblings"] = []
            for sibling in siblings:
                sibling = record(sibling)
                if sibling.get("state") not in {"present", "away"}:
                    raise Refusal("session_identity_unreadable")
                result["siblings"].append({"state": sibling["state"],
                    **({"name": text(sibling["name"])} if "name" in sibling else {})})
        return result

    async def ensure(self, intent, *, started_at):
        value = record(await self.request("runtime-endpoints/ensure", intent, headers={"x-registration-started-at": started_at}))
        if value.get("node_id") != self.credential["node"] or value.get("registration_outcome") not in {"active", "retired", "superseded", "expired"}:
            raise Refusal("registration_answer_unreadable")
        if value["registration_outcome"] == "expired":
            error = Refusal("registration_expired")
            error.registration_verdict = value
            raise error
        text(value.get("endpoint_id")); text(value.get("registered_at"))
        if value["registration_outcome"] != "active":
            error = Refusal("registration_" + value["registration_outcome"])
            error.registration = value
            raise error
        return value

    async def owned(self, session, *, declaration=True):
        registered = json.loads(session["response"])
        endpoint = registered["endpoint_id"]
        value = record(await self.request(f"runtime-endpoints/{quote(endpoint, safe='')}?as={quote(self.credential['node'], safe='')}", method="GET", headers={"X-Endpoint-Nonce": session["nonce"]}))
        if value.get("endpoint_id") != endpoint or value.get("node_id") != self.credential["node"] or value.get("runtime_session_id") != session["root"] or value.get("runtime_kind") != "hermes" or value.get("is_self") is not True:
            raise Refusal("registration_inactive")
        if value.get("retired_at") and value.get("superseded_by_endpoint_id"):
            raise Refusal("registration_superseded")
        if value.get("retired_at"):
            raise Refusal("registration_retired")
        if value.get("superseded_by_endpoint_id"):
            raise Refusal("registration_inactive")
        expected = dict(DECLARATION)
        if session.get("request"):
            intent = json.loads(session["request"])["body"]
            expected.update({key: intent[key] for key in DECLARATION if key in intent})
        capabilities = value.get("runtime_capabilities")
        if declaration and (not isinstance(capabilities, list) or any(not isinstance(c, str) for c in capabilities)
                or not set(expected["runtime_capabilities"]).issubset(capabilities)
                or any(value.get(k) != v for k, v in expected.items() if k != "runtime_capabilities")):
            raise Refusal("registration_declaration_mismatch")
        return value

    @staticmethod
    def endpoint(session):
        if session["state"] != "active" or not session["response"]:
            raise Refusal("registration_unavailable")
        return {"endpoint_id": json.loads(session["response"])["endpoint_id"], "endpoint_nonce": session["nonce"]}

    async def receipt(self, session, receipt):
        endpoint = self.endpoint(session)
        if endpoint["endpoint_id"] != receipt["endpoint"] or endpoint["endpoint_nonce"] != receipt["nonce"]:
            raise Refusal("receipt_registration_changed")
        return await self.request("runtime/receipts", {**endpoint, "act": receipt["act"], "items": [{"message_ref": receipt["message"], "content_digest": receipt["digest"]}]}, expected=204)

    async def resolve(self, session, query, continuation=None):
        page = record(await self.request("runtime/member-send", {"type": "list_runtime_session_targets", "version": 3, **self.endpoint(session), "query": query, **({"continuation": continuation} if continuation else {})}))
        source = record(page.get("acting_source"))
        if page.get("contract_version") != 3 or source.get("kind") != "exact_session":
            raise Refusal("target_page_unreadable")
        text(source.get("session_ref"))
        echo = record(page.get("query"))
        if echo.get("kind") != query["kind"]:
            raise Refusal("target_query_mismatch")
        if query["kind"] == "node_match":
            rows = page.get("nodes")
            if page.get("status") != "runtime_node_target_resolution" or echo.get("match") != "canonical_handle_exact" or echo.get("handle") != query["match"]["handle"] or page.get("outcome") not in {"zero", "one"} or not isinstance(rows, list) or len(rows) != (1 if page["outcome"] == "one" else 0):
                raise Refusal("target_node_resolution_unreadable")
        elif query["kind"] == "node_sessions":
            rows = page.get("sessions")
            if echo.get("node_ref") != query["node_ref"] or record(page.get("node")).get("node_ref") != query["node_ref"] or not isinstance(rows, list):
                raise Refusal("target_session_resolution_unreadable")
            if "match" in query:
                if (page.get("status") != "runtime_node_session_target_resolution" or echo.get("match") != "approved_display_exact"
                        or echo.get("label") != query["match"]["label"]
                        or echo.get("pick_code") != query["match"].get("pick_code")
                        or page.get("outcome") not in {"not_applicable", "zero", "one", "many"}):
                    raise Refusal("target_session_resolution_unreadable")
                if page["outcome"] == "one" and len(rows) != 1 or page["outcome"] in {"zero", "not_applicable"} and rows or page["outcome"] == "many" and len(rows) < 2:
                    raise Refusal("target_session_count_mismatch")
            elif page.get("status") != "runtime_node_session_target_page":
                raise Refusal("target_session_page_unknown")
            for row in rows:
                text(row.get("target_ref")); text(record(row.get("display")).get("label"))
                if "match" in query:
                    text(row["display"].get("name"))
            if len(rows) > 12 or len({row["target_ref"] for row in rows}) != len(rows):
                raise Refusal("target_session_count_mismatch")
        else:
            rows = page.get("nodes")
            if query["kind"] != "browse_nodes" or page.get("status") != "runtime_node_target_page" or not isinstance(rows, list):
                raise Refusal("target_page_unknown")
        return page

    async def list(self, session, continuation=None):
        return record(await self.request("runtime/session-conversations", {"type": "runtime_session_conversations", "version": 1, **self.endpoint(session), "limit": 20, **({"continuation_ref": continuation} if continuation else {})}))

    async def history(self, session, lookup, continuation=None, *, tail=False, before=None):
        return record(await self.request("runtime/session-conversation-history", {"type": "runtime_session_conversation_history", "version": 2, **self.endpoint(session), **lookup, "limit": 5, **({"continuation_ref": continuation} if continuation else {}), **({"tail": True} if tail else {}), **({"before": before} if before else {})}))

    async def send(self, session, identifier, intent):
        outcome = record(await self.request("messages", {**intent, **self.endpoint(session), "send_request_id": identifier}, headers={"Accept": SENDER_MEDIA, "Content-Type": SENDER_MEDIA}))
        result = send_outcome(outcome)
        if result.get("subject") and result["subject"]["self_participant_ref"] != intent["acting_source"]["session_ref"]:
            raise Refusal("send_outcome_source_mismatch")
        if intent.get("requested_conversation_ref") and result.get("subject", {}).get("conversation_ref") != intent["requested_conversation_ref"]:
            raise Refusal("send_outcome_conversation_mismatch")
        return result

    async def outcome(self, session, path):
        ep = self.endpoint(session)
        result = send_outcome(await self.request(path + "/outcome?version=2", method="GET", headers={"Accept": SENDER_MEDIA, "X-Endpoint-Id": ep["endpoint_id"], "X-Endpoint-Nonce": ep["endpoint_nonce"]}))
        from urllib.parse import unquote
        key = "message_ref" if path.startswith("messages/") else "attempt_ref"
        if (key == "message_ref" or result.get("attempt_ref")) and result.get(key) != unquote(path.split("/", 1)[1]):
            raise Refusal("outcome_resource_mismatch")
        return result

    async def retire(self, session):
        endpoint = self.endpoint(session)["endpoint_id"]
        value = record(await self.request("runtime-endpoints/" + quote(endpoint, safe="") + "?as=" + quote(self.credential["node"], safe=""), method="DELETE"))
        if value.get("endpoint_id") != endpoint:
            raise Refusal("registration_retirement_unconfirmed")
        instant(value.get("retired_at"))
        return value

    async def control_ack(self, identifier):
        return await self.request("runtime/control-ack", {"idempotency_key": identifier, "status": "applied"})

    async def name_report(self, session, name):
        endpoint = self.endpoint(session)["endpoint_id"]
        return await self.request("runtime-endpoints/" + quote(endpoint, safe="") + "/display-metadata", {"host_session_name": text(name)})

    async def typing(self, session, conversation):
        await self.request("runtime/typing", {**self.endpoint(session), "conversation_ref": text(conversation)}, expected=204)

    async def stream(self, on_frame, *, on_connected=None):
        await self.open()
        url = self.api.replace("https://", "wss://").replace("http://", "ws://") + "/v1/runtime/control-events?agent_id=" + quote(self.credential["node"], safe="")
        async with self.http.ws_connect(url, headers={"Authorization": "Bearer " + self.credential["token"]}, heartbeat=15, timeout=aiohttp.ClientWSTimeout(ws_receive=35), max_msg_size=16*1024*1024) as ws:
            if on_connected:
                await on_connected()
            async for frame in ws:
                self.assert_current()
                if frame.type == aiohttp.WSMsgType.TEXT:
                    try:
                        value = json.loads(frame.data)
                    except ValueError:
                        raise Refusal("stream_unreadable") from None
                    if not isinstance(value, dict):
                        raise Refusal("stream_unreadable")
                    await on_frame(value)
                elif frame.type in {aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED}:
                    break
            if ws.close_code == 1008:
                raise Refusal("credential_ended", 401)
