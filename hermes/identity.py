"""Resolve native conversation roots through public read-only Host projections."""
from __future__ import annotations

from pathlib import Path

from .state import Refusal


def members(db, physical):
    revision = getattr(db, "conversation_revision", None)
    if callable(revision):
        value = revision(physical, include_ancestors=True)
        if not isinstance(value, tuple) or not value or not isinstance(value[0], (tuple, list)):
            raise Refusal("native_identity_unresolved")
        ids = value[0]
    else:
        # This public projection includes descendants: keep only the requested cutoff.
        lineage = db.get_compression_lineage(physical)
        if not isinstance(lineage, list) or physical not in lineage:
            raise Refusal("native_identity_unresolved")
        ids = lineage[:lineage.index(physical) + 1]
        head = db.get_session(ids[0])
        parent = db.get_session(head["parent_session_id"]) if head and head.get("parent_session_id") else None
        if parent and parent.get("end_reason") == "compression" and not db.is_explicit_fork_child(ids[0]):
            # A singleton may conceal a stale sibling or an unclassified reset fork.
            raise Refusal("native_identity_unresolved")
    if not ids or any(not isinstance(s, str) or not s for s in ids) or len(set(ids)) != len(ids) or physical not in ids:
        raise Refusal("native_identity_unresolved")
    rows, children = {}, {}
    for sid in ids:
        row = db.get_session(sid)
        if not row or row.get("id") != sid:
            raise Refusal("native_identity_unresolved")
        parent = row.get("parent_session_id")
        if parent == sid or parent and db.get_session(parent) is None:
            raise Refusal("native_identity_unresolved")
        rows[sid] = row
        if parent in ids:
            if parent in children:
                raise Refusal("native_identity_unresolved")
            children[parent] = sid
    heads = [sid for sid in ids if rows[sid].get("parent_session_id") not in rows]
    if len(heads) != 1:
        raise Refusal("native_identity_unresolved")
    ordered, current = [], heads[0]
    while current is not None and current not in ordered:
        ordered.append(current)
        current = children.get(current)
    if current is not None or set(ordered) != set(ids) or ordered[-1] != physical:
        raise Refusal("native_identity_unresolved")
    return ordered


def resolve(db, physical, *, budget=1024):
    """Only lineage membership determines ancestry; no private marker interpretation."""
    anchor, seen = physical, set()
    for _ in range(budget):
        if not isinstance(anchor, str) or not anchor or anchor in seen:
            raise Refusal("native_identity_unresolved")
        seen.add(anchor)
        ids = members(db, anchor)
        if ids != [anchor]:
            anchor = ids[0]
            continue
        tool_resolver = getattr(db, "get_tool_rotation_root", None)
        if not callable(tool_resolver):
            row = db.get_session(anchor)
            if not row or not isinstance(row.get("source"), str) or row["source"] == "tool":
                raise Refusal("native_identity_unresolved")
            return anchor
        tool_root = tool_resolver(anchor)
        if not isinstance(tool_root, str) or not tool_root:
            raise Refusal("native_identity_unresolved")
        if tool_root != anchor:
            if db.get_session(tool_root) is None or db.get_tool_rotation_root(tool_root) != tool_root:
                raise Refusal("native_identity_unresolved")
            anchor = tool_root
            continue
        return anchor
    raise Refusal("native_identity_unresolved")


def native_root(home, physical):
    from hermes_state import SessionDB
    try:
        with SessionDB(db_path=Path(home) / "state.db", read_only=True) as db:
            return resolve(db, physical)
    except Refusal:
        raise
    except Exception as error:
        raise Refusal("native_identity_unresolved") from error


