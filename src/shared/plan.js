'use strict';
const STATUS = { pending: 'pending', in_progress: 'in_progress', inProgress: 'in_progress', completed: 'completed' };

function todoInput(entries, explanation) {
  const todos = (entries || [])
    .filter((e) => typeof e?.content === 'string')
    .map(({ content, status, priority }) => ({
      content,
      status: STATUS[status] || 'pending',
      ...(priority ? { priority } : {}),
    }));
  return { todos, ...(typeof explanation === 'string' && explanation.trim() ? { explanation } : {}) };
}

// A TodoWrite call's input as plan entries, or null when it holds none.
const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);
function planOf(input) {
  const todos = input?.todos;
  if (!Array.isArray(todos) || !todos.length) return null;
  const entries = todos
    .filter((t) => typeof t?.content === 'string')
    .map(({ content, status, priority, activeForm }) => ({
      content,
      status: status === 'inProgress' ? 'in_progress' : PLAN_STATUS.has(status) ? status : 'pending',
      ...(priority ? { priority } : {}),
      ...(activeForm ? { activeForm } : {}),
    }));
  if (!entries.length) return null;
  const explanation = typeof input.explanation === 'string' && input.explanation.trim() ? input.explanation : undefined;
  return { entries, ...(explanation ? { explanation } : {}) };
}

// The items with this turn's plan put in, replacing the one it already had.
function withPlan(items, { parent, entries, explanation }) {
  const turn = items.findLast((it) => it.kind === 'user' && !it.parent)?.id ?? 'start';
  const id = parent ? `plan:${turn}:${parent}` : `plan:${turn}`;
  const plan = { id, kind: 'plan', parent: parent || null, entries, ...(explanation ? { explanation } : {}) };
  const at = items.findIndex((it) => it.id === id);
  if (at < 0) return [...items, plan];
  return items.map((it, i) => (i === at ? plan : it));
}

module.exports = { todoInput, planOf, withPlan };
