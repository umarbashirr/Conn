# Conn agent chat experience plan

This program fixes the gaps a code audit and a live walkthrough found in Conn's agent chat on 2026-10-15.
It is for the developer who works in Conn all day. They stop losing the chat column, stop retyping prompts after a failure, get told when an agent needs them, can undo an agent's edits, and see the same reasoning, plans and diffs from every provider.
The rule the program enforces is that every change is proven on the running app at its own head, against trunk, before it joins the stack.
The PR ids in stack order are CUX-01, CUX-02, CUX-03, CUX-04, CUX-05, CUX-06, CUX-07, CUX-08, CUX-09, CUX-10, CUX-11, CUX-12, CUX-13, CUX-14, CUX-15, CUX-16, CUX-17, CUX-18, CUX-19, CUX-20, CUX-21, CUX-22.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. The operator, Umar, reviews and lands every PR. No owner merges. Every PR stops at merge-ready and is appended to one linear stack on `main`.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on their explicit go.
- [ ] On their go, write this exact text into the standing orders and restate it in your todolist. "Plan ~/.claude/orchestrate/conn-chat-ux/docs/plan.md. PRs CUX-01 to CUX-22 in stack order. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator merges every PR. Done when all 22 PRs sit verified in one linear stack on main and the operator has the stack links."
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `/home/xclore/Applications/conn/.claude/skills/verify/SKILL.md`
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/poteto-mode/playbooks/feature.md`
  - [ ] `skills/poteto-mode/playbooks/bug-fix.md`
  - [ ] `skills/show-me-your-work/SKILL.md`
- [ ] Build the perf probe before CUX-01 starts. Write `~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs`. It takes `--root <checkout>` and `--scenario <name>`, boots that checkout with the verify driver's exported `boot`, injects messages through `globalThis.__agent.emit`, prints one JSON line with the metric, and stops the instance. Scenarios are `replay400` (open a chat of 400 replayed items, milliseconds to the last painted row), `stream` (stream 1500 characters in 40 character chunks, p95 frame time and long-task count), `resize` (resize from 1440 to 800 and back with Changes open, milliseconds to a settled layout), `search` (query 50 fixture transcripts, milliseconds to results), and `notify` (blur the window, emit a result, milliseconds to the stubbed Notification call). Commit nothing. Prove it by running every scenario on trunk and saving the output to `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Arm the 30-minute audit tick as a real `/loop` in dynamic mode, which schedules its own wake-up rather than blocking on a sleep. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the standing objective. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Use `subagent_type` `pstack:poteto-agent`. CUX-04, CUX-06, CUX-14 and CUX-22 go to the strongest-judgment model. The rest use the feature model.
- [ ] Follow this dependency graph. The stack is linear in id order, so each owner bases its branch on the branch of the PR before it and rebases when the root restacks.
  - [ ] CUX-01 has no parent PR.
  - [ ] CUX-02 after CUX-01.
  - [ ] CUX-03 after CUX-02.
  - [ ] CUX-04 after CUX-03.
  - [ ] CUX-05 after CUX-04.
  - [ ] CUX-06 after CUX-04.
  - [ ] CUX-07 after CUX-06.
  - [ ] CUX-08 after CUX-07.
  - [ ] CUX-09 after CUX-08.
  - [ ] CUX-10 after CUX-09.
  - [ ] CUX-11 after CUX-10.
  - [ ] CUX-12 after CUX-11.
  - [ ] CUX-13 after CUX-12.
  - [ ] CUX-14 after CUX-13.
  - [ ] CUX-15 after CUX-14.
  - [ ] CUX-16 after CUX-15.
  - [ ] CUX-17 after CUX-16.
  - [ ] CUX-18 after CUX-17.
  - [ ] CUX-19 after CUX-18.
  - [ ] CUX-20 after CUX-19.
  - [ ] CUX-21 after CUX-20.
  - [ ] CUX-22 after CUX-21.
- [ ] Hold the file boundaries. Main-process provider files (`src/main/codex.js`, `src/main/codex-history.js`, `src/main/providers/*`) change only in CUX-02, CUX-05, CUX-12, CUX-14, CUX-15 and CUX-16. `src/main/agent.js` and `src/main/history.js` change only in CUX-04, CUX-05, CUX-06 and CUX-14. `src/renderer/ui/shell/*` changes only in CUX-01, CUX-18, CUX-19 and CUX-20.
- [ ] Hold the review gate. Every PR from CUX-01 to CUX-22 changes an interaction. Each waits for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`. Run every `gh` command as `umarbashirr` with a per-command `GH_TOKEN`, never `gh auth switch`.
- [ ] Open the PR ready, never draft, with `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's checks once before the PR-facing push. The repo has no lint or typecheck script. Run `npx vite build`, every `node scripts/*-check.mjs`, and the repro scripts the PR adds or touches. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Before babysit and the merge-ready report, record the base and head SHAs prepared by the topology owner under the execution playbook.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] Append on a clean verdict, never ship. Record the head SHA, base SHA, base branch and stable base-to-head patch-id. After a restack, an unchanged patch-id keeps the verdict only after checking it still applies, per `playbooks/shipping.md`. A changed patch-id gets a fresh swarm.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the skill at `/home/xclore/Applications/conn/.claude/skills/verify/SKILL.md` with the commands below.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Link dependencies with `ln -s /home/xclore/Applications/conn/node_modules node_modules` when `package-lock.json` matches the main checkout, otherwise run `npm ci`. Run `npx vite build`. Run `node .claude/skills/verify/drive.mjs boot --xvfb` and copy the printed session path. Run `click Later` before the first screenshot.
- [ ] Deliver input only through the driver's `say`, `perm`, `invoke`, `click`, `drag`, `key` and `type` commands. Provider events the driver lacks go through `js --main "globalThis.__agent.emit('message', ...)"`, or through the mock CLIs in `scripts/mock-codex-cli.js` and `scripts/mock-acp-cli.js`. Read-only diagnostics are `js`, `bounds`, `decided`, `doctor` and the instance's `app.log`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. Run `stop --session <session>` when the lane ends, after a failure too.

## Keep the chat and the right column on screen at every window width (CUX-01)

**Depends on.** None.

**Files.**

- [ ] Edit `src/renderer/ui/shell/Shell.jsx`.
- [ ] Edit `src/renderer/ui/shell/tabs-store.js`.
- [ ] Create `scripts/p1-pane-floors-repro.js`.

**Build.**

- [ ] Make the pane floors fit the 800 px window floor in `Shell.jsx`. Rail 160, chat 300, right column 300, plus two handles, leaves margin at 800.
- [ ] Add an `onLayoutChange` reconcile in `Shell.jsx` that calls `expand()` on any panel the library collapsed while the layout state says it is open, replacing the boolean-only `useCollapse` effect.
- [ ] Collapse the rail automatically when opening the right column would push the chat under its floor, and restore it when the window grows back.

**You see.**

- [ ] At 800 px with Changes open, the chat and the Changes column both have width, and a pending permission card is reachable.
- [ ] Widening from 800 to 1440 restores any pane that was squeezed, with no divider drag.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p1-pane-floors-repro.js` boots with the driver exports, sets the window to 800 by 900, opens Changes, asserts `#agent` and `#right` widths are each at least 290, widens to 1440 and asserts both grew. Run `node scripts/p1-pane-floors-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the 800 px plus Changes scenario at trunk and head. Trunk records the 0 px pane. Save `cux-01-regression.png`. Pass when trunk shows one pane at 0 px and head shows both panes at 290 px or more.
- [ ] Lane 2. Set 800 by 900, open Changes, then send `perm Edit --id p1` and click Allow. Save `cux-01-allow-at-800.png`. Pass when `decided p1` prints `allow`.
- [ ] Lane 3. Open the right column at 1440, then shrink to 800 with `js --main` setSize. Save `cux-01-shrink-open.png`. Pass when neither pane is under 290 px.
- [ ] Lane 4. Shrink to 800 with Changes open, then widen to 1440. Save `cux-01-regrow.png`. Pass when the chat is wider than 600 px and the rail is back.
- [ ] Lane 5. At 900 px open Changes. Save `cux-01-rail-autocollapse.png`. Pass when the rail collapses and the chat is at least 400 px wide.
- [ ] Lane 6. At 900 px open Changes, then close it. Save `cux-01-rail-restore.png`. Pass when the rail returns to its previous width.
- [ ] Lane 7. At 1024 px open the browser pane with Ctrl+Shift+B. Save `cux-01-browser-1024.png`. Pass when `bounds` exits 0 and the chat is at least 300 px.
- [ ] Lane 8. Collapse the rail with Ctrl+B at 1440, open Changes, shrink to 800, widen to 1440. Save `cux-01-rail-user-collapsed.png`. Pass when the rail stays collapsed because the user chose it.
- [ ] Lane 9. Drag the chat divider 200 px left at 1440 with `drag`. Save `cux-01-drag.png`. Pass when the drag stops at the chat floor and no pane reaches 0.
- [ ] Lane 10. Open the terminal with Ctrl+` at 800 px with Changes open. Save `cux-01-terminal-800.png`. Pass when the terminal and the chat both render text.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from a window resize between 1440 and 800 with Changes open to a settled layout, at trunk and head.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario resize` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `resize` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 5 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-01-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a window shrinking to 800 with Changes open and growing back in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-01-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## End open tool rows when a turn stops or finishes (CUX-02)

