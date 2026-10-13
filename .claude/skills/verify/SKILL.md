---
name: verify
description: Boot Conn, the Electron app that puts a terminal, an agent chat and a browser pane side by side, on a throwaway HOME and drive it with real mouse and key events, fake agent replies and permission cards, screenshots and video. Use it to prove any UI change in this repo, or whenever a task says to verify, screenshot or record Conn.
---

# Verify Conn

`drive.mjs` in this folder boots one Conn instance and drives it. Every instance gets its own HOME, user-data dir and debug ports, so any number can run at once. No real agent runs. You play the agent with `say`, `perm` and `invoke`, and you play the user with `click`, `key` and `type`.

All commands run from the repo root as `node .claude/skills/verify/drive.mjs <command>`.

This skill runs on Linux only. `stop`, `doctor` and `sessions` read `/proc` to find an instance's processes, and nothing here has been tried on macOS or Windows.

## Launch

You need two things first.

- `node_modules` in the checkout. In a git worktree whose `package-lock.json` matches the main checkout, run `ln -s <main checkout>/node_modules node_modules`. Otherwise run `npm ci`.
- A built renderer. Run `npx vite build`. Run it again after you edit anything under `src/renderer`.

Then boot.

```
node .claude/skills/verify/drive.mjs boot
```

It prints this when the window is up.

```
ready inspect=40637 cdp=39601 boot=4419ms
session /tmp/conn-verify-Qrbzw6
project /tmp/conn-verify-Qrbzw6/shop
```

A toast such as "Codex is out, Update, Later" can appear a few seconds after the window comes up, depending on which CLIs the machine has. It covers the top right of the window. Run `click Later` before any screenshot you keep as evidence.

Copy the `session` path. Every other command needs it as `--session <path>`. Shell variables do not survive between your tool calls, so type the path each time. Use only a session path that your own `boot` printed, or that `sessions` listed for your checkout. Any other folder belongs to another agent.

The instance has one open project, `shop`, a copy of `fixtures/shop` that is also a committed git repo. The window is 1440 by 900. Boot options:

- `--xvfb` runs the window on a hidden X display, so nothing appears on the person's screen. Rendering is in software, and screenshots look the same as from a normal boot. Use it when you run many instances.
- `--root <checkout>` boots a different checkout, such as a trunk worktree, with this same driver.

For a one-shot check, `node .claude/skills/verify/drive.mjs --smoke` boots, saves a screenshot of the empty chat, stops, and prints the `ready` line and `png <path>`.

## Doctor

```
node .claude/skills/verify/drive.mjs doctor --session <session>
```

It reads and changes nothing. It prints one `ok` or `FAIL` line per check and exits 1 if any fails. It checks that `build/renderer` exists and is newer than every file under `src/renderer`, then Electron, a display, `ffmpeg`, `sharp`, that the instance's processes are running, that both ports answer, and that the chat window and the agent stand-in are installed. Run it first when something looks off. Without `--session` it checks only what boot needs, and `--root <checkout>` checks another checkout.

## Drive

Pass the instance with `--session <session>` on each command below.

| Command | What it does |
| --- | --- |
| `say <text>` | Shows an assistant reply. Use `-` to read the text from stdin. `--stream <ms>` types it out in chunks, `--size <chars>` sets the chunk size, `--open` leaves the turn running. |
| `perm [tool]` | Announces a tool call and asks permission for it, like the agent does. The tool is `Edit`, `Write` or `Bash`. `--input <json>`, `--id <id>`, `--agent <json>` and `--bare` (no call row) adjust it. Prints the permission id. |
| `decided [id]` | With an id, prints the decision the app sent back (`allow`, `always` or `deny`) and exits 1 if there is none after 3 seconds. Without one, prints every decision. |
| `invoke <tool> [json]` | Calls one browser tool as the agent would. The second argument is one JSON object of the tool's arguments, and it is left out when the tool takes none. See Browser tools. `--actor <json>` acts as a subagent. |
| `click <target>` | A real mouse click. A bare name matches a visible button, link, tab or menu item by its text, `aria-label` or title. `css=<selector>` and `xy=<x>,<y>` also work. It waits up to 3 seconds for the target. |
| `drag <x0> <y0> <x1> <y1>` | A real mouse drag. It presses at the first point, moves to the second in 20 steps, and releases, all as mouse events. Use it on dividers, for example `drag 944 450 824 450` pulls the column divider 120 px left. Find a divider with `js "[...document.querySelectorAll('[role=separator]')].map((e) => JSON.stringify(e.getBoundingClientRect()))"`. |
| `key <chord>` | A real key press, such as `Ctrl+Shift+B`, `Enter`, `Escape` or `Alt+Down`. |
| `type <text>` | Types into the focused element. `--enter` presses Enter after. Use `-` to read from stdin. |
| `shot` | Saves a PNG of the whole window as a person sees it, with the browser pane's page drawn in at its real bounds, and prints its path. `--out <file>` names it and creates its folder, `--css <selector>` crops to one element, `--no-preview` leaves the pane's page out. |
| `bounds` | Prints the box the renderer last sent for the preview (`ipc`), the native preview's real box (`nativeView`), and the `#paneslot` rectangle (`paneslot`). `match` is true when `ipc` is within 1 px of `paneslot`, and `nativeViewMatch` says the same of `nativeView`. Exits 1 unless `match` is true. |
| `record` | Records the window, with the browser pane's page in it, for `--seconds <n>` (default 10) to `--out <file.mp4>`. `--no-preview` leaves the pane's page out. |
| `js <expression>` | Runs JavaScript in the page and prints the result. `--main` runs it in the main process, where `electron` and `req` are in scope. Use it for read-only checks. |
| `sessions` | Lists the instances this checkout's driver booted, with each one's path, start time, ports, and whether a process still runs. It needs no `--session`. |
| `stop` | Ends the instance. See Cleanup. |

