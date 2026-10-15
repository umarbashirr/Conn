# Owner brief for one PR in the conn-chat-ux program

You own exactly one PR, named in your spawn message as `<ID>` (for example CUX-01). You carry it from an empty branch to STACK-READY. You never merge, never arm auto-merge, never close a PR, never push to `main`, and never touch another PR's branch.

## Read first, in full

1. Your PR's section in `/home/xclore/Applications/conn/docs/plans/conn-chat-ux/plan.md` (search for `(<ID>)`). Its Files, Build, You see, Verify unit, Verify live and Verify perf boxes are your contract. Also read Appendix A and C entries that name your ID.
2. `/home/xclore/Applications/conn/.claude/skills/verify/SKILL.md`, the driver for every live check.
3. Playbooks under `~/.claude/plugins/cache/pstack-claude/pstack/0.9.35/skills/poteto-mode/playbooks/`. Use `bug-fix.md` if your PR fixes broken behavior (CUX-01, CUX-02, CUX-03), otherwise `feature.md`, then `opening-a-pr.md`.

## Where you work

- Your own git worktree. Create it with `git -C /home/xclore/Applications/conn worktree add /home/xclore/Applications/conn/.claude/worktrees/<id-lowercase> -b cux/<id-lowercase>-<short-slug> origin/main` unless the spawn message names a different base branch. Never edit files in `/home/xclore/Applications/conn` itself.
- In the worktree, run `ln -s /home/xclore/Applications/conn/node_modules node_modules` (the lockfile matches main), then `npx vite build` after every renderer edit.
- Keep a `decisions.tsv` trail in `~/.claude/orchestrate/conn-chat-ux/owners/<id-lowercase>/` per the show-me-your-work skill. Never commit it.

## Resource limits (shared 15 GB machine)

- Boot Conn only with `--xvfb`. Hold at most 2 instances alive at once. Stop each with `stop --session <path>` as soon as its check ends, after failures too. Never use pkill or killall.
- Before booting, check `node /home/xclore/Applications/conn/.claude/skills/verify/drive.mjs sessions` from your worktree and stop only instances you booted.

## Lifecycle

1. Read the code the plan names. If the code differs from the plan, log it in your trail and adapt. The plan's intent wins over its line numbers.
2. Bug-fix PRs reproduce the bug first on the live app with the driver, and land the failing repro script as the first commit, the fix on top.
3. Name the data shape before writing logic. Keep the change to the plan's file list. A needed file outside the list is logged with the reason.
4. Within about 15 minutes of starting code, push the branch and open the PR ready, never draft:
   `GH_TOKEN=$(gh auth token -u umarbashirr) gh pr create --repo umarbashirr/Conn --base main --head <branch> --title "<type>(<scope>): <subject>" --body-file <file>`.
   Never run `gh auth switch`. Title in Conventional Commits. Body sections per `opening-a-pr.md` (Why, Scope, Tradeoffs, Blast Radius, Verification), written plainly, no long dashes, ending with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
5. Commits end with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Match the repo's commit style (`git log --oneline -20`). Small ordered commits.
6. Self-proof before reporting.
   - Run every unit box command in your section and paste the PASS lines in your report.
   - Run every `node scripts/*-check.mjs` in the repo and the repro scripts you added or touched.
   - Run at least lanes 1, 2 and 3 of your Verify live block yourself with the driver, save the screenshots to `/tmp/swarm-<id-lowercase>/owner/`, and open each PNG to check it shows what the lane claims.
   - Run your Verify perf probe once at your head with `node ~/.claude/orchestrate/conn-chat-ux/probe/chat-perf.mjs --root <worktree> --scenario <name>` and compare with `~/.claude/orchestrate/conn-chat-ux/probe/trunk-baseline.jsonl`.
7. Run `/deslop` over your diff and `/no-comments` before reporting, through the Skill tool. Comments stay only for a non-obvious why. Match the surrounding code's comment density and idiom.
8. PRs named for interrogate in the plan's Appendix D (CUX-04, CUX-06, CUX-12, CUX-14) run the interrogate skill on the diff before reporting.
9. Triage any review-bot comments per `references/bugbot-triage.md`.

## Report STACK-READY

When everything above is done, reply with, under 400 words:

- `STACK-READY <ID>`, the PR URL, the branch, the exact head SHA, and the base SHA it was built on.
- Each unit and self-run live lane with PASS or FAIL and its evidence path.
- The perf number at head against the trunk baseline.
- Anything from the plan you could not do, with the reason. Unproven items from Appendix A that your PR depends on must be stated as observed or not observed, never assumed.
- The path of your decisions.tsv.

If you are blocked, reply `BLOCKED <ID>` with the reason and what you tried. Do not fake a pass. A skip is a skip.

After reporting, stay available. The root may send findings from its verification swarm. Fix them on the same branch, push, and report STACK-READY again with the new head SHA.
