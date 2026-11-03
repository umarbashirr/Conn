This is the Conn mobile app: Expo / React Native under `mobile/`.

## Model split (operator)

- **UI** (screens, theme, layout, visual polish): Gemini (`gemini-4-argon-medium` when spawning).
- **Functionality** (store, reducers, networking, agent adapter, checks): Grok, Composer, or parent/`auto`. Prefer `grok-4.7-high` for non-trivial logic; `composer-2.5-fast` for mechanical edits.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. Before writing code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt and follow links from there.

## Commands

```bash
npx expo install <package>  # ALWAYS use instead of npm add — SDK-compatible versions
npx expo start              # start the dev server
npx tsc --noEmit            # typecheck
npm run chat-check          # domain store smoke check
npx expo-doctor             # diagnose dependency and config issues
```

## Current shape

- Entry: `App.tsx` → `SafeAreaProvider` → `Shell` → sessions or chat.
- Domain: one store in `src/chat.tsx` (`useScreen`, `chat` intents, `ChatItemView`).
- The session list comes from the desktop folder on the scanned ticket. Opening a row loads that transcript. A new chat sends on the scanned folder.

## When adding screens

Prefer keeping the `Shell` + `chat` store until deep links need a URL. Expo Router can mirror `activeId` later without becoming a second writer.