def transport_profile(db, physical):
    """Compression publishes before the gateway copies the transport onto its child."""
    current = db.get_session(physical).get("transport_profile")
    if current:
        if not isinstance(current, str):
            raise Refusal("native_identity_unresolved")
        return current
    anchor, seen = physical, set()
    for _ in range(1024):
        chain = members(db, anchor)
        for sid in reversed(chain):
            if sid in seen:
                continue
            seen.add(sid)
            value = db.get_session(sid).get("transport_profile")
            if value:
                if not isinstance(value, str):
                    raise Refusal("native_identity_unresolved")
                return value
        head = chain[0]
        if head != anchor:
            anchor = head
            continue
        tool_root = getattr(db, "get_tool_rotation_root", None)
        root = tool_root(anchor) if callable(tool_root) else anchor
        if root == anchor:
            return None
        parent = db.get_session(anchor).get("parent_session_id")
        if not parent or parent in seen or tool_root(parent) != root:
            raise Refusal("native_identity_unresolved")
        anchor = parent
    raise Refusal("native_identity_unresolved")


def native_stop_route(home, physical):
    from hermes_state import SessionDB
    try:
        with SessionDB(db_path=Path(home) / "state.db", read_only=True) as db:
            tip = db.get_compression_tip(physical)
            entry = db.gateway_routing_entry_for_session(tip)
            if entry and isinstance(entry.get("session_key"), str) and entry["session_key"]:
                return entry["session_key"]
            row = db.get_session(physical)
            return row.get("session_key") if row else None
    except Exception as error:
        raise Refusal("native_stop_route_unresolved") from error


def native_end(home, physical, *, expected_root=None, expected_birth=None):
    """Public canonical continuation lifecycle; ordinary UI teardown is recoverable."""
    from hermes_state import SessionDB
    try:
        with SessionDB(db_path=Path(home) / "state.db", read_only=True) as db:
            row = db.get_session(physical)
            if row is None or expected_root and expected_root != physical and db.get_session(expected_root) is None:
                return "deleted"
            if expected_birth and creation(db.get_session(expected_root or physical)) != expected_birth:
                return "deleted"
            tip = db.get_compression_tip(physical)
            latest = db.get_session(tip) if isinstance(tip, str) and tip else None
            if not latest or latest.get("end_reason") == "compression":
                raise Refusal("native_lifecycle_unresolved")
            return "reset" if latest.get("end_reason") == "session_reset" else None
    except Exception as error:
        raise Refusal("native_lifecycle_unresolved") from error


def native_route(home, physical, *, platform="", sender=""):
    """Routing metadata of the actual invocation, never a peer/directory lookup."""
    import json
    from hermes_state import SessionDB
    from hermes_constants import profile_name_for_home
    try:
        with SessionDB(db_path=Path(home) / "state.db", read_only=True) as db:
            row = db.get_session(physical)
            tool_authority = callable(getattr(db, "get_tool_rotation_root", None))
            birth = creation(db.get_session(resolve(db, physical))) if row else None
            transport = transport_profile(db, physical) if row else None
            local = None
            if row and row.get("source") in {"tui", "desktop"} and row.get("session_key") is None and row.get("chat_id") is None:
                anchor = resolve(db, physical)
                local = creation(db.get_session(anchor))
        if not row or row.get("id") != physical:
            raise Refusal("native_route_missing")
        source = row.get("source")
        origin = json.loads(row["origin_json"]) if row.get("origin_json") else {}
        if not isinstance(origin, dict):
            raise Refusal("native_route_unresolved")
        local_sources = {"cli", "tui", "gui", "desktop", "acp", "local"}
        native_platform = origin.get("platform") or ("local" if source in local_sources else source)
        expected = "local" if platform in local_sources else platform
        source_matches = source in local_sources if native_platform == "local" else source == native_platform
        if source == "tool":
            source_matches = tool_authority and origin.get("platform") == native_platform
        if (not isinstance(native_platform, str) or not native_platform
                or expected and expected != native_platform
                or not source_matches):
            raise Refusal("native_platform_mismatch")
        own = profile_name_for_home(home)
        if own and row.get("profile_name") and row["profile_name"] != own:
            raise Refusal("native_profile_changed")
        if local:
            if local["source"] != "tui" or own and local["profile_name"] and local["profile_name"] != own:
                raise Refusal("native_profile_changed")
            return {"route": local["id"], "logical": local["id"], "platform": "local",
                    "peer": (local["id"], local["source"], local["profile_name"], local["started_at"]), "continuation": local, "birth": birth}
        route, chat = row.get("session_key"), row.get("chat_id")
        if not isinstance(route, str) or not route or not isinstance(chat, str) or not chat:
            raise Refusal("native_route_missing")
        if sender and row.get("user_id") != sender:
            raise Refusal("native_sender_mismatch")
        for key in ("chat_id", "chat_type", "thread_id", "user_id"):
            if key in origin and origin[key] != row.get(key):
                raise Refusal("native_peer_mismatch")
        return {"route": route, "logical": chat if native_platform == "local" else "", "platform": native_platform,
                "peer": (chat, row.get("chat_type"), row.get("thread_id"), row.get("user_id"), row.get("profile_name"), transport), "birth": birth}
    except Refusal:
        raise
    except Exception as error:
        raise Refusal("native_route_unresolved") from error