**Depends on.** CUX-01.

**Files.**

- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/main/providers/acp-session.js`.
- [ ] Edit `src/main/codex.js`.
- [ ] Create `scripts/p1-open-tools-end-repro.js`.

**Build.**

- [ ] In `interrupted()` and the `result` handler in `useAgent.js`, mark every main-thread tool row still at `input-streaming` or `input-available` as `output-error` with output `interrupted`, skipping background calls.
- [ ] In `AcpSession.interrupt()`, emit a cancelled tool result for every call that has no `completed` or `failed` update.
- [ ] In `codex.js` `#turnDone`, close command items that never got `item/completed`. First record whether Codex sends `item/completed` for in-flight commands on interrupt.

**You see.**

- [ ] After Stop, no tool row shimmers or counts, and each open call reads `interrupted`.
- [ ] The rail stops showing `Running` for that chat.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p1-open-tools-end-repro.js` emits a `tool_use` through `globalThis.__agent.emit`, clicks Stop, and asserts the row state is `output-error` and the rail text has no `Running`. A second case emits a `result` with an open row. Run `node scripts/p1-open-tools-end-repro.js`.
- [ ] Extend `scripts/p2-interrupt-permissions-repro.js` with an ACP case using `scripts/mock-acp-cli.js` that interrupts mid-call and asserts a cancelled result. Run `node scripts/p2-interrupt-permissions-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Emit a Bash `tool_use` with no result, click Stop, wait 5 s, at trunk and head. Save `cux-02-regression.png`. Pass when trunk shows a ticking timer and head shows `interrupted` with a frozen timer.
- [ ] Lane 2. Emit two tool calls, then a `result` with no tool results. Save `cux-02-result-closes.png`. Pass when both rows read `interrupted`.
- [ ] Lane 3. Run `perm Bash --id p1`, click Deny, then emit the CLI is_error tool result. Save `cux-02-deny-real-path.png`. Pass when the row reads `denied` and shows no timer.
- [ ] Lane 4. Start a subagent row with a background tool, click Stop. Save `cux-02-background-kept.png`. Pass when the background call keeps its own state.
- [ ] Lane 5. Run a mock ACP turn with an open `tool_call`, click Stop. Save `cux-02-acp-cancel.png`. Pass when the ACP row reads `interrupted`.
- [ ] Lane 6. Run a mock Codex turn with an open command, click Stop. Save `cux-02-codex-cancel.png`. Pass when the Codex row reads `interrupted` or the lane records Codex closed it itself.
- [ ] Lane 7. After Stop, read the rail entry for the chat. Save `cux-02-rail-clear.png`. Pass when the rail shows no `Running` text.
- [ ] Lane 8. After Stop, send a new prompt and emit a fresh tool call. Save `cux-02-next-turn.png`. Pass when the new row shimmers and the old row stays `interrupted`.
- [ ] Lane 9. Reload the window and reopen the stopped chat. Save `cux-02-replay.png`. Pass when the replayed rows show no running state.
- [ ] Lane 10. Stop while a permission card is waiting. Save `cux-02-perm-and-tool.png`. Pass when the card and the tool row both end.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds one pass over open tool rows per turn end.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 7 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-02-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a tool call stopped mid-run and the rail clearing in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-02-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Keep queued messages separate when a turn stops (CUX-03)

**Depends on.** CUX-02.

**Files.**

- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/renderer/ui/components/composer.jsx`.
- [ ] Edit `scripts/queue-repro.js`.

**Build.**

- [ ] Change `interrupt` in `useAgent.js` to keep `queued` and mark each entry `held: true` instead of returning joined text, so images survive.
- [ ] Change `stop` in `composer.jsx` to leave the draft alone, and give each held `QueuedItem` row a Send next action next to the existing edit and drop actions.

**You see.**

- [ ] After Stop, two queued messages stay as two numbered rows marked held, and the composer stays its normal height.
- [ ] The interrupted note stays visible above the composer.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Extend `scripts/queue-repro.js` with a case that queues two messages, one with an image, interrupts, and asserts two held entries with the image kept and an empty draft. Run `node scripts/queue-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `say --open`, queue two messages, click Stop, at trunk and head. Save `cux-03-regression.png`. Pass when trunk shows one joined draft and head shows two held rows.
- [ ] Lane 2. Queue a message with an attached image, then Stop. Save `cux-03-image-kept.png`. Pass when the held row shows the image thumbnail.
- [ ] Lane 3. After Stop, click Send next on the second held row. Save `cux-03-send-next.png`. Pass when a new turn starts with that text and the other row stays held.
- [ ] Lane 4. After Stop, drop one held row. Save `cux-03-drop.png`. Pass when one row remains.
- [ ] Lane 5. After Stop, edit a held row and send it. Save `cux-03-edit-held.png`. Pass when the sent user row has the edited text.
- [ ] Lane 6. Type a draft, queue one message, Stop. Save `cux-03-draft-kept.png`. Pass when the draft is unchanged and the held row is separate.
- [ ] Lane 7. After Stop, measure the interrupted note with `js` getBoundingClientRect against the composer top. Save `cux-03-note-visible.png`. Pass when the note bottom is above the composer top.
- [ ] Lane 8. Stop with nothing queued. Save `cux-03-empty-queue.png`. Pass when no held rows appear.
- [ ] Lane 9. Stop, then switch chats and back. Save `cux-03-switch.png`. Pass when the held rows are still there.
- [ ] Lane 10. Stop, then send a fresh prompt. Save `cux-03-fresh-send.png`. Pass when the fresh prompt sends and held rows stay held.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff changes only queue state.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 3 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-03-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of Stop with two queued messages and Send next in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-03-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Retry a turn and edit a past message (CUX-04)

**Depends on.** CUX-03.

**Files.**

- [ ] Edit `src/main/agent.js`.
- [ ] Edit `src/main/history.js`.
- [ ] Edit `src/main/index.js`.
- [ ] Edit `src/preload/index.js`.
- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Create `scripts/p1-rewind-fork-repro.js`.

**Build.**

- [ ] Give every user message Conn sends to the Claude SDK a `uuid` from `randomUUID()` in `agent.js` `#input`, and return it to the renderer as `forkAt` data on the user item.
- [ ] Keep `uuid` and `parentUuid` in `readSession` in `history.js`, and carry them onto replayed user items in `replay()`.
- [ ] Add an `agent:rewind` IPC in `index.js` that stops the idle session and calls the SDK `forkSession(sessionId, {dir, upToMessageId})`, returning the new session id.
- [ ] Mount `MessageActions` on user rows in `App.jsx` with Edit and Retry. Claude chats cut the items before that row, switch to the forked session and send. Codex and ACP chats resend as a new message, and the row says so.

**You see.**

