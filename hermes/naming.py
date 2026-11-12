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
    def service_applied(marker, snapshot):
        return any(isinstance(marker.get(key), dict) and marker[key].get("digest") == snapshot["digest"]
                   for key in ("applying", "applied"))

    def registration(self, held):
        snapshot = None
        try:
            snapshot = self.snapshot(held)
            with self.marker(snapshot) as (marker, _):
                return snapshot["writable"], snapshot["base"] if not self.service_applied(marker, snapshot) else None
        except (ImportError, Refusal) as error:
            self.state.put("native_name_status/" + held["root"], {"status": "unqualified", "reason": getattr(error, "code", "native_name_interfaces_unavailable")})
            if getattr(error, "code", None) == "native_name_busy" and snapshot:
                return snapshot["writable"], None
            return (False if isinstance(error, ImportError) else None), None
        except Exception as error:
            self.client.problem(error)
            self.state.put("native_name_status/" + held["root"], {"status": "pending", "reason": "native_name_unconfirmed"})
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
        with self.marker(snapshot) as (marker, save):
            value = self.saved(held, snapshot)
            base = snapshot["base"]
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
                value.update(reported=digest(base), initial=True)
                self.retain(held, value)
                if self.snapshot(held) != snapshot:
                    raise Refusal("native_name_changed")
            cues = [row for row in self.state.rows("SELECT * FROM controls WHERE root=? AND nonce=? AND credential=? AND applied=0",
                                                  (held["root"], held["nonce"], held["credential"]))
                    if json.loads(row["body"])["type"] == "session_name_changed"]
            if cues or value.get("initial"):
                row = await api.owned(held)
                self.client.bound(held)
                name = text(record(row.get("session_naming")).get("name"))
                if self.snapshot(held) != snapshot:
                    raise Refusal("native_name_changed")
                value.update(initial=False, pending=name)
                with self.state.transaction():
                    self.retain(held, value)
                    for cue in cues:
                        self.state.db.execute("UPDATE controls SET applied=1 WHERE id=? AND root=? AND nonce=? AND credential=?",
                            (cue["id"], held["root"], held["nonce"], held["credential"]))
            name = value.get("pending")
            if not name:
                return
            if not snapshot["writable"]:
                raise Refusal("native_name_setter_unavailable")
            if snapshot["digest"] != digest(name):
                marker["applying"] = {"digest": digest(name), "channel": self.client.build.CHANNEL}
                save()
                try:
                    self.write(held, snapshot, name)
                except Refusal:
                    marker.pop("applying", None); save()
                    raise
                current = self.snapshot(held)
                if current["scope"] != snapshot["scope"] or current["digest"] != digest(name):
                    raise Refusal("native_name_readback_unconfirmed")
            marker["applied"] = {"digest": digest(name), "channel": self.client.build.CHANNEL}
            marker.pop("applying", None); save()
            value.update(pending=None, reported=digest(name))
            self.retain(held, value)
            self.state.put("native_name_status/" + held["root"], {"status": "applied", "name": name})

    async def maintain(self, api, held):
        try:
            await self.work(api, held)
        except ImportError:
            return
        except Refusal as error:
            self.state.put("native_name_status/" + held["root"], {"status": "pending", "reason": error.code})
        except Exception as error:
            self.client.problem(error)
            self.state.put("native_name_status/" + held["root"], {"status": "pending", "reason": "native_name_unconfirmed"})
