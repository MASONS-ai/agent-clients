"""Original-Session native names; channel journals own actions, not titles."""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import time
import uuid

from .identity import creation, members, native_continuation, native_current, resolve
from .services import record, text
from .state import Refusal, encoded


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


class Names:
    def __init__(self, client):
        self.client, self.state, self.host = client, client.state, client.host

    def observe(self, held, outcome):
        self.host.profile()
        with self.state.transaction():
            self.client.check_credential(held["credential"])
            live = self.state.session(held["root"])
            if (not live or (live["nonce"], live["credential"]) != (held["nonce"], held["credential"])
                    or self.state.get("ended/" + held["root"])):
                raise Refusal("native_name_scope_changed")
            self.state.put("native_name_status/" + held["root"], {**outcome, "observed_at": time.time(),
                "credential": held["credential"], "nonce": held["nonce"]})

    def outcome(self, held):
        value = self.state.get("native_name_status/" + held["root"])
        if (not value or (value.get("credential"), value.get("nonce")) != (held["credential"], held["nonce"])
                or type(value.get("observed_at")) not in {int, float}):
            return None
        return {key: value[key] for key in ("status", "reason", "name", "observed_at") if key in value}

    def snapshot(self, held):
        from hermes_state import SessionDB
        self.host.profile()
        self.client.check_credential(held["credential"])
        live = self.state.session(held["root"])
        if not live or (live["nonce"], live["credential"]) != (held["nonce"], held["credential"]) or self.state.get("ended/" + held["root"]):
            raise Refusal("native_name_scope_changed")
        ordinary = self.state.get("ordinary/" + held["root"]) or {}
        physical = self.state.get("active_physical/" + held["root"])
        if ordinary.get("native") and physical:
            self.client.check_native(held, physical)
            physical = native_current(self.host.home, physical, held["route"])
        elif ordinary.get("continuation"):
            physical = native_continuation(self.host.home, held["root"], ordinary["continuation"])["physical"]
        else:
            raise Refusal("native_name_unqualified")
        with SessionDB(db_path=self.host.home / "state.db", read_only=True) as db:
            row, root = db.get_session(physical), db.get_session(held["root"])
            if not row or resolve(db, physical) != held["root"]:
                raise Refusal("native_name_scope_changed")
            title, source = row.get("title"), row.get("title_source")
            if "title_source" not in row or title is not None and not isinstance(title, str) or source not in {None, "user", "derived", "llm"}:
                raise Refusal("native_name_provenance_unqualified")
            scope = digest([str(self.host.home), held["root"], creation(root)])
            previous = self.state.get("native_name_seen/" + scope) or {}
            ancestors = [db.get_session(sid) for sid in members(db, physical) if sid != physical]
            copied = title is not None and source in {None, "user"} and any(
                ancestor.get("title_source") in {"derived", "llm"}
                and (ancestor.get("title") == title or ancestor.get("title") is None)
                for ancestor in ancestors)
            changed = previous.get("physical") == physical and previous.get("digest") != digest(title)
            same = previous.get("physical") == physical
            uncertain_copy = copied and not (same and (changed or previous.get("source") in {"derived", "llm"}
                                                      or previous.get("copied") is False))
            self.state.put("native_name_seen/" + scope, {"physical": physical, "digest": digest(title),
                "source": source, "copied": uncertain_copy})
            if uncertain_copy:
                raise Refusal("native_name_compression_provenance_pending")
            base = title if source in {None, "user"} else None
            writable = (all(callable(getattr(db, method, None)) for method in
                            ("set_session_title", "sanitize_title", "get_session_by_title"))
                        and not (row.get("hidden") and title == "Bot Chat"))
            return {"scope": scope, "physical": physical, "birth": creation(root),
                    "digest": digest(title), "base": base, "writable": writable}

    @contextmanager
    def marker(self, snapshot):
        from plugins.plugin_storage import plugin_data_dir
        self.host.profile()
        directory = plugin_data_dir("masons-session-names")
        if directory.is_symlink():
            raise Refusal("native_name_marker_unavailable")
        os.chmod(directory, 0o700)
        target = directory / (snapshot["scope"] + ".json")
        fd = os.open(directory / (snapshot["scope"] + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refusal("native_name_busy") from None
            if target.is_symlink():
                raise Refusal("native_name_marker_unavailable")
            value = record(json.loads(target.read_text())) if target.exists() else {}
            def save():
                temporary = directory / (snapshot["scope"] + "." + uuid.uuid4().hex)
                try:
                    out = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    with os.fdopen(out, "w") as stream:
                        stream.write(encoded(value)); stream.flush(); os.fsync(stream.fileno())
                    os.replace(temporary, target)
                    sync = os.open(directory, os.O_RDONLY)
                    try: os.fsync(sync)
                    finally: os.close(sync)
                finally:
                    temporary.unlink(missing_ok=True)
            yield value, save
        finally:
            os.close(fd)

    @staticmethod
    def origin(marker, snapshot):
        for key in ("applying", "applied"):
            entry = marker.get(key)
            if isinstance(entry, dict) and entry.get("digest") == snapshot["digest"]:
                return entry.get("origin", "native")
        return "native"

    def service_applied(self, marker, snapshot):
        return self.origin(marker, snapshot) == self.client.build.CHANNEL

    @staticmethod
    def complete(marker, attempt, status="applied"):
        if attempt and attempt.get("action"):
            marker.setdefault("completed", {})[attempt["channel"]] = {
                "action": attempt["action"], "status": status}

    def registration(self, held):
        snapshot = None
        try:
            snapshot = self.snapshot(held)
            scope = snapshot["scope"]
            with self.marker(snapshot) as (marker, _):
                snapshot = self.snapshot(held)
                if snapshot["scope"] != scope:
                    raise Refusal("native_name_scope_changed")
                return snapshot["writable"], snapshot["base"] if not self.service_applied(marker, snapshot) else None
        except (ImportError, Refusal) as error:
            busy = getattr(error, "code", None) == "native_name_busy"
            self.observe(held, {"status": "pending" if busy else "unqualified",
                                "reason": getattr(error, "code", "native_name_interfaces_unavailable")})
            if busy and snapshot:
                return snapshot["writable"], None
            return (False if isinstance(error, ImportError) else None), None
        except Exception as error:
            self.client.problem(error)
            self.observe(held, {"status": "pending", "reason": "native_name_unconfirmed"})
            return None, None

    def saved(self, held, snapshot):
        previous = self.state.get("native_name/" + held["root"]) or {}
        if previous.get("scope") != snapshot["scope"]:
            previous = {"scope": snapshot["scope"]}
        if (previous.get("credential"), previous.get("nonce")) != (held["credential"], held["nonce"]):
            intent = json.loads(held["request"])["body"] if held.get("request") else {}
            previous = {"scope": snapshot["scope"], "credential": held["credential"], "nonce": held["nonce"],
                        "initial": "session_name_apply_v1" in intent.get("runtime_capabilities", []),
                        **({"reported": digest(intent["host_session_name"])} if "host_session_name" in intent else {})}
        return previous

    def retain(self, held, value):
        self.client.bound(held)
        self.state.put("native_name/" + held["root"], value)

    def write(self, held, snapshot, name):
        from hermes_state import SessionDB
        self.client.bound(held)
        if self.snapshot(held) != snapshot:
            raise Refusal("native_name_changed")
        with SessionDB(db_path=self.host.home / "state.db") as db:
            row = db.get_session(snapshot["physical"])
            if (creation(db.get_session(held["root"])) != snapshot["birth"]
                    or resolve(db, snapshot["physical"]) != held["root"]
                    or db.get_compression_tip(snapshot["physical"]) != snapshot["physical"]
                    or not row or digest(row.get("title")) != snapshot["digest"]):
                raise Refusal("native_name_changed")
            if db.sanitize_title(name) != name:
                raise Refusal("native_name_unrepresentable")
            conflict = db.get_session_by_title(name)
            if conflict and resolve(db, conflict["id"]) != held["root"]:
                raise Refusal("native_name_conflict")
            try:
                if db.set_session_title(snapshot["physical"], name) is not True:
                    raise Refusal("native_name_setter_refused")
            except ValueError:
                raise Refusal("native_name_setter_refused") from None

    async def work(self, api, held):
        self.client.bound(held)
        snapshot = self.snapshot(held)
        scope = snapshot["scope"]
        with self.marker(snapshot) as (marker, save):
            snapshot = self.snapshot(held)
            if snapshot["scope"] != scope:
                raise Refusal("native_name_scope_changed")
            applying = marker.get("applying")
            if applying and applying["digest"] == snapshot["digest"]:
                self.complete(marker, applying)
                marker["applied"] = marker.pop("applying")
                save()
            value = self.saved(held, snapshot)
            completed = record(marker.get("completed", {})).get(self.client.build.CHANNEL)
            cues = [row for row in self.state.rows("SELECT * FROM controls WHERE root=? AND nonce=? AND credential=? AND applied=0",
                                                  (held["root"], held["nonce"], held["credential"]))
                    if json.loads(row["body"])["type"] == "session_name_changed"]
            base = snapshot["base"]
            if base and value.get("refused") and value["refused"] != snapshot["digest"]:
                value.pop("refused")
                value.pop("reported", None)
                self.retain(held, value)
            if base and not self.service_applied(marker, snapshot) and value.get("reported") != digest(base):
                if value.get("attempted") == digest(base) and time.time() < value.get("after", 0):
                    return
                value.update(attempted=digest(base), after=time.time() + 60)
                self.retain(held, value)
                response = record(await api.name_report(held, base))
                self.client.bound(held)
                ack = record(response.get("host_session_name"))
                if (response.get("endpoint_id") != json.loads(held["response"])["endpoint_id"]
                        or type(ack.get("accepted")) is not bool):
                    raise Refusal("native_name_report_unconfirmed")
                if not ack["accepted"] and ack.get("reason") != "invalid":
                    raise Refusal("native_name_report_" + str(ack.get("reason", "unconfirmed")))
                if not ack["accepted"] and not cues and not value.get("initial"):
                    if value.get("pending"):
                        self.complete(marker, {"action": value.get("action"), "channel": self.client.build.CHANNEL}, "superseded")
                        save()
                    value.update(reported=digest(base), refused=digest(base), pending=None)
                    self.retain(held, value)
                    self.observe(held, {"status": "invalid", "name": base})
                    return
                value.pop("refused", None)
                value.update(reported=digest(base), initial=True)
                self.retain(held, value)
                if self.snapshot(held) != snapshot:
                    raise Refusal("native_name_changed")
            if base and value.get("refused") == snapshot["digest"] and not cues and not value.get("initial"):
                self.observe(held, {"status": "invalid", "name": base})
                return
            status = self.state.get("native_name_status/" + held["root"])
            recovering = ((not self.outcome(held) or status.get("status") not in {"applied", "superseded", "invalid"}) and not cues
                          and not value.get("initial") and not value.get("pending"))
            if cues or value.get("initial") or recovering:
                row = await api.owned(held)
                self.client.bound(held)
                name = text(record(row.get("session_naming")).get("name"))
                if self.snapshot(held) != snapshot:
                    raise Refusal("native_name_changed")
                if (recovering and value.get("reported") == digest(name)
                        and (snapshot["digest"] == digest(name) or self.service_applied(marker, snapshot))):
                    if not snapshot["writable"]:
                        raise Refusal("native_name_setter_unavailable")
                    # Reconcile this channel's completion without replaying it over another channel.
                    result = completed["status"] if completed and completed["action"] == value.get("action") else "applied"
                    self.observe(held, {"status": result, "name": name})
                    return
                value.pop("refused", None)
                value.update(initial=False, pending=name, action=uuid.uuid4().hex,
                             before=digest(marker.get("applied")))
                with self.state.transaction():
                    self.retain(held, value)
                    for cue in cues:
                        self.state.db.execute("UPDATE controls SET applied=1 WHERE id=? AND root=? AND nonce=? AND credential=?",
                            (cue["id"], held["root"], held["nonce"], held["credential"]))
            name = value.get("pending")
            if not name:
                return
            if not value.get("action") or "before" not in value:
                raise Refusal("native_name_action_unqualified")
            if not (completed and completed["action"] == value["action"]) and value["before"] != digest(marker.get("applied")):
                self.complete(marker, {"action": value["action"], "channel": self.client.build.CHANNEL}, "superseded")
                save()
                completed = marker["completed"][self.client.build.CHANNEL]
            if completed and completed["action"] == value.get("action"):
                value.update(pending=None, reported=digest(name))
                self.retain(held, value)
                self.observe(held, {"status": completed["status"], "name": name})
                return
            if not snapshot["writable"]:
                raise Refusal("native_name_setter_unavailable")
            attempt = {"digest": digest(name), "channel": self.client.build.CHANNEL, "action": value["action"],
                       "origin": self.client.build.CHANNEL if snapshot["digest"] != digest(name) else self.origin(marker, snapshot)}
            if snapshot["digest"] != digest(name):
                marker["applying"] = attempt
                save()
                try:
                    self.write(held, snapshot, name)
                except Refusal:
                    marker.pop("applying", None); save()
                    raise
                current = self.snapshot(held)
                if current["scope"] != snapshot["scope"] or current["digest"] != digest(name):
                    raise Refusal("native_name_readback_unconfirmed")
            self.complete(marker, attempt)
            marker["applied"] = attempt
            marker.pop("applying", None); save()
            value.update(pending=None, reported=digest(name))
            self.retain(held, value)
            self.observe(held, {"status": "applied", "name": name})

    async def maintain(self, api, held):
        try:
            await self.work(api, held)
        except ImportError:
            return
        except Refusal as error:
            self.observe(held, {"status": "pending", "reason": error.code})
        except Exception as error:
            self.client.problem(error)
            self.observe(held, {"status": "pending", "reason": "native_name_unconfirmed"})