- [ ] Hovering a past user message shows Edit and Retry.
- [ ] Editing an earlier Claude message and pressing Enter drops the later turns and answers from that point.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p1-rewind-fork-repro.js` forks a fixture `.jsonl` under a throwaway HOME at a known uuid and asserts the new file ends at that message. Run `node scripts/p1-rewind-fork-repro.js`.
- [ ] Run `node scripts/history-check.js` and `node scripts/session-store-check.js` and confirm they still pass with uuids kept.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Hover a past user message at trunk and head. Save `cux-04-regression.png`. Pass when trunk shows no actions and head shows Edit and Retry.
- [ ] Lane 2. Send two prompts, click Edit on the first, change the text, press Enter. Save `cux-04-edit-first.png`. Pass when the second turn is gone and the new user row has the edited text.
- [ ] Lane 3. Click Retry on the last user message. Save `cux-04-retry-last.png`. Pass when a new turn starts with the same text and the old answer is gone.
- [ ] Lane 4. Reload, reopen the chat from the rail, click Edit on the first message. Save `cux-04-edit-replayed.png`. Pass when the rewind uses the replayed uuid and the chat continues.
- [ ] Lane 5. In a Codex mock chat click Retry. Save `cux-04-codex-resend.png`. Pass when the message resends and the row is labelled as a resend.
- [ ] Lane 6. In an ACP mock chat click Edit. Save `cux-04-acp-resend.png`. Pass when the edited text sends as a new message with the resend label.
- [ ] Lane 7. Click Edit, then press Escape. Save `cux-04-edit-cancel.png`. Pass when the transcript is unchanged.
- [ ] Lane 8. Click Retry while a turn is running. Save `cux-04-retry-busy.png`. Pass when Retry is disabled while the turn runs.
- [ ] Lane 9. Send a prompt with an image, then Retry it. Save `cux-04-retry-image.png`. Pass when the image is sent again.
- [ ] Lane 10. Check `app.log` after an edit for SDK errors. Save `cux-04-log-clean.png`. Pass when the log has no `forkSession` or uuid error.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds an actions row per user message.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 4 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-04-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of editing an earlier message and the chat continuing from there in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-04-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Explain turn errors and offer Retry (CUX-05)

**Depends on.** CUX-04.

**Files.**

- [ ] Create `src/main/turn-error.js`.
- [ ] Edit `src/main/agent.js`.
- [ ] Edit `src/main/codex.js`.
- [ ] Edit `src/main/providers/acp-rpc.js`.
- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Create `scripts/turn-error-check.mjs`.

**Build.**

- [ ] Write a pure `classify` per provider in `turn-error.js` that returns `{kind, message, retryAt, action}` with kind `rate_limit`, `auth`, `network` or `unknown` and action `retry`, `wait` or `login`.
- [ ] Feed it from Claude `rate_limit_event`, `assistant.error` and `result.errors`, from Codex `ErrorNotification.codexErrorInfo`, and from the JSON-RPC `code` that `acp-rpc.js` now keeps.
- [ ] Store the result on the note in `useAgent.js`, and fix a `success` result with `is_error: true` reading as done.
- [ ] Render an error row in the note branch of `App.jsx` with Retry from CUX-04. A `wait` action counts down to `retryAt`.

**You see.**

- [ ] A rate limit mid-turn reads as a plain sentence with the reset time and a Retry button.
- [ ] An auth failure says to log in to that CLI.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/turn-error-check.mjs` feeds recorded Claude, Codex and ACP error shapes to `classify` and asserts kind, action and `retryAt`. Run `node scripts/turn-error-check.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Emit a `rate_limit_event` with status rejected, then an `error_during_execution` result, at trunk and head. Save `cux-05-regression.png`. Pass when trunk shows the raw subtype and head shows a sentence with the reset time.
- [ ] Lane 2. Emit `assistant.error` `authentication_failed`. Save `cux-05-auth.png`. Pass when the row says to log in and offers no countdown.
- [ ] Lane 3. Emit a `success` result with `is_error: true`. Save `cux-05-is-error.png`. Pass when the row is an error, not `done in`.
- [ ] Lane 4. Click Retry on a retry-action error. Save `cux-05-retry.png`. Pass when a new turn starts with the last prompt.
- [ ] Lane 5. Show a wait-action error with `retryAt` 10 s ahead. Save `cux-05-countdown.png`. Pass when Retry counts down and enables at zero.
- [ ] Lane 6. Run a mock Codex turn that sends `usageLimitExceeded`. Save `cux-05-codex-limit.png`. Pass when the row is a rate-limit error.
- [ ] Lane 7. Run a mock ACP turn that rejects with `auth_required`. Save `cux-05-acp-auth.png`. Pass when the row is an auth error.
- [ ] Lane 8. Emit an unknown error shape. Save `cux-05-unknown.png`. Pass when the row shows the provider message and Retry.
- [ ] Lane 9. Reload and reopen the chat. Save `cux-05-replay.png`. Pass when the error row still reads as an error.
- [ ] Lane 10. Read the error row in the light theme. Save `cux-05-light.png`. Pass when the text meets the theme error color and is readable.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds classification at turn end only.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 5 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-05-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a rate-limit error with its countdown and Retry in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-05-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Undo a turn's file edits in Claude chats (CUX-06)

**Depends on.** CUX-04.

**Files.**

- [ ] Edit `src/main/agent.js`.
- [ ] Edit `src/main/index.js`.
- [ ] Edit `src/preload/index.js`.
- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Create `scripts/p1-rewind-files-repro.js`.

**Build.**

- [ ] Turn on `enableFileCheckpointing` in the SDK options in `agent.js`. First prove it still applies with Conn's own `env`.
- [ ] Add `agent:rewind-files` in `index.js` taking the user uuid and `dryRun`. Start the resumed session first when the chat has no live process.
- [ ] Add Undo edits to the user-row actions in `App.jsx`. Run the dry run on hover. Hide the action when `filesChanged` is empty, otherwise show the file count.
- [ ] Confirm in a dialog that names the files, says later turns are undone too, and says the conversation text stays.

**You see.**

- [ ] Undo edits on a Claude turn restores the files and shows how many changed.
- [ ] A turn that only used shell commands shows no Undo edits action.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p1-rewind-files-repro.js` ports `docs/plans/conn-chat-ux/prototype/rewind.mjs` into the repro convention with Bash disallowed, asserting `{"a":"one","b":null}` after rewind. It skips with a printed reason when the CLI is not logged in. Run `node scripts/p1-rewind-files-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask a Claude chat to edit `index.html` with the Edit tool, then hover the user message, at trunk and head. Save `cux-06-regression.png`. Pass when trunk has no Undo edits and head shows it with a file count of 1.
- [ ] Lane 2. Click Undo edits and confirm. Save `cux-06-undo.png`. Pass when `index.html` on disk matches git HEAD.
- [ ] Lane 3. Undo the first of two editing turns. Save `cux-06-undo-earlier.png`. Pass when both turns' edits are gone and the dialog said so.
- [ ] Lane 4. Ask for an edit done only through Bash. Save `cux-06-shell-only.png`. Pass when no Undo edits action shows.
- [ ] Lane 5. Reload, reopen the chat, undo a turn. Save `cux-06-after-restart.png`. Pass when the files are restored.
- [ ] Lane 6. Cancel the confirm dialog. Save `cux-06-cancel.png`. Pass when no file changes.
- [ ] Lane 7. Undo, then send a new prompt. Save `cux-06-continue.png`. Pass when the turn runs and no second session process appears in `ps` for the session dir.
- [ ] Lane 8. Open a Codex chat and hover a user message. Save `cux-06-codex-none.png`. Pass when no Undo edits action shows.
- [ ] Lane 9. Undo in a chat whose project has uncommitted user edits outside the agent. Save `cux-06-user-edits.png`. Pass when files the agent did not touch keep the user's edits.
- [ ] Lane 10. Read `app.log` after an undo. Save `cux-06-log-clean.png`. Pass when no `ProcessTransport` error.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks the feature. The diff adds a dry-run call on hover and the rewind call. Measure milliseconds from hover to the action showing, and from confirm to files restored, plus `replay400` at trunk and head.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median. Time the hover and confirm with `js` performance marks in five head runs.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A hover-to-action time above 400 ms or a confirm-to-restored time above 1500 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 4 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-06-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of an agent edit undone from the user message in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-06-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Notify when a turn ends or needs permission while Conn is unfocused (CUX-07)

**Depends on.** CUX-06.

**Files.**

- [ ] Edit `src/main/index.js`.
- [ ] Edit `src/main/settings.js`.
- [ ] Edit `src/preload/index.js`.
- [ ] Edit `src/renderer/ui/components/settings-panel.jsx`.
- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Create `scripts/p1-notify-repro.js`.

**Build.**

- [ ] Add `notifications: { enabled: true }` to `DEFAULTS` in `settings.js` and a switch in `settings-panel.jsx`.
- [ ] In `index.js`, on a `result` for a turn longer than 5 s and on every permission, including the browser pane's `askBridge`, when `!win.isFocused()`, call `win.flashFrame(true)` and show an Electron `Notification`.
- [ ] Clicking the notification runs `showWindow()` and opens that chat. The window `focus` event turns `flashFrame` off.

**You see.**

- [ ] With Conn in the background, a finished long turn raises a system notification naming the chat.
- [ ] A waiting permission raises a notification that opens the chat on click.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p1-notify-repro.js` stubs `Notification` in main, blurs the window, emits a long result and a permission, and asserts two notifications and a `flashFrame(true)` call. Run `node scripts/p1-notify-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Blur the window with `js --main`, emit a 10 s turn result, at trunk and head. Save `cux-07-regression.png`. Pass when trunk records no notification and head records one.
- [ ] Lane 2. Blur, then `perm Bash`. Save `cux-07-perm.png`. Pass when one notification names the tool.
- [ ] Lane 3. Keep focus and emit a result. Save `cux-07-focused.png`. Pass when no notification.
- [ ] Lane 4. Blur, emit a 2 s turn result. Save `cux-07-short-turn.png`. Pass when no notification.
- [ ] Lane 5. Turn the setting off, blur, emit a result. Save `cux-07-setting-off.png`. Pass when no notification.
- [ ] Lane 6. Click the stubbed notification handler. Save `cux-07-click-opens.png`. Pass when the window shows and that chat is active.
- [ ] Lane 7. Blur, emit a browser-pane permission through `askBridge`. Save `cux-07-bridge-perm.png`. Pass when one notification.
- [ ] Lane 8. Focus the window after a flash. Save `cux-07-flash-off.png`. Pass when `flashFrame(false)` was called.
- [ ] Lane 9. Blur with two chats finishing. Save `cux-07-two-chats.png`. Pass when two notifications name each chat.
- [ ] Lane 10. Restart the app. Save `cux-07-setting-persists.png`. Pass when the setting keeps its value.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks the feature. Measure milliseconds from a `result` in main to the stubbed Notification call at head, plus `replay400` at trunk and head.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario notify` at trunk and at the head, five interleaved pairs, and take each side's median. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A result-to-notification time above 50 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 6 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-07-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a notification arriving while Conn is in the background and opening the chat in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-07-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Drive the chat from the keyboard (CUX-08)

