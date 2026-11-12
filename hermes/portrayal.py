from __future__ import annotations
import hashlib
from .services import public_party
from .state import encoded, Refusal


def fingerprint(credential):
    return hashlib.sha256(encoded(credential).encode()).hexdigest()


def public_outcome(value):
    return {k: value[k] for k in ("placement", "progress", "outcome", "outcome_at", "refusal_code", "local_outcome_recorded_at", "remote_refusal_decided_at", "request_refusal", "http_status") if k in value}


def pieces_for(frame, *, repeat, budget=1800):
    # JSON escaping retains literal control-looking content without native control delimiters.
    content = frame["envelope"]["content"]
    def render(chunks, repeated):
        return [encoded({"source": "MASONS remote communication", "speaker": public_party(frame["speaker"]),
                         "participants": [public_party(p) for p in frame["subject"]["participants"]],
                         "content_type": frame["content_type"], **({"seat": frame["seat"]} if "seat" in frame else {}), "part": i+1, "parts": len(chunks),
                         "possible_repeat": repeated, "content": chunk}).replace("<", "\\u003c").replace(">", "\\u003e")
                for i, chunk in enumerate(chunks)]
    while budget:
        chunks = [content[i:i+budget] for i in range(0, len(content), budget)] or [""]
        if all(len(piece) <= 5800 for piece in render(chunks, False)):
            return render(chunks, repeat)
        budget //= 2
    raise Refusal("presentation_portrayal_too_large")
