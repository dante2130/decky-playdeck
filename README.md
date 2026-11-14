# PlayDeck

A separate Decky Loader plugin for PlayStation Network. It provides a friends list with presence and game activity when PSN supplies them, Online ID search, incoming friend requests and blocked-player lists, and text conversations. The Parties tab lists parties and invitations and provides controls to create, join, invite friends, and leave.

Native party audio, attachment playback, and changes to friend requests or blocked players are currently unavailable. Use PlayStation App for voice.

## Install and sign in

1. Enable Developer Mode in Decky, then select **Install Plugin from ZIP File** and choose `PlayDeck.zip`.
2. Sign in on [PlayStation's website](https://www.playstation.com/) in a browser. In the same browser, visit [Sony's NPSSO endpoint](https://ca.account.sony.com/api/v1/ssocookie).
3. Copy the `npsso` value into **Sony NPSSO code** in the plugin and select **Connect PlayStation Network**. Treat the code like a password. The plugin sends it to Sony during sign-in and stores only the resulting session tokens in its Decky settings directory, in an owner-only file. **Disconnect PlayStation Network** removes the local session.

This plugin uses undocumented PSN endpoints. The Decky build and backend behavior with mocked PSN responses have been checked. Authenticated PSN behavior has yet to be confirmed on hardware.

## Build

From this directory:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
python3 package_plugin.py
```

The backend uses the Python standard library. Endpoint references include [psn-api](https://github.com/achievements-app/psn-api), [express-psn-api](https://github.com/Tazhys/express-psn-api), and [PlayStation Party](https://github.com/speedsorcererdev/PlayStation-Party).
