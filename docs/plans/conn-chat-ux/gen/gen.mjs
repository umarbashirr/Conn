import fs from 'node:fs';
import { PRS } from './prs.mjs';

const RULE = 'Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.';
const MEDIA = '~/.claude/orchestrate/conn-chat-ux/media';
const D = 'node .claude/skills/verify/drive.mjs';

const box = (t) => `- [ ] ${t}`;

function pr(p) {
  const out = [];
  out.push(`## ${p.title} (${p.id})`, '');
  out.push(`**Depends on.** ${p.deps.length ? p.deps.join(', ') + '.' : 'None.'}`, '');
  out.push('**Files.**', '', ...p.files.map(box), '');
  out.push('**Build.**', '', ...p.build.map(box), '');
  out.push('**You see.**', '', ...p.see.map(box), '');
  out.push(`**Verify, unit.** ${RULE}`, '', ...p.unit.map(box), '');
  out.push(`**Verify, live.** ${RULE} Ten lanes on the configured \`swarm workers\` model at the PR head, per the boot recipe.`, '');
  if (p.lanes.length !== 10) throw new Error(`${p.id} has ${p.lanes.length} lanes`);
  p.lanes.forEach(([scenario, slug, pass], i) => {
    const lead = i === 0 ? 'Regression lane against trunk. ' : '';
    out.push(box(`Lane ${i + 1}. ${lead}${scenario} Save \`${p.id.toLowerCase()}-${slug}.png\`. Pass when ${pass}`));
  });
  out.push('');
  out.push(`**Verify, perf.** ${RULE}`, '');
  out.push(box(`Metric. ${p.perf.metric}`));
  out.push(box(`Probe. ${p.perf.probe}`));
  out.push(box(`Baseline. ${p.perf.baseline}`));
  out.push(box(`Rule. ${p.perf.rule}`), '');
  const id = p.id.toLowerCase();
  out.push('**Review gate.** The operator reviews before merge.', '');
  out.push(box(`Copy lane ${p.reviewLanes} screenshots into \`${MEDIA}/${id}-review-<slug>.png\`.`));
  out.push(box(`Record a 30 to 60 second video of ${p.video} in a lane worktree with \`${D} record --session <session> --seconds 45 --out ${MEDIA}/${id}-review.mp4\`.`));
  out.push(box('Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator\'s click.'), '');
  out.push('**Merge.**', '');
  out.push(box('Root\'s clean verdict at the exact head SHA.'));
  out.push(box('Bugbot triage done.'));
  out.push(box('Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.'));
  out.push(box('The root appends the PR to the base-branch stack, and the operator lands it bottom-up.'), '');
  return out.join('\n');
}

const head = fs.readFileSync(new URL('./head.md', import.meta.url), 'utf8');
const tail = fs.readFileSync(new URL('./tail.md', import.meta.url), 'utf8');
const ids = PRS.map((p) => p.id);
const graph = PRS.map((p) => box(p.deps.length ? `${p.id} after ${p.deps.join(' and ')}.` : `${p.id} has no parent PR.`)).map((l) => '  ' + l).join('\n');
const body = head.replace('{{IDS}}', ids.join(', ')).replace('{{GRAPH}}', graph);
fs.writeFileSync(process.argv[2], [body.trimEnd(), '', ...PRS.map(pr), tail.trim(), ''].join('\n'));
console.log(`wrote ${PRS.length} PRs to ${process.argv[2]}`);
