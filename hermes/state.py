"""One transactional communication journal, separate from Hermes SessionDB."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import threading
import time
import uuid


class Refusal(Exception):
    def __init__(self, code, status=None):
        super().__init__(code)
        self.code, self.status = code, status


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def subject_key(value):
    return ("conversation/" + value["conversation_ref"] if value["kind"] == "conversation"
            else "waiting/" + value["message_ref"])


class State:
    def __init__(self, directory, *, profile, channel, connection=None, vault=None):
        self.directory = Path(directory)
        if self.directory.is_symlink():
            raise Refusal("state_directory_symlink")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        path = self.directory / "communication.sqlite3"
        if path.is_symlink():
            raise Refusal("state_file_symlink")
        fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
        self.lock = threading.RLock()
        self.db = connection or sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5)
        self.db.isolation_level = None
        self.vault = vault
        self.db.row_factory = sqlite3.Row

        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(root TEXT PRIMARY KEY,route TEXT NOT NULL,
                logical TEXT NOT NULL,platform TEXT NOT NULL,nonce TEXT NOT NULL,credential TEXT NOT NULL,
                request TEXT,response TEXT,state TEXT NOT NULL DEFAULT 'pending');
            CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,root TEXT NOT NULL,node TEXT NOT NULL,
                digest TEXT NOT NULL,frame TEXT NOT NULL,presented INTEGER NOT NULL DEFAULT 0,
                failures INTEGER NOT NULL DEFAULT 0,set_aside INTEGER NOT NULL DEFAULT 0,progress_at REAL,
                notice_told INTEGER NOT NULL DEFAULT 0,progress_part INTEGER NOT NULL DEFAULT -1);
            CREATE TABLE IF NOT EXISTS receipts(message TEXT NOT NULL,endpoint TEXT NOT NULL,
                nonce TEXT NOT NULL,act TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(message,endpoint,act));
            CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY,message TEXT NOT NULL,
                root TEXT NOT NULL,task TEXT NOT NULL,turn TEXT NOT NULL,request TEXT NOT NULL,call TEXT NOT NULL,
                part INTEGER NOT NULL,total INTEGER NOT NULL,result TEXT NOT NULL,
                seen INTEGER NOT NULL DEFAULT 0,UNIQUE(root,task,turn,request,call));
            CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,root TEXT NOT NULL,
                node TEXT NOT NULL,task TEXT NOT NULL,turn TEXT NOT NULL,request TEXT NOT NULL,call TEXT NOT NULL,body TEXT NOT NULL,party TEXT,outcome TEXT,state TEXT NOT NULL DEFAULT 'pending',UNIQUE(root,task,turn,request,call));
            CREATE TABLE IF NOT EXISTS bindings(root TEXT NOT NULL,conversation TEXT NOT NULL,
                subject TEXT NOT NULL,in_context INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(root,conversation));
            CREATE TABLE IF NOT EXISTS controls(id TEXT PRIMARY KEY,body TEXT NOT NULL,
                applied INTEGER NOT NULL DEFAULT 0,acked INTEGER NOT NULL DEFAULT 0,credential TEXT NOT NULL,
                root TEXT,nonce TEXT);
        """)
        try:
            self._scope(profile, channel)
        except BaseException:
            self.db.close()
            raise

    def _scope(self, profile, channel):
        with self.transaction():
            scope = {"schema": 1, "profile": str(Path(profile).resolve()), "channel": channel}
            previous = self.get("scope")
            if previous is not None and previous != scope:
                raise Refusal("state_scope_conflict")
            self.put("scope", scope)

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self.db
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def close(self):
        with self.lock:
            self.db.close()

    def get(self, key, default=None):
        with self.lock:
            if self.vault is not None and key in {"credential", "candidate"}:
                return self.vault.get(key, default)
            row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def put(self, key, value):
        with self.lock:
            if self.vault is not None and key in {"credential", "candidate"}:
                return self.vault.put(key, value)
            self.db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, encoded(value)))

    def rows(self, sql, args=()):
        with self.lock:
            return [dict(row) for row in self.db.execute(sql, args)]

    def session(self, root):
        rows = self.rows("SELECT * FROM sessions WHERE root=?", (root,))
        return rows[0] if rows else None

    def propose(self, root, route, logical, credential, physical, *, authorize=None):
        """Publish native admission for the resident, without replacing any incarnation."""
        with self.transaction():
            if authorize:
                authorize()
            pending = self.get("admission/" + root)
            if pending and pending.get("link_candidate"):
                ordinary = self.get("ordinary/" + root) or {}
                birth = ordinary.get("continuation")
                peer = [birth.get(k) for k in ("id", "source", "profile_name", "started_at")] if birth else None
                if ((pending["route"], pending["logical"], pending["platform"]) != (route, logical, "local")
                        or birth != pending["birth"] or peer != pending["peer"]):
                    raise Refusal("native_identity_changed")
                self.put("admission/" + root, {**pending, "credential": credential})
                return
            held = self.session(root)
            if held and (held["state"] == "fenced" or ((held["route"], held["logical"], held["platform"], held["credential"]) != (route, logical, "local", credential)
                    and held["state"] not in {"retired", "credential_ended"})):
                raise Refusal("registration_changed")
            self.put("physical/" + physical, root)
            if not self.get("active_physical/" + root):
                self.put("active_physical/" + root, physical)
            self.put("admission/" + root, {"root": root, "route": route, "logical": logical,
                                          "physical": physical, "credential": credential})

    def enroll(self, root, route, logical, credential, *, platform="local", resume=False):
        with self.transaction() as db:
            held = self.session(root)
            if held:
                if (held["state"] == "fenced"
                        or held["credential"] != credential and held["state"] not in {"retired", "credential_ended"}
                        or held["state"] in {"retired", "retiring", "credential_ended"} and not resume):
                    raise Refusal("registration_not_reclaimable")
                if held["state"] == "credential_ended" and held["credential"] == credential:
                    raise Refusal("credential_ended")
                if held["state"] in {"retired", "credential_ended", "recovering"}:
                    db.execute("UPDATE sessions SET nonce=?,credential=?,request=NULL,response=NULL,state='pending' WHERE root=?", (str(uuid.uuid4()), credential, root))
                elif held["state"] == "retiring":
                    raise Refusal("registration_retirement_pending")
                db.execute("UPDATE sessions SET route=?,logical=?,platform=? WHERE root=?", (route, logical, platform, root))
            else:
                db.execute("INSERT INTO sessions(root,route,logical,platform,nonce,credential) VALUES(?,?,?,?,?,?)",
                           (root, route, logical, platform, str(uuid.uuid4()), credential))
        return self.session(root)

    def registration(self, root, request=None, response=None, *, activate=True):
        with self.transaction() as db:
            if request is not None:
                previous = self.session(root)
                if previous["request"] and json.loads(previous["request"]) != request:
                    raise Refusal("registration_intent_changed")
                db.execute("UPDATE sessions SET request=? WHERE root=?", (encoded(request), root))
            if response is not None:
                db.execute("UPDATE sessions SET response=?,state=? WHERE root=? AND state='pending'",
                           (encoded(response), "active" if activate else "pending", root))

    def fence(self, root, state="fenced", *, expected=None, from_state=None):
        with self.lock:
            if expected is None:
                return self.db.execute("UPDATE sessions SET state=? WHERE root=?", (state, root)).rowcount
            return self.db.execute("UPDATE sessions SET state=? WHERE root=? AND nonce=? AND credential=?" + (" AND state=?" if from_state else ""),
                                   (state, root, expected["nonce"], expected["credential"]) + ((from_state,) if from_state else ())).rowcount

    def retain(self, frame, root, nonce, *, node):
        identity, digest = frame["message_ref"], frame["content_digest"]
        with self.transaction() as db:
            previous = db.execute("SELECT * FROM inbox WHERE id=?", (identity,)).fetchone()
            if previous:
                old = json.loads(previous["frame"])
                def actors(value):
                    return (subject_key(value["subject"]), value["subject"]["self_participant_ref"],
                            frozenset((p["kind"], p["participant_ref"]) for p in value["subject"]["participants"]),
                            value["speaker"]["kind"], value["speaker"]["participant_ref"])
                if previous["root"] != root or previous["node"] != node or previous["digest"] != digest or old["envelope"]["content"] != frame["envelope"]["content"] or actors(old) != actors(frame):
                    raise Refusal("message_replay_conflict")
            else:
                db.execute("INSERT INTO inbox(id,root,node,digest,frame) VALUES(?,?,?,?,?)", (identity, root, node, digest, encoded(frame)))
            if previous and previous["set_aside"] and not previous["presented"]:
                return
            act = "presented" if previous and previous["presented"] else "delivered"
            db.execute("INSERT OR IGNORE INTO receipts(message,endpoint,nonce,act) VALUES(?,?,?,?)",
                       (identity, frame["endpoint_id"], nonce, act))

    def next_message(self, root, *, node=None):
        values = self.rows("SELECT * FROM inbox WHERE root=? AND presented=0 AND set_aside=0" + (" AND node=?" if node else "") + " ORDER BY rowid LIMIT 1", (root, node) if node else (root,))
        return values[0] if values else None

    def handoff(self, message, caller, pieces, *, authorize=None):
        with self.transaction() as db:
            if authorize:
                authorize()
            prior = db.execute("SELECT * FROM handoffs WHERE root=? AND task=? AND turn=? AND request=? AND call=?", (caller.root, caller.task, caller.turn, caller.request, caller.call)).fetchone()
            if prior:
                if prior["root"] != caller.root or prior["turn"] != caller.turn:
                    raise Refusal("tool_call_reused")
                return prior["result"]
            row = db.execute("SELECT * FROM inbox WHERE id=? AND root=? AND presented=0 AND set_aside=0",
                             (message, caller.root)).fetchone()
            if row is None:
                raise Refusal("message_not_pending")
            seen = {v[0] for v in db.execute("SELECT part FROM handoffs WHERE message=? AND seen=1", (message,))}
            part = next((n for n in range(len(pieces)) if n not in seen), len(pieces) - 1)
            identifier = str(uuid.uuid4())
            payload = json.loads(pieces[part])
            payload["handoff"] = identifier
            result = encoded(payload).replace("<", "\\u003c").replace(">", "\\u003e")
            db.execute("INSERT INTO handoffs(id,message,root,task,turn,request,call,part,total,result) VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (identifier, message, caller.root, caller.task, caller.turn, caller.request, caller.call, part, len(pieces), result))
            db.execute("UPDATE inbox SET progress_at=COALESCE(progress_at,?) WHERE id=?", (time.time(), message))
            subject = json.loads(row["frame"])["subject"]
            self.bind(caller.root, subject, in_context=True)
            return result

    def observe_context(self, root, working, effective, *, tool_name, authorize=None):
        from .presentation import signature, unique
        working, effective = unique(working), unique(effective)
        native = set(working)
        with self.transaction() as db:
            if authorize:
                authorize()
            held = self.rows("SELECT h.* FROM handoffs h JOIN inbox i ON i.id=h.message WHERE h.root=? AND i.presented=0 AND i.set_aside=0", (root,))
            witnessed = []
            for carrier in effective:
                if carrier not in native:
                    continue
                matches = [h for h in held if (h['call'], tool_name, *signature(h['result'])) == carrier]
                if len(matches) == 1:
                    witnessed.append(matches[0])
            complete, progress = set(), []
            for message in {h['message'] for h in witnessed}:
                expected = next(h['total'] for h in witnessed if h['message'] == message)
                next_part = 0
                for h in witnessed:
                    if h['message'] == message and h['part'] == next_part:
                        progress.append(h)
                        next_part += 1
                if next_part == expected:
                    complete.add(message)
            for message in {h['message'] for h in held if h['seen']} - complete:
                seen = {h['part'] for h in held if h['message'] == message and h['seen']}
                retained = {h['part'] for h in progress if h['message'] == message}
                if seen - retained:
                    db.execute("UPDATE inbox SET failures=failures+1,progress_part=-1,progress_at=? WHERE id=?", (time.time(), message))
                    db.execute("UPDATE inbox SET set_aside=1 WHERE id=? AND failures>=3", (message,))
            for message in {h['message'] for h in held}:
                db.execute("UPDATE handoffs SET seen=0 WHERE message=?", (message,))
            for h in progress:
                db.execute("UPDATE inbox SET progress_at=?,progress_part=? WHERE id=? AND progress_part<? AND set_aside=0", (time.time(), h['part'], h['message'], h['part']))
                db.execute("UPDATE handoffs SET seen=1 WHERE id=? AND EXISTS(SELECT 1 FROM inbox WHERE id=? AND set_aside=0)", (h['id'], h['message']))
            for message in complete:
                db.execute("UPDATE inbox SET presented=1,set_aside=0 WHERE id=?", (message,))
                db.execute("INSERT OR IGNORE INTO receipts(message,endpoint,nonce,act) SELECT message,endpoint,nonce,'presented' FROM receipts WHERE message=?", (message,))

    def expire_presentations(self, now=None):
        with self.transaction() as db:
            db.execute("UPDATE inbox SET set_aside=1 WHERE presented=0 AND progress_at<?", ((time.time() if now is None else now) - 120,))

    def composing(self, root, task, turn, working, effective, *, tool_name, node, self_ref):
        from .presentation import signature, unique
        working, effective = unique(working), unique(effective)
        rows = self.rows("SELECT h.*,i.frame FROM handoffs h JOIN inbox i ON i.id=h.message "
                         "WHERE h.root=? AND h.task=? AND h.turn=? AND i.node=? AND i.set_aside=0", (root, task, turn, node))
        rows = [row for row in rows if json.loads(row["frame"])["subject"]["self_participant_ref"] == self_ref]
        def complete(carriers):
            parts, frames = {}, {}
            for carrier in carriers:
                matches = [row for row in rows if (row["call"], tool_name, *signature(row["result"])) == carrier]
                if len(matches) != 1: continue
                row = matches[0]
                expected = parts.setdefault(row["message"], {"next": 0, "total": row["total"]})
                if expected["next"] == row["part"]: expected["next"] += 1
                frames[row["message"]] = json.loads(row["frame"])
            return ({message: frames[message]["subject"] for message, progress in parts.items()
                     if progress["next"] == progress["total"]},
                    {value["subject"]["conversation_ref"] for value in frames.values() if value["subject"]["kind"] == "conversation"})
        (native, left), (provider, right) = complete(working), complete(effective)
        if len(left | right) != 1: return set()
        return {native[message]["conversation_ref"] for message in native.keys() & provider.keys()
                if native[message]["kind"] == "conversation"}

    def restart_parts(self, root):
        with self.transaction() as db:
            db.execute("UPDATE inbox SET failures=failures+1,progress_part=-1,progress_at=? WHERE root=? AND presented=0 AND set_aside=0 AND progress_at IS NOT NULL", (time.time(), root))
            db.execute("UPDATE inbox SET set_aside=1 WHERE root=? AND failures>=3 AND presented=0", (root,))
            db.execute("UPDATE handoffs SET seen=0 WHERE root=? AND message IN (SELECT id FROM inbox WHERE presented=0 AND set_aside=0)", (root,))

    def context_subject(self, root, node, self_ref, *, pending=False):
        subjects = {}
        bindings = {row["conversation"]: row for row in self.rows("SELECT * FROM bindings WHERE root=?", (root,))}
        def add(value):
            key = subject_key(value)
            if key in bindings:
                value = json.loads(bindings[key]["subject"])
            if value["self_participant_ref"] == self_ref:
                subjects[subject_key(value)] = value
        if pending:
            for row in self.rows("SELECT frame FROM inbox WHERE root=? AND node=? AND presented=0 AND set_aside=0", (root, node)):
                value = json.loads(row["frame"])["subject"]
                add(value)
        for row in bindings.values():
            value = json.loads(row["subject"])
            if row["in_context"] and value["self_participant_ref"] == self_ref:
                add(value)
        if len(subjects) != 1:
            raise Refusal("conversation_selection_required")
        return next(iter(subjects.values()))

    def reconcile_receipts(self, held, *, node, self_ref):
        endpoint = json.loads(held["response"])["endpoint_id"]
        with self.transaction() as db:
            for row in self.rows("SELECT * FROM inbox WHERE root=? AND node=?", (held["root"], node)):
                if json.loads(row["frame"])["subject"]["self_participant_ref"] != self_ref:
                    continue
                if row["set_aside"] and not row["presented"]:
                    continue
                db.execute("INSERT OR IGNORE INTO receipts(message,endpoint,nonce,act) VALUES(?,?,?,?)",
                           (row["id"], endpoint, held["nonce"], "presented" if row["presented"] else "delivered"))

    def pending_receipts(self):
        return self.rows("SELECT r.*,i.digest,s.root FROM receipts r JOIN inbox i ON i.id=r.message JOIN sessions s ON s.root=i.root WHERE r.done=0 AND r.retry_at<=? AND s.state='active'", (time.time(),))

    def receipt_result(self, receipt, ok):
        with self.lock:
            self.db.execute("UPDATE receipts SET done=?,failures=failures+?,retry_at=? WHERE message=? AND endpoint=? AND act=?",
                            (int(ok), int(not ok), time.time() + min(60, 2 ** min(receipt["failures"], 6)),
                             receipt["message"], receipt["endpoint"], receipt["act"]))

    def send_intent(self, caller, body, *, node, party=None, authorize=None):
        with self.transaction() as db:
            if authorize:
                authorize()
            existing = db.execute("SELECT * FROM outbox WHERE root=? AND task=? AND turn=? AND request=? AND call=?", (caller.root, caller.task, caller.turn, caller.request, caller.call)).fetchone()
            if existing:
                if existing["root"] != caller.root or existing["node"] != node or {k:v for k,v in json.loads(existing["body"]).items() if k not in {"endpoint_id","endpoint_nonce"}} != {k:v for k,v in body.items() if k not in {"endpoint_id","endpoint_nonce"}}:
                    raise Refusal("send_call_reused")
                return dict(existing)
            pending = db.execute("SELECT * FROM outbox WHERE root=? AND node=? AND state='pending' ORDER BY rowid LIMIT 1", (caller.root, node)).fetchone()
            if pending:
                raise Refusal("previous_send_unconfirmed")
            identifier = str(uuid.uuid4())
            db.execute("INSERT INTO outbox(id,root,node,task,turn,request,call,body,party) VALUES(?,?,?,?,?,?,?,?,?)", (identifier, caller.root, node, caller.task, caller.turn, caller.request, caller.call, encoded(body), encoded(party) if party else None))
            return dict(db.execute("SELECT * FROM outbox WHERE id=?", (identifier,)).fetchone())

    def send_result(self, identifier, outcome):
        with self.transaction() as db:
            row = db.execute("SELECT root,outcome FROM outbox WHERE id=?", (identifier,)).fetchone()
            prior = json.loads(row["outcome"]) if row and row["outcome"] else None
            old, new = prior.get("subject") if prior else None, outcome.get("subject")
            replaces = (subject_key(old) if old and new and old["kind"] == "waiting" and new["kind"] == "conversation"
                        and prior.get("message_ref") == outcome.get("message_ref") == old["message_ref"]
                        and old["self_participant_ref"] == new["self_participant_ref"] else None)
            db.execute("UPDATE outbox SET outcome=?,state='settled' WHERE id=?", (encoded(outcome), identifier))
            if row and outcome.get("subject"):
                self.bind(row["root"], outcome["subject"], in_context=True, replaces=replaces)

    def bind(self, root, value, *, in_context=False, replaces=None):
        key = subject_key(value)
        with self.lock:
            existing = self.rows("SELECT subject FROM bindings WHERE root=? AND conversation=?", (root, key))
            if value["kind"] == "waiting" and existing and json.loads(existing[0]["subject"])["kind"] == "conversation":
                value = json.loads(existing[0]["subject"])
            elif existing and value["kind"] == "conversation":
                previous = json.loads(existing[0]["subject"])
                known = {p["participant_ref"]: p for p in previous["participants"]}
                value = json.loads(encoded(value))
                for party in value["participants"]:
                    old = known.get(party["participant_ref"], {})
                    code = old.get("pick_code")
                    if (party["kind"] == old.get("kind") == "session" and "pick_code" not in party
                            and party.get("name") == old.get("name")
                            and all(party.get("parent_node", {}).get(k) == old.get("parent_node", {}).get(k) for k in ("kind", "mstpAddress", "handle"))
                            and isinstance(code, str) and len(code) == 6 and all(c in "0123456789abcdef" for c in code)):
                        party["pick_code"] = code
            self.db.execute("INSERT INTO bindings(root,conversation,subject,in_context) VALUES(?,?,?,?) ON CONFLICT(root,conversation) DO UPDATE SET subject=excluded.subject,in_context=MAX(bindings.in_context,excluded.in_context)", (root, key, encoded(value), int(in_context)))
            if replaces:
                self.db.execute("UPDATE bindings SET subject=? WHERE root=? AND conversation=?", (encoded(value), root, replaces))

    def canonical_key(self, root, key):
        rows = self.rows("SELECT subject FROM bindings WHERE root=? AND conversation=?", (root, key))
        return subject_key(json.loads(rows[0]["subject"])) if rows else key

    def parties(self, root, node, selected):
        from .services import public_party
        if selected["kind"] != "waiting":
            rows = self.rows("SELECT subject FROM bindings WHERE root=? AND conversation=?", (root, subject_key(selected)))
            if rows:
                known = json.loads(rows[0]["subject"])
                if (known["self_participant_ref"] == selected["self_participant_ref"]
                        and {(p["kind"], p["participant_ref"]) for p in known["participants"]} == {(p["kind"], p["participant_ref"]) for p in selected["participants"]}):
                    selected = known
            return [public_party(p) for p in selected["participants"] if p["participant_ref"] != selected["self_participant_ref"]]
        for row in self.rows("SELECT outcome,party FROM outbox WHERE root=? AND node=? AND outcome IS NOT NULL AND party IS NOT NULL", (root, node)):
            value = json.loads(row["outcome"]).get("subject")
            if value and subject_key(value) == subject_key(selected) and value["self_participant_ref"] == selected["self_participant_ref"]:
                return [json.loads(row["party"])]
        raise Refusal("conversation_party_unresolved")

    def unconfirmed_retirement(self, held, node):
        self.put("unconfirmed_retirement/" + held["nonce"], {"registration": held, "node": node, "remote_retirement": "unknown", "reason": "credential_ended"})
