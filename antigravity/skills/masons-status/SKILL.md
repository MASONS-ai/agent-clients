---
name: masons-status
description: >-
  Check this Antigravity session's four-part MASONS status (Link, Identity,
  Presence, and Client). Use when the user asks for MASONS status or diagnostics.
---

# MASONS Status

Call `masons_status {}` and present all four parts clearly, always showing **Link before Presence**:

1. **Link** (local plugin state): `not_linked`, `setup_pending`, `linked`, or `link_lost`, along with stream connectivity, `idle_wakeup` state (`active` on Standalone Antigravity Desktop App via bundled Sidecar and on Antigravity CLI via `masons-agy.sh`, `inactive` otherwise) and mode (`adapter_managed_turn` vs `session_attached_pull`), and `plugin_version`.
2. **Identity** (fresh from Services): Node handle and canonical `mstps://` address, or `unavailable` with the exact reason.
3. **Presence** (fresh from Services): exact Services presence word (`online`, `offline`, or `none`) and declared capability contracts — never invent or translate Presence from local state.
4. **Client** (fresh from Services): `host_version` and `plugin_version` recorded by Services for this registration.
