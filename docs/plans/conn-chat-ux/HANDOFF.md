# Conn chat UX: handoff

Work stopped on 2026-10-15 at the operator's request. This note says where each piece stands so the work can continue from Cursor or by hand.

`plan.md` in this folder is the full plan for 22 PRs, CUX-01 to CUX-22. The operator later cut the scope to CUX-01, CUX-02 and CUX-03. CUX-04 to CUX-22 were never started.

## State of each PR

All three PRs target `main` and are still open. None has a clean verification yet. None is merged.

| PR | Branch | Local worktree | Pushed head | Local head |
|---|---|---|---|---|
| CUX-01 [#17](https://github.com/umarbashirr/Conn/pull/17) | `cux/cux-01-pane-floors` | `.claude/worktrees/cux-01` | `0171b54` | `0171b54` |
| CUX-02 [#16](https://github.com/umarbashirr/Conn/pull/16) | `cux/cux-02-end-open-tools` | `.claude/worktrees/cux-02` | `c3edbcd` | `b81dbee`, not pushed |
| CUX-03 [#18](https://github.com/umarbashirr/Conn/pull/18) | `cux/cux-03-held-queue` | `.claude/worktrees/cux-03` | `9df6ddc` | `9df6ddc` |

The worktrees live under `.claude/worktrees/`, so `git worktree list` shows them. Each has a `node_modules` symlink to the main checkout.

### CUX-01. Keep the chat and the right column on screen at every window width

**What it does.** The pane floors now fit the 800 px window. A collapsed pane expands again when the layout says it is open. The rail steps aside when the window is under 1022 px and the right column opens. The changes are in `src/renderer/ui/shell/Shell.jsx` and `src/renderer/ui/shell/layout-store.js`. The repro is `scripts/p1-pane-floors-repro.js`.

**Verified.** All ten live lanes passed. The gates passed. The repro fails 4 checks on trunk and passes 12 of 12 at head. Review screenshots and a video are in `media/`.

**Not verified.** The perf lane was stopped before it finished. The owner's own perf runs were inconclusive under heavy machine load.

**To do before merge.**

1. Update the PR body. It still names `follow`, `narrow` and `fitRail`. The code now calls them `holdPanelsToStore`, `tooNarrowForRail` and `yieldRailToColumn`. The body also says the content floor is chat plus column, but the code adds the handle, which makes 601.
2. Restore two comments the cleanup removed. One explains why `'railOpen' in partial` ends the rail's step-aside even when the value is unchanged, which matters for Customize. The other explains the `groupsRegistered` gate, because `isCollapsed` throws "Group not found" while the panel groups register. They belong at `layout-store.js` lines 35 to 41 and `Shell.jsx` line 259.
3. Check app zoom live. At zoom 1.5 or higher and 800 px, the content is about 533 CSS px, under the 601 floor. Expanding one pane may collapse the other, and the layout handler may then swap them back and forth. This blocks only if it loops.
4. Optional. After the window grows back from 800 px, the rail returns at 288 px instead of its earlier 259 px. The chat ends at 609 px, which passes lane 4 by 9 px.
5. Run the perf check from `probe/`, described below.

**Known gaps, judged not blocking.** If Customize opens while the rail has stepped aside, the rail does not come back when the window grows. Ctrl+B brings it back, and the fix belongs in `enterFullPage` in `src/renderer/ui/app.js`. Dragging a divider past the right column's or the rail's floor makes the pane jump back to its old split instead of stopping at the floor. With the right column closed, `section#right` measures 1 px, which is its border.

### CUX-02. End open tool rows when a turn stops or finishes

**What it does.** After Stop, or after a turn's result, any tool row still open shows `interrupted` and stops its clock. Background work is left alone. ACP sessions cancel open calls on interrupt. Codex sessions close open items when the turn ends, because Codex 0.158 sends no `item/completed` for a command it interrupts. That was observed against the real CLI. The changes are in `src/renderer/ui/useAgent.js`, `src/main/providers/acp-session.js` and `src/main/codex.js`. The repros are `scripts/p1-open-tools-end-repro.js` and new cases in `scripts/p2-interrupt-permissions-repro.js`.

**Verified at the pushed head `c3edbcd`.** All ten live lanes passed, the gates passed, and perf passed (head 1343.7 ms against trunk 1292.9 ms for a 400-item chat). The audit found issues, so the verdict was ISSUES.

**Findings sent to the owner, and where the local work stands.**

1. The repro's `background-command-keeps-its-state` case passed with or without the background skip in `useAgent.js`. The local head adds cases to `p1-open-tools-end-repro.js`. Confirm that the new case fails when the skip is deleted.
2. The rail checks `rail-not-running-after-stop` and `rail-not-running-after-result` also pass on trunk. The PR body must not claim they prove the fix. Not done.
3. The PR body's Blast Radius claims more than the repro checks. Rewrite it. Not done.
4. The header comment in `scripts/mock-codex-cli.js` was stale. Done locally. Commit `ed5e5a2` replaced `c3edbcd`, so the local branch has diverged from the remote.
5. A running foreground subagent row (`kind: 'agent'`) kept shimmering after Stop, and the "Working" chip and the rail's agent count stayed up. Trunk behaves the same. The local head has a failing repro (`e30db0a`) and a fix (`b81dbee`). The owner was stopped right after writing the fix and never ran its checks, so treat it as untested.

**To do before merge.** Run `node scripts/p1-open-tools-end-repro.js` and `node scripts/p2-interrupt-permissions-repro.js` in the worktree. Re-run live lanes 1, 4 and 7. Fix the PR body. Push with `git push --force-with-lease=refs/heads/cux/cux-02-end-open-tools:c3edbcdd1f2b8be2af42b24a5c53b2865ebf94e1 origin cux/cux-02-end-open-tools`, because the branch history was rewritten. Then verify the new head again.

**Review note.** When a turn finishes normally with a call still open, that call shows a red `interrupted` error. The plan asks for this, but it may look too alarming.

### CUX-03. Keep queued messages separate when a turn stops

**What it does.** Stop no longer joins queued messages into the draft. Each one stays as a held row that can be sent next, edited or dropped, and images are kept. The changes are in `src/renderer/ui/useAgent.js` and `src/renderer/ui/components/composer.jsx`. The repro is in `scripts/queue-repro.js`.

**State.** The failing repro (`d55f07f`) comes before the fix (`9df6ddc`), and both are pushed. The owner was stopped before it ran the repo checks, the perf probe or its own live lanes. No independent verification has run.

**To do before merge.** Run `node scripts/queue-repro.js` and the other `scripts/*-check.mjs`. Run the ten live lanes in `plan.md` under CUX-03. Run perf.

## Order of landing

The plan stacks the three PRs in order, with CUX-01 at the base, then CUX-02, then CUX-03. All three were built from `main` at `2dbe95c`. They touch different code except `useAgent.js`, where CUX-02 changes `interrupted()` and the result handler, and CUX-03 changes `interrupt` and queue state. Rebase each onto the one below it before merging, or merge them one at a time into `main` and rebase the rest.

## How to verify

- Build the renderer with `npx vite build` after any change under `src/renderer`.
- Pure checks run with `node scripts/<name>-check.mjs`. App repros run with `node scripts/<name>-repro.js` and print PASS or FAIL per check.
- The live driver is `.claude/skills/verify/drive.mjs`. Read `.claude/skills/verify/SKILL.md` first. Boot with `node .claude/skills/verify/drive.mjs boot --xvfb`, drive with `click`, `key`, `type`, `say` and `perm`, inject agent events with `js --main "globalThis.__agent.emit('message', ...)"`, and always `stop --session <path>` at the end.
- Perf uses `node docs/plans/conn-chat-ux/probe/chat-perf.mjs --root <checkout> --scenario <replay400|stream|resize|search|notify>`. Alternate trunk and head for five pairs and compare medians. The plan's rule fails a head median above the trunk median times 1.10 plus 5 ms. `probe/trunk-baseline.jsonl` has trunk numbers at `2dbe95c`. The `replay400` scenario is noisy under load, so measure when the machine is quiet.
- Each PR's ten live lanes, with their pass conditions, are in `plan.md` under that PR's heading.

## Other findings

- **Possible bug outside these PRs.** A verifier ran mock CLIs, switched new chats to Codex, then reopened an earlier Cursor chat and sent a message. The chat started on Codex and failed with `unknown method thread/resume`. This was not checked on trunk.
- **Unproven items for later PRs.** These are listed in Appendix A of `plan.md`.

## Files in this folder

- `plan.md` is the full 22-PR plan. `gen/` regenerates it with `node docs/plans/conn-chat-ux/gen/gen.mjs docs/plans/conn-chat-ux/plan.md`.
- `prototype/rewind.mjs` is the throwaway proof that Claude file checkpoints rewind edits, used for CUX-06.
- `probe/` holds the perf probe and the trunk baseline.
- `media/` holds the CUX-01 review screenshots and video.
- `process/owner-brief.md` and `process/verifier-brief.md` are the instructions the agents followed. Paths in them point at `~/.claude/orchestrate/conn-chat-ux/`, where the originals still are.
- `process/*-decisions.tsv` are the decision logs of the root and each PR owner. Read one with `column -s$'\t' -t <file>`.
