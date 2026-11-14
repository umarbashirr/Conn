# Conn chat UX: where it ended

`plan.md` in this folder is the original plan for 22 PRs, CUX-01 to CUX-22. It is kept as a record.
The October handoff that stood here described three open PRs. It is out of date and has been
replaced by this note (2026-11-14).

## Shipped

CUX-01 to CUX-19 are merged on `main`:

| CUX | PR | What |
|---|---|---|
| 01 | #17 | Chat and right column stay on screen at every width (zoom fix in #20) |
| 02 | #16 | Open tool rows end when a turn stops or finishes |
| 03 | #18 | Queued messages are held when a turn stops |
| 04 | #19 | Edit or retry a past message |
| 05 | #21 | Turn errors explained, with Retry |
| 06 | #25 | Undo a Claude turn's file edits |
| 07 | #26 | Notify when a turn ends or needs permission while unfocused |
| 08 | #27 | Drive the chat from the keyboard |
| 09 | #28 | Drafts survive reloads |
| 10 | #29 | Permissions and errors announced to screen readers |
| 11 | #30 | Failed tool output without the raw input |
| 12 | #31 | Codex and ACP edits shown as diffs |
| 13 | #34 | Each turn's file changes summarized |
| 14 | #35 | Reasoning rows for every provider |
| 15 | #36 | The agent's plan as a checklist |
| 16 | #37 | Context usage for Cursor, Grok and OpenCode |
| 17 | #38 | Copy a message, export a chat as Markdown |
| 18 | #40, landed by #41 | Search inside chat transcripts from the palette |
| 19 | #39, landed by #41 | New chat in the current folder |

## Not built

- **CUX-20**, widen the chat column and enlarge the toolbar buttons. Never got its own PR. The
  overview panel work (#50) changed the layout around it since, so re-check before reviving it.
- **CUX-21**, label the jump-to-latest button while text streams. Not built.
- **CUX-22**, manage always-allow permission rules. Not built: **Always** on a permission card
  records a rule, but there is no screen to list or remove rules.

Their specs are in `plan.md` under those headings. The process files (`process/`, `gen/`, `probe/`)
belong to the orchestration that ran the program and are not needed to read the code.
