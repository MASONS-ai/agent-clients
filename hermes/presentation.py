"""Immutable snapshots of public native tool carriers, without retaining prompts."""
from __future__ import annotations

import hashlib
import json


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(x, dict) and x.get("type") == "text" and isinstance(x.get("text"), str) for x in value):
        return "".join(x["text"] for x in value)
    return None


def signature(value):
    raw = value.encode("utf-8")
    return len(raw), hashlib.sha256(raw).hexdigest()


def native_name(name, arguments):
    if name != "tool_call":
        return name
    try:
        args = json.loads(arguments) if isinstance(arguments, str) else arguments
        if not isinstance(args, dict):
            return None
        entries = args.get("calls")
        if entries is None:
            entries = [{"name": args.get("name"), "arguments": args.get("arguments")}]
        if isinstance(entries, str):
            entries = json.loads(entries)
        if isinstance(entries, dict):
            entries = [entries]
        if not isinstance(entries, list) or len(entries) != 1 or not isinstance(entries[0], dict):
            return None
        entry = entries[0]
        payload = entry.get("arguments")
        if payload is None:
            payload = {}
        if isinstance(payload, str):
            payload = json.loads(payload) if payload.strip() else {}
        if not isinstance(payload, dict) or entry.get("name") == "tool_call":
            return None
        return entry["name"].strip() if isinstance(entry.get("name"), str) else None
    except (TypeError, ValueError):
        return None


def carriers(messages):
    """Recognize native carrier shapes, never parse remote text as a tool record."""
    if not isinstance(messages, list):
        return ()
    values, calls = [], {}
    def call(identifier, name, arguments):
        name = native_name(name, arguments)
        if isinstance(identifier, str) and identifier and isinstance(name, str) and name:
            calls.setdefault(identifier, []).append(name)
    for item in messages:
        if not isinstance(item, dict):
            continue
        if item.get("role") == "assistant":
            for tool in item.get("tool_calls") or []:
                if isinstance(tool, dict) and isinstance(tool.get("function"), dict):
                    call(tool.get("id"), tool["function"].get("name"), tool["function"].get("arguments"))
            for block in item.get("content") if isinstance(item.get("content"), list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    call(block.get("id"), block.get("name"), block.get("input"))
        if item.get("type") == "function_call":
            call(item.get("call_id"), item.get("name"), item.get("arguments"))
        if item.get("role") == "tool":
            values.append((item.get("tool_call_id"), text_content(item.get("content"))))
        elif item.get("type") == "function_call_output":
            values.append((item.get("call_id"), text_content(item.get("output"))))
        elif item.get("role") == "user" and isinstance(item.get("content"), list):
            for block in item["content"]:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    values.append((block.get("tool_use_id"), text_content(block.get("content"))))
    return tuple((identifier, calls[identifier][0], *signature(value)) for identifier, value in values
                 if identifier in calls and len(calls[identifier]) == 1 and value is not None)


def unique(values):
    counts = {}
    for value in values:
        counts[value[0]] = counts.get(value[0], 0) + 1
    return tuple(value for value in values if counts[value[0]] == 1)
