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
