"""Sony v3 member metadata carries the remote microphone mute property."""
import asyncio
import base64
import json
import unittest
from unittest.mock import AsyncMock
from test_voice_mute import backend, decode


def encode(fields):
    return base64.b64encode(json.dumps(fields).encode()).decode()


class MemberMuteTests(unittest.TestCase):
    def test_reads_only_explicit_microphone_slot(self):
        fields = decode(backend.PARTY_MEMBER_DATA)
        for flag, expected in (("0", False), ("1", True), ("", None), (True, None)):
            fields[5] = flag
            self.assertIs(backend.member_mute({"customData4": encode(fields)}), expected)
        for data in (None, "invalid", encode({}), encode([])):
            self.assertIsNone(backend.member_mute({"customData4": data}))

    def test_new_voice_clears_stale_bridge_and_mute_but_preserves_other_fields(self):
        fields = decode(backend.PARTY_MEMBER_DATA)
        fields[1], fields[5], fields[8] = "retained", "1", "old-bridge\nold-peer"
        actual = decode(backend.voice_member_data({"customData4": encode(fields)}))
        fields[5], fields[8] = "0", ""
        self.assertEqual(actual, fields)

    def test_bridge_mapping_uses_member_account_independently_of_signaling_identity(self):
        fields = decode(backend.PARTY_MEMBER_DATA)
        fields[8] = "bridge-1\npeer-1"
        member = {"accountId": "42", "deviceUniqueId": "different-device", "customData4": encode(fields)}
        self.assertEqual(backend.bridge_member_accounts([member], "bridge-1"), {"peer-1": "42"})
        self.assertEqual(backend.bridge_member_accounts([member], "other-bridge"), {})


class MemberViewTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_invite_survives_bulk_party_rejection(self):
        plugin = backend.Plugin()
        plugin._api = AsyncMock(side_effect=[
            {"invitations": [{"sessionId": "invite-room", "invitationId": "invite-1",
                              "from": {"accountId": "42", "onlineId": "Guest"}}]},
            backend.PsnError(400, 2232321),
            {"parties": []},
            {"v2PartySessions": []},
        ])
        parties = await plugin.parties()
        self.assertEqual(plugin._api.await_args_list[2].args[-1], {"groupInvitedPartySessions": []})
        self.assertTrue(parties[0]["invited"])
        self.assertEqual(parties[0]["invitationId"], "invite-1")
        self.assertEqual(parties[0]["inviter"]["name"], "Guest")

    async def test_party_browser_uses_current_members_and_mute_flags(self):
        plugin = backend.Plugin()
        fields = decode(backend.PARTY_MEMBER_DATA)
        fields[5] = "1"
        plugin._api = AsyncMock(side_effect=[{}, {"parties": [{"sessionId": "session-1", "members": [
            {"accountId": "1", "onlineId": "Stale"}, {"accountId": "2", "onlineId": "Other", "avatarUrl": "https://example.com/avatar.png"}]}]},
            {"v2PartySessions": [{"sessionId": "session-1", "members": [
                {"accountId": "2", "onlineId": "Other", "customData4": encode(fields)}]}]}])
        plugin._update_presences = AsyncMock()
        rooms = await plugin.parties()
        self.assertEqual([member["id"] for member in rooms[0]["members"]], ["2"])
        self.assertTrue(rooms[0]["members"][0]["muted"])
        self.assertEqual(rooms[0]["members"][0]["avatar"], "https://example.com/avatar.png")

    async def test_refresh_uses_v3_view_and_keeps_per_account_mute(self):
        plugin = backend.Plugin()
        fields = decode(backend.PARTY_MEMBER_DATA)
        fields[5] = "1"
        room = {"sessionId": "session-1", "members": [
            {"accountId": "1", "platform": "MOBILE_APP"},
            {"accountId": "2", "platform": "MOBILE_APP", "customData4": encode(fields)}]}
        plugin._api = AsyncMock(return_value={"v2PartySessions": [room]})
        voice = {"session": "session-1", "account": "1"}
        await plugin._refresh_voice_members(voice)
        self.assertEqual(plugin._api.call_args.args[0], backend.PARTIES + "/partySessions?view=v3")
        self.assertEqual(voice["member_mutes"], {"1": None, "2": True})
        self.assertEqual(list(voice["members"]), ["2"])