**Depends on.** CUX-07.

**Files.**

- [ ] Edit `src/shared/keybindings.js`.
- [ ] Edit `src/renderer/ui/lib/keys.js`.
- [ ] Edit `src/renderer/ui/components/composer.jsx`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Create `scripts/p2-chat-keys-repro.js`.

**Build.**

- [ ] Give `stop` the default key Escape in `keybindings.js`, and add a window fallback when focus is on the body or in the transcript, skipped when `inTerminal()` is true.
- [ ] Add Up and Down prompt history in `composer.jsx` `onKeyDown`, drawn from the chat's own user items, only when the caret is on the first or last line.
- [ ] Focus the oldest undecided permission card's Allow button when a card arrives and focus is idle. Handle Y, A and N inside a card. Move focus to the next card or the composer after a decision.
- [ ] Add `CmdOrCtrl+Shift+A` to jump to the waiting permission, with `steal: true`.
- [ ] Show the Stop key in the Stop button tooltip.

**You see.**

- [ ] Escape stops a running turn from the composer.
- [ ] Two stacked permission cards can be answered with Y and N without the mouse.
- [ ] Up in an empty composer brings back the last prompt.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p2-chat-keys-repro.js` drives `key Escape` during `say --open`, two `perm` cards with `key y` and `key n`, and Up in the composer, asserting `decided`, focus and textarea values. Run `node scripts/p2-chat-keys-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `say --open`, press Escape in the composer, at trunk and head. Save `cux-08-regression.png`. Pass when trunk keeps running and head shows interrupted.
- [ ] Lane 2. Stack `perm Bash --id p1` and `perm Edit --id p2`, press y then n. Save `cux-08-perm-keys.png`. Pass when `decided p1` is allow and `decided p2` is deny.
- [ ] Lane 3. After a card arrives, read `document.activeElement`. Save `cux-08-perm-focus.png`. Pass when focus is on the card's Allow button.
- [ ] Lane 4. Press Ctrl+Shift+A from the terminal with a card waiting. Save `cux-08-jump.png`. Pass when focus moves to the card.
- [ ] Lane 5. Focus the terminal and press Escape during a turn. Save `cux-08-terminal-escape.png`. Pass when the turn keeps running and xterm received Escape.
- [ ] Lane 6. Send three prompts, press Up three times in an empty composer. Save `cux-08-history.png`. Pass when the composer shows the first prompt.
- [ ] Lane 7. Type two lines, put the caret on line 2, press Up. Save `cux-08-multiline.png`. Pass when the caret moves to line 1 and the text is unchanged.
- [ ] Lane 8. Open the mention menu with @ and press Up. Save `cux-08-mention-menu.png`. Pass when the menu selection moves and history does not load.
- [ ] Lane 9. Press Escape with a dialog open during a turn. Save `cux-08-dialog-escape.png`. Pass when the dialog closes and the turn keeps running.
- [ ] Lane 10. Hover the Stop button. Save `cux-08-stop-tooltip.png`. Pass when the tooltip shows Escape.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 frame time and long-task count while 1500 characters stream in 40 character chunks, at trunk and head. The diff adds key handlers only.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario stream` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `stream` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A head long-task count above trunk plus 2 also fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 6 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-08-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of answering two permissions and stopping a turn without the mouse in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-08-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Keep drafts across reloads (CUX-09)

**Depends on.** CUX-08.

**Files.**

- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Create `src/renderer/ui/lib/drafts.js`.
- [ ] Create `scripts/drafts-check.mjs`.

**Build.**

- [ ] Move drafts from `useState({})` in `App.jsx` into `drafts.js`, keyed by session id, or `new:` plus the project for an unsent chat.
- [ ] Persist to `localStorage` under `conn.drafts` with a debounced write, following `rail-store.js`. Drop the key on send and on chat delete.

**You see.**

- [ ] A half-typed message is still in the composer after the window reloads.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/drafts-check.mjs` asserts keying, debounce flush, delete on send and the migration from a new chat key to its session id. Run `node scripts/drafts-check.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Type a draft, reload with `js` location.reload, reopen the chat, at trunk and head. Save `cux-09-regression.png`. Pass when trunk shows an empty composer and head shows the draft.
- [ ] Lane 2. Type a draft, send it, reload. Save `cux-09-cleared-on-send.png`. Pass when the composer is empty.
- [ ] Lane 3. Type a draft in an unsent new chat, reload. Save `cux-09-new-chat.png`. Pass when the draft returns in a new chat for that project.
- [ ] Lane 4. Type drafts in two chats, reload, open each. Save `cux-09-two-chats.png`. Pass when each chat shows its own draft.
- [ ] Lane 5. Delete a chat with a draft, reload. Save `cux-09-deleted.png`. Pass when no orphan key stays in `conn.drafts`.
- [ ] Lane 6. Type a draft, start the first send, then reload. Save `cux-09-key-migration.png`. Pass when the draft key moved to the session id.
- [ ] Lane 7. Type quickly for 5 s and count `localStorage.setItem` calls with a `js` spy. Save `cux-09-debounce.png`. Pass when fewer than 20 writes.
- [ ] Lane 8. Type a draft and reload the window twice. Save `cux-09-double-reload.png`. Pass when the draft survives both reloads.
- [ ] Lane 9. Type a 10000 character draft, reload. Save `cux-09-large.png`. Pass when the full draft returns.
- [ ] Lane 10. Switch chats with a draft. Save `cux-09-switch.png`. Pass when the existing switch behavior is unchanged.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds a debounced storage write.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 4 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-09-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a draft surviving a reload in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-09-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Announce permissions and errors to screen readers (CUX-10)

**Depends on.** CUX-09.

**Files.**

- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `src/renderer/ui/components/ai-elements/conversation.jsx`.
- [ ] Edit `src/renderer/ui/components/ai-elements/message.jsx`.

**Build.**

- [ ] Set `aria-busy` on a message while it streams.
- [ ] Give permission cards `role="group"` and `aria-labelledby` pointing at the title.
- [ ] Give the error row from CUX-05 `role="alert"`.
- [ ] Add one visually hidden `aria-live="assertive"` region in `App.jsx` that announces `Permission needed` plus the tool when a card arrives.

**You see.**

- [ ] A screen reader hears that a permission is needed without reading the whole transcript.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add an a11y case to `scripts/p2-chat-keys-repro.js` that asserts the roles, `aria-busy` during streaming, and the live region text after `perm`. Run `node scripts/p2-chat-keys-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `perm Bash`, read the live region text with `js`, at trunk and head. Save `cux-10-regression.png`. Pass when trunk has no live region and head reads `Permission needed: Bash` in the region text.
- [ ] Lane 2. Read the permission card role and label. Save `cux-10-card-role.png`. Pass when role is group and the label resolves to the title.
- [ ] Lane 3. Stream a reply with `say --stream 250` and read `aria-busy` mid-stream and after. Save `cux-10-busy.png`. Pass when true mid-stream and absent after.
- [ ] Lane 4. Emit a rate-limit error. Save `cux-10-alert.png`. Pass when the error row has role alert.
- [ ] Lane 5. Stack two cards. Save `cux-10-two-cards.png`. Pass when the region announced both tools in order.
- [ ] Lane 6. Answer a card. Save `cux-10-region-clears.png`. Pass when the region text clears.
- [ ] Lane 7. Tab through a card. Save `cux-10-tab-order.png`. Pass when focus reaches Allow, Always and Deny in order.
- [ ] Lane 8. Read the transcript role. Save `cux-10-log-role.png`. Pass when the transcript is still role log.
- [ ] Lane 9. Check the hidden region is off screen. Save `cux-10-hidden.png`. Pass when its box is 1 by 1 px and clipped.
- [ ] Lane 10. Screenshot the chat with a card. Save `cux-10-visual.png`. Pass when nothing visible changed against trunk.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 frame time and long-task count while 1500 characters stream in 40 character chunks, at trunk and head. The diff adds attributes and one region.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario stream` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `stream` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A head long-task count above trunk plus 2 also fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 10 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a permission card arriving with the live region text shown in devtools in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Show failed tool output without the raw input (CUX-11)

**Depends on.** CUX-10.

**Files.**

- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `src/renderer/ui/components/tool-row.jsx`.

**Build.**

- [ ] In the generic tool branch of `App.jsx`, show the error text first and move the input JSON into a collapsed Input fold.
- [ ] Replace the silent 4000 character cut with a `N more characters` line and a Show all button.

**You see.**

- [ ] A failed command shows its error first, with the input tucked away.
- [ ] Long output says how much is hidden.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add a case to `scripts/tools-check.mjs` for the output cut helper that asserts the marker text and count. Run `node scripts/tools-check.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Emit a failed Bash call with an error result, at trunk and head. Save `cux-11-regression.png`. Pass when trunk shows input JSON first and head shows the error first with Input folded.
- [ ] Lane 2. Open the Input fold. Save `cux-11-input-fold.png`. Pass when the JSON shows.
- [ ] Lane 3. Emit 9000 characters of output. Save `cux-11-cut-marker.png`. Pass when the row says 5000 more characters.
- [ ] Lane 4. Click Show all. Save `cux-11-show-all.png`. Pass when all 9000 characters render.
- [ ] Lane 5. Emit a successful call with short output. Save `cux-11-success.png`. Pass when the row is unchanged from trunk.
- [ ] Lane 6. Emit a failed Edit call. Save `cux-11-failed-edit.png`. Pass when the error shows and the diff view is unaffected.
- [ ] Lane 7. Emit a failed call inside a folded tool strip. Save `cux-11-in-strip.png`. Pass when the strip shows the failure count and the row reads correctly when opened.
- [ ] Lane 8. Emit output exactly 4000 characters long. Save `cux-11-boundary.png`. Pass when no marker shows.
- [ ] Lane 9. Reload and reopen. Save `cux-11-replay.png`. Pass when the replayed failed row has the same layout.
- [ ] Lane 10. Read the row in the light theme. Save `cux-11-light.png`. Pass when the error text uses the error color.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff changes one tool branch.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 3 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a failed command row and Show all on long output in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-11-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Show Codex and ACP edits as diffs (CUX-12)