def creation(row):
    if not row or not isinstance(row.get("started_at"), (int, float)) or isinstance(row["started_at"], bool):
        raise Refusal("native_identity_unresolved")
    return {key: row.get(key) for key in ("id", "started_at", "source", "profile_name")}


def native_continuation(home, root, expected):
    """Exact native TUI family and creation, without title or minted-key fallback."""
    from hermes_state import SessionDB
    try:
        with SessionDB(db_path=Path(home) / "state.db", read_only=True) as db:
            row = db.get_session(root)
            if creation(row) != expected:
                raise Refusal("native_identity_changed")
            tip = db.get_compression_tip(root)
            if resolve(db, tip) != root:
                raise Refusal("native_identity_changed")
            current = db.get_session(tip)
            if not current or current.get("end_reason") == "session_reset":
                raise Refusal("native_session_ended")
            cwd = current.get("cwd") or row.get("cwd")
            if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not Path(cwd).is_dir():
                raise Refusal("native_working_directory_unavailable")
            return {"physical": tip, "cwd": cwd, "model": current.get("model")}
    except Refusal:
        raise
    except Exception as error:
        raise Refusal("native_identity_unresolved") from error


def native_current(home, physical, route):
    """Corroborate the exact family route while native compression awaits gateway sync."""
    from hermes_state import SessionDB
    try:
        with SessionDB(db_path=Path(home) / "state.db", read_only=True) as db:
            tip = db.get_compression_tip(physical)
            root = resolve(db, physical)
            if resolve(db, tip) != root:
                raise Refusal("native_identity_changed")
            anchor, segment_tip, seen, owners, tool_rotated = tip, tip, set(), set(), False
            for _ in range(1024):
                chain = members(db, anchor)
                if db.get_compression_tip(chain[0]) != segment_tip:
                    raise Refusal("native_identity_changed")
                for sid in chain:
                    if sid in seen:
                        continue
                    seen.add(sid)
                    entry = db.gateway_routing_entry_for_session(sid)
                    if entry and entry.get("session_id") == sid and entry.get("session_key") == route:
                        if resolve(db, sid) != root:
                            raise Refusal("native_identity_changed")
                        owners.add(sid)
                head = chain[0]
                if head != anchor:
                    anchor = head
                    continue
                tool_root = getattr(db, "get_tool_rotation_root", None)
                parent = tool_root(anchor) if callable(tool_root) else anchor
                if parent == anchor:
                    break
                parent = db.get_session(anchor).get("parent_session_id")
                if not parent or tool_root(parent) != tool_root(anchor) or resolve(db, parent) != root:
                    raise Refusal("native_identity_unresolved")
                if parent in seen:
                    raise Refusal("native_identity_unresolved")
                anchor, segment_tip, tool_rotated = parent, parent, True
            else:
                raise Refusal("native_identity_unresolved")
            if len(owners) != 1 or tool_rotated and owners != {tip}:
                raise Refusal("native_route_changed")
            return tip
    except Refusal:
        raise
    except Exception as error:
        raise Refusal("native_route_unresolved") from error
