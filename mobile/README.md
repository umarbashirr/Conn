# Conn Mobile

React Native (Expo) client for Conn.

## Stack

- Expo SDK 58
- React Native 0.88
- TypeScript
- Entry: `App.tsx` mounts the session list and the open chat

## Screens

The first screen is the session list. Sessions are grouped under their project name. **Search** filters titles and project names. **New chat** opens an empty composer.

The chat screen shows the transcript for the session you open. Type a message and press the send button. The app appends your line and clears the field. Pressing send with an empty field does nothing. Suggestion chips on an empty transcript copy their text into the field.

The ground color is `#141414`. After the phone scans a ticket, the list is the chats for that folder. Opening a row loads its transcript and later sends continue on that chat's provider. A new chat sends as Claude on the scanned folder. You can attach up to four photos. A message can be photos alone.

## Point the phone at the desktop gate

The phone sends a turn to Conn and draws the reply in the chat you sent from. An installed Conn opens the same link a checkout does.

1. Start Conn with a project folder already open.
2. Open Customize, then Phone. Scan the code, paste it, or open the `conn://` link from the phone's camera. The ticket names the folder that was focused.
3. From this folder, run `npm start` and open the project in Expo Go. A phone on another machine needs the LAN URL. A `conn://` link from outside the app needs a build that registers the scheme. Expo Go does not.
4. The session list fills from the folder on the ticket. Open a row to load its transcript, or press **New chat** and send from there. The reply is written into that same row.
5. A tool card's **Allow**, **Always**, and **Deny** buttons send that decision. An **AskUserQuestion** card lists each question and its options. **Send answers** submits them. **Skip** declines.
6. When the desktop focuses another folder, the connected phone's list follows. The token and port stay the same.

`CONN_MOBILE_PORT` chooses the port. When it is unset, Conn tries `4777` and then an ephemeral port. `CONN_MOBILE_TOKEN` chooses the token. `CONN_MOBILE_HOST` chooses the bind address, which otherwise is `0.0.0.0`.

The link is cleartext on the LAN. The token is the only check.

## Setup

From this folder:

```sh
npm install
npm start
```

Then scan the QR code with [Expo Go](https://expo.dev/go) on a phone, or press `a` / `i` / `w` for Android emulator, iOS simulator, or web.

This machine has no local Android SDK yet. Use Expo Go on a device, or install Android Studio / Xcode when you need native builds.

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Metro + Expo Dev Tools |
| `npm run android` | Open on Android |
| `npm run ios` | Open on iOS (macOS) |
| `npm run web` | Open in a browser |
| `npm run typecheck` | `tsc --noEmit` |

## Identifiers

- iOS bundle: `dev.conn.app`
- Android package: `dev.conn.app`
- URL scheme: `conn://`
