"""Direct messages use composite IDs with dots and tildes, unlike party IDs."""
import unittest
from unittest.mock import AsyncMock
from test_voice_mute import backend


class ConversationIdTests(unittest.TestCase):
    def test_accepts_direct_and_group_ids_without_widening_party_ids(self):
        for value in ('group-1', '1234567890123456789~9876543210987654321.0'):
            self.assertEqual(backend.conversation_identifier(value), value)
        with self.assertRaises(ValueError):
            backend.identifier('123~456.0')

    def test_rejects_path_segments_and_url_delimiters(self):
        for value in ('', '.', '..', '../group', 'a/b', 'a\\b', '%2f', 'x?y', 'x#y', ' x ', 'x\n', None, 'x' * 129):
            with self.subTest(value=value), self.assertRaises(ValueError):
                backend.conversation_identifier(value)


class DirectMessageTests(unittest.IsolatedAsyncioTestCase):
    async def test_loads_direct_conversation(self):
        plugin = backend.Plugin()
        plugin._api = AsyncMock(return_value={'messages': []})
        plugin._update_profiles = AsyncMock()
        self.assertEqual(await plugin.messages('123~456.0', '123~456.0'), [])
        self.assertIn('/groups/123~456.0/threads/123~456.0/messages', plugin._api.call_args.args[0])

    async def test_send_uses_the_same_direct_identifier_rules(self):
        plugin = backend.Plugin()
        plugin._api = AsyncMock()
        await plugin.send_message('123~456.0', '123~456.0', 'Test')
        self.assertIn('/groups/123~456.0/threads/123~456.0/messages', plugin._api.call_args.args[0])
        self.assertEqual(plugin._api.call_args.args[1], 'POST')
