"""Actual native calls compose new acts; persisted sends retain their own lifetime."""
from __future__ import annotations
import json
from urllib.parse import quote
from .portrayal import public_outcome
from .services import text, record, participant, subject, history_entry, public_party, traversal
from .state import Refusal, subject_key

class Operation:
    def __init__(self, client, api, held, caller):
        self.client, self.api, self.held, self.caller = client, api, held, caller
        self.state, self.host = client.state, client.host
        self.bound, self.problem = client.bound, client.problem

    def guard(self):
        if self.held is None:
            self.api.assert_current()
            self.host.validate(self.caller)
            if self.state.get("ended/" + self.caller.root):
                raise Refusal("native_session_ended")
            return
        self.client.invocation(self.caller, self.held)

    async def source(self, held):
        return await self.client.source(self.api, held)

    def bindings(self, root, party=None, *, self_ref=None):
        values = self.state.rows("SELECT subject FROM bindings WHERE root=?", (root,))
        subjects = list({subject_key(json.loads(v["subject"])): json.loads(v["subject"]) for v in values}.values())
        if self_ref:
            subjects = [s for s in subjects if s["self_participant_ref"] == self_ref]
        if party:
            query = party.lstrip("@").casefold()
            matches = []
            for selected in subjects:
                try:
                    parties = self.state.parties(root, self.api.credential["node"], selected)
                except Refusal:
                    continue
                if any(query in {str(p.get(k, "")).lstrip("@").casefold() for k in ("name", "nickname", "handle", "pick_code", "address")} for p in parties):
                    matches.append(selected)
            subjects = matches
        if len(subjects) != 1:
            raise Refusal("conversation_selection_required")
        return subjects[0]

    async def send(self, args, *, caller, selected=None):
        for key in ("to", "session", "pick_code", "party"):
            if key in args:
                text(args[key])
        if ("pick_code" in args and "session" not in args
                or "session" in args and "to" not in args
                or "party" in args and "to" in args):
            raise Refusal("send_selection_invalid")
        content = args.get("content")
        if not isinstance(content, str) or not content:
            raise Refusal("send_content_required")
        content.encode("utf-8")
        held = self.held
        self.guard()
        source = await self.source(held)
        target_party = None
        if args.get("to"):
            target = await self.resolve_target(held, args)
            if "selection" in target:
                self.guard()
                return target["selection"]
            intent = {"send_intent": "initiate", "addressed_grain": target["grain"], "addressed_party_ref": target["ref"]}
            target_party = target.get("party")
        else:
            conversation = selected or (self.bindings(caller.root, args["party"], self_ref=source["session_ref"]) if args.get("party")
                            else self.client.implicit(caller, held, source))
            if conversation["self_participant_ref"] != source["session_ref"]:
                raise Refusal("conversation_source_changed")
            intent = {"send_intent": "continue", **({"opening_message_ref": conversation["message_ref"]} if conversation["kind"] == "waiting" else {"requested_conversation_ref": conversation["conversation_ref"]})}
        body = {**self.api.endpoint(held), **intent, "acting_source": source, "content": content, "content_type": "text/plain"}
        def authorize():
            self.guard()
            if not args.get("to") and not args.get("party"):
                self.client.implicit(caller, held, source)
        row = self.state.send_intent(caller, body, node=self.api.credential["node"], party=target_party, authorize=authorize)
        if row["outcome"]:
            return public_outcome(json.loads(row["outcome"]))
        return public_outcome(await self.client.replay(self.api, held, row))

    async def resolve_target(self, held, args):
        candidate = text(args.get("to")).strip()
        address = candidate.startswith("mstps://")
        handle = candidate if address else candidate.lstrip("@").lower()
        if not args.get("session"):
            page = record(await self.api.request("discovery/node-addressing-outcomes", {"agentIds": [handle], "declarations": {"source_endpoint_id": self.api.endpoint(held)["endpoint_id"]}}))
            rows = page.get("outcomes")
            if not isinstance(rows, list) or len(rows) != 1 or record(rows[0]).get("address" if address else "handle") != handle:
                raise Refusal("node_addressing_unreadable")
            row = rows[0]
            if row.get("outcome") != "node_addressable":
                raise Refusal(row.get("outcome") if row.get("outcome") in {"no_connection", "unavailable", "exact_session_required"} else "node_addressing_unknown")
            if row.get("acting_source") != await self.source(held):
                raise Refusal("node_addressing_source_mismatch")
            return {"grain": "node", "ref": text(row.get("node_ref")),
                    "party": {"kind": "node", "address" if address else "handle": handle}}
        if address:
            raise Refusal("exact_session_handle_required")
        node = await self.api.resolve(held, {"kind": "node_match", "match": {"kind": "canonical_handle_exact", "handle": handle}})
        if node["acting_source"] != await self.source(held):
            raise Refusal("target_source_mismatch")
        if node.get("outcome") != "one" or len(node["nodes"]) != 1:
            raise Refusal("node_selection_unavailable")
        query = {"kind": "node_sessions", "node_ref": text(node["nodes"][0].get("node_ref"))}
        if args.get("session"):
            code = text(args["pick_code"]).strip().lower() if args.get("pick_code") else None
            if code is not None and (len(code) != 6 or any(c not in "0123456789abcdef" for c in code)):
                raise Refusal("pick_code_invalid")
            query["match"] = {"kind": "approved_display_exact", "label": text(args["session"]), **({"pick_code": code} if code else {})}
        page = await self.api.resolve(held, query)
        if page["acting_source"] != await self.source(held):
            raise Refusal("target_source_mismatch")
        choices = page.get("sessions", [])
        if page.get("outcome") != "one" or len(choices) != 1:
            return {"selection": {"status": "exact_session_selection_required", "outcome": page["outcome"],
                                  "choices": [self.public_target(row, handle=handle) for row in choices],
                                  "detail": "Read again by name alone; this code matched none." if page["outcome"] == "zero" and args.get("pick_code") else "Use the intended Session's disclosed name and code. Shared codes require an unambiguous name; never select by position."}}
        selected = choices[0]
        return {"grain": "exact_session", "ref": text(selected.get("target_ref")),
                "party": {"kind": "session", "name": text(selected["display"].get("name")),
                          "parent_node": {"handle": handle}, **({"pick_code": selected["pick_code"]} if selected.get("pick_code") else {})}}

    @staticmethod
    def public_target(row, *, handle=None):
        result = {}
        for key in ("name", "label", "host_label"):
            try:
                result[key] = text(row["display"].get(key))
            except (Refusal, UnicodeError):
                pass
        code = row.get("pick_code")
        if isinstance(code, str) and len(code) == 6 and all(c in "0123456789abcdef" for c in code):
            result["pick_code"] = code
        return result

    async def standing_outcome(self, held, row, source, caller):
        result = json.loads(row["outcome"]) if row["outcome"] else None
        if not result or result.get("request_refusal"):
            return result
        key = "message_ref" if result.get("message_ref") else "attempt_ref"
        path = ("messages/" if key == "message_ref" else "sending-attempts/") + quote(text(result.get(key)), safe="")
        outcome = await self.api.outcome(held, path)
        self.guard()
        if outcome.get("subject") and outcome["subject"]["self_participant_ref"] != source["session_ref"]:
            raise Refusal("outcome_source_mismatch")
        self.state.send_result(row["id"], outcome)
        return outcome

    async def read(self, args, *, caller):
        held = self.held
        self.guard()
        at, party = args.get("at"), args.get("party")
        scope = {"at": at, "party": party, "nonce": held["nonce"], "credential": held["credential"]}
        key = "read/" + caller.root
        saved = self.state.get(key)
        if args.get("more"):
            if not saved or saved["scope"] != scope:
                raise Refusal("read_continuation_unavailable")
            if saved["items"]:
                return self.read_slice(key, saved, refresh=True)
            if not saved.get("continuation") and not saved.get("outcomes"):
                return {"items": [], "more": False}
        else:
            saved = {"scope": scope, "items": [], "continuation": None}
        continuation = saved.get("continuation")
        source = await self.source(held)
        if at == "conversations":
            page = await self.api.list(held, continuation)
            self.guard()
            if (page.get("type") != "runtime_session_conversations" or page.get("version") != 1
                    or page.get("self_participant_ref") != source["session_ref"]
                    or not isinstance(page.get("items"), list) or not isinstance(page.get("waiting"), list)):
                raise Refusal("conversation_page_unreadable")
            items = []
            if not continuation:
                for row in self.state.rows("SELECT * FROM outbox WHERE root=? AND node=? ORDER BY rowid DESC", (caller.root, self.api.credential["node"])):
                    body = json.loads(row["body"])
                    if body.get("acting_source") != source:
                        continue
                    outcome = json.loads(row["outcome"]) if row["outcome"] else None
                    if outcome and outcome.get("attempt_ref"):
                        try:
                            outcome = await self.standing_outcome(held, row, source, caller)
                        except Refusal as error:
                            self.problem(error)
                            outcome = None
                    if outcome is None or outcome.get("attempt_ref"):
                        content = body["content"]
                        items.append({"kind": "sending", "content_excerpt": content[:1000], "content_truncated": len(content) > 1000,
                                      **(public_outcome(outcome) if outcome else {"status": "send_unconfirmed"})})
            for row in page["items"]:
                parties = [participant(p) for p in row["participants"]]
                selected = subject({"kind": "conversation", "conversation_kind": "session_conversation", "conversation_ref": row["conversation_ref"], "self_participant_ref": source["session_ref"], "participants": parties})
                self.state.bind(caller.root, selected)
                items.append({"participants": [public_party(p) for p in parties], "last_message_at": row.get("last_message_at")})
            # A Session does not assign the fleet's unassigned Node openings.
            saved["waiting_for_owner"] = bool(page["waiting"]) or page.get("waiting_truncated") is True
            saved["continuation"] = page.get("continuation_ref")
        elif at == "history":
            selected = saved.get("selected") if continuation else self.bindings(caller.root, party, self_ref=source["session_ref"])
            lookup = saved.get("lookup") if continuation else ({"message_ref": selected["message_ref"]} if selected["kind"] == "waiting" else {"conversation_ref": selected["conversation_ref"]})
            saved["lookup"] = lookup
            page = await self.api.history(held, lookup, continuation)
            self.guard()
            if page.get("type") != "runtime_session_conversation_history" or page.get("version") != 2 or not isinstance(page.get("items"), list):
                raise Refusal("history_page_unreadable")
            got = subject(page.get("subject"), allow_waiting=True)
            transition = "message_ref" in lookup and selected["kind"] == "waiting" and got["kind"] == "conversation"
            if got["self_participant_ref"] != source["session_ref"] or (not transition and subject_key(got) != subject_key(selected)):
                raise Refusal("history_source_mismatch")
            if not transition and {(p["participant_ref"], p["kind"]) for p in got["participants"]} != {(p["participant_ref"], p["kind"]) for p in selected["participants"]}:
                raise Refusal("history_participants_changed")
            snapshot = text(page.get("snapshot_ref"))
            text(page.get("etag"))
            if continuation and saved.get("snapshot") != snapshot:
                raise Refusal("history_snapshot_changed")
            saved["snapshot"] = snapshot
            self.state.bind(caller.root, got, replaces=subject_key(selected) if transition else None)
            saved["selected"] = got
            items = []
            for row in page["items"]:
                entry = history_entry(row, got)
                content = entry.pop("content")
                chunks = [content[i:i+1000] for i in range(0, len(content), 1000)] or [""]
                for index, chunk in enumerate(chunks):
                    items.append({**entry, "content": chunk, "part": index+1, "parts": len(chunks)})
            saved["continuation"] = page.get("continuation_ref")
            if saved["continuation"] is not None:
                text(saved["continuation"])
        elif at == "outcome":
            if not args.get("more"):
                saved["outcomes"] = [row["id"] for row in self.state.rows("SELECT * FROM outbox WHERE root=? AND node=? ORDER BY rowid DESC", (caller.root, self.api.credential["node"])) if json.loads(row["body"]).get("acting_source") == source]
            items = []
            if saved["outcomes"]:
                identifier = saved["outcomes"].pop(0)
                row = self.state.rows("SELECT * FROM outbox WHERE id=? AND root=? AND node=?", (identifier, caller.root, self.api.credential["node"]))[0]
                result = await self.standing_outcome(held, row, source, caller)
                content = json.loads(row["body"])["content"]
                chunks = [content[i:i+1000] for i in range(0, len(content), 1000)] or [""]
                facts = public_outcome(result) if result else {"status": "send_unconfirmed", "retry": False}
                items = [{**facts, "content": chunk, "part": index+1, "parts": len(chunks)} for index, chunk in enumerate(chunks)]
        elif at == "targets":
            if party:
                if continuation:
                    query = saved["query"]
                else:
                    node = await self.api.resolve(held, {"kind": "node_match", "match": {"kind": "canonical_handle_exact", "handle": text(party).lstrip("@").lower()}})
                    if node["outcome"] != "one":
                        raise Refusal("node_selection_unavailable")
                    query = {"kind": "node_sessions", "node_ref": node["nodes"][0]["node_ref"]}
                page = await self.api.resolve(held, query, continuation)
                items = [self.public_target(row) for row in page["sessions"]]
                saved["query"] = query
            else:
                page = await self.api.resolve(held, {"kind": "browse_nodes"}, continuation)
                items = [{"name": text(record(row.get("display")).get("label")), "handle": row.get("identity", {}).get("handle"), "coverage": row.get("coverage")} for row in page["nodes"]]
            if page["acting_source"] != source:
                raise Refusal("target_source_mismatch")
            saved["traversal"] = traversal(page.get("traversal"), previous=saved.get("traversal") if continuation else None, count=len(page["sessions"] if party else page["nodes"]))
            saved["continuation"] = page["traversal"].get("continuation")
        else:
            raise Refusal("read_at_unknown")
        self.guard()
        saved["items"] = items
        return self.read_slice(key, saved)

    def read_slice(self, key, saved, *, refresh=False):
        # One bounded row/piece per tool result; Services paging is independent of native pickers.
        with self.state.transaction():
            self.guard()
            if refresh:
                current = self.state.get(key)
                if not current or current["scope"] != saved["scope"]:
                    raise Refusal("read_continuation_unavailable")
                saved = current
            item = saved["items"].pop(0) if saved["items"] else None
            result = {"items": [] if item is None else [item], "more": bool(saved["items"] or saved.get("continuation") or saved.get("outcomes"))}
            if "waiting_for_owner" in saved:
                result["waiting_for_owner"] = saved["waiting_for_owner"]
            if item is not None and saved["scope"]["at"] == "history":
                self.state.bind(self.caller.root, saved["selected"], in_context=True)
            self.state.put(key, saved)
            return result
