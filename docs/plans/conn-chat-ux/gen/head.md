# Conn agent chat experience plan

This program fixes the gaps a code audit and a live walkthrough found in Conn's agent chat on 2026-10-15.
It is for the developer who works in Conn all day. They stop losing the chat column, stop retyping prompts after a failure, get told when an agent needs them, can undo an agent's edits, and see the same reasoning, plans and diffs from every provider.
The rule the program enforces is that every change is proven on the running app at its own head, against trunk, before it joins the stack.
The PR ids in stack order are {{IDS}}.

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
{{GRAPH}}
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
