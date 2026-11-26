# PlayDeck

A separate Decky Loader plugin for PlayStation Network. It provides a friends list with presence and game activity when PSN supplies them, Online ID search, incoming friend requests and blocked-player lists, and text conversations. The Parties tab lists parties and invitations and provides controls to create, join, invite friends, and leave.

Native party voice uses Sony’s voice bridge. Joining connects voice automatically; the headset icon reconnects it. Choose Auto or Direct in the gear settings.

## Install and sign in

1. Enable Developer Mode in Decky, then select **Install Plugin from ZIP File** and choose `PlayDeck.zip`.
2. Sign in on [PlayStation's website](https://www.playstation.com/) in a browser. In the same browser, visit [Sony's NPSSO endpoint](https://ca.account.sony.com/api/v1/ssocookie).
3. Open the gear settings and copy the `npsso` value into **Sony NPSSO code** and select **Connect PlayStation Network**. Treat the code like a password. The plugin sends it to Sony during sign-in and stores only the resulting session tokens in its Decky settings directory, in an owner-only file. **Disconnect PlayStation Network** removes the local session.

This plugin uses undocumented PSN endpoints. The build and native relay tests pass. Party voice was verified between PlayDeck on SteamOS and PlayStation App on Android, including audio from the Deck microphone on the Android device.

## Message attachments

In a conversation, select **View image**, **View sticker**, or **Play video** to open an attachment. Use LB/RB to scroll message history while focusing attachment buttons. The viewer fills the available width. Videos support playback controls; on a controller, A plays or pauses, left/right seek 10 seconds, and B closes the viewer. File links are available when Sony supplies them. Deleted or expired media displays an error with a retry option.

Images can load through the authenticated message-resource endpoint. Streaming video uses bundled [HLS.js](https://github.com/video-dev/hls.js); its license is included in `third_party/hls.js-LICENSE.txt`. The Sony media endpoint sequence was checked against [psn-php’s Media implementation](https://github.com/Tustin/psn-php/blob/master/src/Model/Media.php).

## Build

From this directory:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
python3 native/party-voice/build.py --test
python3 native/party-voice/build.py
python3 -m pip install --target py_modules -r requirements-build.txt
python3 package_plugin.py
```

The frontend entry is the readable runtime recovered from the installed plugin because the original voice TypeScript was unavailable. The native relay requires Go 1.24 or later. The package includes the pinned Python voice dependencies. Endpoint references include [psn-api](https://github.com/achievements-app/psn-api), [express-psn-api](https://github.com/Tazhys/express-psn-api), and [PlayStation Party](https://github.com/speedsorcererdev/PlayStation-Party).
