"""Profile-bound public gateway authentication and exact, non-subscribing reads."""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp

from .state import Refusal


class Gateway:
    def __init__(self, home, *, cli=("hermes",), timeout=15):
        self.home, self.cli, self.timeout = Path(home).resolve(), tuple(cli), timeout
        self.http = self.ws = None
        self.lock = asyncio.Lock()
        self.sequence = 0
        self.code_sha = None
        from .continuation import Continuations
        self.continuations = Continuations(self.home)

    async def close(self):
        await self.continuations.close()
        await self.close_wire()

    async def close_wire(self):
        if self.ws is not None:
            await self.ws.close()
            self.ws = None
        if self.http is not None:
            await self.http.close()
            self.http = None

    async def connect(self):
        if self.ws is not None and not self.ws.closed:
            return
        await self.close_wire()
        # The documented home override selects this profile even in a multiplexer.
        env = {k: v for k, v in os.environ.items() if k in {
            "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT",
            "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
            "http_proxy", "https_proxy", "no_proxy", "HERMES_RUNTIME_DIR", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"}}
        env["HERMES_HOME"] = str(self.home)
        process = await asyncio.create_subprocess_exec(*self.cli, "gateway", "attach", "--json",
                                                     env=env, stdout=asyncio.subprocess.PIPE,
                                                     stderr=asyncio.subprocess.PIPE)
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), self.timeout)
        except BaseException:
            if process.returncode is None:
                process.kill()
                await process.wait()
            raise
        try:
            grant = json.loads(stdout)
            if process.returncode != 0:
                raise ValueError()
            endpoint = grant["endpoint"]
            if Path(endpoint["profile_id"]).resolve() != self.home or not endpoint.get("instance_id"):
                raise ValueError()
            if grant["protocol"] != "hermes-gateway-v1" or not isinstance(grant["ticket"], str) or not grant["ticket"]:
                raise ValueError()
            if grant["protocols"] != [grant["protocol"], "hermes-gateway-ticket." + grant["ticket"]]:
                raise ValueError()
            url = urlsplit(grant["url"])
            if (url.scheme != "ws" or not ipaddress.ip_address(url.hostname).is_loopback
                    or not url.port or url.path != "/api/ws" or url.query or url.fragment or url.username or url.password):
                raise ValueError()
            if grant.get("client_code_sha") and endpoint.get("code_sha") and grant["client_code_sha"] != endpoint["code_sha"]:
                raise Refusal("gateway_client_owner_mismatch")
            self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout))
            self.ws = await self.http.ws_connect(grant["url"], protocols=grant["protocols"],
                                               max_msg_size=4 * 1024 * 1024)
            if self.ws.protocol != grant["protocol"]:
                raise ValueError()
            self.code_sha = endpoint.get("code_sha")
        except asyncio.CancelledError:
            await self.close_wire()
            raise
        except Refusal:
            await self.close_wire()
            raise
        except Exception:
            await self.close_wire()
            # Never expose grant/stdout/headers or exception representations containing tickets.
            raise Refusal("gateway_authentication_unconfirmed") from None

    async def info(self, logical):
        if not isinstance(logical, str) or not logical:
            raise Refusal("native_logical_session_missing")
        async with self.lock:
            await self.connect()
            self.sequence += 1
            rid = self.sequence
            try:
                await self.ws.send_json({"jsonrpc": "2.0", "id": rid, "method": "session.info",
                                         "params": {"session_id": logical}})
                async with asyncio.timeout(self.timeout):
                    async for message in self.ws:
                        if message.type != aiohttp.WSMsgType.TEXT:
                            continue
                        for line in message.data.splitlines():
                            frame = json.loads(line)
                            if frame.get("id") != rid or "method" in frame:
                                continue
                            if "error" in frame:
                                reason = frame["error"].get("data", {}).get("reason")
                                raise Refusal("native_session_not_found" if reason == "not_found" else "gateway_read_refused")
                            if not isinstance(frame.get("result"), dict):
                                raise Refusal("gateway_read_unconfirmed")
                            return frame["result"]
                    raise Refusal("gateway_connection_ended")
            except BaseException:
                await self.close_wire()
                raise
