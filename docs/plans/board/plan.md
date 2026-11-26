# Board and pipelines

Conn runs several agents at once: up to eight folders per window, more than
one chat working in each, and as many windows as you open. The rail lists them
folder by folder, which answers "what is in this project" and not "what needs
me right now". Two changes, shipped as two pull requests.

## 1. The Board

One page that answers "what is every agent doing, and which ones need me".

### What it shows

Cards in four lanes, decided by one pure function (`laneOf` in
`src/renderer/ui/lib/board.js`):

| Lane | A chat is here when |
| --- | --- |
| Needs you | a permission or question card is waiting, or its last turn failed and you have not looked |
| Working | a turn is running, or a subagent or background shell it started still is |
| Done | its turn ended while you were reading something else, and you have not opened it since |
| Recent | none of the above, and it was active in the last 24 hours |

A card names the chat, its folder (and worktree, when the folder is one), the
agent, what it is doing now, and how long ago it moved.

### Where cards come from

1. **This window.** The rail store already merges live chats with the
   transcripts on disk. The Board reads the same rows, so the two never
   disagree. `useAgent` adds two facts to what it already syncs: whether the
   last turn ended unseen, and whether it failed.
2. **Other Conn windows.** Each window publishes its own cards to main
   (`board:publish`), and its bridge serves them on `GET /board`, behind the
   same token as every other route. The Board asks every live window found in
   `~/.conn/projects/` for theirs. Opening one of those cards posts to that
   window's `POST /board/open`, which raises it and opens the chat there. A chat
   is never driven from two windows.
3. **Claude Code sessions outside Conn.** `claude agents --json` lists the
   interactive and background sessions the CLI knows about. Those not already
   on the Board show in their own section, read only. A background one offers
   its `claude attach` command. If the CLI is too old to have the command, the
   section is left out.

Nothing is polled while the Board is closed. While it is open, peers and the
CLI are read every few seconds, one request in flight at a time.

### Out of scope

- Changing the eight-folder limit. Another window is the answer for more, and
  the Board is what makes several windows easy to follow.
- Driving an outside session from Conn. A terminal session belongs to its
  terminal.
- The phone. Desktop only (Linux and Windows) for now.

## 2. Pipelines

A saved list of steps, so a workflow you repeat (plan, build, review, fix) is
one launch instead of four prompts typed by hand.

### The file

YAML, in `.conn/pipelines/` in a project (yours, next to its canvas boards) or
`~/.conn/pipelines/` (every project). `src/shared/pipeline.js` parses and
checks it, and refuses a file with a reason rather than running half of it.

```yaml
name: Feature
description: Plan, build and review a change in its own worktree
input: What should be built?
worktree: true
stages:
  - id: plan
    prompt: |
      Plan this change and reply with a numbered plan only:
      {{input}}
    mode: plan
    gate: true
  - id: build
    prompt: |
      Implement this plan:
      {{plan}}
    mode: auto
  - id: review
    prompt: Review the uncommitted changes for bugs. Reply with findings only.
    mode: plan
  - id: fix
    prompt: |
      Fix these findings, if any:
      {{review}}
    mode: auto
    same: build
```

- `{{input}}` is what you typed at launch. `{{<id>}}` is the final reply of an
  earlier stage. A name that is neither is an error when the file is read.
- Each stage runs in a new chat, so a reviewer does not inherit the builder's
  reasoning. `same: <id>` sends it as the next message in that stage's chat
  instead.
- `mode`, `provider` and `model` default to the composer's.
- `gate: true` stops after that stage. The run waits in Needs you until you
  press Continue. You can reply in the stage's chat first; Continue takes its
  latest reply.
- `worktree: true` cuts a new worktree from the folder and runs every stage in
  it.

### Running

The renderer owns chats, so the runner lives there (`pipeline-store.js`). A run
is a small state machine over a record main keeps on disk, one file per run in
`~/.conn/runs/`, so a window that restarts shows what ran and where it stopped.
A run that was mid-stage when the window closed is shown as stopped, with
Continue to send that stage again.

Runs show on the Board as a card per run that moves between lanes with its
stage, and each stage's chat is in the rail under its folder like any other.

## Testing

- Pure logic (lanes, the external list, the pipeline file, templates, the run
  machine) gets plain-node `*-check.mjs` scripts.
- The app gets `*-repro.js` scripts that boot a throwaway Conn with
  `.claude/skills/verify/drive.mjs`, play the agent, and assert on the Board.
- A separate agent verifies each pull request in its own instance, from the
  description alone.
