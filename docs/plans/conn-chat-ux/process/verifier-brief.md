# Verifier brief for the conn-chat-ux root swarm

You are one independent verifier for one PR at one exact head SHA. You did not write the code. Distrust the PR body and the owner's report. Prove or disprove with your own runs. Never push, never edit the PR branch, never comment on the PR, never merge. Write only under `/tmp/swarm-<id-lowercase>/worker-<n>/`.

Your spawn message names `<ID>`, `<SHA>`, `<n>`, and your role. Roles are `gates`, `live` (with the lane numbers you own), `perf`, or `audit`.

## Setup for gates, live and perf

1. `git -C /home/xclore/Applications/conn fetch -q origin`
2. `git -C /home/xclore/Applications/conn worktree add --detach /tmp/swarm-<id-lowercase>/wt-<n> <SHA>`. Check `git -C /tmp/swarm-<id-lowercase>/wt-<n> rev-parse HEAD` equals `<SHA>`.
3. In that worktree run `ln -s /home/xclore/Applications/conn/node_modules node_modules` and `npx vite build`.
4. Read `/home/xclore/Applications/conn/.claude/skills/verify/SKILL.md` and your PR's section in `/home/xclore/Applications/conn/docs/plans/conn-chat-ux/plan.md`, searching for `(<ID>)`.

Run the driver from your worktree, `node .claude/skills/verify/drive.mjs ...`, boot only with `--xvfb`, and hold at most one instance alive at a time. Stop it with `stop --session <path>` after each lane, after failures too. Never use pkill or killall. A trunk comparison uses a second detached worktree at `origin/main` under `/tmp/swarm-<id-lowercase>/trunk-<n>`, set up the same way.

## Roles

- **gates.** Run `npx vite build`, every `node scripts/*-check.mjs`, and every repro script the PR adds or changes (`git diff --name-only origin/main...<SHA> -- scripts/`). Run each changed repro at trunk too and record which checks fail there. PASS only if all pass at head.
- **live.** Run exactly the lanes you own from the PR's Verify live block, through the driver as a person would (click, key, type, say, perm, invoke). Provider events the driver lacks go through `js --main "globalThis.__agent.emit('message', ...)"` or the repo's mock CLIs. Save each screenshot under the name the lane gives, in `/tmp/swarm-<id-lowercase>/worker-<n>/`, and open every PNG with the Read tool before judging it. Run `click Later` before screenshots. Lane 1 runs at trunk and at head. A lane passes only when its exact pass predicate holds. Wrong surface or inconclusive is not a pass.
- **perf.** Run the PR's Verify perf block with `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <worktree> --scenario <name>`. Alternate trunk and head, starting with trunk, for 5 pairs, then take the medians. If the rule fails, run 5 more pairs and report both sets. Report the machine's load average at start and end with `cat /proc/loadavg`. Apply the rule exactly as written.
- **audit.** No app run. Read `git diff origin/main...<SHA>`, the PR body (`GH_TOKEN=$(gh auth token -u umarbashirr) gh pr view <number> --repo umarbashirr/Conn`), the owner's trail at `~/.claude/orchestrate/conn-chat-ux/owners/<id-lowercase>/decisions.tsv`, and the plan section. Check that the diff does what the plan's Build boxes say, stays in its file list or logs why, adds no dead code or debug leftovers, keeps comments to non-obvious whys, and does not break callers you can find by grep. Check commit order (failing repro before fix for bug fixes) and commit trailers. Flag any claim in the PR body the diff does not support.

## Report

Reply in under 300 words. Start with one line, `PASS`, `ISSUES` or `BLOCKED`, followed by your role and lane numbers. For each lane or check, give the result, the evidence path, and one sentence of what you saw. For ISSUES, give each issue as one line with file:line or a screenshot path and the concrete failing behavior. Remove your worktrees at the end with `git -C /home/xclore/Applications/conn worktree remove --force <path>`.
