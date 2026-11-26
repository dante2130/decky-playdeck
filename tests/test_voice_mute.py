"""Mute updates must preserve the bridge mapping and leave failed writes retryable."""
import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

spec = importlib.util.spec_from_file_location("playdeck_backend", Path(__file__).resolve().parents[1] / "main.py")
backend = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"decky": SimpleNamespace()}):
    spec.loader.exec_module(backend)


def decode(data):
    return json.loads(base64.b64decode(data))


class VoiceMuteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = backend.Plugin()
        self.plugin.voice_lock = asyncio.Lock()
        self.plugin.voice = None
        self.voice = {"session": "session-1", "id": "bridge-1", "peer": "peer-1",
                      "member_data": backend.PARTY_MEMBER_DATA, "published": True}
        self.plugin.bridge_voice = self.voice
        self.plugin._set_bridge_member_data = AsyncMock()

    async def test_mute_and_unmute_preserve_bridge_mapping(self):
        original = decode(self.voice["member_data"])
        for muted in (True, False):
            await self.plugin.set_voice_mute("session-1", muted)
            data = decode(self.plugin._set_bridge_member_data.call_args.args[1])
            expected = original.copy()
            expected[5] = "1" if muted else "0"
            self.assertEqual(decode(self.voice["member_data"]), expected)
            expected[8] = "bridge-1\npeer-1"
            self.assertEqual(data, expected)

    async def test_failed_update_does_not_change_cached_member_data(self):
        self.plugin._set_bridge_member_data.side_effect = ValueError("offline")
        with self.assertRaises(ValueError):
            await self.plugin.set_voice_mute("session-1", True)
        self.assertEqual(self.voice["member_data"], backend.PARTY_MEMBER_DATA)

    async def test_stale_session_and_invalid_mute_do_not_publish(self):
        for session, muted in (("other-session", True), ("session-1", "true")):
            with self.assertRaises(ValueError):
                await self.plugin.set_voice_mute(session, muted)
        self.plugin._set_bridge_member_data.assert_not_awaited()

    async def test_unpublished_bridge_does_not_announce_peer(self):
        self.voice["published"] = False
        await self.plugin.set_voice_mute("session-1", True)
        data = decode(self.plugin._set_bridge_member_data.call_args.args[1])
        self.assertEqual(data[5], "1")
        self.assertEqual(data[8], "")


if __name__ == "__main__":
    unittest.main()