**Depends on.** CUX-11.

**Files.**

- [ ] Create `src/shared/unified-diff.js`.
- [ ] Edit `src/main/codex.js`.
- [ ] Edit `src/main/codex-history.js`.
- [ ] Edit `src/main/providers/acp-session.js`.
- [ ] Edit `src/renderer/ui/components/diff-view.jsx`.
- [ ] Edit `src/main/handover.js`.
- [ ] Edit `scripts/mock-acp-cli.js`.
- [ ] Edit `scripts/mock-codex-cli.js`.
- [ ] Create `scripts/unified-diff-check.mjs`.
- [ ] Create `scripts/p2-rich-events-repro.js`.

**Build.**

- [ ] Write a pure unified-diff-to-hunks parser in `src/shared/unified-diff.js`.
- [ ] Map Codex `FileUpdateChange` and ACP `{type:"diff", path, oldText, newText}` content into one input shape `{files:[{path, kind, movePath, hunks:[{before, after}]}]}` in main. Use one mapper for live and replay in Codex.
- [ ] Give `editHunks` in `diff-view.jsx` an `input.files` branch. Move `handover.js` from `changes` to `files`.
- [ ] Add `MOCK_ACP_RICH=1` to the ACP mock and `thread/start` plus `turn/start` handlers under an env flag to the Codex mock.

**You see.**

- [ ] A Codex or Cursor edit shows a red and green diff in the chat and on its permission card.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/unified-diff-check.mjs` parses add, delete, update and move diffs and asserts hunks. Run `node scripts/unified-diff-check.mjs`.
- [ ] `scripts/p2-rich-events-repro.js` runs `AcpSession` on the rich mock and asserts the normalized edit input. Run `node scripts/p2-rich-events-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a mock Codex edit turn at trunk and head. Save `cux-12-regression.png`. Pass when trunk shows JSON and head shows a diff.
- [ ] Lane 2. Run a mock ACP turn with diff content. Save `cux-12-acp-diff.png`. Pass when the row shows a diff.
- [ ] Lane 3. Show the ACP permission card for an edit. Save `cux-12-acp-perm.png`. Pass when the card shows the diff.
- [ ] Lane 4. Run a Codex add-file change. Save `cux-12-codex-add.png`. Pass when the row shows the file as added.
- [ ] Lane 5. Run a Codex delete change. Save `cux-12-codex-delete.png`. Pass when the row shows the file as deleted.
- [ ] Lane 6. Run a Codex move change. Save `cux-12-codex-move.png`. Pass when the row shows both paths.
- [ ] Lane 7. Reload and reopen the Codex chat. Save `cux-12-codex-replay.png`. Pass when the replayed row shows the same diff.
- [ ] Lane 8. Hand a Codex chat over to Claude. Save `cux-12-handover.png`. Pass when the handover text lists the changed files.
- [ ] Lane 9. Run a Claude Edit turn. Save `cux-12-claude-same.png`. Pass when the Claude diff is unchanged from trunk.
- [ ] Lane 10. Run a real Cursor, Grok or OpenCode edit if one is logged in. Save `cux-12-real-acp.png`. Pass when the lane records whether diff content arrived, observed or not observed.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds parsing at the main boundary.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 3 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-12-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a Codex edit and an ACP edit shown as diffs in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-12-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Summarize each turn's file changes (CUX-13)

**Depends on.** CUX-12.

**Files.**

- [ ] Edit `src/renderer/ui/lib/turns.js`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `scripts/turns-check.mjs`.

**Build.**

- [ ] Add a pure `turnEdits(items)` to `turns.js` that walks from a user item to the next and returns `[{path, added, removed}]` from `editHunks` and `hunkStats`.
- [ ] Render a footer under the turn end note in `App.jsx`, computed at render time so replayed chats get it too. Each path opens the diff.

**You see.**

- [ ] Each finished turn ends with the files it changed and their added and removed line counts.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add `turnEdits` cases to `scripts/turns-check.mjs` for two edits to one file, a Write, and a turn with none. Run `node scripts/turns-check.mjs`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a Claude turn with two Edit calls at trunk and head. Save `cux-13-regression.png`. Pass when trunk shows no summary and head lists the file with counts.
- [ ] Lane 2. Run a turn with no edits. Save `cux-13-none.png`. Pass when no footer shows.
- [ ] Lane 3. Run a turn editing three files. Save `cux-13-three-files.png`. Pass when three paths with counts.
- [ ] Lane 4. Click a path in the footer. Save `cux-13-open-diff.png`. Pass when the diff opens.
- [ ] Lane 5. Run a Codex mock edit turn. Save `cux-13-codex.png`. Pass when the footer lists the Codex file.
- [ ] Lane 6. Reload and reopen. Save `cux-13-replay.png`. Pass when the footer shows on the replayed turn.
- [ ] Lane 7. Run a Write that overwrites a file. Save `cux-13-write.png`. Pass when the counts match the hunk stats.
- [ ] Lane 8. Stop a turn after one edit. Save `cux-13-stopped.png`. Pass when the footer lists the one edit.
- [ ] Lane 9. Run a denied edit. Save `cux-13-denied.png`. Pass when the denied edit is not listed.
- [ ] Lane 10. Read the footer at 800 px. Save `cux-13-narrow.png`. Pass when paths truncate without overflow.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff computes the footer at render time.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 3 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-13-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a turn ending with its file summary and opening a diff in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-13-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Show the agent's reasoning for every provider (CUX-14)

**Depends on.** CUX-13.

**Files.**

- [ ] Edit `src/main/agent.js`.
- [ ] Edit `src/main/codex.js`.
- [ ] Edit `src/main/codex-history.js`.
- [ ] Edit `src/main/providers/acp-session.js`.
- [ ] Edit `src/main/providers/acp-history.js`.
- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `scripts/p2-rich-events-repro.js`.

**Build.**

- [ ] Record first whether the default Claude model streams thinking text without `thinking.display` set to `summarized`, and set it in `agent.js` if needed.
- [ ] Add the renderer item `{id, kind:"reasoning", parent, text, streaming, at, ms}` in `useAgent.js`, fed from `thinking` blocks and `thinking_delta`, and from history replay.
- [ ] Normalize Codex `item/reasoning/summaryTextDelta` and ACP `agent_thought_chunk` into the Claude stream shape in main, closing one block before the other opens.
- [ ] Render a reasoning row in `App.jsx` that streams open and folds to `Thought for Ns` when it ends.

**You see.**

- [ ] While an agent thinks, its reasoning streams in a muted row, which folds to a one-line summary when it ends.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add reasoning cases to `scripts/p2-rich-events-repro.js` for ACP thought chunks and Codex reasoning deltas, asserting block open and close order. Run `node scripts/p2-rich-events-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Emit Claude `thinking_delta` stream events at trunk and head. Save `cux-14-regression.png`. Pass when trunk shows only the Thinking shimmer and head shows the reasoning text.
- [ ] Lane 2. Let the thinking block end. Save `cux-14-fold.png`. Pass when the row folds to `Thought for` plus seconds.
- [ ] Lane 3. Click the folded row. Save `cux-14-unfold.png`. Pass when the full reasoning shows.
- [ ] Lane 4. Run a mock Codex turn with reasoning summary deltas. Save `cux-14-codex.png`. Pass when the reasoning row shows the summary.
- [ ] Lane 5. Run a mock ACP turn alternating thought and message chunks. Save `cux-14-acp-alternate.png`. Pass when thought and reply render in separate rows in order.
- [ ] Lane 6. Reload and reopen a Claude chat with thinking. Save `cux-14-replay.png`. Pass when the folded row is there.
- [ ] Lane 7. Stop mid-thinking. Save `cux-14-stopped.png`. Pass when the row stops streaming and folds.
- [ ] Lane 8. Run a real Claude turn if logged in. Save `cux-14-real-claude.png`. Pass when the lane records whether thinking text arrived, observed or not observed.
- [ ] Lane 9. Scroll up while reasoning streams. Save `cux-14-scroll.png`. Pass when the view does not jump.
- [ ] Lane 10. Read the row in light and dark themes. Save `cux-14-themes.png`. Pass when the text is muted and readable in both.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 frame time and long-task count while 1500 characters stream in 40 character chunks, at trunk and head. The diff adds a streamed row kind.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario stream` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `stream` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A head long-task count above trunk plus 2 also fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 5 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-14-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of reasoning streaming and folding in a Claude and an ACP chat in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-14-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Show the agent's plan as a checklist (CUX-15)

