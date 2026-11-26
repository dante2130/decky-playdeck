"""Attachment viewing resolves only media belonging to the requested conversation."""
import unittest
from unittest.mock import AsyncMock
from test_voice_mute import backend

CDN = 'https://example.cloudfront.net/image.jpg?Signature=test'


class AttachmentParsingTests(unittest.TestCase):
    def test_recognizes_image_video_and_sticker_without_leaking_resolution_ids(self):
        for field, kind in [('imageMessageDetail', 'image'), ('videoMessageDetail', 'video'), ('stickerMessageDetail', 'image')]:
            row = {'messageUid': '1#12', 'messageDetail': {field: {'ugcId': 'private-id', 'resourceId': 'resource'}}}
            attachment = backend.message(row)['attachments'][0]
            self.assertEqual(attachment['kind'], kind)
            self.assertNotIn('ugcId', attachment)
            self.assertNotIn('resourceId', attachment)
        self.assertEqual(backend.message({'body': 'Text'})['attachments'], [])

    def test_media_links_reject_active_or_local_urls_and_upgrade_legacy_stickers(self):
        self.assertEqual(backend.attachment_url(CDN), CDN)
        self.assertEqual(backend.attachment_url('http://static-resource.np.community.playstation.net/sticker.png'),
                         'https://static-resource.np.community.playstation.net/sticker.png')
        for url in ['javascript:alert(1)', 'data:text/html,test', 'http://localhost/file',
                    'https://playstation.net.evil.com/file', 'https://user:pass@example.cloudfront.net/file',
                    'https://example.cloudfront.net:8443/file']:
            self.assertIsNone(backend.attachment_url(url))


class AttachmentMediaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.plugin = backend.Plugin()
        self.row = {'messageUid': '1#12', 'messageDetail': {'imageMessageDetail': {'ugcId': 'ugc-1'}}}

    async def test_resolves_image_through_metadata_then_temporary_url(self):
        self.plugin._api = AsyncMock(side_effect=[{'messages': [self.row]}, {'ugcDocument': [{'id': 'media-1'}]},
                                                 {'screenshotUrl': CDN}])
        media = await self.plugin.attachment_media('123~456.0', '123~456.0', '1#12')
        self.assertEqual(media['url'], CDN)
        self.assertEqual(media['kind'], 'image')
        calls = self.plugin._api.call_args_list
        self.assertIn('/groups/123~456.0/threads/123~456.0/messages', calls[0].args[0])
        self.assertIn('ugcIds=ugc-1', calls[1].args[0])
        self.assertTrue(calls[2].args[0].endswith('/ugc/media-1/url'))

    async def test_video_uses_streaming_playlist_when_available(self):
        self.row['messageDetail'] = {'videoMessageDetail': {'ugcId': 'ugc-1'}}
        mp4 = 'https://example.cloudfront.net/video.mp4?Signature=test'
        self.plugin._api = AsyncMock(side_effect=[{'messages': [self.row]}, {'ugcDocument': [{'id': 'media-1'}]},
                                                 {'downloadUrl': mp4, 'videoUrl': 'https://example.cloudfront.net/video.m3u8'}])
        media = await self.plugin.attachment_media('g', 't', '1#12')
        self.assertEqual(media['url'], 'https://example.cloudfront.net/video.m3u8')
        self.assertEqual(media['stream'], 'hls')

    async def test_missing_message_cannot_resolve_unrelated_media(self):
        self.plugin._api = AsyncMock(return_value={'messages': []})
        with self.assertRaisesRegex(ValueError, 'no longer available'):
            await self.plugin.attachment_media('g', 't', '1#12')
        self.assertEqual(self.plugin._api.await_count, 1)

    async def test_invalid_parameters_do_not_request_media(self):
        self.plugin._api = AsyncMock()
        for group, message, index in [('../g', '1#12', 0), ('g', '../media', 0), ('g', '1#12', True), ('g', '1#12', -1)]:
            with self.assertRaises(ValueError):
                await self.plugin.attachment_media(group, 't', message, index)
        self.plugin._api.assert_not_awaited()

    async def test_image_prefers_authenticated_message_resource(self):
        self.row['messageDetail']['imageMessageDetail']['resourceId'] = 'resource-1'
        self.plugin._api = AsyncMock(return_value={'messages': [self.row]})
        self.plugin._attachment_resource = AsyncMock(return_value={'kind': 'image', 'url': 'data:image/png;base64,test'})
        self.assertTrue((await self.plugin.attachment_media('g', 't', '1#12'))['url'].startswith('data:image/png'))
        self.plugin._attachment_resource.assert_awaited_once()

    async def test_sticker_uses_safe_cdn_link_without_media_api_calls(self):
        self.row['messageDetail'] = {'stickerMessageDetail': {'imageUrl': CDN}}
        self.plugin._api = AsyncMock(return_value={'messages': [self.row]})
        self.assertEqual((await self.plugin.attachment_media('g', 't', '1#12'))['url'], CDN)
        self.assertEqual(self.plugin._api.await_count, 1)