`click`, `key`, `type`, `say` and `perm` return after the page has drawn two frames, so a `shot` right after one shows its result. When the result needs longer, such as the Changes list refreshing from git, poll the page with `js` until it appears, then shoot.

The first `say`, `perm` or `invoke` has no chat to talk to, so it types `Hello` into the composer and sends it, which starts one. Pass `--prompt <text>` to `say` to send something else. After that, these commands talk to the newest chat.

### Browser tools

`invoke` drives the page inside the browser pane. Each tool takes one JSON object. A `?` marks an argument you can leave out. These are the shapes in the `TOOLS` table in `src/main/tools.js`, and that table wins if the two disagree.

| Tool | Arguments | Does |
| --- | --- | --- |
| `navigate` | `{"url": "http://localhost:3000/"}` | Loads the URL. A bare port such as `"3000"` is expanded. |
| `snapshot` | `{"max"?: 2000}` | Prints an outline of the page. Each element has a handle such as `[ref=e3]`. |
| `click` | `{"target": "e3", "button"?, "clickCount"?, "modifiers"?}` | A real mouse click. The target is a ref from `snapshot`, written `e3`, or a CSS selector. |
| `fill` | `{"target": "e2", "value": "SAVE10"}` | Sets an input's value and fires `input` and `change`. |
| `type` | `{"text": "SAVE10", "target"?, "delay"?}` | Real keystrokes, into `target` when given. |
| `press` | `{"key": "Enter"}` | A key or chord, such as `ctrl+a`. |
| `waitFor` | `{"selector"?: "#message.ok", "ms"?, "networkIdle"?: true, "timeout"?: 3000}` | Waits for a selector, a delay, or a quiet network. |
| `text`, `html` | `{"max"?: 300}` | The visible text, or the raw HTML. |
| `evaluate` | `{"code": "document.title"}` | Runs JavaScript in the page inside the pane. `js` runs in Conn's own window instead. |
| `screenshot` | `{"fullPage"?, "target"?, "name"?}` | Saves a PNG of the page and returns its path. |
| `hover`, `scrollTo`, `highlight` | `{"target": "e3"}` | Acts on one element. |
| `select` | `{"target": "e4", "value": "red"}` | Picks an option in a `<select>`. |
| `scroll` | `{"dy"?: 400, "dx"?}` | Scrolls by pixels. |
| `back`, `forward`, `reload`, `state`, `devtools`, `clearViewport` | `{}` | Needs no arguments. |
| `setViewport` | `{"width": 390, "height": 844}` | Emulates a screen size. |
| `console` | `{"level"?, "limit"?}` | The page's console messages. |
| `network` | `{"limit"?}` | Failed requests since the last navigation. |
| `preview` | `{"open"?: true}` | Shows or hides the browser pane. |
| `tabs`, `tabNew`, `tabSelect`, `tabClose` | `{}`, `{"url"?}`, `{"tab": "<id from tabs>"}`, `{"tab"?}` | Lists, opens, drives and closes this chat's tabs. |

Run these against the shop page, with the URL the terminal printed.