**Depends on.** CUX-14.

**Files.**

- [ ] Edit `src/main/codex.js`.
- [ ] Edit `src/main/providers/acp-session.js`.
- [ ] Edit `src/renderer/ui/useAgent.js`.
- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `src/renderer/ui/lib/tools.js`.
- [ ] Edit `src/main/handover.js`.
- [ ] Edit `scripts/p2-rich-events-repro.js`.

**Build.**

- [ ] Add the item `{id:"plan:"+turnUserId, kind:"plan", parent, entries:[{content, status, priority, activeForm}], explanation}` that each update replaces in place.
- [ ] Map Claude `TodoWrite` input, Codex `turn/plan/updated` and ACP `plan` updates into it. Codex `inProgress` becomes `in_progress`.
- [ ] Render a checklist row in `App.jsx`. Render ExitPlanMode and Codex `plan` items as full markdown instead of the 120 character clip in `tools.js`.
- [ ] Point `handover.js` at the plan item.

**You see.**

- [ ] The agent's plan shows as one checklist per turn that ticks off as it works.
- [ ] A proposed plan in plan mode shows in full.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add plan cases to `scripts/p2-rich-events-repro.js` for ACP and Codex updates, asserting the in-place replace. Run `node scripts/p2-rich-events-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Emit a Claude TodoWrite with three todos at trunk and head. Save `cux-15-regression.png`. Pass when trunk shows raw JSON and head shows a checklist.
- [ ] Lane 2. Emit a second TodoWrite marking one done. Save `cux-15-update.png`. Pass when one checklist shows with one item ticked.
- [ ] Lane 3. Run a mock ACP turn with two plan updates. Save `cux-15-acp.png`. Pass when one checklist with the latest state.
- [ ] Lane 4. Run a mock Codex turn with `turn/plan/updated`. Save `cux-15-codex.png`. Pass when one checklist with the latest state.
- [ ] Lane 5. Emit an ExitPlanMode with a 2000 character plan. Save `cux-15-exit-plan.png`. Pass when the full markdown shows.
- [ ] Lane 6. Reload and reopen the Claude chat. Save `cux-15-replay.png`. Pass when the checklist shows its last state.
- [ ] Lane 7. Hand the chat over to another CLI. Save `cux-15-handover.png`. Pass when the handover text includes the plan.
- [ ] Lane 8. Emit a plan with an in_progress item. Save `cux-15-in-progress.png`. Pass when that item shows its activeForm text.
- [ ] Lane 9. Read the checklist at 800 px. Save `cux-15-narrow.png`. Pass when items wrap without overflow.
- [ ] Lane 10. Emit a plan in a subagent. Save `cux-15-subagent.png`. Pass when the plan shows inside the subagent stream.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds one row kind.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 5 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-15-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a plan checklist ticking off during a turn in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-15-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Show context usage for Cursor, Grok and OpenCode (CUX-16)

**Depends on.** CUX-15.

**Files.**

- [ ] Edit `src/main/providers/acp-session.js`.
- [ ] Edit `src/main/providers/acp-history.js`.
- [ ] Edit `scripts/p2-rich-events-repro.js`.

**Build.**

- [ ] Map ACP `usage_update {used, size, cost}` to an empty assistant message carrying usage, following `codex.js`, and return it from `contextUsage()` instead of null.
- [ ] Map the optional PromptResponse `usage` when present, and keep it optional because the schema marks it unstable.

**You see.**

- [ ] The context meter fills for ACP chats the same way it does for Claude and Codex.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add a `usage_update` case to `scripts/p2-rich-events-repro.js` asserting `contextUsage()` returns used and size. Run `node scripts/p2-rich-events-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a mock ACP turn with `usage_update` at trunk and head. Save `cux-16-regression.png`. Pass when trunk shows no meter and head shows the meter at used over size.
- [ ] Lane 2. Emit a second `usage_update`. Save `cux-16-update.png`. Pass when the meter moves.
- [ ] Lane 3. Emit `usage_update` with cost. Save `cux-16-cost.png`. Pass when the cost shows where Claude shows it.
- [ ] Lane 4. Run a mock ACP turn without usage. Save `cux-16-absent.png`. Pass when no meter and no error.
- [ ] Lane 5. Reload and reopen the ACP chat. Save `cux-16-replay.png`. Pass when the meter shows the replayed value.
- [ ] Lane 6. Open the usage panel. Save `cux-16-panel.png`. Pass when the ACP chat appears with its numbers.
- [ ] Lane 7. Run a Claude chat. Save `cux-16-claude-same.png`. Pass when the Claude meter is unchanged.
- [ ] Lane 8. Run a Codex chat. Save `cux-16-codex-same.png`. Pass when the Codex meter is unchanged.
- [ ] Lane 9. Run a real Cursor, Grok or OpenCode turn if logged in. Save `cux-16-real-acp.png`. Pass when the lane records whether `usage_update` arrived, observed or not observed.
- [ ] Lane 10. Read the meter at 800 px. Save `cux-16-narrow.png`. Pass when the meter fits.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds mapping in main only.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 3 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-16-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the context meter filling in an ACP chat in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-16-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Copy a message and export a chat (CUX-17)

**Depends on.** CUX-16.

**Files.**

- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `src/main/index.js`.
- [ ] Edit `src/preload/index.js`.
- [ ] Edit `src/renderer/ui/shell/Palette.jsx`.
- [ ] Delete the unused `ConversationDownload` from `src/renderer/ui/components/ai-elements/conversation.jsx`.
- [ ] Create `scripts/p2-chat-export-repro.js`.

**Build.**

- [ ] Add `CopyButton` to the `MessageActions` row on user and assistant messages, hidden while streaming.
- [ ] Add a `chat:export` handler in `index.js` that reads the whole transcript from disk, writes Markdown, and saves through a dialog, following `canvas:save`.
- [ ] Put Export chat in the chat header and in the palette `COMMANDS`.

**You see.**

- [ ] Every message has a copy button.
- [ ] Export chat saves the full conversation as Markdown.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p2-chat-export-repro.js` exports a 600-message fixture transcript with the dialog stubbed and asserts the first and last messages are in the file. Run `node scripts/p2-chat-export-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Hover an assistant message at trunk and head. Save `cux-17-regression.png`. Pass when trunk shows no copy and head shows Copy.
- [ ] Lane 2. Click Copy on an assistant message and read the clipboard with `js --main`. Save `cux-17-copy-assistant.png`. Pass when the clipboard holds the message text.
- [ ] Lane 3. Click Copy on a user message. Save `cux-17-copy-user.png`. Pass when the clipboard holds the prompt.
- [ ] Lane 4. Hover a streaming message. Save `cux-17-streaming.png`. Pass when no Copy shows.
- [ ] Lane 5. Click Export chat in the header with the dialog stubbed. Save `cux-17-export.png`. Pass when the saved Markdown holds every turn.
- [ ] Lane 6. Export a reopened chat longer than 400 messages. Save `cux-17-export-long.png`. Pass when the first message is in the file.
- [ ] Lane 7. Run Export chat from the palette. Save `cux-17-palette.png`. Pass when the export runs.
- [ ] Lane 8. Cancel the save dialog. Save `cux-17-cancel.png`. Pass when no file is written.
- [ ] Lane 9. Export a Codex chat. Save `cux-17-codex.png`. Pass when the Markdown holds the Codex turns.
- [ ] Lane 10. Export a chat with tool calls. Save `cux-17-tools.png`. Pass when tool calls appear as short lines, not JSON.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds a copy button per message.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 5 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-17-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of copying a message and exporting a chat in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-17-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Search inside chat transcripts (CUX-18)

**Depends on.** CUX-17.

**Files.**

- [ ] Edit `src/main/index.js`.
- [ ] Edit `src/main/history.js`.
- [ ] Edit `src/main/codex-history.js`.
- [ ] Edit `src/preload/index.js`.
- [ ] Edit `src/renderer/ui/shell/Palette.jsx`.
- [ ] Create `scripts/p2-transcript-search-repro.js`.

**Build.**

- [ ] Add `agent:search` in main. Narrow Claude transcripts with `rg -l -i -F` per open project, fall back to streaming files in Node when `rg` is missing, then parse only matches and keep hits in human and assistant text.
- [ ] Search Codex through `thread/read`. Keep ACP chats title-only and say so in the results.
- [ ] Show a Chats mentioning group in the palette with a snippet, using the existing 80 ms debounce.

**You see.**

