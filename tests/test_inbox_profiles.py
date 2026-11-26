"""Missing message avatars use profile lookup; presence stays with the same account."""
import unittest
from unittest.mock import AsyncMock
from test_voice_mute import backend


class InboxProfilesTests(unittest.IsolatedAsyncioTestCase):
    async def test_enriches_nonfriend_avatar_and_shares_current_presence(self):
        plugin = backend.Plugin()
        async def api(url):
            if '/profiles?' in url:
                return {'profiles': [{'onlineId': 'Other',
                                      'avatarUrl': 'https://example.com/other.png'}]}
            if 'favoriteFilter=notFavorite' in url:
                return {'groups': [{'groupId': key, 'members': [{'accountId': '2', 'onlineId': 'Other'}]}
                                   for key in ['group-1', 'group-2']]}
            return {'groups': []}
        async def presence(players):
            for player in players:
                player['status'] = 'online'
        plugin._api = AsyncMock(side_effect=api)
        plugin._update_presences = AsyncMock(side_effect=presence)
        rooms = await plugin.inbox()
        for room in rooms:
            self.assertEqual(room['members'][0]['avatar'], 'https://example.com/other.png')
            self.assertEqual(room['members'][0]['status'], 'online')
        profile_calls = [call for call in plugin._api.call_args_list if '/profiles?' in call.args[0]]
        self.assertEqual(len(profile_calls), 1)
        self.assertEqual(len(plugin._update_presences.call_args.args[0]), 1)

    async def test_profile_error_does_not_hide_conversation(self):
        plugin = backend.Plugin()
        async def api(url):
            if '/profiles?' in url:
                raise ValueError('unavailable')
            return {'groups': [{'groupId': 'group-1', 'members': [{'accountId': '2', 'onlineId': 'Other'}]}]}
        plugin._api = AsyncMock(side_effect=api)
        plugin._update_presences = AsyncMock()
        rooms = await plugin.inbox()
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0]['members'][0]['name'], 'Other')


class MessageSenderAvatarTests(unittest.IsolatedAsyncioTestCase):
    async def test_history_enriches_sender_avatars_once_even_when_not_in_current_group(self):
        plugin = backend.Plugin()
        async def api(url):
            if '/profiles?' in url:
                return {'profiles': [{'onlineId': 'PastMember', 'avatarUrl': 'https://example.com/past.png'}]}
            return {'messages': [
                {'messageUid': str(i), 'sender': {'accountId': '2', 'onlineId': 'PastMember'},
                 'createdTimestamp': str(1793379678000 + i), 'body': 'Test'} for i in range(2)]}
        plugin._api = AsyncMock(side_effect=api)
        rows = await plugin.messages('group-1', 'thread-1')
        self.assertEqual([row['avatar'] for row in rows], ['https://example.com/past.png'] * 2)
        self.assertEqual(len([call for call in plugin._api.call_args_list if '/profiles?' in call.args[0]]), 1)
