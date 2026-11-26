// Shared with main, which replays transcripts by the same rules.
export { planOf, withPlan } from '../../../shared/plan.js';

export const planDone = (entries) => entries.filter((e) => e.status === 'completed').length;

export const planComplete = (entries) => entries.length > 0 && planDone(entries) === entries.length;