- [ ] Searching a word from inside a chat finds that chat with the matching line.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p2-transcript-search-repro.js` searches 50 fixture transcripts with and without `rg` on PATH and asserts hits, snippets and no tool-output-only matches. Run `node scripts/p2-transcript-search-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Search a word that is only in a transcript body at trunk and head. Save `cux-18-regression.png`. Pass when trunk says nothing matches and head lists the chat with a snippet.
- [ ] Lane 2. Search a chat title. Save `cux-18-title.png`. Pass when title matches still show first.
- [ ] Lane 3. Click a transcript result. Save `cux-18-open.png`. Pass when the chat opens.
- [ ] Lane 4. Search a word found only in tool output. Save `cux-18-tool-only.png`. Pass when no result.
- [ ] Lane 5. Search with `rg` removed from PATH. Save `cux-18-no-rg.png`. Pass when results still come back.
- [ ] Lane 6. Search a Codex chat body. Save `cux-18-codex.png`. Pass when the Codex chat is listed.
- [ ] Lane 7. Search an ACP chat body. Save `cux-18-acp.png`. Pass when the results say ACP chats match by title only.
- [ ] Lane 8. Type fast for 2 s. Save `cux-18-debounce.png`. Pass when at most one search runs per 80 ms pause.
- [ ] Lane 9. Search a word matching 40 chats. Save `cux-18-many.png`. Pass when results are capped and the palette stays responsive.
- [ ] Lane 10. Search mixed case. Save `cux-18-case.png`. Pass when matching is case-insensitive.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Trunk lacks body search. Measure milliseconds from query to results over 50 fixture transcripts at head, plus `replay400` at trunk and head.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario search` at trunk and at the head, five interleaved pairs, and take each side's median. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A search time above 500 ms on the fixture fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3 and 9 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-18-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of finding a chat by a word inside it in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-18-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Start a new chat in the current folder (CUX-19)

**Depends on.** CUX-18.

**Files.**

- [ ] Edit `src/renderer/ui/shell/Rail.jsx`.
- [ ] Edit `src/renderer/ui/app.js`.
- [ ] Create `scripts/p2-new-chat-repro.js`.

**Build.**

- [ ] Make the rail New chat button call `reset()` in the active chat's folder and focus the composer.
- [ ] Keep `NewChatDialog` for when no project is open and behind a New chat in action. Text matching no folder offers to start a chat with that text.

**You see.**

- [ ] New chat goes straight to an empty composer in the current folder.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p2-new-chat-repro.js` clicks New chat, types a prompt, presses Enter and asserts a chat started in `shop`. Run `node scripts/p2-new-chat-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Click New chat and type a prompt at trunk and head. Save `cux-19-regression.png`. Pass when trunk shows the folder picker and head starts a chat in shop.
- [ ] Lane 2. Read the composer folder chip after New chat. Save `cux-19-chip.png`. Pass when the chip says shop.
- [ ] Lane 3. Change the folder with the chip. Save `cux-19-chip-change.png`. Pass when the chat starts in the new folder.
- [ ] Lane 4. Close every project and click New chat. Save `cux-19-no-project.png`. Pass when the folder picker opens.
- [ ] Lane 5. Use New chat in. Save `cux-19-chat-in.png`. Pass when the picker opens.
- [ ] Lane 6. Type text matching no folder in the picker. Save `cux-19-picker-text.png`. Pass when the picker offers to start a chat with the text.
- [ ] Lane 7. Use the per-folder plus in the rail. Save `cux-19-folder-plus.png`. Pass when behavior is unchanged.
- [ ] Lane 8. Click New chat while a turn runs in another chat. Save `cux-19-busy-other.png`. Pass when the running chat keeps running.
- [ ] Lane 9. Press the newChat command from the palette. Save `cux-19-palette.png`. Pass when it matches the button.
- [ ] Lane 10. Check focus after New chat. Save `cux-19-focus.png`. Pass when the composer has focus.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff changes one click path.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 4 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-19-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of New chat going straight to the composer in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-19-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Widen the chat column and enlarge the toolbar buttons (CUX-20)

**Depends on.** CUX-19.

**Files.**

- [ ] Edit `src/renderer/ui/App.jsx`.
- [ ] Edit `src/renderer/ui/components/composer.jsx`.
- [ ] Edit `src/renderer/ui/components/ai-elements/message.jsx`.
- [ ] Edit `src/renderer/ui/shell/Toolbar.jsx`.
- [ ] Edit `src/renderer/ui/shell/TitleBar.jsx`.

**Build.**

- [ ] Replace `max-w-3xl`, which is 624 px under the 13 px root, with a px cap such as `max-w-[min(100%,880px)]` on the transcript and the composer.
- [ ] Change `ICON_BUTTON` in `Toolbar.jsx` and the matching title bar buttons to about 28 px buttons with 16 px glyphs.

**You see.**

- [ ] At 1440 the chat column uses about 880 px and code blocks stop scrolling sideways for ordinary lines.
- [ ] Toolbar icons are large enough to hit and read.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add width assertions to `scripts/p1-pane-floors-repro.js` for the transcript at 1440 and 900. Run `node scripts/p1-pane-floors-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Measure the transcript width at 1440 at trunk and head. Save `cux-20-regression.png`. Pass when trunk is near 570 px and head is near 880 px.
- [ ] Lane 2. Stream a reply with a 100 character code line. Save `cux-20-code-width.png`. Pass when the code block has no horizontal scrollbar.
- [ ] Lane 3. Measure toolbar button boxes with `js`. Save `cux-20-toolbar.png`. Pass when each is at least 26 px.
- [ ] Lane 4. Read the toolbar at 800 px. Save `cux-20-toolbar-narrow.png`. Pass when no icons overlap or clip.
- [ ] Lane 5. Measure the transcript at 900 with Changes open. Save `cux-20-narrow.png`. Pass when it fills the chat panel without overflow.
- [ ] Lane 6. Read user bubbles at 1440. Save `cux-20-bubbles.png`. Pass when bubbles keep their right alignment and max width.
- [ ] Lane 7. Read the composer at 1440. Save `cux-20-composer.png`. Pass when it matches the transcript width.
- [ ] Lane 8. Read a table reply. Save `cux-20-table.png`. Pass when the table fits.
- [ ] Lane 9. Read the title bar window buttons. Save `cux-20-titlebar.png`. Pass when they match the new size and still work.
- [ ] Lane 10. Switch to the light and glass themes. Save `cux-20-themes.png`. Pass when layout is the same.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff changes widths only.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2 and 3 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-20-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the wider chat column and the larger toolbar in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-20-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Label the jump-to-latest button while text streams (CUX-21)

**Depends on.** CUX-20.

**Files.**

- [ ] Edit `src/renderer/ui/components/working-panel.jsx`.
- [ ] Edit `src/renderer/ui/components/ai-elements/conversation.jsx`.

**Build.**

- [ ] When the user has scrolled up and new content arrives, turn the arrow into a labelled pill reading New messages, placed clear of code block scrollbars.

**You see.**

- [ ] Scrolling up during a reply shows a New messages pill that jumps to the end.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Add a case to `scripts/p2-chat-keys-repro.js` that streams, scrolls up, and asserts the pill text and that clicking it reaches the bottom. Run `node scripts/p2-chat-keys-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Stream a reply and scroll up at trunk and head. Save `cux-21-regression.png`. Pass when trunk shows a bare arrow and head shows the New messages pill.
- [ ] Lane 2. Click the pill. Save `cux-21-jump.png`. Pass when the view reaches the bottom and the pill hides.
- [ ] Lane 3. Scroll up with no new content. Save `cux-21-idle.png`. Pass when the plain arrow shows, without the label.
- [ ] Lane 4. Scroll up over a code block during streaming. Save `cux-21-over-code.png`. Pass when the pill does not overlap the code scrollbar.
- [ ] Lane 5. Scroll back down by hand. Save `cux-21-manual.png`. Pass when the pill hides.
- [ ] Lane 6. Stream with the view at the bottom. Save `cux-21-pinned.png`. Pass when no pill shows.
- [ ] Lane 7. Tab to the pill and press Enter. Save `cux-21-keyboard.png`. Pass when it jumps.
- [ ] Lane 8. Read the pill at 800 px. Save `cux-21-narrow.png`. Pass when it fits.
- [ ] Lane 9. Read the pill in light and glass themes. Save `cux-21-themes.png`. Pass when it is readable.
- [ ] Lane 10. Stream in a subagent sheet and scroll up. Save `cux-21-subagent.png`. Pass when the sheet shows the same pill.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. p95 frame time and long-task count while 1500 characters stream in 40 character chunks, at trunk and head. The diff adds one state flag.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario stream` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `stream` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails. A head long-task count above trunk plus 2 also fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 2 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-21-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the New messages pill during a streamed reply in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-21-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Manage always-allow permission rules (CUX-22)

**Depends on.** CUX-21.

**Files.**

- [ ] Edit `src/main/agent.js`.
- [ ] Edit `src/main/index.js`.
- [ ] Edit `src/preload/index.js`.
- [ ] Edit `src/renderer/ui/components/settings-panel.jsx`.
- [ ] Create `scripts/p2-permission-rules-repro.js`.