```
node .claude/skills/verify/drive.mjs invoke --session <session> navigate '{"url":"http://localhost:44773/"}'
node .claude/skills/verify/drive.mjs invoke --session <session> snapshot
node .claude/skills/verify/drive.mjs invoke --session <session> fill '{"target":"e2","value":"SAVE10"}'
node .claude/skills/verify/drive.mjs invoke --session <session> click '{"target":"e3"}'
node .claude/skills/verify/drive.mjs invoke --session <session> waitFor '{"selector":"#message.ok","timeout":3000}'
node .claude/skills/verify/drive.mjs invoke --session <session> text
```

The snapshot lists `- textbox "Coupon code" [ref=e2]` and `- button "Apply" [ref=e3]`, and the last command prints the page with `SAVE10 applied: $4.00 off`. Refs are dropped when the page navigates. A stale ref prints an error that says to take a fresh snapshot, and `invoke` exits 1.

### Reaching things

`key` reaches chords the page handles itself.

| Chord | Opens |
| --- | --- |
| `Ctrl+Shift+B` | The browser pane |
| `Ctrl+Shift+T` | A new terminal tab, focused |
| ``Ctrl+` `` | The terminal pane |
| `Ctrl+Shift+G` | Changes, the uncommitted diff |
| `Ctrl+Shift+D` | The project files |
| `Ctrl+Shift+J` | The console and network drawer |
| `Ctrl+B` | The session rail |
| `Ctrl+K` | The command palette |
| `Ctrl+Shift+K` | The chat box, focused |

Chords the window menu owns, such as `Ctrl+,`, `Ctrl+O`, `Ctrl+Shift+F` and zoom, never reach the page, so `key` cannot press them. Click the menu or the toolbar button instead.

Changes lists only uncommitted edits. The project starts clean, so edit a file in the `project` folder first, for example change `<h1>Your cart</h1>` to `<h1>Your basket</h1>` in `index.html`. Then press `Ctrl+Shift+G`. The list takes up to about 2 seconds to fill from git, so wait for it before you shoot. The right column is `section#right`, and this `js` call polls it for 10 seconds and prints `true` once `index.html` is listed.

```
node .claude/skills/verify/drive.mjs js --session <session> "new Promise(async (done) => { for (let i = 0; i < 40; i++) { if (document.querySelector('section#right').innerText.includes('index.html')) return done(true); await new Promise((r) => setTimeout(r, 250)); } done(false); })"
```

### The shop fixture

`fixtures/shop` is a cart page with a coupon field (`#coupon`) and an Apply button (`#apply`). `SAVE10` takes $4.00 off a $40.00 total. Its `server.mjs` serves the page on a free port and prints `Local: http://localhost:<port>/`, the line Conn's terminal watches for to offer the page in the browser. To run it the way a person would:

```
node .claude/skills/verify/drive.mjs key --session <session> Ctrl+Shift+T
node .claude/skills/verify/drive.mjs type --session <session> "node server.mjs" --enter
node .claude/skills/verify/drive.mjs js --session <session> "document.querySelector('#terms .xterm-rows').innerText"
```

The terminal opens in the project folder, so the relative path works. The last command prints what the terminal shows, including the URL. Pass that URL to `invoke navigate`, then use the tools above.

### A reply and a permission, end to end

```
node .claude/skills/verify/drive.mjs say --session <session> $'Run it:\n\n```bash\necho hello\n```'
node .claude/skills/verify/drive.mjs perm --session <session> Edit --id p1
node .claude/skills/verify/drive.mjs click --session <session> Allow
node .claude/skills/verify/drive.mjs decided --session <session> p1
```

The reply draws a shell block with Copy and Run buttons. The last command prints `allow`. A permission that was answered draws an `allowed` mark on the row of its call.

## Evidence

A proof shows the action and the state it caused, not only the last screen. Follow these rules.

- Use the real path. Press the key, click the button. Do not set app state with `js` and call that a pass.
- Look at every PNG before you rely on it. Open it with the Read tool.
- Check side effects next to the pixels. `decided`, `bounds`, and the files in `project` say what the app did, and a screenshot may not.
- Save screenshots where your task says. `--out` creates any missing folders on the way. Without an instruction, `shot` writes to `/tmp/verify-evidence/`, which `stop` leaves alone. Name each file for the claim it proves.

Two things about pictures.

