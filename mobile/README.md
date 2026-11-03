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

The ground color is `#141414`. This build reads fixture transcripts.

## Point the phone at the desktop gate

The phone sends a turn to unpackaged Conn and draws the reply in the chat you sent from.

1. Start unpackaged Conn with a project folder already open.
2. Read the main-process log. It prints the bind address, the token, and a `ws://` URL when the machine has a LAN address.
3. Paste that URL into `GATE_URL`, the token into `GATE_TOKEN`, and the open folder's absolute path into `GATE_PROJECT`. Those constants are at the top of `src/conn-live.ts`.
4. From this folder, run `npm start` and open the project in Expo Go. A phone on another machine needs the LAN URL. A simulator on the desktop machine can use `ws://127.0.0.1` and the port from the log.
5. Open **Zinc tokens** and send. That fixture's id is `s1`, and the phone sends `s1` as the desktop chat key. Or press **New chat** and send from there. The new row's id is the chat key, and the reply is written into that same row.
6. A permission card's **Allow**, **Always**, and **Deny** buttons mark the card and send the decision to the desktop.

`CONN_MOBILE_PORT` chooses the port. When it is unset, Conn tries `4777` and then an ephemeral port. `CONN_MOBILE_TOKEN` chooses the token. `CONN_MOBILE_HOST` chooses the bind address, which otherwise is `0.0.0.0`. A packaged app does not open the gate.

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