**Build.**

- [ ] Find where Always writes rules for Claude, Codex and ACP, and whether the SDK exposes a read and write path. Write the finding to the trail. If there is none, park the PR with that finding.
- [ ] List the rules per project in `settings-panel.jsx` with a remove action that writes back through the same path.

**You see.**

- [ ] Settings lists every always-allow rule per project, and removing one makes the agent ask again.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/p2-permission-rules-repro.js` adds a rule through Always, reads it through the new IPC, removes it, and asserts the next call asks again. Run `node scripts/p2-permission-rules-repro.js`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Click Always on a Bash permission, then open Settings, at trunk and head. Save `cux-22-regression.png`. Pass when trunk lists no rules and head lists the Bash rule.
- [ ] Lane 2. Remove the rule and run the same command. Save `cux-22-remove.png`. Pass when a permission card appears.
- [ ] Lane 3. Add rules in two projects. Save `cux-22-per-project.png`. Pass when each project lists its own rule.
- [ ] Lane 4. Restart the app. Save `cux-22-persist.png`. Pass when the rules list is the same.
- [ ] Lane 5. Add an Edit rule. Save `cux-22-edit-rule.png`. Pass when it is listed with its pattern.
- [ ] Lane 6. Open Settings with no rules. Save `cux-22-empty.png`. Pass when an empty state shows.
- [ ] Lane 7. Add a rule in a Codex chat. Save `cux-22-codex.png`. Pass when the rule shows or the lane records Codex keeps none.
- [ ] Lane 8. Add a rule in an ACP chat. Save `cux-22-acp.png`. Pass when the rule shows or the lane records ACP keeps none.
- [ ] Lane 9. Remove a rule while a turn runs. Save `cux-22-busy.png`. Pass when the running turn is unaffected.
- [ ] Lane 10. Read the list at 800 px. Save `cux-22-narrow.png`. Pass when it fits.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Milliseconds from opening a 400-item replayed chat to its last painted row, at trunk and head. The diff adds a settings view only.
- [ ] Probe. Run `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario replay400` at trunk and at the head, five interleaved pairs, and take each side's median.
- [ ] Baseline. Record the trunk `replay400` median first, then compare it with the value in `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
- [ ] Rule. A head median above the trunk median times 1.10 plus 5 ms fails.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1 and 2 screenshots into `~/.claude/orchestrate/conn-chat-ux/media/cux-22-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of adding and removing an always-allow rule in a lane worktree with `node .claude/skills/verify/drive.mjs record --session <session> --seconds 45 --out ~/.claude/orchestrate/conn-chat-ux/media/cux-22-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends the PR to the base-branch stack, and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names, which is links to the stack root and tip, a one-line verdict summary per PR, and anything parked or excluded with the reason.

## Appendix A. Prototype evidence

**File checkpoints rewind Claude's edits.** The throwaway script is `docs/plans/conn-chat-ux/prototype/rewind.mjs`, run as `node rewind.mjs live|resume [nobash]` against the SDK in this checkout. It was not committed and has no branch or SHA. With Bash disallowed, a live session rewound to the turn-2 user message took the files from `{"a":"two","b":"x"}` to `{"a":"one","b":null}`. The dry run listed both files with one insertion and two deletions and changed nothing. A resumed session with no new turn rewound the same way, and a second rewind to the turn-1 message removed both files. Backups live in `~/.claude/file-history/<session>/`, so they survive an app restart. A made-up id returned `{"canRewind":false,"error":"No file checkpoint found for this message."}`. After the query ended, `rewindFiles` threw `ProcessTransport is not ready for writing`.

**Shell edits are not checkpointed.** When haiku wrote the files with Bash, every checkpoint had empty `trackedFileBackups`. The dry run returned `{"canRewind":true,"filesChanged":[]}` and the real rewind changed nothing while reporting success. CUX-06 therefore drives its button from the dry run and says when nothing is tracked.

**The chat column collapse is a pane-floor overflow.** A live repro at 800 px with Changes open showed the floors summing to 802 px. The rail floor is 180, the chat floor 300, the right floor 320, plus two 1 px handles. The library collapsed one pane, and `useCollapse` in `src/renderer/ui/shell/Shell.jsx` never expanded it again after the window grew to 1440.

**Denied and interrupted Claude calls already end their rows.** The walkthrough's ticking timers came from the verify driver, whose `perm` sends no tool result. The bundled CLI sends an `is_error` tool result on deny and on abort. Two real gaps remain. ACP sessions never close calls after `session/cancel`, and the renderer's `interrupted()` and `result` handlers leave `input-available` tool rows open.

**Still unproven.** Whether the current default Claude model streams thinking text without `display:'summarized'`. Whether Cursor, Grok and OpenCode send `agent_thought_chunk`, `plan`, diff content or `usage_update`, which the ACP schema allows. Whether Codex sends `item/completed` for commands in flight on interrupt. Whether checkpointing still turns on when Conn passes its own `env` to the SDK. Where Claude persists "always allow" rules at runtime. Each of these is the first build box of the PR that depends on it.

## Appendix B. Alternatives rejected

**Adopting shadcn Trace for the transcript.** Conn already has the rows Trace offers. The gaps are provider data that never reaches the renderer, which Trace does not fix. The operator dropped it on 2026-10-15.

**Fork-based retry for Codex in the first pass.** Codex `thread/fork` and `thread/revert` exist, but Conn does not record turn ids per item. CUX-04 resends as a new message for Codex and ACP and labels it. Codex fork can follow once turn ids are kept.

**A renderer-side search index.** Building it means reading 537M of Claude transcripts on this machine, and it goes stale every turn. CUX-18 uses a main-process `rg -l` narrow, measured at 0.30s warm over 166 files, then parses only the matching files.

**Joining queued messages into the draft on Stop.** This is today's behavior. It loses queued images and hides the interrupted note. CUX-03 keeps queued entries as held, editable rows.

**Exporting from renderer state.** A reopened chat holds only its last 400 messages, so the export would silently drop the start of long chats. CUX-17 exports from the transcript on disk in main.

**Persisting drafts by chat key.** The chat key is a fresh `uid('c')` per page load. CUX-09 keys drafts by session id, or by `new:` plus the project for an unsent chat.

## Appendix C. Risks

**CUX-01.** Changing pane floors moves every layout. The owner watches the 800, 900, 1024 and 1440 widths with each right-pane view open, and the rail collapsed and expanded.

**CUX-04 and CUX-06.** Both add a `uuid` to every user message Conn sends to the SDK. A malformed uuid breaks sends for every Claude chat. The owner proves a send, a resume and a replay before anything else.

**CUX-06.** Rewind needs a live session process. A reopened chat must start its resumed session first, and the owner watches for a second process racing the next send. Undoing a turn also undoes every later turn and leaves the conversation text in place. The confirm dialog must say both.

**CUX-07.** A notification on every result would be noise. Notify only when the window is unfocused, and only for a turn longer than a few seconds or for a permission. The settings toggle defaults on.

**CUX-08.** Escape is the terminal's key. The window fallback must skip when `inTerminal()` is true, and the owner proves Escape still reaches xterm.

**CUX-12, CUX-14, CUX-15 and CUX-16.** Real Cursor, Grok and OpenCode builds may send none of the new ACP events. The mock CLI proves the mapping. A real-agent run is recorded as observed or not observed, never assumed.

**CUX-19.** This reverses a deliberate choice documented in `src/renderer/ui/shell/Rail.jsx`, where "the folder is the question". The operator approves the new default in the review gate.

**CUX-22.** Where Claude stores "always allow" rules is unknown. If the SDK exposes no read and write path for them, the owner stops at a written finding and the PR is parked, not faked.

**Stack length.** Twenty-two stacked PRs restack often. Main-process provider files are shared by six PRs, so the root restacks bottom-up after each landing and re-verifies any PR whose patch-id changed.

## Appendix D. Links and reading list

Read before editing. `/home/xclore/Applications/conn/.claude/skills/verify/SKILL.md` for the driver. `src/renderer/ui/useAgent.js` for the item model, kinds `user`, `assistant`, `tool`, `perm`, `agent` and `note`. `src/renderer/ui/App.jsx` from the `Item` switch to the note branch. `src/main/agent.js`, `src/main/codex.js` and `src/main/providers/acp-session.js` for the three provider boundaries. `scripts/turns-check.mjs` and `scripts/p1-rail-activity-repro.js` for the check and repro conventions. `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for `rewindFiles`, `forkSession`, `rate_limit_event` and `thinking`. The Codex protocol types come from `codex app-server generate-ts --out /tmp/codex-schema`.

CUX-04, CUX-06, CUX-12 and CUX-14 get `skills/how/SKILL.md` before the build and `skills/interrogate/SKILL.md` before review. The rest get `skills/how/SKILL.md` only if the owner's first read finds the code differs from this plan.

Each owner keeps a `decisions.tsv` trail per `skills/show-me-your-work/SKILL.md`, uncommitted, returned with its report. The root keeps its own trail in `~/.claude/orchestrate/conn-chat-ux/trail/`.