- The browser pane is a native view laid over the window, which a plain capture of the window leaves out. `shot` and `record` take the pane's page from the main process and lay it over the window at the pane's real bounds, using `sharp` from the checkout's `node_modules`, so one image or video shows the page above the terminal. Only the view the shell placed in the box counts, so a view the app borrows for a moment to screenshot a hidden tab is never drawn. They leave the page out when a person would not see it, which is when no pane is open, the shell has hidden it behind a menu (the shell paints its own still there), or it is parked off the window. Pass `--no-preview` to leave it out anyway. `invoke screenshot` returns the page alone and prints the PNG path.
- `record` blocks for the whole duration, so start it in the background and drive while it runs. Here `reply.txt` is any text file of about 1,500 characters, which at 250 ms per 40-character chunk streams for about 10 seconds.

```
node .claude/skills/verify/drive.mjs record --session <session> --seconds 10 --out /tmp/verify-evidence/run.mp4 &
node .claude/skills/verify/drive.mjs say --session <session> - --stream 250 < reply.txt
wait
```

The frames come from the page's screencast and are written to `ffmpeg` on a fixed clock, so the MP4 is as long as `--seconds`. While the browser pane is showing, `record` writes no frame until the first one with the pane's page in it is ready. If that takes longer than 15 seconds, or the recording's length when that is longer, it stops, deletes the partial file, exits 1 and names the cause. The same limit covers connecting to the window and starting the screencast, and `--bound <ms>` changes it. If `ffmpeg` dies, is killed or is missing, `record` exits 1 and prints no path. A busy machine can make a recording start a few seconds late. Check it with `ffprobe -v error -show_entries format=duration -of csv=p=0 run.mp4`. Pull a still from it with `ffmpeg -i run.mp4 -frames:v 1 first.png`.

## Cleanup

```
node .claude/skills/verify/drive.mjs stop --session <session>
```

It prints `stopped` and exits 0 when the instance is gone. If a process survives `SIGKILL` it exits 1 and names the process ids, and the session folder stays.

Run it when you finish and after every failed attempt. It ends every process that belongs to the instance and deletes the session folder, which holds the HOME, the user-data dir and the project copy. Screenshots and videos you saved elsewhere stay. For an instance booted with `--xvfb` it also removes the `xvfb-run.*` folder in the temp dir that the instance's own Xvfb names, which killing `xvfb-run` leaves behind.

`stop` works in two steps. It first signals the whole process group that `boot` started, `SIGTERM` and then `SIGKILL`, so Electron, its helpers and a terminal's jobs go together. It does that only while the group's leader has this session's `--user-data-dir` on its command line, so a hand-edited state file cannot aim the signal at another group. It then looks for stragglers and signals them by pid. The app launches provider agents into process groups of their own, and Codex starts a `git fetch` at startup that can outlive the app and keep a debug port bound, so a group kill alone misses them.

A process counts as a straggler only when the session's folders name it.

- `--user-data-dir=<session>/userdata` is on its command line, which marks Electron and its helpers.
- Its command line has a path under `<session>/home/`.
- It inherited `HOME=<session>/home`.
- Its working directory is inside the session.

`stop` refuses a session folder that is not a `conn-verify-*` folder directly under the temp dir, or whose state file names a home or user-data dir other than its own, or a pid that is not a real process id. It signals nothing and deletes nothing in that case. It never matches on a program name, and it never signals the shell or tool that ran `stop`, even when that shell stands in the project folder. Do not run `pkill` or `killall`, because the person who owns this machine runs Conn too.

If you lost the session path, run `node .claude/skills/verify/drive.mjs sessions`. It lists only the instances whose state file this checkout's driver wrote, so it never shows another checkout's lanes. If another agent shares your checkout, the start time tells your instances apart. Stop the ones you booted. Do not look for sessions in `ps` or under `/tmp`.

## Gotchas

- `perm` records the answer in the main process. Nothing runs the tool, so an allowed `Edit` does not change the file.
- `click` takes the first visible match, exact text before partial. If another element sits on top of the point, it prints a warning and the click lands on that element, as it would for a person.
- Boot turns off Chromium's throttling of covered and background windows, so instances that overlap on one screen still paint and tick.
- Ports come from the OS (`--inspect=0` and `--remote-debugging-port=0`). Read them from the `boot` output. They are in `<session>/session.json` as `inspect` and `cdp`, and the app's own log is `<session>/app.log`.
- The module exports the same commands, so a script can `import { boot, say, perm, invoke, click, key, type, shot, bounds, record, stop, sessions } from './drive.mjs'`. `boot()` returns the session object and every other function takes it first.
- When the checkout is a worktree, edits to `src/main` need a fresh `boot`. Edits to `src/renderer` need `npx vite build` and a fresh `boot`.
