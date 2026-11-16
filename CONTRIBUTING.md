# Contributing to Conn

Thanks for helping. Conn is an Electron app that puts an agent chat, a terminal and a browser pane side by side. This page says how to propose a change.

## How changes get in

1. Fork the repository and create a branch in your fork.
2. Make the change and test it (see below).
3. Open a pull request against `main`.

Only the maintainer merges pull requests. Expect review comments before a merge. Pull requests from forks run GitHub Actions only after the maintainer approves the run.

For anything larger than a small fix, open an issue first. Agreeing on the approach before the code saves both of us time.

## Run it from source

```sh
npm install
npm start             # builds the renderer, then opens Conn
```

Run `npm run enable-sandbox` once to turn Chromium's sandbox back on. `npm run dev` starts Conn with developer tools.

The agent panel drives the `claude` CLI on your PATH, with your own login. If `claude --version` answers in a terminal, the panel works. The README lists the other agents Conn supports and how to install them.

## Test your change

- **The renderer builds.** Run `npx vite build` after any change under `src/renderer`.
- **The checks still pass.** `scripts/` holds plain-node checks and repro scripts, named `*-check.*` and `*-repro.*`. Run the ones that cover the code you touched, for example `node scripts/tools-check.mjs`. A change to the browser tools should keep `node scripts/browser-cost-check.mjs` passing.
- **The app does what you claim.** `.claude/skills/verify/SKILL.md` explains `drive.mjs`, which boots a throwaway Conn and drives it with real mouse and key events. For a UI change, attach a screenshot or a short recording to the pull request.

For a bug fix, add a script under `scripts/` that fails before your fix and passes after it, in the style of the existing repros.

## Write the pull request

- Keep it focused on one change. Several small pull requests are easier to review than one large one.
- Title it in the Conventional Commits style, for example `fix(browser): stop a batch when the turn is interrupted`.
- In the description, say why the change exists, what it leaves out, and how you tested it.
- Keep comments in the code for reasons the code cannot show, and write them in plain sentences, like the code around them.

## Report a bug or ask for a feature

Open an issue. For a bug, include what you did, what you expected, what happened, your OS, and the Conn version. A screenshot helps.

## License

Conn is MIT licensed. By opening a pull request you agree that your contribution is licensed under the same terms (see `LICENSE`).
